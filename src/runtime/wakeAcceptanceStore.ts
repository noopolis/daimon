import { constants } from "node:fs";
import { link, lstat, open, readFile, readdir, realpath, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import {
  MAX_WAKE_ACCEPTANCE_RECORD_BYTES,
  parseWakeAcceptanceRequest,
  sanitizeWakeCompletionText,
  type OrganizationRuntimeWakeAcceptanceRequest,
  type OrganizationRuntimeWakeReceiptStatus,
  type WakeReceiptCode,
  type WakeReceiptState,
  wakeAcceptanceDigest
} from "./wakeAcceptanceTypes.js";
import { parseStoredWakeAcceptance, publicAcceptance, publicStatus, type StoredWakeAcceptanceRecord } from "./wakeAcceptanceRecord.js";
import { assertOfflineReconciliationLeaseAvailable } from "./wakeAcceptanceReconciliation.js";
import { acquireHostRegistration, releaseHostRegistration, type StoreHostRegistration } from "./storeCoordination.js";
import { MAX_WAKE_ACCEPTANCE_RECORDS, terminalFilesToCompact } from "./wakeAcceptanceRetention.js";

type Stored = StoredWakeAcceptanceRecord;
export type WakeExecutionClaim = Readonly<{ acceptance_id: string; owner_id: string; generation: string; expires_at: string }>;
export type WakeExecutionClaimResult = Readonly<{ state: "acquired"; claim: WakeExecutionClaim }> | Readonly<{ state: "held"; retry_at: string }> | Readonly<{ state: "terminal" }>;
type TransitionLock = Readonly<{ owner_id: string; generation: string; pid: number; process_start: string; boot_id: string; pid_namespace_dev: number; pid_namespace_ino: number }>;
type DirectoryIdentity = Readonly<{ dev: number; ino: number; uid: number; mode: number }>;
export type WakeAcceptanceStoreTestOptions = Readonly<{ claimTtlMs?: number; afterFinalLockAssertion?: () => Promise<void>; nowForTest?: () => number; ownerLiveness?: (lock: TransitionLock) => Promise<boolean>; processIdentity?: () => Promise<Omit<TransitionLock, "owner_id" | "generation">> }>;
/** Deliberately absent from the public option type; adjacent tests synchronize only this race. */
type InternalTestHooks = Readonly<{ afterInitialLeaseCheckForTest?: () => Promise<void> }>;
const DEFAULT_CLAIM_TTL_MS = 240_000;

/** Durable, private idempotency authority; callers must pre-create its 0700 root. */
export class WakeAcceptanceStore {
  private mutations: Promise<void> = Promise.resolve();
  private readonly acceptanceFiles = new Map<string, string>();
  private constructor(private readonly root: string, private readonly directory: Awaited<ReturnType<typeof open>>, private readonly identity: DirectoryIdentity, private readonly registration: StoreHostRegistration, private readonly claimTtlMs: number, private readonly now: () => number, private readonly owner: Omit<TransitionLock, "owner_id" | "generation">, private readonly ownerLiveness: (lock: TransitionLock) => Promise<boolean>, private readonly afterFinalLockAssertion?: () => Promise<void>) {}

  static async open(root: string, options: WakeAcceptanceStoreTestOptions = {}): Promise<WakeAcceptanceStore> {
    const claimTtlMs = options.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS;
    if (!Number.isInteger(claimTtlMs) || claimTtlMs < 1 || claimTtlMs > 600_000) throw new Error("wake acceptance claim lease is outside its bound");
    if (!path.isAbsolute(root)) throw new Error("wake acceptance store path must be absolute");
    const owner = await (options.processIdentity ?? currentProcessIdentity)();
    await assertNoLinks(root);
    await assertOfflineReconciliationLeaseAvailable(root).catch(() => { throw new Error("wake acceptance store is reserved for offline reconciliation"); });
    await (options as WakeAcceptanceStoreTestOptions & InternalTestHooks).afterInitialLeaseCheckForTest?.();
    const before = await lstat(root);
    if (!before.isDirectory() || before.isSymbolicLink() || before.uid !== process.getuid?.() || (before.mode & 0o777) !== 0o700) throw new Error("wake acceptance store must be a caller-prepared private directory");
    const directory = await open(root, constants.O_RDONLY | directoryFlag() | noFollow());
    try {
      const after = await directory.stat();
      const real = await realpath(root);
      if (!same(identity(before), identity(after))) throw new Error("wake acceptance store changed during validation");
      const registration = await acquireHostRegistration(real, directory, owner);
      return new WakeAcceptanceStore(real, directory, identity(before), registration, claimTtlMs, options.nowForTest ?? Date.now, owner, options.ownerLiveness ?? processIsAlive, options.afterFinalLockAssertion);
    } catch (error) {
      await directory.close().catch(() => undefined);
      throw error;
    }
  }

  accept(request: OrganizationRuntimeWakeAcceptanceRequest): Promise<{ readonly record: Stored; readonly created: boolean }> {
    return this.serialize(async () => await this.acceptNow(request));
  }

  private async acceptNow(request: OrganizationRuntimeWakeAcceptanceRequest): Promise<{ readonly record: Stored; readonly created: boolean }> {
    await this.verify();
    const request_digest = wakeAcceptanceDigest(request);
    const target = this.fileFor(request.agent_id, request.delivery_id);
    const existing = await this.readOptional(target);
    if (existing !== undefined) {
      if (existing.request_digest !== request_digest) throw new WakeAcceptanceConflictError();
      return { record: existing, created: false };
    }
    await this.compactTerminalRecords();
    if ((await this.files()).length >= MAX_WAKE_ACCEPTANCE_RECORDS) throw new Error("wake acceptance store has no capacity without deleting active work");
    const now = new Date().toISOString();
    const record: Stored = { acceptance_id: randomUUID(), agent_id: request.agent_id, delivery_id: request.delivery_id, request_digest, event: request.event, state: "accepted", accepted_at: now, updated_at: now };
    const temporary = path.join(this.root, `.pending-${randomUUID()}`);
    try {
      await this.writeNew(temporary, record);
      try { await link(temporary, target); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const winner = await this.read(target);
        if (winner.request_digest !== request_digest) throw new WakeAcceptanceConflictError();
        return { record: winner, created: false };
      }
      await this.directory.sync();
      this.acceptanceFiles.set(record.acceptance_id, target);
      return { record, created: true };
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  async status(acceptanceId: string): Promise<OrganizationRuntimeWakeReceiptStatus | undefined> {
    const record = await this.findByAcceptanceId(acceptanceId);
    return record === undefined ? undefined : publicStatus(record);
  }

  async activity(): Promise<readonly (OrganizationRuntimeWakeReceiptStatus & Readonly<{ active: boolean; queue_position?: number }>)[]> {
    const records = await Promise.all((await this.files()).map(async (file) => await this.read(path.join(this.root, file))));
    records.sort((left, right) => left.accepted_at.localeCompare(right.accepted_at) || left.acceptance_id.localeCompare(right.acceptance_id));
    const queued = new Map<string, number>();
    return records.map((record) => {
      const position = record.state === "accepted" ? (queued.get(record.agent_id) ?? 0) + 1 : undefined;
      if (position !== undefined) queued.set(record.agent_id, position);
      return { ...publicStatus(record), active: record.state === "running", ...(position === undefined ? {} : { queue_position: position }) };
    });
  }

  async recoverable(agentIds: ReadonlySet<string>): Promise<readonly Stored[]> {
    const result: Stored[] = [];
    for (const file of await this.files()) {
      const record = await this.read(path.join(this.root, file));
      if (!agentIds.has(record.agent_id)) throw new Error("wake acceptance store contains an unknown agent authority");
      if (record.state === "accepted" || record.state === "running") result.push(record);
    }
    return result.sort((left, right) => left.accepted_at.localeCompare(right.accepted_at) || left.acceptance_id.localeCompare(right.acceptance_id));
  }

  transition(acceptanceId: string, state: WakeReceiptState, code?: WakeReceiptCode): Promise<Stored> {
    return this.serialize(async () => await this.transitionNow(acceptanceId, state, code));
  }

  /** Fuse race seam: never stops a record that was claimed after enumeration. */
  transitionAcceptedToStopped(acceptanceId: string): Promise<Stored> {
    return this.serialize(async () => {
      const target = await this.pathForAcceptanceId(acceptanceId);
      const prior = await this.read(target);
      if (prior.state !== "accepted") return prior;
      const record: Stored = { ...prior, state: "stopped", code: "host_stopping", updated_at: new Date().toISOString() };
      await this.replace(target, record);
      return record;
    });
  }

  acquireClaim(acceptanceId: string, ownerId: string): Promise<WakeExecutionClaimResult> {
    return this.serialize(async () => {
      if (!uuid(ownerId)) throw new Error("wake execution owner is invalid");
      const record = await this.findByAcceptanceId(acceptanceId);
      if (record === undefined) throw new Error("wake acceptance receipt is unavailable");
      if (isTerminal(record.state)) return { state: "terminal" };
      const target = this.claimFor(record);
      const current = await this.readClaimOptional(target);
      if (current !== undefined && !expired(current, this.now())) return { state: "held", retry_at: current.expires_at };
      const lock = await this.acquireTransitionLock(record, ownerId);
      if (lock === undefined) return { state: "held", retry_at: new Date(this.now() + 50).toISOString() };
      try {
        const checked = await this.readClaimOptional(target);
        if (checked !== undefined && !expired(checked, this.now())) return { state: "held", retry_at: checked.expires_at };
        if (checked !== undefined) { await unlink(target); await this.directory.sync(); }
      const claim: WakeExecutionClaim = { acceptance_id: record.acceptance_id, owner_id: ownerId, generation: randomUUID(), expires_at: new Date(this.now() + this.claimTtlMs).toISOString() };
      const temporary = path.join(this.root, `.claim-${randomUUID()}`);
      try {
        await this.writeNew(temporary, claim);
        try { await link(temporary, target); } catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") { const winner = await this.readClaim(target); return { state: "held", retry_at: winner.expires_at }; } throw error; }
        await this.directory.sync();
        return { state: "acquired", claim };
      } finally { await unlink(temporary).catch(() => undefined); }
      } finally { await this.releaseTransitionLock(record, lock); }
    });
  }

  claimHeartbeatIntervalMs(): number { return Math.max(1, Math.floor(this.claimTtlMs / 3)); }

  renewClaim(acceptanceId: string, claim: WakeExecutionClaim): Promise<WakeExecutionClaim> {
    return this.serialize(async () => {
      const record = await this.findByAcceptanceId(acceptanceId);
      if (record === undefined) throw new Error("wake acceptance receipt is unavailable");
      const lock = await this.acquireTransitionLock(record, claim.owner_id);
      if (lock === undefined) throw new WakeExecutionClaimLostError();
      try {
        const current = await this.readClaim(this.claimFor(record));
        if (current.acceptance_id !== acceptanceId || current.acceptance_id !== claim.acceptance_id || current.owner_id !== claim.owner_id || current.generation !== claim.generation || current.expires_at !== claim.expires_at || expired(current, this.now())) throw new WakeExecutionClaimLostError();
        const renewed: WakeExecutionClaim = { ...current, expires_at: new Date(this.now() + this.claimTtlMs).toISOString() };
        await this.replaceValue(this.claimFor(record), renewed);
        return renewed;
      } finally { await this.releaseTransitionLock(record, lock); }
    });
  }

  /** `text` carries the completion output on success and the engine failure cause on failure. */
  transitionClaimed(acceptanceId: string, claim: WakeExecutionClaim, state: WakeReceiptState, code?: WakeReceiptCode, completedText?: string): Promise<Stored> {
    return this.serialize(async () => {
      if (completedText !== undefined && state !== "completed" && state !== "failed") throw new Error("wake text requires completed or failed state");
      const initial = await this.findByAcceptanceId(acceptanceId);
      if (initial === undefined) throw new Error("wake acceptance receipt is unavailable");
      const lock = await this.acquireTransitionLock(initial, claim.owner_id);
      if (lock === undefined) throw new WakeExecutionClaimLostError();
      try {
        let record = await this.transitionNowClaimed(acceptanceId, claim);
        if (isTerminal(record.state)) return record;
        if (state !== "running" && record.claim_generation !== claim.generation) throw new WakeExecutionClaimLostError();
        await this.assertTransitionLock(record, lock);
        record = await this.transitionNowClaimed(acceptanceId, claim);
        if (isTerminal(record.state)) return record;
        if (state !== "running" && record.claim_generation !== claim.generation) throw new WakeExecutionClaimLostError();
        await this.assertTransitionLock(record, lock);
        await this.afterFinalLockAssertion?.();
        await this.assertTransitionLock(record, lock);
        const target = this.fileFor(record.agent_id, record.delivery_id);
        const next: Stored = { ...record, state, updated_at: new Date().toISOString(), claim_generation: claim.generation, ...(code === undefined ? {} : { code }), ...(completedText === undefined ? {} : { text: sanitizeWakeCompletionText(completedText) }) };
        await this.replace(target, next);
        if (isTerminal(state)) {
          const currentClaim = await this.readClaimOptional(this.claimFor(record));
          if (currentClaim?.owner_id === claim.owner_id && currentClaim.generation === claim.generation) { await unlink(this.claimFor(record)); await this.directory.sync(); }
        }
        return next;
      } finally { await this.releaseTransitionLock(initial, lock); }
    });
  }

  releaseClaims(ownerId: string): Promise<void> {
    return this.serialize(async () => {
      for (const file of await this.claimFiles()) {
        const claim = await this.readClaim(path.join(this.root, file));
        if (claim.owner_id === ownerId) await unlink(path.join(this.root, file));
      }
      await this.directory.sync();
    });
  }

  private async transitionNow(acceptanceId: string, state: WakeReceiptState, code?: WakeReceiptCode): Promise<Stored> {
    const target = await this.pathForAcceptanceId(acceptanceId);
    const prior = await this.read(target);
    if (isTerminal(prior.state)) return prior;
    const record: Stored = { ...prior, state, updated_at: new Date().toISOString(), ...(code === undefined ? {} : { code }) };
    await this.replace(target, record);
    return record;
  }

  async close(): Promise<void> { await this.mutations; await releaseHostRegistration(this.root, this.directory, this.registration); await this.directory.close(); }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutations.catch(() => undefined).then(operation);
    this.mutations = result.then(() => undefined, () => undefined);
    return result;
  }

  private async findByAcceptanceId(acceptanceId: string): Promise<Stored | undefined> {
    if (!uuid(acceptanceId)) return undefined;
    const known = this.acceptanceFiles.get(acceptanceId);
    if (known !== undefined) return await this.readOptional(known);
    for (const file of await this.files()) {
      const record = await this.read(path.join(this.root, file));
      this.acceptanceFiles.set(record.acceptance_id, path.join(this.root, file));
      if (record.acceptance_id === acceptanceId) return record;
    }
    return undefined;
  }
  private async pathForAcceptanceId(acceptanceId: string): Promise<string> {
    const record = await this.findByAcceptanceId(acceptanceId);
    if (record === undefined) throw new Error("wake acceptance receipt is unavailable");
    return this.fileFor(record.agent_id, record.delivery_id);
  }
  private claimFor(record: Stored): string { return path.join(this.root, `${createHash("sha256").update(record.agent_id).digest("hex")}.agent-claim`); }
  private lockFor(record: Stored): string { return this.fileFor(record.agent_id, record.delivery_id).replace(/\.json$/u, ".transition-lock"); }
  private async acquireTransitionLock(record: Stored, ownerId: string): Promise<TransitionLock | undefined> {
    const target = this.lockFor(record);
    const current = await this.readLockOptional(target);
    if (current !== undefined && !sameNamespace(current, this.owner)) throw new WakeTransitionLockBlockedError();
    if (current !== undefined && await this.ownerLiveness(current)) return undefined;
    if (current !== undefined) { await unlink(target); await this.directory.sync(); }
    const lock: TransitionLock = { owner_id: ownerId, generation: randomUUID(), ...this.owner };
    const temporary = path.join(this.root, `.lock-${randomUUID()}`);
    try {
      await this.writeNew(temporary, lock);
      try { await link(temporary, target); } catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined; throw error; }
      await this.directory.sync();
      return lock;
    } finally { await unlink(temporary).catch(() => undefined); }
  }
  private async assertTransitionLock(record: Stored, lock: TransitionLock): Promise<void> {
    const current = await this.readLock(this.lockFor(record)).catch(() => { throw new WakeExecutionClaimLostError(); });
    if (current.owner_id !== lock.owner_id || current.generation !== lock.generation || current.pid !== lock.pid || current.process_start !== lock.process_start || current.boot_id !== lock.boot_id || !sameNamespace(current, lock)) throw new WakeExecutionClaimLostError();
  }
  private async releaseTransitionLock(record: Stored, lock: TransitionLock): Promise<void> {
    const target = this.lockFor(record);
    const current = await this.readLockOptional(target);
    if (current !== undefined && current.owner_id === lock.owner_id && current.generation === lock.generation && current.pid === lock.pid && current.process_start === lock.process_start && current.boot_id === lock.boot_id && sameNamespace(current, lock)) { await unlink(target); await this.directory.sync(); }
  }
  private fileFor(agentId: string, deliveryId: string): string {
    return path.join(this.root, `${createHash("sha256").update(`${agentId}\u0000${deliveryId}`).digest("hex")}.json`);
  }
  private async files(): Promise<readonly string[]> {
    await this.verify();
    const entries = await readdir(this.root);
    const files = entries.filter((entry) => /^[a-f0-9]{64}\.json$/.test(entry));
    if (files.length > MAX_WAKE_ACCEPTANCE_RECORDS || entries.length > MAX_WAKE_ACCEPTANCE_RECORDS + 128) throw new Error("wake acceptance store exceeds its bounded record limit");
    return files;
  }
  private async claimFiles(): Promise<readonly string[]> { return (await readdir(this.root)).filter((entry) => /^[a-f0-9]{64}\.agent-claim$/.test(entry)); }
  private async readOptional(file: string): Promise<Stored | undefined> { try { return await this.read(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; } }
  private async read(file: string): Promise<Stored> {
    const entry = await lstat(file);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.uid !== process.getuid?.() || (entry.mode & 0o777) !== 0o600 || entry.size > MAX_WAKE_ACCEPTANCE_RECORD_BYTES) throw new Error("wake acceptance record is unsafe");
    const bytes = await readFile(file);
    if (bytes.length > MAX_WAKE_ACCEPTANCE_RECORD_BYTES) throw new Error("wake acceptance record exceeds its bound");
    return parseStoredWakeAcceptance(JSON.parse(bytes.toString("utf8")));
  }
  private async readClaimOptional(file: string): Promise<WakeExecutionClaim | undefined> { try { return await this.readClaim(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; } }
  private async readClaim(file: string): Promise<WakeExecutionClaim> {
    const entry = await lstat(file);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.uid !== process.getuid?.() || (entry.mode & 0o777) !== 0o600 || entry.size > 1_024) throw new Error("wake execution claim is unsafe");
    const value: unknown = JSON.parse((await readFile(file)).toString("utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("wake execution claim is invalid");
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length !== 4 || !Object.hasOwn(record, "acceptance_id") || !Object.hasOwn(record, "owner_id") || !Object.hasOwn(record, "generation") || !Object.hasOwn(record, "expires_at")) throw new Error("wake execution claim is invalid");
    const claim = { acceptance_id: string(record.acceptance_id), owner_id: string(record.owner_id), generation: string(record.generation), expires_at: timestamp(record.expires_at) };
    if (!uuid(claim.acceptance_id) || !uuid(claim.owner_id) || !uuid(claim.generation)) throw new Error("wake execution claim is invalid");
    return claim;
  }
  private async readLockOptional(file: string): Promise<TransitionLock | undefined> { try { return await this.readLock(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; } }
  private async readLock(file: string): Promise<TransitionLock> {
    const entry = await lstat(file);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.uid !== process.getuid?.() || (entry.mode & 0o777) !== 0o600 || entry.size > 1_024) throw new Error("wake transition lock is unsafe");
    const value: unknown = JSON.parse((await readFile(file)).toString("utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("wake transition lock is invalid");
    const lock = value as Record<string, unknown>;
    if (Object.keys(lock).length !== 7 || !Object.hasOwn(lock, "owner_id") || !Object.hasOwn(lock, "generation") || !Object.hasOwn(lock, "pid") || !Object.hasOwn(lock, "process_start") || !Object.hasOwn(lock, "boot_id") || !Object.hasOwn(lock, "pid_namespace_dev") || !Object.hasOwn(lock, "pid_namespace_ino")) throw new Error("wake transition lock is invalid");
    const result: TransitionLock = { owner_id: string(lock.owner_id), generation: string(lock.generation), pid: integer(lock.pid), process_start: string(lock.process_start), boot_id: string(lock.boot_id), pid_namespace_dev: integer(lock.pid_namespace_dev), pid_namespace_ino: integer(lock.pid_namespace_ino) };
    if (!uuid(result.owner_id) || !uuid(result.generation) || result.pid < 1 || !result.process_start || !result.boot_id || result.pid_namespace_dev < 1 || result.pid_namespace_ino < 1) throw new Error("wake transition lock is invalid");
    return result;
  }
  private async transitionNowClaimed(acceptanceId: string, claim: WakeExecutionClaim): Promise<Stored> {
    const record = await this.findByAcceptanceId(acceptanceId);
    if (record === undefined) throw new Error("wake acceptance receipt is unavailable");
    const current = await this.readClaim(this.claimFor(record));
    if (current.acceptance_id !== acceptanceId || current.acceptance_id !== claim.acceptance_id || current.owner_id !== claim.owner_id || current.generation !== claim.generation || current.expires_at !== claim.expires_at || expired(current, this.now())) throw new WakeExecutionClaimLostError();
    return record;
  }
  private async compactTerminalRecords(): Promise<void> {
    const files = await this.files();
    if (files.length < 2_112) return;
    const records = await Promise.all(files.map(async (file) => ({ file, record: await this.read(path.join(this.root, file)) })));
    for (const file of terminalFilesToCompact(records.map(({ file, record }) => ({ file, state: record.state, updatedAt: record.updated_at, acceptanceId: record.acceptance_id })))) {
      const record = records.find((candidate) => candidate.file === file)?.record;
      if (record !== undefined) this.acceptanceFiles.delete(record.acceptance_id);
      await unlink(path.join(this.root, file));
    }
    await this.directory.sync();
  }
  private async writeNew(file: string, record: unknown): Promise<void> {
    const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow(), 0o600);
    try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); } finally { await handle.close(); }
  }
  private async replace(target: string, record: Stored): Promise<void> { await this.replaceValue(target, record); }
  private async replaceValue(target: string, record: unknown): Promise<void> {
    const temporary = path.join(this.root, `.replace-${randomUUID()}`);
    try { await this.writeNew(temporary, record); await rename(temporary, target); await this.directory.sync(); } finally { await unlink(temporary).catch(() => undefined); }
  }
  private async verify(): Promise<void> {
    await assertNoLinks(this.root);
    const entry = await lstat(this.root);
    const opened = await this.directory.stat();
    if (!same(identity(entry), this.identity) || !same(identity(opened), this.identity) || (await realpath(this.root)) !== this.root) throw new Error("wake acceptance store changed after validation");
  }
}

export class WakeAcceptanceConflictError extends Error { constructor() { super("delivery id is already bound to a different request"); } }
export class WakeExecutionClaimLostError extends Error { constructor() { super("wake execution claim was lost"); } }
/** A container boundary requires deployment-authorized offline reconciliation. */
export class WakeTransitionLockBlockedError extends Error { readonly code = "offline_reconciliation_required" as const; constructor() { super("wake transition lock requires offline reconciliation"); } }
export { publicAcceptance } from "./wakeAcceptanceRecord.js";
function string(value: unknown): string { if (typeof value !== "string") throw new Error("wake acceptance record is invalid"); return value; }
function integer(value: unknown): number { if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error("wake transition lock is invalid"); return value; }
function timestamp(value: unknown): string { const result = string(value); if (Number.isNaN(Date.parse(result)) || new Date(result).toISOString() !== result) throw new Error("wake acceptance record is invalid"); return result; }
function uuid(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value); }
function isTerminal(state: WakeReceiptState): boolean { return state === "completed" || state === "failed" || state === "stopped"; }
function expired(claim: WakeExecutionClaim, now: number): boolean { return Date.parse(claim.expires_at) <= now; }
function identity(value: Awaited<ReturnType<typeof lstat>>): DirectoryIdentity {
  const numeric = value as typeof value & { dev: number; ino: number; uid: number; mode: number };
  return { dev: numeric.dev, ino: numeric.ino, uid: numeric.uid, mode: numeric.mode & 0o7777 };
}
function same(left: DirectoryIdentity, right: DirectoryIdentity): boolean { return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid && left.mode === right.mode; }
function sameNamespace(left: Pick<TransitionLock, "pid_namespace_dev" | "pid_namespace_ino">, right: Pick<TransitionLock, "pid_namespace_dev" | "pid_namespace_ino">): boolean { return left.pid_namespace_dev === right.pid_namespace_dev && left.pid_namespace_ino === right.pid_namespace_ino; }
function noFollow(): number { return (constants as typeof constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0; }
function directoryFlag(): number { return (constants as typeof constants & { O_DIRECTORY?: number }).O_DIRECTORY ?? 0; }
async function assertNoLinks(target: string): Promise<void> { let current = path.parse(target).root; for (const part of path.relative(current, target).split(path.sep).filter(Boolean)) { current = path.join(current, part); if ((await lstat(current)).isSymbolicLink() && current !== "/var") throw new Error("wake acceptance store path contains a symlink"); } }
async function currentProcessIdentity(): Promise<Omit<TransitionLock, "owner_id" | "generation">> {
  if (process.platform !== "linux") throw new Error("wake transition locks require Linux process identity");
  const boot_id = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  if (!boot_id) throw new Error("wake transition owner identity is invalid");
  return { pid: process.pid, process_start: await linuxProcessStart(process.pid), boot_id, ...await linuxPidNamespace() };
}
async function processIsAlive(lock: TransitionLock): Promise<boolean> {
  if (process.platform !== "linux") throw new Error("wake transition lock liveness is unsupported");
  if (!sameNamespace(lock, await linuxPidNamespace())) throw new WakeTransitionLockBlockedError();
  const boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  if (!boot) throw new Error("wake transition owner liveness cannot be proven");
  if (boot !== lock.boot_id) return false;
  try { return await linuxProcessStart(lock.pid) === lock.process_start; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw new Error("wake transition owner liveness cannot be proven"); }
}
async function linuxProcessStart(pid: number): Promise<string> {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8");
  const close = stat.lastIndexOf(")");
  const fields = stat.slice(close + 2).trim().split(/\s+/u);
  const start = fields[19];
  if (close < 0 || start === undefined || !/^\d+$/u.test(start)) throw new Error("wake transition owner identity is invalid");
  return start;
}
async function linuxPidNamespace(): Promise<Pick<TransitionLock, "pid_namespace_dev" | "pid_namespace_ino">> {
  const identity = await stat("/proc/self/ns/pid");
  const pid_namespace_dev = Number(identity.dev);
  const pid_namespace_ino = Number(identity.ino);
  if (!Number.isSafeInteger(pid_namespace_dev) || !Number.isSafeInteger(pid_namespace_ino) || pid_namespace_dev < 1 || pid_namespace_ino < 1) throw new Error("wake transition owner identity is invalid");
  return { pid_namespace_dev, pid_namespace_ino };
}

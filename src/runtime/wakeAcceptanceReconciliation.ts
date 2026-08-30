import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, readFile, realpath, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { clearDeadHostRegistrations, hostRegistrationDigest, listHostRegistrations, type StoreHostRegistration, type StoreHostRegistrationIdentity } from "./storeCoordination.js";

export const OFFLINE_RECONCILIATION_VERSION = "noopolis.daimon.offline-transition-reconciliation.v1" as const;
export const OFFLINE_RECONCILIATION_BLOCKED_CODE = "offline_reconciliation_required" as const;
const MAX_BYTES = 16_384;
const RECEIPT_VERSION = "noopolis.daimon.offline-transition-reconciliation-receipt.v1" as const;

export const OFFLINE_RECONCILIATION_REQUEST_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema", $id: OFFLINE_RECONCILIATION_VERSION, type: "object", additionalProperties: false,
  required: ["version", "agent_id", "delivery_id", "store", "lock", "attestation"], properties: {
    version: { const: OFFLINE_RECONCILIATION_VERSION }, agent_id: { type: "string", minLength: 1, maxLength: MAX_BYTES }, delivery_id: { type: "string", minLength: 1, maxLength: MAX_BYTES },
    store: { type: "object", additionalProperties: false, required: ["dev", "ino"], properties: { dev: { type: "integer", minimum: 1 }, ino: { type: "integer", minimum: 1 } } },
    lock: { type: "object", additionalProperties: false, required: ["dev", "ino", "owner_id", "generation", "pid", "process_start", "boot_id", "pid_namespace_dev", "pid_namespace_ino"], properties: { dev: { type: "integer", minimum: 1 }, ino: { type: "integer", minimum: 1 }, owner_id: { type: "string" }, generation: { type: "string" }, pid: { type: "integer", minimum: 1 }, process_start: { type: "string" }, boot_id: { type: "string" }, pid_namespace_dev: { type: "integer", minimum: 1 }, pid_namespace_ino: { type: "integer", minimum: 1 } } },
    attestation: { type: "object", additionalProperties: false, required: ["version", "authority_id", "attestation_id", "state", "proof"], properties: { version: { const: "noopolis.deployment.container-quiescence.v1" }, authority_id: { type: "string", minLength: 1, maxLength: MAX_BYTES }, attestation_id: { type: "string", minLength: 1, maxLength: MAX_BYTES }, state: { enum: ["absent", "quiescent"] }, proof: { type: "string", minLength: 1, maxLength: MAX_BYTES } } }
  }
} as const;

type Identity = Readonly<{ dev: number; ino: number }>;
type Lock = Readonly<{ dev: number; ino: number; owner_id: string; generation: string; pid: number; process_start: string; boot_id: string; pid_namespace_dev: number; pid_namespace_ino: number }>;
type Lease = Readonly<{ owner_id: string; pid: number; process_start: string; boot_id: string; pid_namespace_dev: number; pid_namespace_ino: number }>;
export type OfflineDeploymentAttestation = Readonly<{ version: "noopolis.deployment.container-quiescence.v1"; authority_id: string; attestation_id: string; state: "absent" | "quiescent"; proof: string }>;
export type OfflineTransitionReconciliationRequest = Readonly<{ version: typeof OFFLINE_RECONCILIATION_VERSION; agent_id: string; delivery_id: string; store: Identity; lock: Lock; attestation: OfflineDeploymentAttestation }>;
export type OfflineTransitionReconciliationAuthorizationContext = Readonly<{ version: "noopolis.daimon.offline-transition-authorization-context.v1"; deployment_identity: string; deployment_state: "absent" | "quiescent"; nonce: string; request_digest: string; agent_id: string; delivery_id: string; store: Identity; lock: Lock; stale_host_registrations: readonly StoreHostRegistrationIdentity[] }>;
export type OfflineTransitionReconciliationProofReceipt = Readonly<{ request_digest: string; nonce: string; exclusive_store: true; authorized_registration_digests: readonly string[] }>;
export type OfflineTransitionReconciliationReceipt = Readonly<{ version: typeof RECEIPT_VERSION; reconciliation_id: string; request_digest: string; state: "reconciled"; reconciled_at: string; cleared_registration_digests: readonly string[] }>;
export type OfflineTransitionReconciliationResult = OfflineTransitionReconciliationReceipt | Readonly<{ version: typeof OFFLINE_RECONCILIATION_VERSION; state: "blocked"; code: typeof OFFLINE_RECONCILIATION_BLOCKED_CODE }>;
export type OfflineTransitionReconciliationOptions = Readonly<{ storePath: string; verifyDeploymentAttestation: (context: OfflineTransitionReconciliationAuthorizationContext, attestation: OfflineDeploymentAttestation) => Promise<OfflineTransitionReconciliationProofReceipt>; leaseIdentity?: () => Promise<Lease>; leaseLiveness?: (lease: Lease) => Promise<boolean>; hostLiveness?: (host: StoreHostRegistration) => Promise<boolean> }>;

/** Deployment-only: caller must exclusively mount the private store offline. */
export async function reconcileOfflineWakeTransition(value: unknown, options: OfflineTransitionReconciliationOptions): Promise<OfflineTransitionReconciliationResult> {
  try {
    const request = parseOfflineTransitionReconciliationRequest(value);
    const root = await openStore(options.storePath, request.store);
    try {
      const lease = await acquireLease(root.path, root.directory, await (options.leaseIdentity ?? currentLeaseIdentity)(), options.leaseLiveness ?? leaseIsAlive);
      if (lease === undefined) return blocked();
      try {
        const target = lockPath(root.path, request.agent_id, request.delivery_id);
        const receiptPath = receiptFile(root.path, request);
        let receipt = await readReceiptOptional(receiptPath);
        if (receipt !== undefined && receipt.request_digest !== digest(request)) return blocked();
        if (receipt?.state === "reconciled") return publicReceipt(receipt);
        const context = authorizationContext(request, await listHostRegistrations(root.path));
        const proof = await options.verifyDeploymentAttestation(context, request.attestation).catch(() => { throw new OfflineTransitionReconciliationBlockedError(); });
        if (!sameProofReceipt(proof, context)) throw new OfflineTransitionReconciliationBlockedError();
        const cleared = await clearDeadHostRegistrations(root.path, root.directory, lease, options.hostLiveness ?? leaseIsAlive, new Set(proof.authorized_registration_digests)).catch(() => undefined);
        if (cleared === undefined) return blocked();
        await assertStore(root, request.store);
        await assertRecord(recordPath(root.path, request.agent_id, request.delivery_id), request);
        if (receipt === undefined) receipt = await writeReceipt(receiptPath, { version: RECEIPT_VERSION, reconciliation_id: randomUUID(), request_digest: digest(request), state: "prepared", reconciled_at: "", cleared_registration_digests: [] }, root.directory);
        const lock = await readLockOptional(target);
        if (lock !== undefined) {
          if (!same(lock, request.lock) || !same(await lstat(target), request.lock)) throw new OfflineTransitionReconciliationBlockedError();
          await assertStore(root, request.store);
          await assertRecord(recordPath(root.path, request.agent_id, request.delivery_id), request);
          await unlink(target);
          await root.directory.sync();
        }
        const reconciled = { ...receipt, state: "reconciled" as const, reconciled_at: new Date().toISOString(), cleared_registration_digests: uniqueDigests([...receipt.cleared_registration_digests, ...cleared]) };
        await replaceReceipt(receiptPath, reconciled, root.directory);
        return publicReceipt(reconciled);
      } finally { await releaseLease(lease, root.directory, root.path); }
    } finally { await root.directory.close(); }
  } catch (error) {
    if (error instanceof OfflineTransitionReconciliationBlockedError) return blocked();
    throw error;
  }
}

export function parseOfflineTransitionReconciliationRequest(value: unknown): OfflineTransitionReconciliationRequest {
  const root = strictRecord(value, ["version", "agent_id", "delivery_id", "store", "lock", "attestation"]);
  if (text(root.version) !== OFFLINE_RECONCILIATION_VERSION) throw new TypeError("offline reconciliation version is unsupported");
  const store = strictRecord(root.store, ["dev", "ino"]);
  const lock = strictRecord(root.lock, ["dev", "ino", "owner_id", "generation", "pid", "process_start", "boot_id", "pid_namespace_dev", "pid_namespace_ino"]);
  const attestation = strictRecord(root.attestation, ["version", "authority_id", "attestation_id", "state", "proof"]);
  const state = text(attestation.state);
  if (text(attestation.version) !== "noopolis.deployment.container-quiescence.v1" || (state !== "absent" && state !== "quiescent")) throw new TypeError("offline reconciliation attestation is invalid");
  const parsedLock: Lock = { dev: positive(lock.dev), ino: positive(lock.ino), owner_id: uuid(lock.owner_id), generation: uuid(lock.generation), pid: positive(lock.pid), process_start: nonBlank(lock.process_start), boot_id: nonBlank(lock.boot_id), pid_namespace_dev: positive(lock.pid_namespace_dev), pid_namespace_ino: positive(lock.pid_namespace_ino) };
  return { version: OFFLINE_RECONCILIATION_VERSION, agent_id: nonBlank(root.agent_id), delivery_id: nonBlank(root.delivery_id), store: { dev: positive(store.dev), ino: positive(store.ino) }, lock: parsedLock, attestation: { version: "noopolis.deployment.container-quiescence.v1", authority_id: nonBlank(attestation.authority_id), attestation_id: nonBlank(attestation.attestation_id), state, proof: nonBlank(attestation.proof) } };
}

export class OfflineTransitionReconciliationBlockedError extends Error { readonly code = OFFLINE_RECONCILIATION_BLOCKED_CODE; constructor() { super("offline transition reconciliation is blocked"); } }
/** Normal hosts may start only after the durable offline lease is absent. */
export async function assertOfflineReconciliationLeaseAvailable(root: string): Promise<void> { if (await readLeaseOptional(path.join(root, ".offline-reconciliation.lock")) !== undefined) throw new OfflineTransitionReconciliationBlockedError(); }

async function openStore(root: string, expected: Identity): Promise<{ path: string; directory: Awaited<ReturnType<typeof open>> }> {
  if (!path.isAbsolute(root)) throw new OfflineTransitionReconciliationBlockedError();
  await assertNoLinks(root);
  const before = await lstat(root);
  if (!before.isDirectory() || before.isSymbolicLink() || before.uid !== process.getuid?.() || (before.mode & 0o777) !== 0o700 || !same(before, expected)) throw new OfflineTransitionReconciliationBlockedError();
  const directory = await open(root, constants.O_RDONLY | directoryFlag() | noFollow());
  try {
    const canonical = await realpath(root);
    if (!same(await directory.stat(), expected)) throw new OfflineTransitionReconciliationBlockedError();
    return { path: canonical, directory };
  } catch (error) { await directory.close().catch(() => undefined); throw error; }
}
async function assertStore(root: { path: string; directory: Awaited<ReturnType<typeof open>> }, expected: Identity): Promise<void> { await assertNoLinks(root.path); if (!same(await lstat(root.path), expected) || !same(await root.directory.stat(), expected) || await realpath(root.path) !== root.path) throw new OfflineTransitionReconciliationBlockedError(); }
/**
 * Publishes `value` at `target` only if `target` does not already exist, and
 * only ever under complete, fsynced content — the name never appears holding a
 * partial or zero-byte document, which `readLease` would otherwise accept as a
 * safe file and then fail to `JSON.parse`.
 *
 * `link(2)` is mandatory here and `rename(2)` is FORBIDDEN. rename overwrites
 * its destination unconditionally, so two acquirers that both pass the
 * (non-atomic) `readLeaseOptional` pre-check would both publish and both
 * believe they hold the exclusive offline-reconciliation lease. link fails with
 * EEXIST when the target exists, which is the mutual exclusion `acquireLease`
 * converts into a blocked result. Exported solely so that contract can be
 * asserted directly; it is not re-exported from `./index.ts`.
 */
export async function publishExclusive(target: string, value: unknown, directory: Awaited<ReturnType<typeof open>>): Promise<void> { const temp = `${target}.${randomUUID()}`; try { await writeNew(temp, value); await link(temp, target); await directory.sync(); } finally { await unlink(temp).catch(() => undefined); } }
async function acquireLease(root: string, directory: Awaited<ReturnType<typeof open>>, owner: Lease, liveness: (lease: Lease) => Promise<boolean>): Promise<Lease | undefined> { const target = path.join(root, ".offline-reconciliation.lock"); const current = await readLeaseOptional(target); if (current !== undefined) { if (!sameNamespace(current, owner) || await liveness(current)) return undefined; await unlink(target); await directory.sync(); } try { await publishExclusive(target, owner, directory); return owner; } catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined; throw error; } }
async function releaseLease(lease: Lease, directory: Awaited<ReturnType<typeof open>>, root: string): Promise<void> { const target = path.join(root, ".offline-reconciliation.lock"); const current = await readLease(target); if (!sameLease(current, lease)) throw new OfflineTransitionReconciliationBlockedError(); await unlink(target); await directory.sync(); }
function lockPath(root: string, agent: string, delivery: string): string { return path.join(root, `${createHash("sha256").update(`${agent}\u0000${delivery}`).digest("hex")}.transition-lock`); }
function recordPath(root: string, agent: string, delivery: string): string { return path.join(root, `${createHash("sha256").update(`${agent}\u0000${delivery}`).digest("hex")}.json`); }
function receiptFile(root: string, request: OfflineTransitionReconciliationRequest): string { return path.join(root, `.reconcile-${createHash("sha256").update(JSON.stringify({ store: request.store, lock: request.lock })).digest("hex")}.json`); }
function digest(request: unknown): string { return createHash("sha256").update(JSON.stringify(request)).digest("hex"); }
function authorizationContext(request: OfflineTransitionReconciliationRequest, stale_host_registrations: readonly StoreHostRegistrationIdentity[]): OfflineTransitionReconciliationAuthorizationContext { return { version: "noopolis.daimon.offline-transition-authorization-context.v1", deployment_identity: request.attestation.authority_id, deployment_state: request.attestation.state, nonce: request.attestation.attestation_id, request_digest: digest({ request, stale_host_registrations }), agent_id: request.agent_id, delivery_id: request.delivery_id, store: request.store, lock: request.lock, stale_host_registrations }; }
function sameProofReceipt(value: unknown, context: OfflineTransitionReconciliationAuthorizationContext): value is OfflineTransitionReconciliationProofReceipt { try { const proof = strictRecord(value, ["request_digest", "nonce", "exclusive_store", "authorized_registration_digests"]); return text(proof.request_digest) === context.request_digest && text(proof.nonce) === context.nonce && proof.exclusive_store === true && Array.isArray(proof.authorized_registration_digests) && proof.authorized_registration_digests.every((item) => /^[a-f0-9]{64}$/u.test(text(item))) && proof.authorized_registration_digests.every((item) => context.stale_host_registrations.some((host) => hostRegistrationDigest(host) === item)); } catch { return false; } }
async function readLock(file: string): Promise<Lock> { const entry = await lstat(file); if (!safeFile(entry)) throw new OfflineTransitionReconciliationBlockedError(); const value = strictRecord(JSON.parse((await readFile(file)).toString("utf8")), ["owner_id", "generation", "pid", "process_start", "boot_id", "pid_namespace_dev", "pid_namespace_ino"]); return { dev: Number(entry.dev), ino: Number(entry.ino), owner_id: uuid(value.owner_id), generation: uuid(value.generation), pid: positive(value.pid), process_start: nonBlank(value.process_start), boot_id: nonBlank(value.boot_id), pid_namespace_dev: positive(value.pid_namespace_dev), pid_namespace_ino: positive(value.pid_namespace_ino) }; }
async function readLease(file: string): Promise<Lease> { const entry = await lstat(file); if (!safeFile(entry)) throw new OfflineTransitionReconciliationBlockedError(); const value = strictRecord(JSON.parse((await readFile(file)).toString("utf8")), ["owner_id", "pid", "process_start", "boot_id", "pid_namespace_dev", "pid_namespace_ino"]); return { owner_id: uuid(value.owner_id), pid: positive(value.pid), process_start: nonBlank(value.process_start), boot_id: nonBlank(value.boot_id), pid_namespace_dev: positive(value.pid_namespace_dev), pid_namespace_ino: positive(value.pid_namespace_ino) }; }
async function readLeaseOptional(file: string): Promise<Lease | undefined> { try { return await readLease(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; } }
async function readLockOptional(file: string): Promise<Lock | undefined> { try { return await readLock(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; } }
async function assertRecord(file: string, request: OfflineTransitionReconciliationRequest): Promise<void> { const entry = await lstat(file).catch(() => { throw new OfflineTransitionReconciliationBlockedError(); }); if (!safeFile(entry)) throw new OfflineTransitionReconciliationBlockedError(); const value: unknown = JSON.parse((await readFile(file)).toString("utf8")); if (value === null || typeof value !== "object" || Array.isArray(value)) throw new OfflineTransitionReconciliationBlockedError(); const record = value as Record<string, unknown>; if (record.agent_id !== request.agent_id || record.delivery_id !== request.delivery_id) throw new OfflineTransitionReconciliationBlockedError(); }
type StoredReceipt = OfflineTransitionReconciliationReceipt | Readonly<{ version: typeof RECEIPT_VERSION; reconciliation_id: string; request_digest: string; state: "prepared"; reconciled_at: ""; cleared_registration_digests: readonly string[] }>;
async function readReceiptOptional(file: string): Promise<StoredReceipt | undefined> { try { const entry = await lstat(file); if (!safeFile(entry)) throw new OfflineTransitionReconciliationBlockedError(); const value = strictRecord(JSON.parse((await readFile(file)).toString("utf8")), ["version", "reconciliation_id", "request_digest", "state", "reconciled_at", "cleared_registration_digests"]); const state = text(value.state); const cleared_registration_digests = digests(value.cleared_registration_digests); if (text(value.version) !== RECEIPT_VERSION || (state !== "prepared" && state !== "reconciled") || !/^[a-f0-9]{64}$/u.test(text(value.request_digest))) throw new OfflineTransitionReconciliationBlockedError(); const receipt = { version: RECEIPT_VERSION, reconciliation_id: uuid(value.reconciliation_id), request_digest: text(value.request_digest), state, reconciled_at: text(value.reconciled_at), cleared_registration_digests }; if (state === "prepared" && receipt.reconciled_at) throw new OfflineTransitionReconciliationBlockedError(); if (state === "reconciled" && !receipt.reconciled_at) throw new OfflineTransitionReconciliationBlockedError(); return receipt as StoredReceipt; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; } }
async function writeReceipt(target: string, receipt: StoredReceipt, directory: Awaited<ReturnType<typeof open>>): Promise<StoredReceipt> { const temp = `${target}.${randomUUID()}`; try { await writeNew(temp, receipt); await link(temp, target); await directory.sync(); return receipt; } catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new OfflineTransitionReconciliationBlockedError(); throw error; } finally { await unlink(temp).catch(() => undefined); } }
async function replaceReceipt(target: string, receipt: OfflineTransitionReconciliationReceipt, directory: Awaited<ReturnType<typeof open>>): Promise<void> { const temp = `${target}.${randomUUID()}`; try { await writeNew(temp, receipt); await rename(temp, target); await directory.sync(); } finally { await unlink(temp).catch(() => undefined); } }
async function writeNew(file: string, value: unknown): Promise<void> { const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow(), 0o600); try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); } }
function publicReceipt(receipt: OfflineTransitionReconciliationReceipt): OfflineTransitionReconciliationReceipt { return receipt; }
function blocked(): OfflineTransitionReconciliationResult { return { version: OFFLINE_RECONCILIATION_VERSION, state: "blocked", code: OFFLINE_RECONCILIATION_BLOCKED_CODE }; }
function strictRecord(value: unknown, keys: readonly string[]): Record<string, unknown> { if (value === null || typeof value !== "object" || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new TypeError("offline reconciliation request is invalid"); const result: Record<string, unknown> = Object.create(null); for (const key of Reflect.ownKeys(value)) { if (typeof key !== "string") throw new TypeError("offline reconciliation request is invalid"); const descriptor = Object.getOwnPropertyDescriptor(value, key); if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) throw new TypeError("offline reconciliation request is invalid"); result[key] = descriptor.value; } if (Object.keys(result).length !== keys.length || keys.some((key) => !Object.hasOwn(result, key))) throw new TypeError("offline reconciliation request is invalid"); return result; }
function text(value: unknown): string { if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_BYTES) throw new TypeError("offline reconciliation request is invalid"); return value; }
function nonBlank(value: unknown): string { const result = text(value); if (!result.trim()) throw new TypeError("offline reconciliation request is invalid"); return result; }
function uuid(value: unknown): string { const result = nonBlank(value); if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(result)) throw new TypeError("offline reconciliation request is invalid"); return result; }
function positive(value: unknown): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new TypeError("offline reconciliation request is invalid"); return value; }
function digests(value: unknown): readonly string[] { if (!Array.isArray(value) || value.length > 128 || value.some((item) => !/^[a-f0-9]{64}$/u.test(text(item)))) throw new OfflineTransitionReconciliationBlockedError(); return uniqueDigests(value); }
function uniqueDigests(values: readonly string[]): readonly string[] { return [...new Set(values)].sort(); }
function same(left: Pick<Identity, "dev" | "ino">, right: Pick<Identity, "dev" | "ino">): boolean { return Number(left.dev) === right.dev && Number(left.ino) === right.ino; }
function sameNamespace(left: Pick<Lease, "pid_namespace_dev" | "pid_namespace_ino">, right: Pick<Lease, "pid_namespace_dev" | "pid_namespace_ino">): boolean { return left.pid_namespace_dev === right.pid_namespace_dev && left.pid_namespace_ino === right.pid_namespace_ino; }
function sameLease(left: Lease, right: Lease): boolean { return left.owner_id === right.owner_id && left.pid === right.pid && left.process_start === right.process_start && left.boot_id === right.boot_id && sameNamespace(left, right); }
function safeFile(entry: Awaited<ReturnType<typeof lstat>>): boolean { return entry.isFile() && !entry.isSymbolicLink() && Number(entry.uid) === process.getuid?.() && (Number(entry.mode) & 0o777) === 0o600 && Number(entry.size) <= MAX_BYTES; }
function noFollow(): number { return (constants as typeof constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0; }
function directoryFlag(): number { return (constants as typeof constants & { O_DIRECTORY?: number }).O_DIRECTORY ?? 0; }
async function assertNoLinks(target: string): Promise<void> { let current = path.parse(target).root; for (const part of path.relative(current, target).split(path.sep).filter(Boolean)) { current = path.join(current, part); if ((await lstat(current)).isSymbolicLink() && current !== "/var") throw new OfflineTransitionReconciliationBlockedError(); } }
async function currentLeaseIdentity(): Promise<Lease> { if (process.platform !== "linux") throw new OfflineTransitionReconciliationBlockedError(); const boot_id = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(); const namespace = await stat("/proc/self/ns/pid"); const process_start = await linuxProcessStart(process.pid); if (!boot_id || !Number.isSafeInteger(Number(namespace.dev)) || !Number.isSafeInteger(Number(namespace.ino))) throw new OfflineTransitionReconciliationBlockedError(); return { owner_id: randomUUID(), pid: process.pid, process_start, boot_id, pid_namespace_dev: Number(namespace.dev), pid_namespace_ino: Number(namespace.ino) }; }
async function leaseIsAlive(lease: Lease): Promise<boolean> { if (process.platform !== "linux") throw new OfflineTransitionReconciliationBlockedError(); const namespace = await stat("/proc/self/ns/pid"); if (!sameNamespace(lease, { pid_namespace_dev: Number(namespace.dev), pid_namespace_ino: Number(namespace.ino) })) throw new OfflineTransitionReconciliationBlockedError(); const boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(); if (!boot) throw new OfflineTransitionReconciliationBlockedError(); if (boot !== lease.boot_id) return false; try { return await linuxProcessStart(lease.pid) === lease.process_start; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw new OfflineTransitionReconciliationBlockedError(); } }
async function linuxProcessStart(pid: number): Promise<string> { const statText = await readFile(`/proc/${pid}/stat`, "utf8"); const close = statText.lastIndexOf(")"); const start = statText.slice(close + 2).trim().split(/\s+/u)[19]; if (close < 0 || start === undefined || !/^\d+$/u.test(start)) throw new OfflineTransitionReconciliationBlockedError(); return start; }

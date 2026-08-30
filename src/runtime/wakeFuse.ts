import { constants } from "node:fs";
import { open, readFile, readdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

import { TURN_USAGE_LEDGER, TURN_USAGE_MAX_IDENTIFIER_CHARS, TURN_USAGE_ROTATE_BYTES } from "./turnUsageLedger.js";

export const WAKE_FUSE_VERSION = "noopolis.daimon.wake-fuse.v1" as const;
export const WAKE_FUSE_DIRECTORY_ENV = "DAIMON_WAKE_FUSE_DIRECTORY" as const;
export const DEFAULT_WAKE_FUSE_MAX_WAKES = 100;
export const DEFAULT_WAKE_FUSE_MAX_TOKENS = 5_000_000;

export type WakeFuseTripReason = "wake_ceiling" | "token_ceiling" | "operator_stop" | "ledger_unavailable";
export type WakeFuseVerdict = Readonly<{ state: "admitted" }> | Readonly<{ state: "tripped"; reason: WakeFuseTripReason }>;
export type WakeFuseOptions = Readonly<{
  organizationKey: string;
  environment?: NodeJS.ProcessEnv;
  now?: () => Date;
}>;

type Admission = Readonly<{ v: typeof WAKE_FUSE_VERSION; kind: "admission"; epoch: string; at: string; agent: string; delivery: string }>;
type EpochStart = Readonly<{ v: typeof WAKE_FUSE_VERSION; kind: "epoch_start"; epoch: string; at: string }>;

/**
 * Durable catastrophic-wake admission fuse for one organization/container.
 *
 * Operator trip: `docker exec <container> touch /var/lib/spawnfile/daimon/usage/fuse.stop`.
 * Unlike `recordTurnUsage` ("advisory: never rejects"), every storage or
 * evaluation failure here rejects admission: this safety boundary fails closed.
 */
export class WakeFuse {
  private serial: Promise<void> = Promise.resolve();
  private reason: WakeFuseTripReason | undefined;

  private constructor(
    private readonly armed: boolean,
    private readonly directory: string,
    private readonly epoch: string,
    private readonly epochStartedAt: string,
    private readonly maxWakes: number,
    private readonly maxTokens: number,
    private readonly admissions: Set<string>,
    private readonly now: () => Date
  ) {}

  static async open(options: WakeFuseOptions): Promise<WakeFuse> {
    const environment = options.environment ?? process.env;
    const setting = environment.DAIMON_WAKE_FUSE;
    if (setting !== undefined && setting !== "off") throw new Error("DAIMON_WAKE_FUSE must be exactly 'off' when set");
    if (environment.DAIMON_WAKE_FUSE_EPOCH !== undefined && nonBlank(environment.DAIMON_WAKE_FUSE_EPOCH) === undefined) throw new Error("DAIMON_WAKE_FUSE_EPOCH must be non-blank");
    const epoch = nonBlank(environment.DAIMON_WAKE_FUSE_EPOCH)
      // Agent ids are the stable organization identity available to Daimon.
      ?? `organization-${createHash("sha256").update(options.organizationKey).digest("hex")}`;
    const maxWakes = ceiling(environment.DAIMON_WAKE_FUSE_MAX_WAKES, DEFAULT_WAKE_FUSE_MAX_WAKES, "DAIMON_WAKE_FUSE_MAX_WAKES");
    const maxTokens = ceiling(environment.DAIMON_WAKE_FUSE_MAX_TOKENS, DEFAULT_WAKE_FUSE_MAX_TOKENS, "DAIMON_WAKE_FUSE_MAX_TOKENS");
    const directory = resolveWakeFuseDirectory(environment);
    const now = options.now ?? (() => new Date());
    if (setting === "off") return new WakeFuse(false, directory, epoch, now().toISOString(), maxWakes, maxTokens, new Set(), now);

    // Unbounded defaults would reproduce exactly the failure this module prevents.
    await readdir(directory);
    const records = await readFuseRecords(directory);
    const existingStart = records.filter((record): record is EpochStart => record.kind === "epoch_start" && record.epoch === epoch).at(-1);
    const epochStartedAt = existingStart?.at ?? now().toISOString();
    if (existingStart === undefined) await append(directory, { v: WAKE_FUSE_VERSION, kind: "epoch_start", epoch, at: epochStartedAt });
    const admissions = new Set(records
      .filter((record): record is Admission => record.kind === "admission" && record.epoch === epoch)
      .map((record) => key(record.agent, record.delivery)));
    const fuse = new WakeFuse(true, directory, epoch, epochStartedAt, maxWakes, maxTokens, admissions, now);
    if (await exists(path.join(directory, "fuse.stop"))) fuse.reason = "operator_stop";
    return fuse;
  }

  admit(agentId: string, deliveryId: string): Promise<WakeFuseVerdict> {
    if (!this.armed) return Promise.resolve({ state: "admitted" });
    // One organization is one container/control-host process. This promise
    // chain is organization-wide in-process serialization, not cross-process locking.
    const result = this.serial.catch(() => undefined).then(async () => await this.admitNow(agentId, deliveryId));
    this.serial = result.then(() => undefined, () => undefined);
    return result;
  }

  async pollOperatorStop(): Promise<WakeFuseTripReason | undefined> {
    if (!this.armed || this.reason !== undefined) return this.reason;
    try {
      if (await exists(path.join(this.directory, "fuse.stop"))) this.reason = "operator_stop";
    } catch { this.reason = "ledger_unavailable"; }
    return this.reason;
  }

  tripped(): WakeFuseTripReason | undefined { return this.reason; }
  async close(): Promise<void> { await this.serial; }

  private async admitNow(agentId: string, deliveryId: string): Promise<WakeFuseVerdict> {
    if (this.reason !== undefined) return { state: "tripped", reason: this.reason };
    try {
      if (await exists(path.join(this.directory, "fuse.stop"))) return this.trip("operator_stop");
      const admissionKey = key(bounded(agentId), bounded(deliveryId));
      if (this.admissions.has(admissionKey)) return { state: "admitted" };
      if (this.admissions.size >= this.maxWakes) return this.trip("wake_ceiling");
      // Lagging indicator: usage is written after turn completion, so in-flight
      // spend can overshoot by one concurrent round. The wake ceiling bounds it;
      // design §5.2 owns the later pre-spawn reservation.
      if (await sumTokens(this.directory, this.epochStartedAt) >= this.maxTokens) return this.trip("token_ceiling");
      const record: Admission = { v: WAKE_FUSE_VERSION, kind: "admission", epoch: this.epoch, at: this.now().toISOString(), agent: bounded(agentId), delivery: bounded(deliveryId) };
      await append(this.directory, record);
      this.admissions.add(admissionKey);
      return { state: "admitted" };
    } catch { return this.trip("ledger_unavailable"); }
  }

  private trip(reason: WakeFuseTripReason): WakeFuseVerdict {
    this.reason ??= reason;
    return { state: "tripped", reason: this.reason };
  }
}

export function resolveWakeFuseDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  const override = environment[WAKE_FUSE_DIRECTORY_ENV]?.trim();
  return override !== undefined && override.startsWith("/") ? override : TURN_USAGE_LEDGER.directoryPath;
}

function ceiling(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}
function nonBlank(value: string | undefined): string | undefined { const trimmed = value?.trim(); return trimmed ? trimmed : undefined; }
function bounded(value: string): string { return [...value].slice(0, TURN_USAGE_MAX_IDENTIFIER_CHARS).join(""); }
function key(agent: string, delivery: string): string { return `${agent}\u0000${delivery}`; }
function admissionsPath(directory: string): string { return path.join(directory, "admissions.jsonl"); }

async function append(directory: string, record: Admission | EpochStart): Promise<void> {
  const file = admissionsPath(directory);
  try { if ((await stat(file)).size >= TURN_USAGE_ROTATE_BYTES) await rename(file, `${file}.1`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
  const handle = await open(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, TURN_USAGE_LEDGER.fileMode);
  try { const result = await handle.write(bytes, 0, bytes.length); if (result.bytesWritten !== bytes.length) throw new Error("wake fuse admission append was torn"); }
  finally { await handle.close(); }
}

async function readFuseRecords(directory: string): Promise<Array<Admission | EpochStart>> {
  const records: Array<Admission | EpochStart> = [];
  for (const file of [`${admissionsPath(directory)}.1`, admissionsPath(directory)]) {
    for (const line of await lines(file)) {
      try {
        const value = JSON.parse(line) as Partial<Admission | EpochStart>;
        if (value.v !== WAKE_FUSE_VERSION || typeof value.epoch !== "string" || typeof value.at !== "string" || Number.isNaN(Date.parse(value.at))) continue;
        if (value.kind === "epoch_start") records.push(value as EpochStart);
        else if (value.kind === "admission" && typeof value.agent === "string" && typeof value.delivery === "string") records.push(value as Admission);
      } catch { /* malformed historical fuse lines do not count */ }
    }
  }
  return records;
}

async function sumTokens(directory: string, since: string): Promise<number> {
  let total = 0;
  for (const file of [path.join(directory, "usage.jsonl.1"), path.join(directory, "usage.jsonl")]) {
    for (const line of await lines(file)) {
      try {
        const value = JSON.parse(line) as { at?: unknown; total?: unknown };
        if (typeof value.at === "string" && !Number.isNaN(Date.parse(value.at)) && value.at >= since && typeof value.total === "number" && Number.isFinite(value.total) && value.total >= 0) total += value.total;
      } catch { /* usage accounting is advisory input; malformed lines are skipped */ }
    }
  }
  return total;
}
async function lines(file: string): Promise<string[]> { try { return (await readFile(file, "utf8")).split("\n").filter(Boolean); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; } }
async function exists(file: string): Promise<boolean> { try { await stat(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } }

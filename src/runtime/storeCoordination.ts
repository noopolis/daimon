import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, readdir, unlink } from "node:fs/promises";
import path from "node:path";

export type StoreProcessIdentity = Readonly<{ pid: number; process_start: string; boot_id: string; pid_namespace_dev: number; pid_namespace_ino: number }>;
export type StoreHostRegistration = StoreProcessIdentity & Readonly<{ owner_id: string }>;
export type StoreHostRegistrationIdentity = StoreHostRegistration & Readonly<{ dev: number; ino: number }>;

export async function acquireHostRegistration(root: string, directory: Awaited<ReturnType<typeof open>>, identity: StoreProcessIdentity): Promise<StoreHostRegistration> {
  const registration: StoreHostRegistration = { owner_id: randomUUID(), ...identity };
  const target = path.join(root, `.host-online-${registration.owner_id}.json`);
  await writeNew(target, registration);
  await directory.sync();
  if (await exists(path.join(root, ".offline-reconciliation.lock"))) {
    await unlink(target);
    await directory.sync();
    throw new Error("wake acceptance store is reserved for offline reconciliation");
  }
  return registration;
}

export async function releaseHostRegistration(root: string, directory: Awaited<ReturnType<typeof open>>, registration: StoreHostRegistration): Promise<void> {
  const target = path.join(root, `.host-online-${registration.owner_id}.json`);
  const current = await readRegistration(target);
  if (!sameOwner(current, registration)) throw new Error("wake acceptance host registration changed");
  await unlink(target);
  await directory.sync();
}

/** Admin callers hold their durable offline lease before calling this. */
export async function listHostRegistrations(root: string): Promise<readonly StoreHostRegistrationIdentity[]> { const result: StoreHostRegistrationIdentity[] = []; for (const entry of await readdir(root)) { if (/^\.host-online-[0-9a-f-]{36}\.json$/iu.test(entry)) result.push(await readRegistration(path.join(root, entry))); } return result; }
/** Returns undefined when any registration is live, unknown, or changed. */
export async function clearDeadHostRegistrations(root: string, directory: Awaited<ReturnType<typeof open>>, identity: StoreProcessIdentity, liveness: (owner: StoreHostRegistration) => Promise<boolean>, authorizedCrossNamespace: ReadonlySet<string>): Promise<readonly string[] | undefined> {
  const cleared: string[] = [];
  for (const entry of await readdir(root)) {
    if (!/^\.host-online-[0-9a-f-]{36}\.json$/iu.test(entry)) continue;
    const target = path.join(root, entry);
    const owner = await readRegistration(target);
    const digest = hostRegistrationDigest(owner);
    if (!sameNamespace(owner, identity) && !authorizedCrossNamespace.has(digest)) return undefined;
    if (sameNamespace(owner, identity) && await liveness(owner)) return undefined;
    const checked = await readRegistration(target);
    if (!sameIdentity(checked, owner)) return undefined;
    await unlink(target);
    await directory.sync();
    cleared.push(digest);
  }
  return cleared;
}

async function readRegistration(target: string): Promise<StoreHostRegistrationIdentity> {
  const entry = await lstat(target);
  if (!entry.isFile() || entry.isSymbolicLink() || Number(entry.uid) !== process.getuid?.() || (Number(entry.mode) & 0o777) !== 0o600 || Number(entry.size) > 1024) throw new Error("wake acceptance host registration is unsafe");
  const value: unknown = JSON.parse((await readFile(target)).toString("utf8"));
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("wake acceptance host registration is invalid");
  const record = value as Record<string, unknown>;
  const keys = ["owner_id", "pid", "process_start", "boot_id", "pid_namespace_dev", "pid_namespace_ino"];
  if (Object.keys(record).length !== keys.length || keys.some((key) => !Object.hasOwn(record, key))) throw new Error("wake acceptance host registration is invalid");
  const result: StoreHostRegistrationIdentity = { dev: Number(entry.dev), ino: Number(entry.ino), owner_id: uuid(record.owner_id), pid: positive(record.pid), process_start: text(record.process_start), boot_id: text(record.boot_id), pid_namespace_dev: positive(record.pid_namespace_dev), pid_namespace_ino: positive(record.pid_namespace_ino) };
  if (!result.process_start || !result.boot_id) throw new Error("wake acceptance host registration is invalid");
  return result;
}
async function writeNew(target: string, value: unknown): Promise<void> { const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow(), 0o600); try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); } }
async function exists(target: string): Promise<boolean> { try { await lstat(target); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } }
function sameOwner(left: StoreHostRegistration, right: StoreHostRegistration): boolean { return left.owner_id === right.owner_id && left.pid === right.pid && left.process_start === right.process_start && left.boot_id === right.boot_id && sameNamespace(left, right); }
function sameIdentity(left: StoreHostRegistrationIdentity, right: StoreHostRegistrationIdentity): boolean { return left.dev === right.dev && left.ino === right.ino && sameOwner(left, right); }
export function hostRegistrationDigest(value: StoreHostRegistrationIdentity): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function sameNamespace(left: Pick<StoreProcessIdentity, "pid_namespace_dev" | "pid_namespace_ino">, right: Pick<StoreProcessIdentity, "pid_namespace_dev" | "pid_namespace_ino">): boolean { return left.pid_namespace_dev === right.pid_namespace_dev && left.pid_namespace_ino === right.pid_namespace_ino; }
function text(value: unknown): string { if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 1024) throw new Error("wake acceptance host registration is invalid"); return value; }
function uuid(value: unknown): string { const result = text(value); if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(result)) throw new Error("wake acceptance host registration is invalid"); return result; }
function positive(value: unknown): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error("wake acceptance host registration is invalid"); return value; }
function noFollow(): number { return (constants as typeof constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0; }

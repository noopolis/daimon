import { readFile, stat } from "node:fs/promises";
export type TransitionLock = Readonly<{ owner_id: string; generation: string; pid: number; process_start: string; boot_id: string; pid_namespace_dev: number; pid_namespace_ino: number }>;
export class WakeTransitionLockBlockedError extends Error { readonly code = "offline_reconciliation_required" as const; constructor() { super("wake transition lock requires offline reconciliation"); } }
export function sameNamespace(left: Pick<TransitionLock, "pid_namespace_dev" | "pid_namespace_ino">, right: Pick<TransitionLock, "pid_namespace_dev" | "pid_namespace_ino">): boolean { return left.pid_namespace_dev === right.pid_namespace_dev && left.pid_namespace_ino === right.pid_namespace_ino; }
export async function currentProcessIdentity(): Promise<Omit<TransitionLock, "owner_id" | "generation">> {
  if (process.platform !== "linux") throw new Error("wake transition locks require Linux process identity");
  const boot_id = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  if (!boot_id) throw new Error("wake transition owner identity is invalid");
  return { pid: process.pid, process_start: await linuxProcessStart(process.pid), boot_id, ...await linuxPidNamespace() };
}
export async function processIsAlive(lock: TransitionLock): Promise<boolean> {
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

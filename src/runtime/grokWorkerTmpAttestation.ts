import type { Stats } from "node:fs";
import { lstat } from "node:fs/promises";
import path from "node:path";

import { GROK_ENGINE_BROKER } from "../contracts/runtimeContractManifest.js";

type Entry = Pick<Stats, "uid" | "gid" | "mode"> & Readonly<{ isDirectory(): boolean }>;
const HOME = GROK_ENGINE_BROKER.worker.home;
const FIRST_WORKER_UID = GROK_ENGINE_BROKER.identities.firstWorkerUid;

export type GrokWorkerTmpWorker = Readonly<{ home: string; uid: number }>;
/** Test seams only; production uses the manifest defaults. */
export type GrokWorkerTmpOptions = Readonly<{ sharedRoots?: readonly string[]; sharedOwnerUid?: number; firstWorkerUid?: number }>;

/**
 * Temp-directory isolation, checked before every turn for *every* registered
 * worker, not only the one about to run: a misprovisioned sibling temp
 * directory (group- or world-writable) would be a place this worker could
 * write into and that sibling would read from.
 *
 * Grok 1.0.34's strict profile grants shared `/tmp` and `/var/tmp`
 * read-write, and it refuses to start when either (or any ancestor of a
 * granted path) is in `deny` — verified live: `deny = ["/tmp"]`,
 * `["/var/tmp"]`, `["/run"]`, `["/etc"]` all fail with "could not apply the
 * sandbox profile", while `["/tmp/sub"]` works. So the kernel profile cannot
 * keep evaluator temp files away from the worker. Unix modes can, because the
 * launcher drops the worker to its own uid/gid with no supplementary groups:
 *
 * - shared temp roots are root-owned, owned by a group below the worker range,
 *   and give "other" at most read (Grok opens the directory; without search
 *   the worker can list names but cannot open, stat, or create anything); a
 *   deployment that lets workers traverse or write them is refused;
 * - the worker's own `<home>/tmp` (the launcher's compiled `TMPDIR`, which
 *   strict grants read-write) is a real directory owned by the worker with no
 *   group or other access, and every registered worker's is checked.
 *
 *
 * Entries come from `lstat`, so a symlink is never a directory here: a
 * symlinked temp root or private temp is refused by the directory check.
 *
 * Pure so every refusal is testable without root.
 */
export function assertGrokWorkerTmpEntries(entries: Readonly<{ privateTmps: readonly Readonly<{ uid: number; entry: Entry | undefined }>[]; shared: readonly (Entry | undefined)[] }>, options: GrokWorkerTmpOptions = {}): void {
  const shared = HOME.sharedTmp;
  const firstWorkerUid = options.firstWorkerUid ?? FIRST_WORKER_UID;
  if (entries.shared.length === 0 || entries.privateTmps.length === 0) throw unavailable();
  for (const entry of entries.shared) {
    if (entry === undefined || !entry.isDirectory() || entry.uid !== (options.sharedOwnerUid ?? shared.uid) || entry.gid >= shared.maxGroupExclusive || (Number(entry.mode) & 0o007 & ~shared.otherMode) !== 0) throw unavailable();
  }
  for (const { uid, entry } of entries.privateTmps) {
    if (!Number.isSafeInteger(uid) || uid < firstWorkerUid || entry === undefined || !entry.isDirectory() || entry.uid !== uid || (Number(entry.mode) & 0o077) !== 0) throw unavailable();
  }
}

/** `workers` must list every registered worker (the running one included). */
export async function verifyGrokWorkerTmp(workers: readonly GrokWorkerTmpWorker[], options: GrokWorkerTmpOptions = {}): Promise<void> {
  const inspect = async (file: string): Promise<Entry | undefined> => { try { return await lstat(file); } catch { return undefined; } };
  assertGrokWorkerTmpEntries({
    privateTmps: await Promise.all(workers.map(async (worker) => ({ uid: worker.uid, entry: await inspect(path.join(worker.home, HOME.privateTmp.relativeToWorkerHome)) }))),
    shared: await Promise.all((options.sharedRoots ?? HOME.sharedTmp.paths).map(inspect))
  }, options);
}

/** A registration's worker home is the parent of its `<home>/.grok/sandbox.toml`. */
export const grokWorkerHomeForProfile = (profilePath: string): string | undefined =>
  path.basename(path.dirname(profilePath)) === ".grok" ? path.dirname(path.dirname(profilePath)) : undefined;

const unavailable = (): Error => new Error("Grok worker temp isolation attestation unavailable");

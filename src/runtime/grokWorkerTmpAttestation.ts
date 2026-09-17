import type { Stats } from "node:fs";
import { lstat } from "node:fs/promises";
import path from "node:path";

import { GROK_ENGINE_BROKER } from "../contracts/runtimeContractManifest.js";

type Entry = Pick<Stats, "uid" | "gid" | "mode"> & Readonly<{ isDirectory(): boolean; isSymbolicLink(): boolean }>;
const HOME = GROK_ENGINE_BROKER.worker.home;

/**
 * Temp-directory isolation for one worker, checked before every turn.
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
 *   group or other access.
 *
 * Pure so every refusal is testable without root.
 */
export function assertGrokWorkerTmpEntries(entries: Readonly<{ privateTmp: Entry | undefined; shared: readonly (Entry | undefined)[] }>, workerUid: number): void {
  const shared = HOME.sharedTmp;
  for (const entry of entries.shared) {
    if (entry === undefined || !entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== shared.uid || entry.gid >= shared.maxGroupExclusive || (Number(entry.mode) & 0o007 & ~shared.otherMode) !== 0) throw unavailable();
  }
  const own = entries.privateTmp;
  if (own === undefined || !own.isDirectory() || own.isSymbolicLink() || own.uid !== workerUid || (Number(own.mode) & 0o077) !== 0) throw unavailable();
}

export async function verifyGrokWorkerTmp(workerHome: string, workerUid: number, sharedRoots: readonly string[] = HOME.sharedTmp.paths): Promise<void> {
  const inspect = async (file: string): Promise<Entry | undefined> => { try { return await lstat(file); } catch { return undefined; } };
  assertGrokWorkerTmpEntries({
    privateTmp: await inspect(path.join(workerHome, HOME.privateTmp.relativeToWorkerHome)),
    shared: await Promise.all(sharedRoots.map(inspect))
  }, workerUid);
}

const unavailable = (): Error => new Error("Grok worker temp isolation attestation unavailable");

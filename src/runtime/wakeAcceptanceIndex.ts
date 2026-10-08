import path from "node:path";

import { MAX_WAKE_ACCEPTANCE_RECORDS } from "./wakeAcceptanceRetention.js";

/**
 * A stamp younger than this may share a coarse filesystem timestamp tick with
 * a write that lands after it was taken, so it is never trusted to prove that
 * nothing changed (the racy-timestamp rule).
 */
const RACY_WINDOW_NS = 2_000_000_000n;
/**
 * Own writes bind without a sync, so another process compacting behind a host
 * that only ever hits could leave bindings for files that are gone. Past this
 * many the index is dropped and the next miss rebuilds it from the directory.
 */
const MAX_INDEX_ENTRIES = MAX_WAKE_ACCEPTANCE_RECORDS * 2;
export type WakeAcceptanceStat = Readonly<{ ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }>;
type Entry = { id: string; stamp?: string };
export type WakeAcceptanceIndexSource = Readonly<{
  /** Opened-handle stat of the store directory. */
  directoryStat: () => Promise<WakeAcceptanceStat>;
  /** Record file names, after the store's own root validation and bounds. */
  files: () => Promise<readonly string[]>;
  /** Acceptance id of one record, read through every safety check of the store. */
  readId: (file: string) => Promise<string>;
  /** Identity stamp of one record file; undefined when it is gone. */
  fileStat: (file: string) => Promise<WakeAcceptanceStat | undefined>;
}>;

/**
 * Acceptance-id → record-file index. Own writes keep it current; a directory
 * whose stamp moved since the last sync (another process, or this one) is
 * re-listed, and only record files whose own stamp moved are read again. A miss
 * against an unchanged directory reads no record file.
 */
export class WakeAcceptanceIndex {
  private readonly byId = new Map<string, string>();
  private readonly byFile = new Map<string, Entry>();
  private synced: string | undefined;
  /** Bumped by every binding change made outside a sync; a sync that saw one never vouches for the directory. */
  private mutations = 0;
  private refreshing: Promise<void> | undefined;
  constructor(private readonly root: string, private readonly source: WakeAcceptanceIndexSource, private readonly nowNs: () => bigint = () => BigInt(Date.now()) * 1_000_000n) {}
  /**
   * The record bound to this id, verified to still carry it. Unknown and
   * compacted ids are polled, so a miss against an unchanged directory reads
   * no record file.
   */
  async find<T extends Readonly<{ acceptance_id: string }>>(acceptanceId: string, read: (file: string) => Promise<T | undefined>): Promise<T | undefined> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const known = this.byId.get(acceptanceId);
      if (known !== undefined) {
        const record = await read(known);
        if (record?.acceptance_id === acceptanceId) return record;
        this.unbind(acceptanceId, known);
      }
      if (attempt === 0) await this.refresh();
    }
    return undefined;
  }
  /** Binds a record this process wrote; its file stamp is learned on the next sync. */
  set(acceptanceId: string, file: string): void {
    this.mutations += 1;
    if (this.byFile.size >= MAX_INDEX_ENTRIES) { this.byFile.clear(); this.byId.clear(); this.synced = undefined; }
    this.bind(file, acceptanceId, undefined);
  }
  /** Drops a record file this process deleted. */
  forget(file: string): void { this.mutations += 1; this.drop(file); }
  /** Brings the index level with the directory; a no-op while the directory is unchanged. Single-flight. */
  async refresh(): Promise<void> {
    while (this.refreshing !== undefined) await this.refreshing.catch(() => undefined);
    const run = this.refreshNow();
    this.refreshing = run;
    try { await run; } finally { if (this.refreshing === run) this.refreshing = undefined; }
  }
  private async refreshNow(): Promise<void> {
    const startedAt = this.nowNs();
    const directory = await this.source.directoryStat();
    const directoryStamp = stampOf(directory);
    if (this.synced === directoryStamp) return;
    const mutations = this.mutations;
    const listed = (await this.source.files()).map((name) => path.join(this.root, name));
    // Prune what the directory no longer lists even when a record below fails to
    // read, so the maps stay bounded by the store's own record bound.
    const present = new Set(listed);
    try { await this.scan(listed, present); } finally {
      for (const file of [...this.byFile.keys()]) if (!present.has(file)) this.drop(file);
    }
    // Vouch for the directory only if nothing rebound while listing and its stamp
    // was already settled when it was taken (the racy-timestamp rule).
    this.synced = this.mutations === mutations && !racy(directory, startedAt) ? directoryStamp : undefined;
  }
  private async scan(listed: readonly string[], present: Set<string>): Promise<void> {
    for (const file of listed) {
      const seenAt = this.nowNs();
      const stat = await this.source.fileStat(file);
      if (stat === undefined) { present.delete(file); continue; }
      const stamp = racy(stat, seenAt) ? undefined : stampOf(stat);
      const known = this.byFile.get(file);
      if (known !== undefined && known.stamp !== undefined && known.stamp === stamp) continue;
      let id: string;
      try { id = await this.source.readId(file); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        present.delete(file);
        continue;
      }
      this.bind(file, id, stamp);
    }
  }
  /** A binding found stale: drop only what still says so, never a newer binding of the same file. */
  private unbind(acceptanceId: string, file: string): void {
    this.mutations += 1;
    if (this.byId.get(acceptanceId) === file) this.byId.delete(acceptanceId);
    if (this.byFile.get(file)?.id === acceptanceId) this.byFile.delete(file);
    this.synced = undefined;
  }
  private drop(file: string): void {
    const entry = this.byFile.get(file);
    if (entry !== undefined && this.byId.get(entry.id) === file) this.byId.delete(entry.id);
    this.byFile.delete(file);
    this.synced = undefined;
  }
  private bind(file: string, acceptanceId: string, stamp: string | undefined): void {
    const prior = this.byFile.get(file);
    if (prior !== undefined && prior.id !== acceptanceId && this.byId.get(prior.id) === file) this.byId.delete(prior.id);
    this.byFile.set(file, { id: acceptanceId, ...(stamp === undefined ? {} : { stamp }) });
    this.byId.set(acceptanceId, file);
  }
}
/** A stamp taken within the window of its own last change may share a tick with a later write. */
function racy(stat: WakeAcceptanceStat, observedAt: bigint): boolean {
  const changed = stat.mtimeNs > stat.ctimeNs ? stat.mtimeNs : stat.ctimeNs;
  return observedAt - changed < RACY_WINDOW_NS;
}
function stampOf(stat: WakeAcceptanceStat): string { return `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`; }

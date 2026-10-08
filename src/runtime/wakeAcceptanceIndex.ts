import path from "node:path";

/**
 * A stamp younger than this may share a coarse filesystem timestamp tick with
 * a write that lands after it was taken, so it is never trusted to prove that
 * nothing changed (the racy-timestamp rule).
 */
const RACY_WINDOW_NS = 2_000_000_000n;
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
        this.forget(known);
      }
      if (attempt === 0) await this.refresh();
    }
    return undefined;
  }
  /** Binds a record this process wrote; its file stamp is learned on the next sync. */
  set(acceptanceId: string, file: string): void { this.bind(file, acceptanceId, undefined); }
  /** Drops a record file this process deleted, or a binding found stale. */
  forget(file: string): void {
    const entry = this.byFile.get(file);
    if (entry !== undefined && this.byId.get(entry.id) === file) this.byId.delete(entry.id);
    this.byFile.delete(file);
    this.synced = undefined;
  }
  /** Brings the index level with the directory; a no-op while the directory is unchanged. */
  async refresh(): Promise<void> {
    const directory = await this.source.directoryStat();
    const directoryStamp = stampOf(directory);
    if (this.synced === directoryStamp) return;
    const present = new Set<string>();
    for (const name of await this.source.files()) {
      const file = path.join(this.root, name);
      const stat = await this.source.fileStat(file);
      if (stat === undefined) continue;
      present.add(file);
      const stamp = this.racy(stat) ? undefined : stampOf(stat);
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
    for (const file of [...this.byFile.keys()]) if (!present.has(file)) this.forget(file);
    this.synced = this.racy(directory) ? undefined : directoryStamp;
  }
  private bind(file: string, acceptanceId: string, stamp: string | undefined): void {
    const prior = this.byFile.get(file);
    if (prior !== undefined && prior.id !== acceptanceId && this.byId.get(prior.id) === file) this.byId.delete(prior.id);
    this.byFile.set(file, { id: acceptanceId, ...(stamp === undefined ? {} : { stamp }) });
    this.byId.set(acceptanceId, file);
  }
  private racy(stat: WakeAcceptanceStat): boolean {
    const changed = stat.mtimeNs > stat.ctimeNs ? stat.mtimeNs : stat.ctimeNs;
    return this.nowNs() - changed < RACY_WINDOW_NS;
  }
}
function stampOf(stat: WakeAcceptanceStat): string { return `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`; }

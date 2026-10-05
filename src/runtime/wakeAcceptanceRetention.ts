export const TERMINAL_RECEIPT_IDEMPOTENCY_HORIZON = 2_048;
export const WAKE_ACCEPTANCE_COMPACTION_THRESHOLD = 2_112;
export const MAX_WAKE_ACCEPTANCE_RECORDS = 2_176;
/**
 * How long a delivery may sit in `accepted` before the store stops it.
 *
 * Inbox agents return every delivery they did not dispose of to `accepted`
 * (deferred), and a failed execution keeps its batch for retry. Nothing ever
 * ended either, so by 2026-10-05 213 deliveries up to two weeks old sat in the
 * queue, were re-offered on every wake, and kept the store at its bound. Two
 * days is longer than any delivery stays actionable in a daily organization.
 */
export const STALE_QUEUED_DELIVERY_MS = 48 * 60 * 60_000;

export type RetentionCandidate = Readonly<{
  file: string;
  state: "accepted" | "running" | "completed" | "failed" | "stopped";
  updatedAt: string;
  acceptedAt?: string;
  acceptanceId: string;
}>;

/** Queued, unclaimed deliveries accepted before the staleness horizon. Running or claimed work never qualifies. */
export function staleQueuedFilesToStop(records: readonly (RetentionCandidate & Readonly<{ claimed: boolean }>)[], nowMs: number): readonly string[] {
  return records
    .filter((record) => record.state === "accepted" && !record.claimed && record.acceptedAt !== undefined && Date.parse(record.acceptedAt) <= nowMs - STALE_QUEUED_DELIVERY_MS)
    .map((record) => record.file);
}

/**
 * Active work is never eligible. The newest terminal receipts survive up to the
 * idempotency horizon, but never so many that active work plus kept receipts
 * still sits at the compaction threshold: a horizon that ignores active work
 * lets parked deliveries hold the store at its bound with nothing to compact.
 */
export function terminalFilesToCompact(records: readonly RetentionCandidate[]): readonly string[] {
  if (records.length < WAKE_ACCEPTANCE_COMPACTION_THRESHOLD) return [];
  const terminal = records
    .filter((record) => record.state === "completed" || record.state === "failed" || record.state === "stopped")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.acceptanceId.localeCompare(left.acceptanceId));
  const keep = Math.max(0, Math.min(TERMINAL_RECEIPT_IDEMPOTENCY_HORIZON, WAKE_ACCEPTANCE_COMPACTION_THRESHOLD - 1 - (records.length - terminal.length)));
  return terminal.slice(keep).map((record) => record.file);
}

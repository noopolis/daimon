export const TERMINAL_RECEIPT_IDEMPOTENCY_HORIZON = 2_048;
export const WAKE_ACCEPTANCE_COMPACTION_THRESHOLD = 2_112;
export const MAX_WAKE_ACCEPTANCE_RECORDS = 2_176;

export type RetentionCandidate = Readonly<{
  file: string;
  state: "accepted" | "running" | "completed" | "failed" | "stopped";
  updatedAt: string;
  acceptanceId: string;
}>;

/** Active work is never eligible; the newest terminal receipt horizon survives. */
export function terminalFilesToCompact(records: readonly RetentionCandidate[]): readonly string[] {
  if (records.length < WAKE_ACCEPTANCE_COMPACTION_THRESHOLD) return [];
  const terminal = records
    .filter((record) => record.state === "completed" || record.state === "failed" || record.state === "stopped")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.acceptanceId.localeCompare(left.acceptanceId));
  return terminal.slice(TERMINAL_RECEIPT_IDEMPOTENCY_HORIZON).map((record) => record.file);
}

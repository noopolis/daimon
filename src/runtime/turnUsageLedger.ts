import { constants } from "node:fs";
import { open, rename, stat } from "node:fs/promises";

/**
 * Append-only per-turn token accounting for one container.
 *
 * The record carries no organization: there is one ledger per container and one
 * organization per container, so identity comes from which container was
 * queried. Nothing engine-controlled and non-numeric is ever persisted.
 */
export const TURN_USAGE_LEDGER_VERSION = "noopolis.daimon.turn-usage.v1" as const;

/**
 * Where the broker writes, and what Spawnfile provisions.
 *
 * Deliberately *not* folded into `RUNTIME_CONTRACT_MANIFEST`. That manifest's
 * canonical bytes are digest-pinned by Spawnfile
 * (`DAIMON_CONTRACT_MANIFEST_SHA256`) and attested against the runtime image
 * selected at compile time, so any new key there makes every pinned image fail
 * to attest and blocks all Daimon compiles until an image is rebuilt and
 * re-pinned. Nothing about metering needs digest attestation: this is a path
 * both sides agree on, mirrored in `spawnfile/src/runtime/daimon/`. Registering
 * the schema in the manifest is bookkeeping that belongs with the next image
 * rebuild.
 */
export const TURN_USAGE_LEDGER = {
  version: TURN_USAGE_LEDGER_VERSION,
  directoryPath: "/var/lib/spawnfile/daimon/usage",
  filePath: "/var/lib/spawnfile/daimon/usage/usage.jsonl",
  rotatedFilePath: "/var/lib/spawnfile/daimon/usage/usage.jsonl.1",
  directoryMode: 0o750,
  fileMode: 0o640
} as const;

/**
 * `agent` and `wake` are caller-supplied external text (`wake` is `event.id`
 * from the wake request, schema-bounded to 4096 codepoints). They are truncated
 * so one record cannot grow past a size where a single `write(2)` stops being
 * atomic. JSON escaping already prevents line injection.
 */
export const TURN_USAGE_MAX_IDENTIFIER_CHARS = 128;

/** Rotate to a single `.1` sibling. ~2.5k lines/day observed, so this is months. */
export const TURN_USAGE_ROTATE_BYTES = 64 * 1024 * 1024;

export type TurnUsageMeasurement = Readonly<{
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  calls: number;
  notionalUsd: number;
  complete: boolean;
}>;

/**
 * Every engine whose headless stream reports its own token accounting.
 *
 * Codex, AGY, and Grok all publish decoded terminal-stream accounting here.
 * Spawnfile's reader mirrors this list and is updated separately in packet
 * A1b; until then, a reader that rejects `codex` will drop every Codex line.
 */
export const TURN_USAGE_ENGINES = ["agy", "codex", "grok"] as const;

/**
 * Whether the wake that spent these tokens went on to succeed.
 *
 * Money is spent by a failed wake exactly as by a successful one, so a row is
 * written whenever the engine actually reported usage — see
 * `../pi/cliSession.ts`. Without this field every failed wake's spend was
 * simply absent from the ledger, and an organization's cost total silently
 * undercounted by however much its failures burned.
 *
 * `reason` is a closed vocabulary, never an engine- or error-supplied string:
 * the record's rule that nothing engine-controlled and non-numeric is
 * persisted still holds, and `renderTurnUsageLine` degrades anything outside
 * the list to `unknown` rather than writing it through.
 */
export const TURN_USAGE_OUTCOMES = ["completed", "failed"] as const;

/**
 * - `token_ceiling` — the turn's own reported usage crossed the per-wake ceiling.
 * - `wake_timeout` — the wall-clock bound fired before the child finished.
 * - `output_limit` — the retained-output bound was exceeded.
 * - `engine_exit` — the child exited non-zero (or died) after reporting usage.
 * - `turn_rejected` — usage was reported but the decoded turn was not publishable.
 * - `unknown` — any other failure (verification, cleanup, spawn).
 */
export const TURN_USAGE_FAILURE_REASONS = [
  "token_ceiling",
  "wake_timeout",
  "output_limit",
  "engine_exit",
  "turn_rejected",
  "unknown"
] as const;

export type TurnUsageFailureReason = typeof TURN_USAGE_FAILURE_REASONS[number];

export type TurnUsageOutcome = Readonly<{
  status: typeof TURN_USAGE_OUTCOMES[number];
  reason?: TurnUsageFailureReason;
}>;

export type TurnUsageEntry = Readonly<{
  agent: string;
  wake: string;
  engine: typeof TURN_USAGE_ENGINES[number];
  usage: TurnUsageMeasurement;
  at?: string;
  outcome?: TurnUsageOutcome;
}>;

/**
 * Where a metered turn is appended.
 *
 * Production is {@link TURN_USAGE_LEDGER}`.filePath`, which Spawnfile
 * provisions as a non-run-scoped volume. `DAIMON_TURN_USAGE_LEDGER_PATH`
 * redirects it to an absolute path elsewhere; it exists so the wiring between a
 * live engine session and this ledger can be exercised end to end, and so an
 * operator can relocate the ledger without a rebuild. A relative or empty value
 * is ignored rather than honoured, because a ledger written to a
 * process-relative path is a ledger nobody can find again.
 */
export const TURN_USAGE_LEDGER_PATH_ENV = "DAIMON_TURN_USAGE_LEDGER_PATH" as const;

export const resolveTurnUsageLedgerPath = (environment: NodeJS.ProcessEnv = process.env): string => {
  const override = environment[TURN_USAGE_LEDGER_PATH_ENV]?.trim();
  return override !== undefined && override.startsWith("/") ? override : TURN_USAGE_LEDGER.filePath;
};

const bounded = (value: string): string => [...value].slice(0, TURN_USAGE_MAX_IDENTIFIER_CHARS).join("");

/**
 * `outcome`/`reason` are an additive field pair inside the *unchanged* `v1`
 * record, deliberately not a `v2`.
 *
 * Spawnfile's reader (`spawnfile/src/runtime/usageLedger.ts`) rejects any `v`
 * that is not `noopolis.daimon.turn-usage.v1` and returns `null` for the whole
 * line, while picking only the fields it knows and ignoring the rest. Bumping
 * the version would therefore make an unreleased Spawnfile drop *every* row —
 * strictly worse than the defect being fixed. Reading the pair is opt-in;
 * every historical row lacks it and, since a failed wake previously recorded
 * nothing at all, absent can be read as `completed` without ambiguity.
 */
const outcomeFields = (outcome: TurnUsageOutcome | undefined): Record<string, string> => {
  const status = outcome?.status === "failed" ? "failed" : "completed";
  if (status === "completed") return { outcome: status };
  const reason = outcome?.reason;
  return { outcome: status, reason: reason !== undefined && TURN_USAGE_FAILURE_REASONS.includes(reason) ? reason : "unknown" };
};

/** One complete line, newline-terminated. `JSON.stringify` escapes any embedded newline. */
export const renderTurnUsageLine = (entry: TurnUsageEntry): string => `${JSON.stringify({
  v: TURN_USAGE_LEDGER_VERSION,
  agent: bounded(entry.agent),
  wake: bounded(entry.wake),
  engine: entry.engine,
  at: entry.at ?? new Date().toISOString(),
  input: entry.usage.input,
  output: entry.usage.output,
  cache_read: entry.usage.cacheRead,
  cache_write: entry.usage.cacheWrite,
  total: entry.usage.total,
  calls: entry.usage.calls,
  notional_usd: entry.usage.notionalUsd,
  complete: entry.usage.complete,
  ...outcomeFields(entry.outcome)
})}\n`;

const rotate = async (file: string): Promise<void> => {
  let size: number;
  try { size = (await stat(file)).size; } catch { return; }
  if (size >= TURN_USAGE_ROTATE_BYTES) await rename(file, `${file}.1`);
};

/**
 * One `write(2)` per complete line. Turns for different agents run concurrently
 * inside the single broker process, and `O_APPEND` makes a single sub-page write
 * atomic against them. The directory is root-provisioned, so this never creates
 * it: a missing directory is a provisioning failure, not something to paper over.
 */
const appendLine = async (file: string, line: string): Promise<void> => {
  const bytes = Buffer.from(line, "utf8");
  const handle = await open(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, TURN_USAGE_LEDGER.fileMode);
  try {
    const { bytesWritten } = await handle.write(bytes, 0, bytes.length);
    if (bytesWritten !== bytes.length) throw new Error("turn usage ledger append was torn");
  } finally { await handle.close(); }
};

/**
 * Advisory. Never rejects.
 *
 * The caller runs this inside the broker's turn `try` block, after the turn has
 * already been recorded as *completed*. That block's `catch` calls
 * `finish(..., failed)` unconditionally, and `finish` has no terminal-state
 * guard — it renames over an existing record. An escaping append error would
 * therefore rewrite an already-completed turn as failed. This guard is the only
 * thing preventing that, so it is the one place where getting "advisory" wrong
 * corrupts turn state instead of merely dropping a line.
 */
export const recordTurnUsage = async (file: string, entry: TurnUsageEntry): Promise<void> => {
  try {
    await rotate(file);
    await appendLine(file, renderTurnUsageLine(entry));
  } catch {
    /* advisory: a failed append never fails a turn that published */
  }
};

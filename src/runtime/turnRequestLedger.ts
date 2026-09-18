import { constants } from "node:fs";
import { open, rename, stat } from "node:fs/promises";

import { readCodexRolloutRequests, type CodexRequestUsage } from "../pi/codexRolloutUsage.js";
import type { GrokBrokerModel } from "./grokBrokerModelPolicy.js";
import { TURN_USAGE_LEDGER, TURN_USAGE_MAX_IDENTIFIER_CHARS, TURN_USAGE_ROTATE_BYTES } from "./turnUsageLedger.js";

/**
 * Per-model-request token accounting, written *beside* the per-wake usage
 * ledger and never inside it.
 *
 * `turnUsageLedger.ts` records one aggregate row per wake. Production measured
 * 55 wakes at 14,890,263 input tokens against 159,726 output — output is 1.06%
 * of the spend — with context per model request flat at 23–32k regardless of
 * how many requests a wake made. That is the signature of a fixed prefix
 * replayed once per request rather than of a conversation that grows, but the
 * aggregate row cannot tell the two apart, and every optimisation worth doing
 * next depends on which one it is. This file is what tells them apart.
 *
 * It is a separate stream, not a wider row, for one specific reason. Spawnfile's
 * reader (`spawnfile/src/runtime/usageLedger.ts`) rejects any line whose `v` is
 * not `noopolis.daimon.turn-usage.v1` and returns `null` for the whole line, so
 * a version bump on the existing ledger would make an unreleased Spawnfile drop
 * every row it can read today. Nothing here changes the shape, version, path, or
 * field list of that ledger; a reader that knows nothing about this file keeps
 * working byte for byte.
 */
export const TURN_REQUEST_LEDGER_VERSION = "noopolis.daimon.turn-requests.v1" as const;

/**
 * Default location: the directory Spawnfile already provisions for the usage
 * ledger, under its own filename. No new mount, no new provisioning step.
 */
export const TURN_REQUEST_LEDGER = {
  version: TURN_REQUEST_LEDGER_VERSION,
  directoryPath: TURN_USAGE_LEDGER.directoryPath,
  filePath: `${TURN_USAGE_LEDGER.directoryPath}/requests.jsonl`,
  rotatedFilePath: `${TURN_USAGE_LEDGER.directoryPath}/requests.jsonl.1`,
  fileMode: TURN_USAGE_LEDGER.fileMode
} as const;

/**
 * `DAIMON_TURN_REQUESTS_LEDGER_PATH` relocates the stream, exactly as
 * `DAIMON_TURN_USAGE_LEDGER_PATH` relocates the ledger it sits beside. A
 * relative or empty value is ignored rather than honoured: a ledger written to
 * a process-relative path is a ledger nobody can find again.
 */
export const TURN_REQUEST_LEDGER_PATH_ENV = "DAIMON_TURN_REQUESTS_LEDGER_PATH" as const;

export const resolveTurnRequestLedgerPath = (environment: NodeJS.ProcessEnv = process.env): string => {
  const override = environment[TURN_REQUEST_LEDGER_PATH_ENV]?.trim();
  return override !== undefined && override.startsWith("/") ? override : TURN_REQUEST_LEDGER.filePath;
};

export type TurnRequestEntry = Readonly<{
  agent: string;
  wake: string;
  /** The Codex thread whose rollout these rows were read from. */
  thread: string;
  requests: readonly CodexRequestUsage[];
  at?: string;
}>;

const bounded = (value: string): string => [...value].slice(0, TURN_USAGE_MAX_IDENTIFIER_CHARS).join("");

/**
 * One line per model request.
 *
 * `fresh_input` is `input − cached_input`, the split the whole exercise exists
 * to see. It is derived from exactly the relationship Daimon already validates
 * (`cached_input_tokens` is a subset of `input_tokens`, asserted by Codex's own
 * reconciled totals and re-checked when the block is decoded). `cache_write` is
 * emitted raw and never subtracted, because whether Codex counts a cache write
 * inside `input_tokens` has not been verified — a reader that needs that answer
 * has the raw number to work from instead of a guess baked into the row.
 */
export const renderTurnRequestLines = (entry: TurnRequestEntry): string => {
  const at = entry.at ?? new Date().toISOString();
  const requests = entry.requests.length;
  return entry.requests.map((request) => `${JSON.stringify({
    v: TURN_REQUEST_LEDGER_VERSION,
    agent: bounded(entry.agent),
    wake: bounded(entry.wake),
    engine: "codex",
    at,
    thread: bounded(entry.thread),
    request: request.index,
    requests,
    input: request.input,
    cached_input: request.cachedInput,
    fresh_input: request.input - request.cachedInput,
    cache_write: request.cacheWrite,
    output: request.output,
    reasoning: request.reasoning,
    total: request.total,
    ...requestClockFields(request)
  })}\n`).join("");
};

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/u;
/** Per-request `started_at`/`ended_at`, each only when it was measured; `at` stays the append time. */
const requestClockFields = (request: Readonly<{ startedAt?: string; endedAt?: string }>): Record<string, string> => ({
  ...(request.startedAt !== undefined && TIMESTAMP.test(request.startedAt) ? { started_at: request.startedAt } : {}),
  ...(request.endedAt !== undefined && TIMESTAMP.test(request.endedAt) ? { ended_at: request.endedAt } : {})
});

/** One Grok broker model request: usage from the worker stream, timing from the proxy. */
/**
 * `usageSource`: `stream` (the worker's own per-request frame), `upstream`
 * (the provider response the proxy saw), or `estimated` (no valid usage; the
 * proxy's conservative charge, see `grokBrokerTurnMeter.ts`).
 */
/**
 * `toolCalls` are the tool-call names that request's response carried, as the
 * proxy read them (`grokBrokerTurnMeter.ts`): names only, bounded, `[]` for a
 * response that called nothing, and absent when no response could be decoded.
 */
export type GrokTurnRequest = Readonly<{ index: number; input: number; cacheRead: number; cacheWrite: number; output: number; total: number; startedAt?: string; endedAt?: string; usageSource?: "stream" | "upstream" | "estimated"; toolCalls?: readonly string[] }>;
/**
 * `requestCount` is the turn's admitted request count when it exceeds the rows:
 * a killed turn's in-flight request was sent upstream but never reported usage,
 * so it has no row yet still counts in every row's `requests`.
 */
export type GrokTurnRequestEntry = Readonly<{ agent: string; wake: string; turn: string; session?: string; model: GrokBrokerModel; requests: readonly GrokTurnRequest[]; requestCount?: number; at?: string }>;

/**
 * Grok rows share the Codex row's field meaning: `input` is the whole prompt
 * side the request replayed (`input_tokens + cache_read`), `cached_input` the
 * cache read, `fresh_input` the uncached remainder. Grok does not separate
 * reasoning tokens, so `reasoning` is absent rather than zero. `turn` is the
 * broker idempotency key and `thread` the Grok session id when the stream
 * named one.
 *
 * `tool_calls` is what a turn's rows could not say before: whether the model
 * ever *tried* to call anything. Two live turns ended with correctly mounted
 * tools and no visible attempt, and the rows recorded timings and tokens only,
 * so the question could not be answered after the fact. It is names only —
 * never arguments, never message content, never a bearer — bounded, `[]` for a
 * response that called nothing, and absent for a response that could not be
 * decoded, because a fabricated empty list is byte-identical to a measured one.
 *
 * It is an additive field inside the unchanged
 * `noopolis.daimon.turn-requests.v1` row, deliberately without a version bump:
 * Spawnfile's usage reader (`spawnfile/src/runtime/usageLedger.ts`) drops every
 * line whose `v` it does not recognise while ignoring fields it does not know,
 * and Paideia only relocates this stream's path
 * (`DAIMON_TURN_REQUESTS_LEDGER_PATH`). A bump is what would blind them; a new
 * field is not.
 */
export const renderGrokTurnRequestLines = (entry: GrokTurnRequestEntry): string => {
  const at = entry.at ?? new Date().toISOString();
  return entry.requests.map((request) => `${JSON.stringify({
    v: TURN_REQUEST_LEDGER_VERSION,
    agent: bounded(entry.agent),
    wake: bounded(entry.wake),
    engine: "grok",
    at,
    turn: entry.turn,
    ...(entry.session === undefined ? {} : { thread: bounded(entry.session) }),
    model: entry.model,
    request: request.index,
    requests: Math.max(entry.requests.length, entry.requestCount ?? 0),
    input: request.input + request.cacheRead,
    cached_input: request.cacheRead,
    fresh_input: request.input,
    cache_write: request.cacheWrite,
    output: request.output,
    total: request.total,
    ...(request.usageSource === undefined ? {} : { usage_source: request.usageSource }),
    ...(request.toolCalls === undefined ? {} : { tool_calls: request.toolCalls }),
    ...requestClockFields(request)
  })}\n`).join("");
};

/**
 * Append already-rendered, newline-terminated ledger lines in one write, with the
 * same rotation and file mode as both ledgers. Advisory: never rejects. The
 * broker uses it to append the exact bytes it sealed into a turn record.
 */
export const recordLedgerLines = async (file: string, lines: string): Promise<boolean> => {
  if (lines.length === 0) return false;
  try { await rotate(file); await appendLines(file, lines); return true; } catch { return false; }
};

/** Advisory and never rejects, like {@link recordTurnRequests}; an empty turn writes nothing. */
export const recordGrokTurnRequests = async (file: string, entry: GrokTurnRequestEntry): Promise<boolean> => {
  if (entry.requests.length === 0) return false;
  try { await rotate(file); await appendLines(file, renderGrokTurnRequestLines(entry)); return true; } catch { return false; }
};

const rotate = async (file: string): Promise<void> => {
  let size: number;
  try { size = (await stat(file)).size; } catch { return; }
  if (size >= TURN_USAGE_ROTATE_BYTES) await rename(file, `${file}.1`);
};

/**
 * One `write(2)` for the whole wake's rows.
 *
 * Turns for different agents run concurrently inside the single broker process.
 * `O_APPEND` makes a single sub-page write atomic against them, so a wake's rows
 * are contiguous and never interleaved with another wake's — which matters more
 * here than in the per-wake ledger, because a row only means something beside
 * the other rows of its own thread. A wake with enough requests to exceed a page
 * is still append-ordered per line; interleaving would cost grouping, not
 * correctness, since every row carries its own thread id.
 */
const appendLines = async (file: string, lines: string): Promise<void> => {
  const bytes = Buffer.from(lines, "utf8");
  const handle = await open(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, TURN_REQUEST_LEDGER.fileMode);
  try {
    const { bytesWritten } = await handle.write(bytes, 0, bytes.length);
    if (bytesWritten !== bytes.length) throw new Error("turn request ledger append was torn");
  } finally { await handle.close(); }
};

/**
 * Advisory. Never rejects, and never writes an empty wake.
 *
 * A wake whose rollout was absent, unreadable, or undecodable contributes no
 * rows at all rather than a zero row — the same invariant the usage ledger
 * holds, for the same reason: a fabricated zero is byte-identical to a measured
 * one, and this stream exists to be believed.
 */
export const recordTurnRequests = async (file: string, entry: TurnRequestEntry): Promise<boolean> => {
  if (entry.requests.length === 0) return false;
  try {
    await rotate(file);
    await appendLines(file, renderTurnRequestLines(entry));
    return true;
  } catch {
    /* advisory: instrumentation never fails a wake that published */
    return false;
  }
};

/**
 * The whole instrumentation path for one Codex wake: find that thread's
 * rollout, decode its per-request usage, append it. Never throws.
 *
 * A wake that produced no rows says so on stderr exactly once. Silence would
 * make a permanently blind instrument indistinguishable from a working one —
 * `--ephemeral`, a relocated `CODEX_HOME`, or a Codex version that renamed the
 * usage frame all end here, and each is worth one line rather than a
 * quietly-empty file nobody questions.
 */
export const recordCodexTurnRequests = async (input: Readonly<{
  agent: string;
  wake: string;
  codexHome: string;
  threadId: string;
  file?: string;
}>): Promise<boolean> => {
  try {
    const requests = await readCodexRolloutRequests(input.codexHome, input.threadId);
    const written = await recordTurnRequests(input.file ?? resolveTurnRequestLedgerPath(), {
      agent: input.agent,
      wake: input.wake,
      thread: input.threadId,
      requests
    });
    if (!written) {
      console.error(`daimon: no per-request usage recorded for codex thread ${input.threadId} (${requests.length === 0 ? "no decodable rollout usage" : "ledger append failed"})`);
    }
    return written;
  } catch (error) {
    console.error(`daimon: per-request usage instrumentation failed: ${error instanceof Error ? error.message : "unknown error"}`);
    return false;
  }
};

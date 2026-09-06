import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Per-model-request token accounting, recovered from the rollout file Codex
 * already writes for every non-`--ephemeral` thread.
 *
 * Daimon's usage ledger records exactly one row per wake, decoded from the
 * single `turn.completed` frame on the `--json` stream. That row is a sum: it
 * cannot say whether a wake's fresh input is one cold miss on a shared prefix
 * that is then replayed cheaply, or a context that grows with every tool call.
 * Those two shapes call for opposite optimisations, and the aggregate row is
 * blind to the difference. It also drops `reasoning_output_tokens` entirely.
 *
 * Codex writes the missing detail to
 * `$CODEX_HOME/sessions/<yyyy>/<mm>/<dd>/rollout-<ts>-<thread-id>.jsonl`, one
 * usage frame per model request. Two frame shapes carry it, and both were read
 * off real rollouts written by codex-cli 0.153.4:
 *
 *     {"type":"token_usage_record","payload":{"thread_id":…,"turn_id":…,
 *       "usage":{"input_tokens":22119,"cached_input_tokens":21888,
 *       "cache_write_input_tokens":0,"output_tokens":358,
 *       "reasoning_output_tokens":169,"total_tokens":22477}, …}}
 *
 *     {"type":"event_msg","payload":{"type":"token_count","info":{
 *       "last_token_usage":{…same fields…},"total_token_usage":{…}}}}
 *
 * `token_usage_record` is preferred because it names its thread and turn. The
 * `token_count` shape is the fallback for a Codex version that predates it —
 * the pinned runtime image's version was not available to check. The two are
 * emitted in pairs, so they are never both counted.
 *
 * Reading is strictly advisory and strictly read-only: Codex owns these files,
 * Daimon never writes, moves, or prunes them.
 */

/** One model request's own token usage, exactly as Codex reported it. */
export type CodexRequestUsage = Readonly<{
  /** 0-based position of this request within the rollout. */
  index: number;
  input: number;
  cachedInput: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  total: number;
}>;

/**
 * A thread id is interpolated into a filename suffix, so it is constrained to
 * the shape Codex actually emits (a UUID) before it can reach the filesystem.
 * A value carrying `/` or `..` would otherwise steer the search out of
 * `$CODEX_HOME`.
 */
const SAFE_THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/u;

export const isCodexThreadId = (value: unknown): value is string =>
  typeof value === "string" && SAFE_THREAD_ID.test(value);

/**
 * Codex lays rollouts out as `sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl`, so
 * three directory levels below `sessions` is the whole tree. Directory entries
 * are walked newest-name-first, which for zero-padded date components is
 * newest-day-first — the wake that just finished is in the first day directory
 * examined, so the search normally reads one directory per level.
 */
const ROLLOUT_MAX_DEPTH = 3;

/** A budget so a pathological sessions tree cannot turn instrumentation into a stall. */
const ROLLOUT_MAX_ENTRIES = 20_000;

/** Rollouts are model transcripts; refuse to buffer an implausible one. */
export const CODEX_ROLLOUT_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Locate the rollout belonging to *this* turn, by thread id.
 *
 * The thread id comes from the `thread.started` frame Codex emits as the very
 * first line of its own `--json` stream (verified live against codex-cli
 * 0.153.4: `{"type":"thread.started","thread_id":"01a076d3-…"}`), and the
 * rollout filename ends with `-<thread-id>.jsonl`. Nothing here globs for "the
 * newest file": with concurrent agents in one container, newest-file matching
 * would attribute one agent's requests to another's wake.
 */
export const findCodexRolloutPath = async (codexHome: string, threadId: string): Promise<string | undefined> => {
  if (!isCodexThreadId(threadId)) return undefined;
  const suffix = `-${threadId}.jsonl`;
  let budget = ROLLOUT_MAX_ENTRIES;
  const walk = async (directory: string, depth: number): Promise<string | undefined> => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return undefined; }
    budget -= entries.length;
    if (budget < 0) return undefined;
    const match = entries.find((entry) => entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(suffix));
    if (match !== undefined) return path.join(directory, match.name);
    if (depth >= ROLLOUT_MAX_DEPTH) return undefined;
    const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
    for (const name of directories) {
      const found = await walk(path.join(directory, name), depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return walk(path.join(codexHome, "sessions"), 0);
};

type JsonRecord = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const tokenCount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/**
 * Decode one usage block, or `undefined` when any part of it is not a
 * non-negative safe integer.
 *
 * The rule `turnUsageLedger.ts` and `codexHeadlessResult.ts` already hold to
 * applies here unchanged: a substituted zero is byte-identical to a real zero,
 * so a number is never invented. `cache_write_input_tokens` and `total_tokens`
 * may be absent (older Codex versions omit them); absent means zero and a
 * derived total respectively, but present-and-malformed still rejects the
 * block. The subset relationships Codex's own totals imply — cached input
 * inside input, reasoning output inside output — are checked rather than
 * assumed, because a block that violates them is not describing the request
 * this row claims to describe.
 */
const decodeRequestUsage = (usage: unknown, index: number): CodexRequestUsage | undefined => {
  if (!isRecord(usage)) return undefined;
  const input = tokenCount(usage.input_tokens);
  const cachedInput = tokenCount(usage.cached_input_tokens);
  const output = tokenCount(usage.output_tokens);
  const reasoning = tokenCount(usage.reasoning_output_tokens);
  if (input === undefined || cachedInput === undefined || output === undefined || reasoning === undefined) return undefined;
  const cacheWrite = usage.cache_write_input_tokens === undefined ? 0 : tokenCount(usage.cache_write_input_tokens);
  const total = usage.total_tokens === undefined ? input + output : tokenCount(usage.total_tokens);
  if (cacheWrite === undefined || total === undefined) return undefined;
  if (cachedInput > input || reasoning > output) return undefined;
  return { index, input, cachedInput, cacheWrite, output, reasoning, total };
};

const usageBlock = (frame: JsonRecord, threadId: string): { usage: unknown } | undefined => {
  const payload = isRecord(frame.payload) ? frame.payload : undefined;
  if (payload === undefined) return undefined;
  if (frame.type === "token_usage_record") {
    // The file is already thread-scoped by its name; the field is checked anyway
    // so a forked or sub-thread record can never be billed to this wake.
    if (typeof payload.thread_id === "string" && payload.thread_id !== threadId) return undefined;
    return { usage: payload.usage };
  }
  if (frame.type === "event_msg" && payload.type === "token_count" && isRecord(payload.info)) {
    return { usage: payload.info.last_token_usage };
  }
  return undefined;
};

/**
 * Every model request in one rollout, in stream order — or an empty list.
 *
 * "Or an empty list" is the whole contract. A rollout that yields no usage
 * frame, or that contains a usage frame Daimon cannot decode, produces nothing:
 * a partial or invented row here would be indistinguishable from a real
 * measurement, and the entire point of this file is to be trusted about which
 * of two cost shapes production actually has.
 *
 * Individual unparseable *lines* are skipped rather than fatal. Codex appends
 * to this file while the turn runs, so a torn final line is an ordinary
 * artefact of reading it, not evidence that the accounting is wrong. A usage
 * frame that parses but whose usage block does not decode is fatal, because
 * that is a genuine disagreement about the shape of the number.
 *
 * Daimon spawns one `codex exec` per wake and never resumes a thread, so one
 * rollout is one wake. If that ever changes, this needs a turn-id filter.
 */
export const parseCodexRolloutRequests = (text: string, threadId: string): readonly CodexRequestUsage[] => {
  const requests: CodexRequestUsage[] = [];
  const fallback: CodexRequestUsage[] = [];
  let previousFallback = "";
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    let frame: unknown;
    try { frame = JSON.parse(line); } catch { continue; }
    if (!isRecord(frame)) continue;
    const block = usageBlock(frame, threadId);
    if (block === undefined) continue;
    if (frame.type === "token_usage_record") {
      const decoded = decodeRequestUsage(block.usage, requests.length);
      if (decoded === undefined) return [];
      requests.push(decoded);
      continue;
    }
    // `token_count` is NOT one frame per request: the captured fixture carries
    // six of them for four requests, three of which repeat one earlier
    // `last_token_usage` verbatim because the event is re-emitted whenever the
    // rate-limit block refreshes. Counting them would inflate the request count
    // — the single number this whole stream exists to establish. Only a block
    // that differs from the one before it is a new request.
    const serialized = JSON.stringify(block.usage);
    if (serialized === previousFallback) continue;
    previousFallback = serialized;
    const decoded = decodeRequestUsage(block.usage, fallback.length);
    if (decoded === undefined) return [];
    fallback.push(decoded);
  }
  // A Codex version that emits both shapes emits `token_usage_record` once per
  // request, so the richer one wins outright rather than being merged into a
  // double count. The fallback exists only for a version that has neither.
  return requests.length > 0 ? requests : fallback;
};

/**
 * Read one turn's per-request usage. Never throws.
 *
 * Absent, unreadable, oversized, or undecodable all answer the same way: an
 * empty list, which the caller writes nothing for.
 */
export const readCodexRolloutRequests = async (
  codexHome: string,
  threadId: string
): Promise<readonly CodexRequestUsage[]> => {
  const file = await findCodexRolloutPath(codexHome, threadId);
  if (file === undefined) return [];
  let text: string;
  try {
    const bytes = await readFile(file);
    if (bytes.byteLength > CODEX_ROLLOUT_MAX_BYTES) return [];
    text = bytes.toString("utf8");
  } catch { return []; }
  return parseCodexRolloutRequests(text, threadId);
};

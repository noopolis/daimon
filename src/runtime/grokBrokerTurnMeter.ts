import { GROK_ENGINE_BROKER } from "../contracts/runtimeContractManifest.js";
import { sumEngineBrokerTurnUsage, type EngineBrokerLimitReason, type EngineBrokerTurnLimits, type EngineBrokerTurnUsage } from "./engineBrokerTurnAccounting.js";

/**
 * `estimated` marks a request whose response carried no valid usage and was
 * charged {@link estimateGrokRequestUsage}. `toolCalls` are the tool-call names
 * that request's response carried, names only ({@link parseGrokResponseToolNames});
 * absent means the response could not be decoded, `[]` that it called nothing.
 */
export type GrokBrokerRequestTiming = Readonly<{ startedAt: string; endedAt?: string; usage?: EngineBrokerTurnUsage; estimated?: true; toolCalls?: readonly string[] }>;
export type GrokBrokerTurnMeterSnapshot = Readonly<{ requests: number; tokens: number; limitReason: EngineBrokerLimitReason; usage: EngineBrokerTurnUsage | null; estimatedRequests: number; timings: readonly GrokBrokerRequestTiming[] }>;
/** The model's last answer when it called no tool: the turn's final reply, as the proxy saw it, and when it settled. */
export type GrokBrokerFinalReply = Readonly<{ index: number; text: string; at: number }>;

/**
 * The weight a cached prompt read carries against the token ceiling.
 *
 * The ceiling exists to bound spend, and a cached read is billed at a quarter
 * of a fresh input token (xAI's published cached-input rate for the Grok 4
 * family). Counting it at full weight made the ceiling a context-size limit
 * instead: a writing or composing turn re-reads its whole conversation on
 * every request, 85–90% of it from cache, and production turns died at a
 * 1.1M "ceiling" having spent about a third of that. Fresh input, output and
 * reasoning still count in full; the sealed usage and ledgers are unchanged
 * and keep every cached token at its raw count.
 */
export const GROK_CACHED_INPUT_TOKEN_WEIGHT = 0.25;
/** What one request's usage costs against `maxTokens`: everything at full weight except cached reads. */
export const grokCeilingTokens = (usage: EngineBrokerTurnUsage): number =>
  usage.total - usage.cacheRead + Math.ceil(usage.cacheRead * GROK_CACHED_INPUT_TOKEN_WEIGHT);

/**
 * The proxy's per-turn spend gate.
 *
 * Every forwarded model request of one turn passes through {@link admit}
 * *before* a bearer is attached, so the checks are hard for requests and
 * elapsed time and between-requests for tokens:
 *
 * - `maxRequests`: request `maxRequests + 1` is refused; upstream never sees it.
 * - `timeoutMs`: a request arriving after the deadline is refused (the broker's
 *   own timer additionally kills a worker that is mid-request).
 * - `maxTokens`: checked against the running total of upstream-reported usage
 *   of the requests already answered. A request is admitted while that total is
 *   still below the ceiling, so the overshoot is bounded by exactly one
 *   request's usage — the last admitted one. Cached prompt reads count at
 *   {@link GROK_CACHED_INPUT_TOKEN_WEIGHT} ({@link grokCeilingTokens}); an
 *   uncached replay (P0 observed one at +55%) is fresh input and counts in full.
 *
 * The first limit that fires is sticky: every later request is refused with
 * the same reason, and `onLimit` runs once.
 *
 * The token bound is only a bound if no request can be admitted on a total
 * that an in-flight request has not yet reported into. So a turn has at most
 * ONE upstream request in flight: a second request arriving before the first
 * settled is refused (`busy`, HTTP 429) without being counted or tripping a
 * limit. Grok's headless loop is sequential — every live capture (P1
 * live-round1, P2 live) shows each request ending before the next starts — so
 * this refuses only a worker that is not behaving like Grok. Tripping a limit
 * (including the broker's timer) aborts that in-flight upstream call through
 * its own `AbortSignal` rather than letting it run to completion.
 */
export class GrokBrokerTurnMeter {
  private readonly startedAt: number;
  private readonly timings: { startedAt: string; endedAt?: string; usage?: EngineBrokerTurnUsage; estimated?: true; toolCalls?: readonly string[] }[] = [];
  private tokens = 0;
  private reason: EngineBrokerLimitReason = "none";
  private inFlight: { index: number; controller: AbortController } | undefined;
  private final: GrokBrokerFinalReply | undefined;
  private activityAt: number;
  constructor(readonly limits: EngineBrokerTurnLimits, private readonly onLimit: (reason: Exclude<EngineBrokerLimitReason, "none">) => void = () => undefined, private readonly now: () => number = Date.now) {
    this.startedAt = now();
    this.activityAt = this.startedAt;
  }

  /** Returns the request index and its upstream abort signal when admitted, the limit that refused it, or `busy` while another request is in flight. */
  admit(): Readonly<{ index: number; signal: AbortSignal } | { refused: Exclude<EngineBrokerLimitReason, "none"> } | { busy: true }> {
    if (this.reason === "none") {
      if (this.now() - this.startedAt >= this.limits.timeoutMs) this.trip("timeout");
      else if (this.timings.length >= this.limits.maxRequests) this.trip("requests");
      else if (this.tokens >= this.limits.maxTokens) this.trip("tokens");
    }
    if (this.reason !== "none") return { refused: this.reason };
    if (this.inFlight !== undefined) return { busy: true };
    this.timings.push({ startedAt: new Date(this.now()).toISOString() });
    // A new request means the previous answer was not the last one.
    this.final = undefined; this.activityAt = this.now();
    const controller = new AbortController();
    this.inFlight = { index: this.timings.length - 1, controller };
    return { index: this.inFlight.index, signal: controller.signal };
  }

  /**
   * Records one admitted request's end, its usage, and the tool-call names its
   * response carried. A response without valid usage (absent, malformed,
   * implausible, or a failed/aborted call) is charged a conservative estimate
   * from the request body size, so a missing `usage` can never silently disable
   * the token ceiling. `toolCalls` is observation only: it never affects
   * admission, the running total, or any limit.
   *
   * `finalReply` is the answer text of a response that called no tool and
   * stopped ({@link parseGrokFinalReply}). It is recorded only when the same
   * response decoded to zero tool calls, and only for the request still the
   * latest: it is what lets the broker end a turn whose worker has finished but
   * not exited, and report finished work whose stdout the launcher refused.
   */
  settle(index: number, usage: EngineBrokerTurnUsage | undefined, requestBytes: number, toolCalls?: readonly string[], finalReply?: string): void {
    const timing = this.timings[index];
    if (timing === undefined || timing.endedAt !== undefined) return;
    if (this.inFlight?.index === index) this.inFlight = undefined;
    timing.endedAt = new Date(this.now()).toISOString();
    if (usage === undefined) { timing.usage = estimateGrokRequestUsage(requestBytes); timing.estimated = true; }
    else timing.usage = usage;
    if (toolCalls !== undefined) timing.toolCalls = toolCalls;
    this.tokens += grokCeilingTokens(timing.usage);
    this.activityAt = this.now();
    if (finalReply !== undefined && toolCalls !== undefined && toolCalls.length === 0 && index === this.timings.length - 1) this.final = { index, text: finalReply, at: this.activityAt };
  }

  /** The turn's final reply, while no later request has been admitted. */
  finalReply(): GrokBrokerFinalReply | undefined { return this.final; }
  /** Whether a model request is in flight right now. */
  busy(): boolean { return this.inFlight !== undefined; }
  /** When a model request last started or settled (the meter's construction before any). */
  lastActivityAt(): number { return this.activityAt; }

  /** Trips a limit from outside the request path (the broker's wall-clock timer). */
  trip(reason: Exclude<EngineBrokerLimitReason, "none">): void {
    if (this.reason !== "none") return;
    this.reason = reason;
    this.abortInFlight();
    this.onLimit(reason);
  }

  /** Aborts the in-flight upstream call, if any (limit trip, or the broker ending the turn). */
  abortInFlight(): void { this.inFlight?.controller.abort(); }

  snapshot(): GrokBrokerTurnMeterSnapshot {
    const measured = this.timings.flatMap((timing) => timing.usage === undefined ? [] : [timing.usage]);
    return { requests: this.timings.length, tokens: this.tokens, limitReason: this.reason, usage: sumEngineBrokerTurnUsage(measured), estimatedRequests: this.timings.filter((timing) => timing.estimated === true).length, timings: this.timings.map((timing) => Object.freeze({ ...timing })) };
  }
}

const { requestUsageMaxTokens, missingUsageEstimate } = GROK_ENGINE_BROKER.turnLimits;

/** The charge for a request without valid usage: `ceil(bodyBytes / 2)` input plus a fixed output allowance. */
export const estimateGrokRequestUsage = (requestBytes: number): EngineBrokerTurnUsage => {
  const input = Math.ceil(Math.max(0, requestBytes) / missingUsageEstimate.inputBytesPerToken), output = missingUsageEstimate.outputTokens;
  return { input, cacheRead: 0, cacheWrite: 0, output, total: input + output };
};

type JsonRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is JsonRecord => value !== null && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/**
 * Upstream-reported usage of one chat-completions response, or `undefined`.
 *
 * The proxy buffers the whole upstream body, so the last `usage` object of an
 * SSE stream (`stream_options.include_usage`) or of a JSON body is available
 * before the body is returned to the worker. OpenAI-shaped `prompt_tokens`
 * include cached tokens; they are split into disjoint buckets here, and any
 * reasoning tokens reported outside `completion_tokens` (visible as
 * `total_tokens` above prompt + completion) are folded into `output` so the
 * total invariant holds. A malformed block, or one whose total exceeds
 * `GROK_ENGINE_BROKER.turnLimits.requestUsageMaxTokens`, is invalid: never
 * zero-filled and never added — the meter charges an estimate instead.
 */
export function parseGrokUpstreamUsage(body: Uint8Array, contentType: string | undefined): EngineBrokerTurnUsage | undefined {
  let found: EngineBrokerTurnUsage | undefined;
  for (const candidate of decodeUpstreamResponse(body, contentType) ?? []) {
    if (!isRecord(candidate) || !isRecord(candidate.usage)) continue;
    // Last usage block wins even when invalid: an implausible final report
    // must not fall back to an earlier, smaller block (the request is then
    // charged the estimate instead).
    found = decodeOpenAiUsage(candidate.usage);
  }
  return found;
}

/**
 * Every decodable JSON object of one upstream response: each `data:` event of
 * an SSE stream, or the single body of a JSON response.
 *
 * `undefined` means *nothing* decoded — an unparseable or non-JSON response.
 * Callers must keep that distinct from a decoded response that said nothing,
 * because the ledger never fabricates an observation it did not make.
 */
function decodeUpstreamResponse(body: Uint8Array, contentType: string | undefined): unknown[] | undefined {
  const text = Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("utf8");
  const candidates: unknown[] = [];
  if (contentType?.includes("text/event-stream") === true || text.startsWith("data:")) {
    for (const line of text.split(/\r?\n/u)) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]" || payload.length === 0) continue;
      try { candidates.push(JSON.parse(payload)); } catch { /* a non-JSON event carries neither usage nor a tool call */ }
    }
  } else {
    try { candidates.push(JSON.parse(text)); } catch { return undefined; }
  }
  return candidates.length === 0 ? undefined : candidates;
}

/** At most this many names per request row; a longer list ends in {@link GROK_TOOL_CALL_TRUNCATED}. */
export const GROK_REQUEST_TOOL_CALLS_MAX = 16;
/** A `name` that is not a plain short identifier is counted, never passed through. */
export const GROK_TOOL_CALL_INVALID = "<invalid>";
export const GROK_TOOL_CALL_TRUNCATED = "<truncated>";
const TOOL_CALL_NAME = /^[A-Za-z0-9_.-]{1,64}$/u;

/**
 * The tool-call NAMES one upstream response carried, and nothing else.
 *
 * Two live turns could not answer "did the model ever try `use_tool` or
 * `search_tool`", because the per-request rows recorded timings and tokens but
 * never an attempt. This is that answer, under four rules:
 *
 * - names only. No arguments, no message content, no tokens, no header. A
 *   `name` that is not a plain short identifier is recorded as
 *   {@link GROK_TOOL_CALL_INVALID} rather than passing provider bytes through;
 * - bounded. At most {@link GROK_REQUEST_TOOL_CALLS_MAX} entries, the last being
 *   {@link GROK_TOOL_CALL_TRUNCATED} when the response carried more, so a
 *   pathological response cannot write an unbounded row;
 * - absence stays absence. A decoded response that called nothing returns `[]`;
 *   a response that could not be decoded returns `undefined` and the row records
 *   no field at all;
 * - one streaming call names itself in one delta and streams its arguments in
 *   the rest, so a repeat of the same `(choice, call)` index is that same call,
 *   not a second attempt.
 */
export function parseGrokResponseToolNames(body: Uint8Array, contentType: string | undefined): readonly string[] | undefined {
  const candidates = decodeUpstreamResponse(body, contentType);
  if (candidates === undefined) return undefined;
  const names: string[] = [], seen = new Set<string>();
  scan: for (const candidate of candidates) {
    if (!isRecord(candidate) || !Array.isArray(candidate.choices)) continue;
    for (const choice of candidate.choices) {
      if (!isRecord(choice)) continue;
      for (const source of [choice.delta, choice.message]) {
        if (!isRecord(source) || !Array.isArray(source.tool_calls)) continue;
        for (const call of source.tool_calls) {
          if (!isRecord(call) || !isRecord(call.function)) continue;
          const name = call.function.name;
          // An arguments-only delta names nothing; it is not an attempt of its own.
          if (typeof name !== "string" || name.length === 0) continue;
          if (typeof choice.index === "number" && typeof call.index === "number") {
            const key = `${choice.index}:${call.index}`;
            if (seen.has(key)) continue;
            seen.add(key);
          }
          names.push(TOOL_CALL_NAME.test(name) ? name : GROK_TOOL_CALL_INVALID);
          if (names.length > GROK_REQUEST_TOOL_CALLS_MAX) break scan;
        }
      }
    }
  }
  return names.length > GROK_REQUEST_TOOL_CALLS_MAX ? [...names.slice(0, GROK_REQUEST_TOOL_CALLS_MAX - 1), GROK_TOOL_CALL_TRUNCATED] : names;
}

/** The most of a final reply the broker reports; the rest is cut at a marker that says how much. */
export const GROK_FINAL_REPLY_MAX_BYTES = 64 * 1024;

/**
 * The answer text of a response that *stopped*: every `delta.content` of a
 * streamed response (or the `message.content` of a JSON one) in order, when
 * some choice finished with `finish_reason: "stop"` and none with anything else.
 *
 * `undefined` means the response is not known to be final — undecodable, no
 * finish reason, or one that asks for a tool. The caller additionally requires
 * the same body to have decoded to zero tool calls. The text is bounded by
 * {@link boundGrokFinalReply}, so a runaway answer can never make the turn's
 * own report the thing that fails it.
 */
export function parseGrokFinalReply(body: Uint8Array, contentType: string | undefined): string | undefined {
  const candidates = decodeUpstreamResponse(body, contentType);
  if (candidates === undefined) return undefined;
  let text = "", stopped = false;
  for (const candidate of candidates) {
    if (!isRecord(candidate) || !Array.isArray(candidate.choices)) continue;
    for (const choice of candidate.choices) {
      if (!isRecord(choice)) continue;
      for (const source of [choice.delta, choice.message]) if (isRecord(source) && typeof source.content === "string") text += source.content;
      // Only `stop` is a finished answer: `length` was cut off mid-answer and
      // `content_filter` withheld it, so neither is work done.
      if (typeof choice.finish_reason === "string" && choice.finish_reason.length > 0) {
        if (choice.finish_reason !== "stop") return undefined;
        stopped = true;
      }
    }
  }
  return stopped ? boundGrokFinalReply(text) : undefined;
}

/** `text` whole when it fits {@link GROK_FINAL_REPLY_MAX_BYTES}, else its head and a marker naming what was cut — never a failure. */
export function boundGrokFinalReply(text: string, maxBytes = GROK_FINAL_REPLY_MAX_BYTES): string {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return text;
  const marker = (cut: number) => `\n[… ${cut} bytes truncated by the Daimon broker …]`;
  const budget = Math.max(0, maxBytes - Buffer.byteLength(marker(bytes)));
  // Cut on a code point: a byte-counted window must not leave half a character behind.
  const head = new TextDecoder("utf-8", { fatal: false }).decode(Buffer.from(text, "utf8").subarray(0, budget)).replace(/\uFFFD$/u, "");
  return `${head}${marker(bytes - Buffer.byteLength(head, "utf8"))}`;
}

function decodeOpenAiUsage(usage: JsonRecord): EngineBrokerTurnUsage | undefined {
  const prompt = count(usage.prompt_tokens), completion = count(usage.completion_tokens);
  if (prompt === undefined || completion === undefined) return undefined;
  const details = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {};
  const cached = details.cached_tokens === undefined ? 0 : count(details.cached_tokens);
  const reported = usage.total_tokens === undefined ? prompt + completion : count(usage.total_tokens);
  if (cached === undefined || reported === undefined || cached > prompt) return undefined;
  const total = Math.max(reported, prompt + completion);
  const completionDetails = isRecord(usage.completion_tokens_details) ? usage.completion_tokens_details : {};
  const reasoning = count(completionDetails.reasoning_tokens);
  const output = total - prompt;
  if (total > requestUsageMaxTokens) return undefined;
  return { input: prompt - cached, cacheRead: cached, cacheWrite: 0, output, total, ...(reasoning === undefined || reasoning > output ? {} : { reasoning }) };
}

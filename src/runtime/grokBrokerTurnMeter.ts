import { sumEngineBrokerTurnUsage, type EngineBrokerLimitReason, type EngineBrokerTurnLimits, type EngineBrokerTurnUsage } from "./engineBrokerTurnAccounting.js";

export type GrokBrokerRequestTiming = Readonly<{ startedAt: string; endedAt?: string; usage?: EngineBrokerTurnUsage }>;
export type GrokBrokerTurnMeterSnapshot = Readonly<{ requests: number; tokens: number; limitReason: EngineBrokerLimitReason; usage: EngineBrokerTurnUsage | null; timings: readonly GrokBrokerRequestTiming[] }>;

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
 *   request's usage — the last admitted one. Usage counts total input
 *   *including* cached tokens (P0 observed an uncached replay at +55%).
 *
 * The first limit that fires is sticky: every later request is refused with
 * the same reason, and `onLimit` runs once.
 */
export class GrokBrokerTurnMeter {
  private readonly startedAt: number;
  private readonly timings: { startedAt: string; endedAt?: string; usage?: EngineBrokerTurnUsage }[] = [];
  private tokens = 0;
  private reason: EngineBrokerLimitReason = "none";
  constructor(readonly limits: EngineBrokerTurnLimits, private readonly onLimit: (reason: Exclude<EngineBrokerLimitReason, "none">) => void = () => undefined, private readonly now: () => number = Date.now) {
    this.startedAt = now();
  }

  /** Returns the request index when admitted, or the limit that refused it. */
  admit(): Readonly<{ index: number } | { refused: Exclude<EngineBrokerLimitReason, "none"> }> {
    if (this.reason === "none") {
      if (this.now() - this.startedAt >= this.limits.timeoutMs) this.trip("timeout");
      else if (this.timings.length >= this.limits.maxRequests) this.trip("requests");
      else if (this.tokens >= this.limits.maxTokens) this.trip("tokens");
    }
    if (this.reason !== "none") return { refused: this.reason };
    this.timings.push({ startedAt: new Date(this.now()).toISOString() });
    return { index: this.timings.length - 1 };
  }

  /** Records one admitted request's end and its upstream-reported usage, when the body carried any. */
  settle(index: number, usage: EngineBrokerTurnUsage | undefined): void {
    const timing = this.timings[index];
    if (timing === undefined || timing.endedAt !== undefined) return;
    timing.endedAt = new Date(this.now()).toISOString();
    if (usage === undefined) return;
    timing.usage = usage;
    this.tokens += usage.total;
  }

  /** Trips a limit from outside the request path (the broker's wall-clock timer). */
  trip(reason: Exclude<EngineBrokerLimitReason, "none">): void {
    if (this.reason !== "none") return;
    this.reason = reason;
    this.onLimit(reason);
  }

  snapshot(): GrokBrokerTurnMeterSnapshot {
    const measured = this.timings.flatMap((timing) => timing.usage === undefined ? [] : [timing.usage]);
    return { requests: this.timings.length, tokens: this.tokens, limitReason: this.reason, usage: sumEngineBrokerTurnUsage(measured), timings: this.timings.map((timing) => Object.freeze({ ...timing })) };
  }
}

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
 * total invariant holds. A malformed block is ignored, never zero-filled.
 */
export function parseGrokUpstreamUsage(body: Uint8Array, contentType: string | undefined): EngineBrokerTurnUsage | undefined {
  const text = Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("utf8");
  const candidates: unknown[] = [];
  if (contentType?.includes("text/event-stream") === true || text.startsWith("data:")) {
    for (const line of text.split(/\r?\n/u)) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]" || payload.length === 0) continue;
      try { candidates.push(JSON.parse(payload)); } catch { /* a non-JSON event carries no usage */ }
    }
  } else {
    try { candidates.push(JSON.parse(text)); } catch { return undefined; }
  }
  let found: EngineBrokerTurnUsage | undefined;
  for (const candidate of candidates) {
    if (!isRecord(candidate) || !isRecord(candidate.usage)) continue;
    const decoded = decodeOpenAiUsage(candidate.usage);
    if (decoded !== undefined) found = decoded;
  }
  return found;
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
  return { input: prompt - cached, cacheRead: cached, cacheWrite: 0, output, total, ...(reasoning === undefined || reasoning > output ? {} : { reasoning }) };
}

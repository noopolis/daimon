/**
 * Per-request token accounting read off a Grok `streaming-messages-json`
 * stream.
 *
 * Grok 1.0.34 puts the usage of each model request on that request's
 * top-level `assistant` frame (`message.usage`, the same four disjoint
 * Messages API buckets as the terminal `result.usage`), before any tool result
 * of that request, and the per-request frames sum exactly to the terminal
 * result (P0 host matrix). That makes the stream usable in two places the
 * terminal frame is not: a turn that failed before its `result` frame, and a
 * per-request ledger row.
 *
 * Never throws, and never invents a number: a usage block that is present but
 * does not decode discards *all* requests, because one fabricated zero is
 * byte-identical to a measured one.
 */
export type GrokRequestUsage = Readonly<{ index: number; input: number; cacheRead: number; cacheWrite: number; output: number; total: number }>;
export type GrokStreamUsage = Readonly<{ requests: readonly GrokRequestUsage[]; sessionId?: string; reportedModels: readonly string[] }>;

type JsonRecord = Readonly<Record<string, unknown>>;
const isRecord = (value: unknown): value is JsonRecord => typeof value === "object" && value !== null && !Array.isArray(value);
const tokenCount = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/u;
const MODEL_KEY = /^[a-z0-9][a-z0-9.-]{0,63}$/u;

const decodeUsage = (usage: unknown): Omit<GrokRequestUsage, "index"> | undefined => {
  if (!isRecord(usage)) return undefined;
  const input = tokenCount(usage.input_tokens), output = tokenCount(usage.output_tokens), cacheRead = tokenCount(usage.cache_read_input_tokens), cacheWrite = tokenCount(usage.cache_creation_input_tokens);
  if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined) return undefined;
  return { input, cacheRead, cacheWrite, output, total: input + cacheRead + cacheWrite + output };
};

export const decodeGrokStreamUsage = (output: string): GrokStreamUsage => {
  const byMessage = new Map<string, Omit<GrokRequestUsage, "index">>();
  const reportedModels = new Set<string>();
  let sessionId: string | undefined, corrupt = false;
  for (const line of output.split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    let event: unknown;
    try { event = JSON.parse(line); } catch { continue; }
    if (!isRecord(event)) continue;
    if (typeof event.session_id === "string" && SESSION_ID.test(event.session_id)) sessionId ??= event.session_id;
    if (event.type === "result" && isRecord(event.modelUsage)) for (const key of Object.keys(event.modelUsage)) reportedModels.add(MODEL_KEY.test(key) ? key : "invalid");
    if (event.type !== "assistant" || event.parent_tool_use_id !== null || !isRecord(event.message) || event.message.usage === undefined) continue;
    const decoded = decodeUsage(event.message.usage);
    if (decoded === undefined || typeof event.message.id !== "string") { corrupt = true; continue; }
    // One request can surface as more than one frame of the same message; it is one request.
    byMessage.set(event.message.id, decoded);
  }
  const requests = corrupt ? [] : [...byMessage.values()].map((usage, index) => Object.freeze({ index, ...usage }));
  return { requests, ...(sessionId === undefined ? {} : { sessionId }), reportedModels: [...reportedModels].sort() };
};

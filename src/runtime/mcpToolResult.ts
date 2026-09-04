/**
 * Lowering an upstream MCP server's `CallToolResult` onto a Pi tool result.
 *
 * Every `mcp_*` tool is a *passthrough*: Daimon calls a declared MCP server and
 * has to hand the model back what that server actually said. It used to hand
 * back routing metadata instead — `details: { server, tool, is_error }` — and
 * because the MCP mount lowers `details` to `structuredContent`
 * (`src/mcp/toolServer.ts`) and the engines render `structuredContent` in
 * preference to `content`, an agent calling any declared MCP tool saw
 * `{"server":"newsroom","tool":"file_article","is_error":true}` and nothing
 * else. The tool's own answer, and the reason for its own failure, never
 * reached the model. `moltnet_read` was the same defect in a Daimon-authored
 * tool; this is the wider one, in the tools Daimon does not author.
 *
 * Three rules follow, and they are the whole design:
 *
 *   1. **Both channels always carry the payload.** `content` and
 *      `structuredContent` are each filled with the result, mirroring whichever
 *      one the server did not send. Daimon has already been wrong once about
 *      which channel an engine renders; carrying the answer in both is the only
 *      shape where being wrong again costs nothing. A server that sent
 *      `structuredContent` gets it forwarded *verbatim*, so a declared
 *      `outputSchema` still describes what the model sees.
 *
 *   2. **`isError` is raised, not reported.** Pi's `AgentToolResult` has no
 *      error channel — a Pi tool signals failure by throwing, and
 *      `toolServer.ts` lowers a throw to `isError: true` plus the message. So an
 *      upstream `isError: true` becomes a thrown {@link McpToolCallError}
 *      carrying the server's own reason text. The model then gets a result
 *      flagged as a failure *and* the sentence explaining it, which is the
 *      difference between correcting a call and guessing at it.
 *
 *   3. **The bound truncates; it never throws the payload away.** An oversized
 *      result used to be refused outright, so the agent got
 *      `Error: MCP tool result exceeds bound` and none of the data. It is now
 *      degraded to a head of the serialized result plus an explicit marker
 *      naming both sizes.
 *
 * Daimon deliberately does *not* re-declare the upstream `outputSchema` on its
 * own mount. A declared output schema obliges every result to carry conforming
 * `structuredContent`, which neither a content-only server response nor rule 3's
 * truncation marker can satisfy — declaring it would turn a degraded result into
 * a client-side protocol error and lose the payload all over again.
 */

/** Bound on the whole receipt record, mirrored from `productionAgentTools.ts`. */
const MAX_RECEIPT_BYTES = 65_536;

/**
 * Headroom left inside the receipt bound for the receipt's own envelope.
 *
 * A successful MCP result is stored in its receipt so a replayed identical call
 * in the same wake answers with the result rather than with a digest of it. The
 * envelope (`kind`, ids, engine, server, tool, digest, `is_error`, `at`) is a
 * few hundred bytes for any sane name; 4096 is generous enough that a stored
 * result can never push the receipt past its own bound.
 */
export const MCP_RECEIPT_ENVELOPE_RESERVE_BYTES = 4_096;

/** Bound on one lowered MCP tool result, model-facing and receipt-facing alike. */
export const MCP_TOOL_RESULT_MAX_BYTES = MAX_RECEIPT_BYTES - MCP_RECEIPT_ENVELOPE_RESERVE_BYTES;

/** Rendered for a server that answered with neither content nor structured content. */
export const MCP_EMPTY_RESULT_TEXT = "[daimon: the MCP server returned a result with no content]";

/** Reason used when a server flags an error but supplies no text for it. */
export const MCP_ERROR_WITHOUT_DETAIL = "the MCP server reported an error and gave no reason";

/**
 * An upstream MCP tool that answered with `isError: true`.
 *
 * The reason is the server's own words. `toolServer.ts` renders a thrown error
 * as `"<name>: <message>"` inside an `isError: true` result, so the model
 * receives both the failure flag and the explanation.
 */
export class McpToolCallError extends Error {
  public readonly server: string;
  public readonly tool: string;
  public readonly reason: string;

  public constructor(server: string, tool: string, reason: string) {
    super(`${server}/${tool} failed: ${reason}`);
    this.name = "McpToolCallError";
    this.server = server;
    this.tool = tool;
    this.reason = reason;
  }
}

/** The fields of an upstream `CallToolResult` that Daimon reads. */
export interface McpUpstreamResult {
  readonly content?: unknown;
  readonly structuredContent?: unknown;
  readonly isError?: unknown;
}

/** A lowered result, ready to be returned from a Pi `ToolDefinition.execute`. */
export interface RenderedMcpToolResult {
  readonly content: readonly unknown[];
  readonly details: Record<string, unknown>;
  readonly truncated: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Flatten an MCP content array to text, naming the parts that are not text. */
export function mcpContentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!isRecord(part)) return "";
      if (part.type === "text" && typeof part.text === "string") return part.text;
      return `[${typeof part.type === "string" ? part.type : "unknown"} content part]`;
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

/** Truncate to a byte budget without splitting a UTF-8 code point. */
export function truncateUtf8(value: string, maxBytes: number): { text: string; truncated: boolean; originalBytes: number } {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return { text: value, truncated: false, originalBytes: bytes.byteLength };
  let end = Math.max(0, maxBytes);
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return { text: bytes.subarray(0, end).toString("utf8"), truncated: true, originalBytes: bytes.byteLength };
}

const truncationMarker = (resultBytes: number, boundBytes: number): string =>
  `\n[daimon: truncated — the MCP tool result was ${resultBytes} bytes, above the ${boundBytes}-byte tool result bound]`;

/**
 * The server's own explanation for an `isError: true` result.
 *
 * Both channels are consulted, because a server may put a human sentence in
 * `content` and a machine-readable code in `structuredContent`, and an agent
 * that has to fix its own call needs whichever one it was given.
 */
export function mcpErrorReason(result: McpUpstreamResult, maxBytes: number): string {
  const text = mcpContentText(result.content);
  const structured = result.structuredContent === undefined ? "" : safeStringify(result.structuredContent);
  const reason = [text, structured].filter((piece) => piece.length > 0).join(" ");
  if (reason.length === 0) return MCP_ERROR_WITHOUT_DETAIL;
  const bounded = truncateUtf8(reason, maxBytes);
  return bounded.truncated ? `${bounded.text}${truncationMarker(bounded.originalBytes, maxBytes)}` : bounded.text;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "[daimon: the MCP server returned a value that is not JSON-serialisable]";
  }
}

/** Everything a result carries beyond the three fields this module names. */
function otherFields(result: McpUpstreamResult): Record<string, unknown> | undefined {
  if (!isRecord(result)) return undefined;
  const rest = Object.fromEntries(Object.entries(result).filter(([key]) => key !== "content" && key !== "structuredContent" && key !== "isError"));
  return Object.keys(rest).length === 0 ? undefined : rest;
}

const measure = (content: readonly unknown[], details: Record<string, unknown>): number =>
  Buffer.byteLength(safeStringify({ content, structuredContent: details }), "utf8");

/**
 * Lower one upstream result, or throw {@link McpToolCallError} when it is an
 * error result.
 */
export function renderMcpToolResult(input: {
  readonly server: string;
  readonly tool: string;
  readonly result: McpUpstreamResult;
  readonly maxBytes?: number;
}): RenderedMcpToolResult {
  const maxBytes = input.maxBytes ?? MCP_TOOL_RESULT_MAX_BYTES;
  if (input.result.isError === true) {
    throw new McpToolCallError(input.server, input.tool, mcpErrorReason(input.result, Math.floor(maxBytes / 2)));
  }
  const upstreamContent = Array.isArray(input.result.content) ? input.result.content : undefined;
  // A server predating the `content` field answers in some other shape entirely
  // (the SDK still types `toolResult` for those). Forward whatever it did send
  // rather than reporting an empty result over the top of a real one.
  const legacy = upstreamContent === undefined && !isRecord(input.result.structuredContent) ? otherFields(input.result) : undefined;
  const structured = isRecord(input.result.structuredContent) ? input.result.structuredContent : legacy;
  const content: readonly unknown[] = upstreamContent !== undefined && upstreamContent.length > 0
    ? upstreamContent
    : structured !== undefined
      ? [{ type: "text", text: safeStringify(structured) }]
      : [{ type: "text", text: MCP_EMPTY_RESULT_TEXT }];
  // Rule 1: the channel the server left empty mirrors the one it filled, so the
  // payload is present whichever one the engine chooses to render.
  const details: Record<string, unknown> = structured ?? { content: upstreamContent ?? [] };
  if (measure(content, details) <= maxBytes) return { content, details, truncated: false };
  return degrade(input.result, measure(content, details), maxBytes);
}

/**
 * Rule 3: an oversized result becomes a bounded head of itself plus a marker.
 *
 * Both channels still mirror each other, so the head is written twice; the
 * budget is halved to pay for that and then shrunk until the whole record
 * genuinely fits, rather than trusting an estimate of the JSON overhead.
 */
function degrade(result: McpUpstreamResult, resultBytes: number, maxBytes: number): RenderedMcpToolResult {
  const serialized = safeStringify({
    ...(result.content === undefined ? {} : { content: result.content }),
    ...(result.structuredContent === undefined ? {} : { structured_content: result.structuredContent })
  });
  const marker = truncationMarker(resultBytes, maxBytes);
  const build = (head: string): RenderedMcpToolResult => ({
    content: [{ type: "text", text: `${head}${marker}` }],
    details: { daimon_truncated: true, bound_bytes: maxBytes, result_bytes: resultBytes, result_json_head: head },
    truncated: true
  });
  let budget = Math.max(0, Math.floor(maxBytes / 2));
  let candidate = build(truncateUtf8(serialized, budget).text);
  for (let attempt = 0; attempt < 8 && budget > 0; attempt += 1) {
    const size = measure(candidate.content, candidate.details);
    if (size <= maxBytes) return candidate;
    budget = Math.max(0, budget - Math.ceil((size - maxBytes) / 2) - 16);
    candidate = build(truncateUtf8(serialized, budget).text);
  }
  return candidate;
}

/** The result of one MCP call, as stored in its receipt for replay. */
export interface McpReceiptResult {
  readonly content: readonly unknown[];
  readonly details: Record<string, unknown>;
}

/**
 * Rebuild a tool answer from a receipt written by an earlier identical call.
 *
 * The wake-scoped receipt exists so a repeated identical call is not sent
 * upstream twice. It used to be *returned* to the model in place of the result,
 * so a retried call answered with `{"kind":"mcp",…,"digest":"sha256:…"}` — the
 * least useful thing an agent stuck in a retry loop could possibly receive.
 * A recorded failure is replayed as the same failure, with the same reason.
 */
export function replayMcpReceipt(server: string, tool: string, receipt: Record<string, unknown>): RenderedMcpToolResult {
  if (typeof receipt.error === "string") throw new McpToolCallError(server, tool, receipt.error);
  const stored = receipt.result;
  if (isRecord(stored) && Array.isArray(stored.content) && isRecord(stored.details)) {
    return { content: stored.content, details: stored.details, truncated: receipt.truncated === true };
  }
  throw new McpToolCallError(
    server,
    tool,
    "an identical earlier call in this wake was recorded without its result, so it cannot be replayed; change the arguments to make a new call"
  );
}

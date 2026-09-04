import assert from "node:assert/strict";
import test from "node:test";

import {
  MCP_EMPTY_RESULT_TEXT,
  MCP_ERROR_WITHOUT_DETAIL,
  MCP_TOOL_RESULT_MAX_BYTES,
  McpToolCallError,
  mcpContentText,
  mcpErrorReason,
  renderMcpToolResult,
  replayMcpReceipt,
  truncateUtf8
} from "./mcpToolResult.js";

/** `assert.throws` returns nothing, so capture the error to assert on its reason. */
const caught = (run: () => unknown): McpToolCallError => {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof McpToolCallError, `expected an McpToolCallError, got ${String(error)}`);
    return error;
  }
  throw new assert.AssertionError({ message: "expected the call to fail" });
};

const rendered = (result: Parameters<typeof renderMcpToolResult>[0]["result"], maxBytes?: number) =>
  renderMcpToolResult({ server: "newsroom", tool: "file_article", result, ...(maxBytes === undefined ? {} : { maxBytes }) });

test("a content-only result reaches the model through both channels", () => {
  const result = rendered({ content: [{ type: "text", text: "3 headlines on the wire" }] });
  assert.deepEqual(result.content, [{ type: "text", text: "3 headlines on the wire" }]);
  // `details` becomes `structuredContent`, which the engines render in
  // preference to `content`; a server that filled only `content` must not
  // leave that channel carrying routing metadata.
  assert.deepEqual(result.details, { content: [{ type: "text", text: "3 headlines on the wire" }] });
  assert.ok(JSON.stringify(result.details).includes("3 headlines on the wire"));
  assert.equal(result.truncated, false);
});

test("a structured-only result reaches the model verbatim, and is mirrored into content", () => {
  const result = rendered({ structuredContent: { open: true, editor: "irene" } });
  assert.deepEqual(result.details, { open: true, editor: "irene" }, "a declared outputSchema still describes what the model sees");
  assert.deepEqual(result.content, [{ type: "text", text: '{"open":true,"editor":"irene"}' }]);
});

test("a result carrying both channels forwards each of them unchanged", () => {
  const result = rendered({
    content: [{ type: "text", text: "3 headlines" }],
    structuredContent: { headline_count: 3 }
  });
  assert.deepEqual(result.content, [{ type: "text", text: "3 headlines" }]);
  assert.deepEqual(result.details, { headline_count: 3 });
});

test("a result with neither channel says so rather than rendering as empty", () => {
  const result = rendered({});
  assert.deepEqual(result.content, [{ type: "text", text: MCP_EMPTY_RESULT_TEXT }]);
  assert.deepEqual(result.details, { content: [] });
});

test("an error result raises the server's own reason, not a routing summary", () => {
  const reason = "file_article: 'headline' is required and must be a non-empty string.";
  const error = caught(() => rendered({ isError: true, content: [{ type: "text", text: reason }] }));
  assert.equal(error.reason, reason);
  assert.equal(error.message, `newsroom/file_article failed: ${reason}`);
  // `toolServer.ts` renders a thrown error as `"<name>: <message>"` inside an
  // `isError: true` result, so this is exactly the sentence the model receives.
  assert.match(`${error.name}: ${error.message}`, /'headline' is required/u);
});

test("an error result surfaces a machine-readable code alongside the sentence", () => {
  const error = caught(() => rendered({
    isError: true,
    content: [{ type: "text", text: "section \"sports\" is not allowed." }],
    structuredContent: { code: "unknown_section", allowed: ["news", "opinion"] }
  }));
  assert.match(error.reason, /unknown_section/u);
  assert.match(error.reason, /is not allowed/u);
});

test("an error result with no detail is still unambiguously a failure", () => {
  const error = caught(() => rendered({ isError: true, content: [] }));
  assert.equal(error.reason, MCP_ERROR_WITHOUT_DETAIL);
});

test("an oversized error reason truncates with a marker rather than being dropped", () => {
  const error = caught(() => rendered({ isError: true, content: [{ type: "text", text: "x".repeat(4_000) }] }, 512));
  assert.match(error.reason, /^x+/u, "the head of the server's reason survives");
  assert.match(error.reason, /\[daimon: truncated — the MCP tool result was 4000 bytes/u);
});

test("an oversized result truncates with a marker instead of failing the call", () => {
  const body = "a".repeat(200_000);
  const result = rendered({ content: [{ type: "text", text: `ARCHIVE-HEAD ${body}` }], structuredContent: { entries: [1, 2, 3] } });
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify({ content: result.content, structuredContent: result.details })) <= MCP_TOOL_RESULT_MAX_BYTES);
  const text = (result.content[0] as { text: string }).text;
  assert.match(text, /ARCHIVE-HEAD/u, "the head of the payload survives the bound");
  assert.match(text, /\[daimon: truncated — the MCP tool result was \d+ bytes, above the 61440-byte tool result bound\]/u);
  assert.equal(result.details.daimon_truncated, true);
  assert.match(String(result.details.result_json_head), /ARCHIVE-HEAD/u, "both channels still carry the surviving payload");
});

test("truncation converges even when the bound is tiny", () => {
  for (const maxBytes of [0, 1, 32, 200, 1_024]) {
    const result = rendered({ content: [{ type: "text", text: "z".repeat(50_000) }] }, maxBytes);
    assert.equal(result.truncated, true);
    assert.match((result.content[0] as { text: string }).text, /\[daimon: truncated/u, `bound ${maxBytes} keeps its marker`);
  }
});

test("truncation never splits a UTF-8 code point", () => {
  const value = "é".repeat(64);
  const cut = truncateUtf8(value, 9);
  assert.equal(cut.truncated, true);
  assert.equal(cut.text, "é".repeat(4), "the 9th byte is a continuation byte and is dropped whole");
  assert.equal(cut.originalBytes, 128);
  assert.equal(truncateUtf8(value, 128).truncated, false);
});

test("non-text content parts are named rather than silently dropped from a reason", () => {
  assert.equal(mcpContentText([{ type: "image", data: "…" }, { type: "text", text: "why" }]), "[image content part]\nwhy");
  assert.equal(mcpErrorReason({ content: "not-an-array" }, 100), MCP_ERROR_WITHOUT_DETAIL);
});

test("a replayed receipt returns the recorded result, never the receipt", () => {
  const stored = { kind: "mcp", digest: "sha256:abc", is_error: false, result: { content: [{ type: "text", text: "filed" }], details: { filed: true } } };
  const replayed = replayMcpReceipt("newsroom", "file_article", stored);
  assert.deepEqual(replayed.content, [{ type: "text", text: "filed" }]);
  assert.deepEqual(replayed.details, { filed: true });
  assert.ok(!JSON.stringify(replayed).includes("sha256:abc"), "the digest is audit state, not the tool's answer");
});

test("a replayed failure fails again for the same recorded reason", () => {
  const error = caught(() => replayMcpReceipt("newsroom", "file_article", { kind: "mcp", is_error: true, error: "'headline' is required" }));
  assert.equal(error.reason, "'headline' is required");
});

test("a receipt with no recorded result says so instead of passing metadata off as the answer", () => {
  const error = caught(() => replayMcpReceipt("newsroom", "file_article", { kind: "mcp", server: "newsroom", tool: "file_article", is_error: false }));
  assert.match(error.reason, /cannot be replayed/u);
});

test("a server answering in the pre-content compatibility shape still reaches the model", () => {
  const result = rendered({ toolResult: { filed: true, id: 7 } } as never);
  assert.deepEqual(result.details, { toolResult: { filed: true, id: 7 } });
  assert.deepEqual(result.content, [{ type: "text", text: '{"toolResult":{"filed":true,"id":7}}' }]);
});

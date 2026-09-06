import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { renderMcpToolResult, MCP_TOOL_RESULT_MAX_BYTES, type McpUpstreamResult } from "./mcpToolResult.js";
import {
  capToolResult,
  DEFAULT_TOOL_RESULT_MAX_BYTES,
  MIN_TOOL_RESULT_MAX_BYTES,
  resolveExemptToolNames,
  resolveToolResultMaxBytes,
  spillPayload,
  TOOL_OUTPUT_RETAINED_FILES,
  TOOL_RESULT_EXEMPT_ENV,
  TOOL_RESULT_MAX_BYTES_ENV
} from "./toolResultSpill.js";

const measure = (content: readonly unknown[], details: Record<string, unknown>): number =>
  Buffer.byteLength(JSON.stringify({ content, structuredContent: details }), "utf8");

const withDirectory = async (body: (directory: string) => Promise<void>): Promise<void> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "daimon-tool-spill-"));
  try { await body(directory); } finally { await rm(directory, { recursive: true, force: true }); }
};

const cap = async (
  result: McpUpstreamResult,
  options: Partial<{ maxBytes: number; exempt: ReadonlySet<string>; spillDirectory: string; toolName: string; spillId: string }> = {}
) => capToolResult({
  toolName: options.toolName ?? "mcp_desk_archive_dump",
  rendered: renderMcpToolResult({ server: "desk", tool: "archive_dump", result, maxBytes: MCP_TOOL_RESULT_MAX_BYTES }),
  result,
  maxBytes: options.maxBytes ?? DEFAULT_TOOL_RESULT_MAX_BYTES,
  exempt: options.exempt ?? new Set(),
  spillDirectory: options.spillDirectory ?? path.join(os.tmpdir(), "daimon-unused-spill"),
  spillId: options.spillId ?? "daimon-abc123"
});

test("a result under the cap passes through byte-identical", async () => {
  const result: McpUpstreamResult = {
    content: [{ type: "text", text: "3 headlines on the wire" }],
    structuredContent: { headline_count: 3, headlines: ["strike", "budget", "weather"] }
  };
  const rendered = renderMcpToolResult({ server: "desk", tool: "wire_summary", result, maxBytes: MCP_TOOL_RESULT_MAX_BYTES });
  const capped = await cap(result);
  assert.equal(capped.truncated, false);
  assert.deepEqual(capped.content, rendered.content, "an upstream content array is forwarded unchanged");
  assert.deepEqual(capped.details, rendered.details, "an upstream structuredContent is still forwarded verbatim");
  assert.equal(JSON.stringify(capped.content), JSON.stringify(rendered.content));
  assert.equal(capped.spillPath, undefined);
});

test("a result over the cap is truncated head and tail, and the record fits the cap", async () => {
  await withDirectory(async (directory) => {
    const body = `HEAD-MARKER${"a".repeat(200_000)}TAIL-MARKER`;
    const capped = await cap({ content: [{ type: "text", text: body }] }, { spillDirectory: directory, maxBytes: 16_384 });
    assert.equal(capped.truncated, true);
    assert.ok(measure(capped.content, capped.details) <= 16_384, "the capped record is under the bound it names");
    const text = JSON.stringify(capped.content);
    assert.match(text, /HEAD-MARKER/u, "the head of the payload survives");
    assert.match(text, /TAIL-MARKER/u, "the tail survives too — a head-only view loses the answer's conclusion");
    assert.match(text, /bytes elided/u);
  });
});

test("the truncation notice names the file and the exact way to read it", async () => {
  await withDirectory(async (directory) => {
    const body = `HEAD${"a".repeat(200_000)}TAIL`;
    const capped = await cap({ content: [{ type: "text", text: body }] }, { spillDirectory: directory });
    const notice = JSON.stringify(capped.content);
    assert.ok(capped.spillPath !== undefined);
    assert.ok(notice.includes(capped.spillPath!), "the model is told where the full result is");
    assert.match(notice, /sed -n/u, "and how to read it");
    assert.match(notice, /grep -n/u);
    assert.match(notice, /do NOT repeat this tool call/u, "a bare truncation notice causes a re-run of the same expensive call");
    assert.equal(capped.details.full_output_path, capped.spillPath, "the path is in the channel the engines render, not only in content");
  });
});

test("the spilled file holds the complete payload, re-fetchable byte for byte", async () => {
  await withDirectory(async (directory) => {
    const body = `HEAD${"a".repeat(200_000)}TAIL`;
    const capped = await cap({ content: [{ type: "text", text: body }] }, { spillDirectory: directory });
    assert.equal(await readFile(capped.spillPath!, "utf8"), body, "the elided middle is genuinely recoverable");
    assert.equal(capped.details.result_bytes, Buffer.byteLength(body, "utf8"));
  });
});

test("an exempt tool is never truncated and keeps exactly today's behaviour", async () => {
  await withDirectory(async (directory) => {
    const result: McpUpstreamResult = { content: [{ type: "text", text: `HEAD${"a".repeat(200_000)}TAIL` }] };
    const rendered = renderMcpToolResult({ server: "desk", tool: "archive_dump", result, maxBytes: MCP_TOOL_RESULT_MAX_BYTES });
    const capped = await cap(result, { spillDirectory: directory, exempt: new Set(["mcp_desk_archive_dump"]) });
    assert.deepEqual(capped.content, rendered.content);
    assert.deepEqual(capped.details, rendered.details);
    assert.equal(capped.spillPath, undefined);
    assert.deepEqual(await readdir(directory), [], "an exempt tool writes no spill file at all");
  });
});

test("a save failure still truncates, and says the middle is unrecoverable", async () => {
  await withDirectory(async (directory) => {
    // A file where the spill directory should be: the write cannot succeed.
    const blocked = path.join(directory, "blocked");
    await writeFile(blocked, "not a directory");
    const capped = await cap({ content: [{ type: "text", text: `HEAD${"a".repeat(200_000)}TAIL` }] }, { spillDirectory: blocked });
    assert.equal(capped.truncated, true, "re-exposing the full output on a disk error is worse than truncating");
    assert.equal(capped.spillPath, undefined);
    assert.equal(capped.details.full_output_saved, false);
    assert.match(JSON.stringify(capped.content), /could NOT be written to disk/u);
    assert.match(JSON.stringify(capped.content), /narrow the call's arguments/u);
  });
});

test("a structured or mixed result spills losslessly as its serialized record", () => {
  assert.equal(spillPayload({ content: [{ type: "text", text: "plain" }] }).format, "text");
  assert.equal(spillPayload({ content: [{ type: "text", text: "plain" }], structuredContent: { a: 1 } }).format, "json");
  assert.equal(spillPayload({ structuredContent: { a: 1 } }).format, "json");
  const mixed = spillPayload({ content: [{ type: "text", text: "t" }, { type: "image", data: "AAA" }] });
  assert.equal(mixed.format, "json");
  assert.match(mixed.text, /"image"/u, "a non-text part is preserved in the spill rather than described away");
});

test("the head/tail view never splits a UTF-8 code point", async () => {
  await withDirectory(async (directory) => {
    const capped = await cap({ content: [{ type: "text", text: "é".repeat(120_000) }] }, { spillDirectory: directory });
    assert.equal(JSON.stringify(capped.content).includes("\\ufffd"), false);
    assert.equal(JSON.stringify(capped.details).includes("\\ufffd"), false);
  });
});

test("spilled files are pruned newest-first so an agent cannot fill its own runtime home", async () => {
  await withDirectory(async (directory) => {
    const body = `HEAD${"a".repeat(40_000)}TAIL`;
    for (let index = 0; index < TOOL_OUTPUT_RETAINED_FILES + 4; index += 1) {
      await cap({ content: [{ type: "text", text: body }] }, { spillDirectory: directory, spillId: `daimon-${index}` });
    }
    const remaining = await readdir(directory);
    assert.ok(remaining.length <= TOOL_OUTPUT_RETAINED_FILES + 1, `retained ${remaining.length}`);
  });
});

test("the bound and the exemption list come from the environment, and a nonsense bound is refused", () => {
  assert.equal(resolveToolResultMaxBytes({}), DEFAULT_TOOL_RESULT_MAX_BYTES);
  assert.equal(resolveToolResultMaxBytes({ [TOOL_RESULT_MAX_BYTES_ENV]: "32768" }), 32_768);
  assert.throws(() => resolveToolResultMaxBytes({ [TOOL_RESULT_MAX_BYTES_ENV]: "12" }), new RegExp(`at least ${MIN_TOOL_RESULT_MAX_BYTES}`, "u"));
  assert.throws(() => resolveToolResultMaxBytes({ [TOOL_RESULT_MAX_BYTES_ENV]: "lots" }), /must be an integer/u);
  assert.deepEqual([...resolveExemptToolNames({})], []);
  assert.deepEqual([...resolveExemptToolNames({ [TOOL_RESULT_EXEMPT_ENV]: " mcp_a_b , mcp_c_d ," })], ["mcp_a_b", "mcp_c_d"]);
});

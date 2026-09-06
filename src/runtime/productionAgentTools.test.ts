import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import test from "node:test";

import { createProductionAgentTools } from "./productionAgentTools.js";
import { MCP_TOOL_RESULT_MAX_BYTES } from "./mcpToolResult.js";
import { DEFAULT_TOOL_RESULT_MAX_BYTES, TOOL_RESULT_EXEMPT_ENV } from "./toolResultSpill.js";
import type { OrganizationRuntimeAgentConfig } from "./organizationRuntime.js";

async function receipts(root: string): Promise<string[]> {
  return await Promise.all((await readdir(path.join(root, "tool-state"))).filter((name) => name.endsWith(".json")).map((name) => readFile(path.join(root, "tool-state", name), "utf8")));
}

test("production cognition mounts only declared MCP tools and records a bounded receipt", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-production-tools-"));
  try {
    const agent: OrganizationRuntimeAgentConfig = { id: "alpha", name: "Alpha", instructions: "work", workspacePath: root, runtimeHomePath: root, engine: { kind: "codex" }, mcp: [{ name: "lifecycle", transport: "stdio", command: process.execPath, args: [path.resolve("src/runtime/fixtures/testMcpServer.mjs")], env: {}, tools: ["checkpoint"] }] };
    const tools = await createProductionAgentTools(agent, { current: "schedule:release" }); assert.deepEqual(tools.map((tool) => tool.name), ["mcp_lifecycle_checkpoint"]);
    const result = await tools[0]!.execute("call", { phase: "release" } as never, undefined, undefined, {} as never);
    // Asserted on `details` specifically: it is lowered to `structuredContent`,
    // which the engines render in preference to `content`, so a whole-result
    // `JSON.stringify` check passes while the model still sees nothing.
    assert.ok(JSON.stringify(result.details).includes(`release:home=${root}`), "the payload must reach the channel the engines render");
    assert.ok(JSON.stringify(result.content).includes(`release:home=${root}`));
    assert.equal(await readFile(path.join(root, "mcp-home-writable"), "utf8"), "ok"); assert.match((await receipts(root)).join(""), /"kind":"mcp".*"agent_id":"alpha".*"engine":"codex".*"tool":"checkpoint"/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("production Moltnet tool enforces compiled scope and records accepted message receipt", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-production-moltnet-"));
  try {
    const cli = path.join(root, "moltnet"); await writeFile(cli, `#!/usr/bin/env node\nimport(${JSON.stringify(url.pathToFileURL(path.resolve("src/runtime/fixtures/testMoltnetMachine.mjs")).href)});\n`); await chmod(cli, 0o755);
    const agent: OrganizationRuntimeAgentConfig = { id: "alpha", name: "Alpha", instructions: "work", workspacePath: root, runtimeHomePath: root, engine: { kind: "codex" }, moltnet: { cliPath: cli, configPath: path.join(root, "config.json"), networks: [{ id: "news", rooms: ["desk"], dms: false }] } };
    const tool = (await createProductionAgentTools(agent, { current: "schedule:occurrence" }))[0]!;
    await assert.rejects(tool.execute("call", { network: "news", target: "dm:beta", text: "no" } as never, undefined, undefined, {} as never), /not declared/u);
    await tool.execute("call", { network: "news", target: "room:desk", text: "é".repeat(1024) } as never, undefined, undefined, {} as never);
    await assert.rejects(tool.execute("call", { network: "news", target: "room:desk", text: `${"é".repeat(1024)}a` } as never, undefined, undefined, {} as never), /exceeds declared scope/u);
    await tool.execute("call", { network: "news", target: "room:desk", text: "hello" } as never, undefined, undefined, {} as never);
    await tool.execute("call", { network: "news", target: "room:desk", text: "hello" } as never, undefined, undefined, {} as never);
    const replacement = (await createProductionAgentTools(agent, { current: "schedule:occurrence" }))[0]!;
    await replacement.execute("call", { network: "news", target: "room:desk", text: "hello" } as never, undefined, undefined, {} as never);
    const stored = await receipts(root); assert.match(stored.join(""), /"kind":"moltnet".*"delivery_id":"daimon-.*"message_id":"msg-1"/u); assert.equal(stored.length, 2);
    await writeFile(path.join(root, "tool-state", "unrelated-torn.json"), "{");
    await replacement.execute("call", { network: "news", target: "room:desk", text: "hello" } as never, undefined, undefined, {} as never);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an accepted Moltnet send records the wake as having spoken, but a read never does", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-production-moltnet-spoke-"));
  try {
    const cli = path.join(root, "moltnet"); await writeFile(cli, `#!/usr/bin/env node\nimport(${JSON.stringify(url.pathToFileURL(path.resolve("src/runtime/fixtures/testMoltnetMachine.mjs")).href)});\n`); await chmod(cli, 0o755);
    const agent: OrganizationRuntimeAgentConfig = { id: "alpha", name: "Alpha", instructions: "work", workspacePath: root, runtimeHomePath: root, engine: { kind: "codex" }, moltnet: { cliPath: cli, configPath: path.join(root, "config.json"), networks: [{ id: "news", rooms: ["desk"], dms: false }] } };
    const wakeContext = { current: "schedule:occurrence" as string | undefined, spokeFor: undefined as string | undefined };
    const [sendTool, readTool] = await createProductionAgentTools(agent, wakeContext);

    await readTool!.execute("call", { network: "news", target: "room:desk" } as never, undefined, undefined, {} as never);
    assert.equal(wakeContext.spokeFor, undefined, "moltnet_read must never mark the wake as spoken");

    await sendTool!.execute("call", { network: "news", target: "room:desk", text: "hello" } as never, undefined, undefined, {} as never);
    assert.equal(wakeContext.spokeFor, "schedule:occurrence", "an accepted send must record the delivery id of the wake that spoke");

    // A retried tool call that replays the same accepted receipt (the
    // idempotent path) still counts as having spoken this wake.
    wakeContext.spokeFor = undefined;
    await sendTool!.execute("call", { network: "news", target: "room:desk", text: "hello" } as never, undefined, undefined, {} as never);
    assert.equal(wakeContext.spokeFor, "schedule:occurrence", "a replayed accepted send must also record the wake as spoken");

    // A later wake for the same agent never inherits an earlier wake's flag.
    wakeContext.current = "schedule:next-occurrence";
    wakeContext.spokeFor = undefined;
    await readTool!.execute("call", { network: "news", target: "room:desk" } as never, undefined, undefined, {} as never);
    assert.equal(wakeContext.spokeFor, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Moltnet identifiers are local ids, never a colon-scoped agent id", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-production-moltnet-id-"));
  try {
    const cli = path.join(root, "moltnet"); await writeFile(cli, `#!/usr/bin/env node\nimport(${JSON.stringify(url.pathToFileURL(path.resolve("src/runtime/fixtures/testMoltnetMachine.mjs")).href)});\n`); await chmod(cli, 0o755);
    const agent: OrganizationRuntimeAgentConfig = { id: "alpha", name: "Alpha", instructions: "work", workspacePath: root, runtimeHomePath: root, engine: { kind: "codex" }, moltnet: { cliPath: cli, configPath: path.join(root, "config.json"), networks: [{ id: "news", rooms: ["desk"], dms: false }] } };
    const tool = (await createProductionAgentTools(agent, { current: "schedule:occurrence" }))[0]!;
    await tool.execute("call", { network: "news", target: "room:desk", text: "hello" } as never, undefined, undefined, {} as never);
    const stored = (await receipts(root)).join("");
    const deliveryId = (JSON.parse(stored) as { delivery_id: string }).delivery_id;
    assert.ok(!deliveryId.includes(":"), `delivery id must be a local id, got ${deliveryId}`);
    assert.match(deliveryId, /^daimon-[0-9a-f]{64}$/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

/**
 * Build the CLI shim the production tool spawns, pointing the fixture at a
 * corpus file and a request journal.
 */
async function moltnetCli(root: string, corpus: Record<string, unknown[]>): Promise<{ cli: string; journal: string }> {
  const corpusPath = path.join(root, "corpus.json");
  const journal = path.join(root, "journal.jsonl");
  await writeFile(corpusPath, JSON.stringify(corpus));
  await writeFile(journal, "");
  const cli = path.join(root, "moltnet");
  await writeFile(cli, `#!/usr/bin/env node\nprocess.env.DAIMON_TEST_MOLTNET_CORPUS=${JSON.stringify(corpusPath)};\nprocess.env.DAIMON_TEST_MOLTNET_JOURNAL=${JSON.stringify(journal)};\nimport(${JSON.stringify(url.pathToFileURL(path.resolve("src/runtime/fixtures/testMoltnetMachine.mjs")).href)});\n`);
  await chmod(cli, 0o755);
  return { cli, journal };
}

function roomMessage(index: number, text: string): Record<string, unknown> {
  return {
    id: `msg_${`${index}`.padStart(4, "0")}`,
    network_id: "news",
    origin: { network_id: "news", message_id: `msg_${`${index}`.padStart(4, "0")}` },
    target: { kind: "room", room_id: "desk" },
    from: { type: "agent", id: "beta", name: "Beta", network_id: "news" },
    parts: [{ kind: "text", text }],
    mentions: [],
    created_at: new Date(Date.UTC(2026, 8, 1, 0, index)).toISOString()
  };
}

function moltnetAgent(root: string, cli: string): OrganizationRuntimeAgentConfig {
  return { id: "alpha", name: "Alpha", instructions: "work", workspacePath: root, runtimeHomePath: root, engine: { kind: "codex" }, moltnet: { cliPath: cli, configPath: path.join(root, "config.json"), networks: [{ id: "news", rooms: ["desk"], dms: false }] } };
}

async function readTool(root: string, cli: string) {
  return (await createProductionAgentTools(moltnetAgent(root, cli), { current: "schedule:occurrence" }))[1]!;
}

async function journalEntries(file: string): Promise<Record<string, unknown>[]> {
  return (await readFile(file, "utf8")).split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("a Moltnet read delivers message text and the page cursor to the model, not just a count", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-moltnet-read-payload-"));
  try {
    const pitches = Array.from({ length: 6 }, (_value, index) => roomMessage(index + 1, `pitch ${index + 1}: ${"c".repeat(1_900)}`));
    const { cli } = await moltnetCli(root, { "room:desk": pitches });
    const result = await (await readTool(root, cli)).execute("call", { network: "news", target: "room:desk", limit: 6 } as never, undefined, undefined, {} as never) as { content: { text: string }[]; details: Record<string, unknown> };

    // `details` is what the MCP mount lowers to `structuredContent`, and that is
    // what the engines put in front of the model. Asserting on `content` alone
    // is what let a tool that returned nothing look identical to one that worked.
    const rendered = JSON.stringify(result.details);
    assert.match(rendered, /pitch 1:/u, "the model-visible field must carry message text");
    assert.match(rendered, /pitch 6:/u);
    assert.equal((result.details.messages as unknown[]).length, 6);
    assert.equal(result.details.message_count, 6);
    assert.deepEqual((result.details.page as Record<string, unknown>).has_more, false);
    assert.deepEqual(result.details.target, { kind: "room", id: "desk" });
    assert.deepEqual(JSON.parse(result.content[0]!.text), result.details, "content and details must carry the same payload");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a Moltnet read reports the next_before cursor when the room holds more than was asked for", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-moltnet-read-cursor-"));
  try {
    const { cli } = await moltnetCli(root, { "room:desk": Array.from({ length: 30 }, (_value, index) => roomMessage(index + 1, `note ${index + 1}`)) });
    const result = await (await readTool(root, cli)).execute("call", { network: "news", target: "room:desk", limit: 7 } as never, undefined, undefined, {} as never) as { details: Record<string, unknown> };
    const page = result.details.page as Record<string, unknown>;
    assert.equal(page.has_more, true);
    assert.equal(page.next_before, "msg_0024", "the model must receive a cursor it can page with");
    assert.equal((result.details.messages as { id: string }[]).at(0)?.id, "msg_0024");
    assert.equal((result.details.messages as { id: string }[]).at(-1)?.id, "msg_0030");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a room too large for one wire page is returned whole through cursor following", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-moltnet-read-paging-"));
  try {
    const room = Array.from({ length: 18 }, (_value, index) => roomMessage(index + 1, `story ${index + 1}: ${"d".repeat(600)}`));
    const { cli, journal } = await moltnetCli(root, { "room:desk": room });
    const result = await (await readTool(root, cli)).execute("call", { network: "news", target: "room:desk", limit: 18 } as never, undefined, undefined, {} as never) as { details: Record<string, unknown> };
    assert.deepEqual((result.details.messages as { id: string }[]).map((message) => message.id), room.map((message) => message.id as string), "every message, oldest first");
    const entries = await journalEntries(journal);
    assert.ok(entries.length >= 4, "an 18 message room cannot cross this wire in one page");
    assert.ok(entries.every((entry) => (entry.limit as number) <= 5));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a page that would exceed the 16 KB line cap is split rather than failed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-moltnet-read-cap-"));
  try {
    // Five of these overflow the frozen 16384 byte response line; two do not.
    const room = Array.from({ length: 8 }, (_value, index) => roomMessage(index + 1, `bulletin ${index + 1}: ${"e".repeat(3_600)}`));
    const { cli, journal } = await moltnetCli(root, { "room:desk": room });
    const result = await (await readTool(root, cli)).execute("call", { network: "news", target: "room:desk", limit: 8 } as never, undefined, undefined, {} as never) as { details: Record<string, unknown> };
    assert.deepEqual((result.details.messages as { id: string }[]).map((message) => message.id), room.map((message) => message.id as string));
    assert.equal(result.details.truncated, undefined, "a cap overflow must be paged around, never surfaced as a failed read");

    const entries = await journalEntries(journal);
    const refusals = entries.filter((entry) => entry.error === "transport");
    assert.ok(refusals.length > 0, "the wire must actually have refused an oversized page");
    assert.ok(refusals.every((entry) => (entry.limit as number) > 1));
    assert.ok(entries.some((entry) => entry.error === null && (entry.messages as number) > 0), "and a smaller page must then have succeeded");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a single message over the 4 KB part cap is reported and does not abort the read", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-moltnet-read-part-cap-"));
  try {
    const room = [
      ...Array.from({ length: 3 }, (_value, index) => roomMessage(index + 1, `early ${index + 1}`)),
      roomMessage(4, `oversized: ${"f".repeat(5_000)}`),
      ...Array.from({ length: 3 }, (_value, index) => roomMessage(index + 5, `late ${index + 5}`))
    ];
    const { cli } = await moltnetCli(root, { "room:desk": room });
    const result = await (await readTool(root, cli)).execute("call", { network: "news", target: "room:desk", limit: 7 } as never, undefined, undefined, {} as never) as { details: Record<string, unknown> };

    assert.deepEqual((result.details.messages as { id: string }[]).map((message) => message.id), ["msg_0005", "msg_0006", "msg_0007"], "the read keeps everything newer than the message it cannot fetch");
    const truncated = result.details.truncated as Record<string, unknown> | undefined;
    assert.equal(truncated?.reason, "message_exceeds_machine_wire_caps");
    assert.match(String(truncated?.detail), /4096 bytes/u);
    assert.equal(truncated?.cursor, "msg_0005");
    assert.equal((result.details.page as Record<string, unknown>).has_more, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a Moltnet error reaches the caller with its own code, not a generic refusal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-moltnet-read-error-"));
  try {
    const { cli } = await moltnetCli(root, { "room:desk": [roomMessage(1, "hello")] });
    // An unknown cursor is ErrInvalidCursor in the CLI, reported as transport.
    await assert.rejects(
      (await readTool(root, cli)).execute("call", { network: "news", target: "room:desk", before: "msg_9999" } as never, undefined, undefined, {} as never),
      /Moltnet read failed: transport/u
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});

/**
 * The declared-MCP passthrough, against a fixture that answers the way real
 * servers do. Every `mcp_*` tool used to return `{ server, tool, is_error }`
 * and nothing else, so each of these cases reached the model empty.
 */
function mcpAgent(root: string, tools: string[]): OrganizationRuntimeAgentConfig {
  return {
    id: "alpha", name: "Alpha", instructions: "work", workspacePath: root, runtimeHomePath: root, engine: { kind: "codex" },
    mcp: [{ name: "desk", transport: "stdio", command: process.execPath, args: [path.resolve("src/runtime/fixtures/testMcpServer.mjs")], env: { DAIMON_TEST_MCP_TOOLS: tools.join(",") }, tools }]
  };
}

/** `assert.rejects` yields nothing to inspect; capture the failure itself. */
async function failure(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof Error);
    return error;
  }
  throw new assert.AssertionError({ message: "expected the tool call to fail" });
}

test("a declared MCP tool's own payload reaches the model in every result shape", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-mcp-passthrough-"));
  try {
    const tools = await createProductionAgentTools(mcpAgent(root, ["checkpoint", "desk_status", "wire_summary"]), { current: "schedule:release" });
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    const contentOnly = await byName.get("mcp_desk_checkpoint")!.execute("call", { phase: "release" } as never, undefined, undefined, {} as never);
    assert.match(JSON.stringify(contentOnly.details), /release:home=/u, "a content-only server must still fill the rendered channel");

    const structuredOnly = await byName.get("mcp_desk_desk_status")!.execute("call", {} as never, undefined, undefined, {} as never);
    assert.deepEqual(structuredOnly.details, { open: true, editor: "irene", queue: ["draft-1", "draft-2"] }, "structured content passes through verbatim");
    assert.match(JSON.stringify(structuredOnly.content), /irene/u);

    const both = await byName.get("mcp_desk_wire_summary")!.execute("call", {} as never, undefined, undefined, {} as never);
    assert.deepEqual(both.details, { headline_count: 3, headlines: ["strike", "budget", "weather"] });
    assert.deepEqual(both.content, [{ type: "text", text: "3 headlines on the wire: strike, budget, weather" }]);

    for (const result of [contentOnly, structuredOnly, both]) {
      assert.ok(!JSON.stringify(result.details).includes("\"is_error\""), "routing metadata must never stand in for the payload");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a failing MCP tool reaches the model as a failure, with the server's reason intact", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-mcp-error-"));
  try {
    const tools = await createProductionAgentTools(mcpAgent(root, ["file_article", "silent_failure"]), { current: "schedule:edition" });
    const fileArticle = tools.find((tool) => tool.name === "mcp_desk_file_article")!;

    // The 17.6M-token case: an agent calls the tool with the wrong argument
    // shape and has to learn the right one from the answer, not by guessing.
    const missing = await failure(() => fileArticle.execute("call", { body: "text" } as never, undefined, undefined, {} as never));
    assert.equal(missing.name, "McpToolCallError");
    assert.match(missing.message, /'headline' is required and must be a non-empty string/u);
    assert.match(missing.message, /Expected \{headline: string, body: string, section: "news"\|"opinion"\}/u);
    // `toolServer.ts` renders exactly this string inside an `isError: true`
    // result, so it is verbatim what the model receives.
    assert.match(`${missing.name}: ${missing.message}`, /^McpToolCallError: desk\/file_article failed: /u);

    const badSection = await failure(() => fileArticle.execute("call", { headline: "h", body: "b", section: "sports" } as never, undefined, undefined, {} as never));
    assert.match(badSection.message, /is not one of "news" or "opinion"/u, "the sentence survives");
    assert.match(badSection.message, /unknown_section/u, "and so does the machine-readable code");

    const silent = await failure(() => tools.find((tool) => tool.name === "mcp_desk_silent_failure")!.execute("call", {} as never, undefined, undefined, {} as never));
    assert.match(silent.message, /reported an error and gave no reason/u);

    // A failure is recorded as one, and a repeated identical call fails again
    // for the same stated cause rather than replaying an opaque digest.
    const stored = (await receipts(root)).join("");
    assert.match(stored, /"is_error":true/u);
    assert.match(stored, /'headline' is required/u);
    const replayed = await failure(() => fileArticle.execute("call", { body: "text" } as never, undefined, undefined, {} as never));
    assert.match(replayed.message, /'headline' is required and must be a non-empty string/u);
    assert.ok(!replayed.message.includes("sha256:"), "a retried failure must not answer with a digest");

    const filed = await fileArticle.execute("call", { headline: "Strike", body: "b", section: "news" } as never, undefined, undefined, {} as never);
    assert.deepEqual(filed.details, { filed: true, headline: "Strike", section: "news" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an oversized MCP result is capped, spilled to disk, and re-fetchable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-mcp-oversize-"));
  try {
    const tools = await createProductionAgentTools(mcpAgent(root, ["archive_dump"]), { current: "schedule:edition" });
    const result = await tools[0]!.execute("call", {} as never, undefined, undefined, {} as never);
    const serialized = JSON.stringify({ content: result.content, structuredContent: result.details });
    // Every tool result is replayed on every remaining model request of the
    // wake, so the bound that matters is the context bound, not the receipt one.
    assert.ok(Buffer.byteLength(serialized) <= DEFAULT_TOOL_RESULT_MAX_BYTES, "the per-result bound holds");
    assert.ok(Buffer.byteLength(serialized) <= MCP_TOOL_RESULT_MAX_BYTES, "and so, therefore, does the receipt bound");
    assert.match(serialized, /ARCHIVE-HEAD/u, "the head of the payload survives");
    assert.match(serialized, /bytes elided/u);

    const spilled = path.join(root, "tool-output");
    const files = await readdir(spilled);
    assert.equal(files.length, 1);
    const full = await readFile(path.join(spilled, files[0]!), "utf8");
    assert.match(full, /ARCHIVE-HEAD/u);
    assert.ok(Buffer.byteLength(full) > DEFAULT_TOOL_RESULT_MAX_BYTES, "the complete result is what reached disk");
    assert.ok(serialized.includes(path.join(spilled, files[0]!)), "the model is told exactly where to read it");
    assert.match((await receipts(root)).join(""), /"truncated":true/u);

    // The receipt still fits its own bound with the capped result inside it,
    // and a repeated call replays that result rather than the receipt.
    const replayed = await tools[0]!.execute("call", {} as never, undefined, undefined, {} as never);
    assert.match(JSON.stringify(replayed.details), /ARCHIVE-HEAD/u);
    assert.equal((await readdir(spilled)).length, 1, "a replayed call does not re-spill");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an exempt MCP tool keeps exactly the pre-cap behaviour, receipt bound and all", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-mcp-exempt-"));
  const previous = process.env[TOOL_RESULT_EXEMPT_ENV];
  process.env[TOOL_RESULT_EXEMPT_ENV] = "mcp_desk_archive_dump";
  try {
    const tools = await createProductionAgentTools(mcpAgent(root, ["archive_dump"]), { current: "schedule:edition" });
    const result = await tools[0]!.execute("call", {} as never, undefined, undefined, {} as never);
    const serialized = JSON.stringify({ content: result.content, structuredContent: result.details });
    assert.ok(Buffer.byteLength(serialized) > DEFAULT_TOOL_RESULT_MAX_BYTES, "the exemption really is an exemption");
    assert.ok(Buffer.byteLength(serialized) <= MCP_TOOL_RESULT_MAX_BYTES, "the receipt bound still holds");
    assert.match(serialized, /\[daimon: truncated — the MCP tool result was \d+ bytes, above the 61440-byte tool result bound\]/u);
    await assert.rejects(readdir(path.join(root, "tool-output")), /ENOENT/u, "an exempt tool spills nothing");
  } finally {
    if (previous === undefined) delete process.env[TOOL_RESULT_EXEMPT_ENV]; else process.env[TOOL_RESULT_EXEMPT_ENV] = previous;
    await rm(root, { recursive: true, force: true });
  }
});

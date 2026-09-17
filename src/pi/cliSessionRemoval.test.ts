import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createCliSessionFactory } from "./cliSession.js";

// Grok has no removal child any more (its endpoint lives in GROK_HOME config),
// so removal-failure semantics are exercised through AGY's `mcp remove`.
const agyStream = (text: string): string => JSON.stringify({ event: "result", result: { conversation_id: "fake", status: "SUCCESS", response: text, num_turns: 1, usage: { input_tokens: 1, output_tokens: 1, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 2 } } });

test("MCP removal failure rejects without emitting a successful turn", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-agy-remove-failure-"));
  const grok = path.join(root, "grok.mjs");
  await writeFile(grok, `const args = process.argv.slice(2); if (args.includes("remove")) process.exit(23); else if (args.includes("add")) process.exit(0); else process.stdout.write(${JSON.stringify(agyStream("engine complete"))});`);
  try {
    const { session } = await createCliSessionFactory({ command: process.execPath, commandArgs: [grok], engine: "agy", maxToolTurns: 1, timeoutMs: 10_000 })({ cwd: root });
    let turns = 0;
    session.subscribe((event) => { if (event.type === "turn_end") turns += 1; });
    await assert.rejects(session.prompt("research"), /CLI engine exited 23/);
    assert.ok(session.disposeAsync);
    await assert.rejects(session.disposeAsync(), /CLI engine exited 23/);
    assert.equal(turns, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Grok direct sessions register the per-wake MCP endpoint in GROK_HOME, never through a project-scoped child", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-grok-home-mcp-"));
  const grok = path.join(root, "grok.mjs");
  const engineHomePath = path.join(root, "home", ".grok");
  const seen = path.join(root, "seen");
  await writeFile(grok, `import { appendFileSync, readFileSync } from "node:fs"; const args = process.argv.slice(2); appendFileSync(${JSON.stringify(seen)}, args.includes("mcp") ? "MCP-CHILD\\n" : readFileSync(${JSON.stringify(path.join(engineHomePath, "config.toml"))}, "utf8")); process.stdout.write(${JSON.stringify([{ type: "assistant", parent_tool_use_id: null, session_id: "fake", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "done" }] } }, { type: "result", subtype: "success", is_error: false, result: "done", stop_reason: "end_turn", session_id: "fake" }].map((event) => JSON.stringify(event)).join("\n"))});`);
  try {
    const { session } = await createCliSessionFactory({ command: process.execPath, commandArgs: [grok], engine: "grok", maxToolTurns: 1, timeoutMs: 10_000, engineHomePath })({ cwd: root });
    await session.prompt("research");
    const during = await readFile(seen, "utf8");
    assert.doesNotMatch(during, /MCP-CHILD/u);
    assert.match(during, /\[mcp_servers\.daimon\]\nurl = "http:\/\/127\.0\.0\.1:\d+\/mcp"/u);
    assert.match(during, /\[skills\]\ndisabled = \[/u);
    const after = await readFile(path.join(engineHomePath, "config.toml"), "utf8");
    assert.doesNotMatch(after, /mcp_servers/u);
    await session.disposeAsync?.();

    const unowned = await createCliSessionFactory({ command: process.execPath, commandArgs: [grok], engine: "grok", maxToolTurns: 1, timeoutMs: 10_000 })({ cwd: root });
    await assert.rejects(unowned.session.prompt("research"), /Daimon-owned GROK_HOME/u);
    await unowned.session.disposeAsync?.();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CLI_ENGINE_MAX_OUTPUT_BYTES, createCliSessionFactory } from "./cliSession.js";
import { decodeGrokHeadlessResult } from "./grokHeadlessResult.js";

const assistant = (text: string, stopReason: string = "end_turn", sessionId: string = "session-1") => ({
  type: "assistant", parent_tool_use_id: null, session_id: sessionId,
  message: { role: "assistant", stop_reason: stopReason, content: [{ type: "text", text }] }
});

const result = (text: string, stopReason: string = "end_turn", sessionId: string = "session-1") => ({
  type: "result", subtype: "success", is_error: false, result: text, stop_reason: stopReason, session_id: sessionId
});

const stream = (...events: readonly unknown[]): string => events.map((event) => JSON.stringify(event)).join("\n");

test("Grok message stream ignores multiple tool narrations and returns the exact matching terminal answer", () => {
  assert.equal(decodeGrokHeadlessResult(stream(
    { type: "system", subtype: "init", session_id: "session-1" },
    { ...assistant("I'll inspect the room.", "tool_use"), message: {
      role: "assistant", stop_reason: "tool_use", content: [
        { type: "text", text: "I'll inspect the room." }, { type: "tool_use", id: "tool-1", name: "read_file", input: { path: "one" } }
      ]
    } },
    { type: "user", parent_tool_use_id: null, session_id: "session-1", message: { role: "user", content: [{
      type: "tool_result", tool_use_id: "tool-1", content: "x".repeat(CLI_ENGINE_MAX_OUTPUT_BYTES * 2)
    }] } },
    { ...assistant("I need one more source.", "tool_use"), message: {
      role: "assistant", stop_reason: "tool_use", content: [
        { type: "text", text: "I need one more source." }, { type: "tool_use", id: "tool-2", name: "read_file", input: { path: "two" } }
      ]
    } },
    { type: "user", parent_tool_use_id: null, session_id: "session-1", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-2", content: "two" }] } },
    { ...assistant("publishable ACK"), message: { role: "assistant", stop_reason: "end_turn", content: [
      { type: "thinking", thinking: "compose" }, { type: "text", text: "publishable ACK" }
    ] } },
    result("publishable ACK")
  )), "publishable ACK");
  assert.equal(decodeGrokHeadlessResult(stream(assistant("bounded final", "stop_sequence"), result("bounded final", "stop_sequence"))), "bounded final");
});

test("Grok message stream rejects cancelled, error, malformed, empty, and mismatched terminals without leaking text", () => {
  const canary = "progress-must-not-publish";
  for (const output of [
    stream(assistant(canary, "cancelled"), result(canary, "cancelled")),
    stream({ type: "error", message: canary }),
    stream(result(canary)),
    stream(assistant(canary), result("different")),
    stream(assistant(" "), result(" ")),
    stream(assistant(canary), { ...result(canary), errors: [canary] }),
    stream(assistant(canary), { ...result(canary), errors: canary }),
    stream(result(canary), assistant(canary)),
    stream({ ...assistant(canary), message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "tool_use", id: "tool-1" }] } }, result(canary)),
    canary
  ]) {
    assert.throws(() => decodeGrokHeadlessResult(output), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /no publishable terminal response/);
      assert.equal(error.message.includes(canary), false);
      return true;
    });
  }
});

test("exit-zero cancelled Grok sessions reject without emitting a turn", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-grok-cancelled-result-"));
  const grok = path.join(root, "grok.mjs");
  const cancelled = stream(assistant("progress-must-not-publish", "cancelled"), result("progress-must-not-publish", "cancelled"));
  await writeFile(grok, [
    "const args = process.argv.slice(2);",
    "if (args.includes('mcp')) process.stdout.write('ok');",
    `else process.stdout.write(${JSON.stringify(cancelled)});`
  ].join("\n"));
  try {
    const { session } = await createCliSessionFactory({
      command: process.execPath, commandArgs: [grok], engine: "grok", timeoutMs: 10_000
    })({ cwd: root });
    let turns = 0;
    session.subscribe((event) => { if (event.type === "turn_end") turns += 1; });
    await assert.rejects(session.prompt("research"), /no publishable terminal response/);
    assert.equal(turns, 0);
    await session.disposeAsync?.();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("successful Grok sessions emit only decoded terminal text", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-grok-terminal-result-"));
  const grok = path.join(root, "grok.mjs");
  const multiTool = stream(
    assistant("first progress note", "tool_use"),
    { type: "user", parent_tool_use_id: null, session_id: "session-1", message: { role: "user", content: [{
      type: "tool_result", tool_use_id: "tool-1", content: "x".repeat(CLI_ENGINE_MAX_OUTPUT_BYTES * 2)
    }] } },
    assistant("second progress note", "tool_use"),
    { type: "user", parent_tool_use_id: null, session_id: "session-1", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-2", content: "two" }] } },
    assistant("publishable ACK"), result("publishable ACK")
  );
  await writeFile(grok, [
    "const args = process.argv.slice(2);",
    "if (args.includes('mcp')) process.stdout.write('ok');",
    `else process.stdout.write(${JSON.stringify(multiTool)});`
  ].join("\n"));
  try {
    const { session } = await createCliSessionFactory({
      command: process.execPath, commandArgs: [grok], engine: "grok", timeoutMs: 10_000
    })({ cwd: root });
    let reply = "";
    session.subscribe((event) => {
      if (event.type !== "turn_end" || !("content" in event.message) || !Array.isArray(event.message.content)) return;
      reply = event.message.content.filter((entry) => entry.type === "text").map((entry) => entry.text).join("");
    });
    await session.prompt("research");
    assert.equal(reply, "publishable ACK");
    await session.disposeAsync?.();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createCliSessionFactory } from "./cliSession.js";
import { GrokSubscriptionAuthenticationRejectedError } from "../runtime/grokAuthenticationError.js";

const grokStream = (text: string): string => [
  { type: "assistant", parent_tool_use_id: null, session_id: "fake", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text }] } },
  { type: "result", subtype: "success", is_error: false, result: text, stop_reason: "end_turn", session_id: "fake" }
].map((event) => JSON.stringify(event)).join("\n");

test("Grok removal failure rejects without emitting a successful turn", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-grok-remove-failure-"));
  const grok = path.join(root, "grok.mjs");
  await writeFile(grok, `const args = process.argv.slice(2); if (args.includes("remove")) process.exit(23); else if (args.includes("add")) process.exit(0); else process.stdout.write(${JSON.stringify(grokStream("engine complete"))});`);
  try {
    const { session } = await createCliSessionFactory({ command: process.execPath, commandArgs: [grok], engine: "grok", maxToolTurns: 1, timeoutMs: 10_000 })({ cwd: root });
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

test("Grok authentication rejection keeps precedence over bounded removal failure", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-grok-auth-remove-failure-"));
  const grok = path.join(root, "grok.mjs");
  const authSecret = "auth-rejection-secret-canary";
  const cleanupSecret = "cleanup-secret-canary";
  await writeFile(grok, `const args=process.argv.slice(2);if(args.includes("remove")){process.stderr.write("cleanup ${cleanupSecret}");process.exit(23)}else if(args.includes("add"))process.exit(0);else{process.stderr.write("RefreshTokenRejected ${authSecret}");process.exit(7)}`);
  try {
    const { session } = await createCliSessionFactory({
      command: process.execPath, commandArgs: [grok], engine: "grok", maxToolTurns: 1,
      timeoutMs: 10_000, credentialSecretValues: async () => [authSecret, cleanupSecret]
    })({ cwd: root });
    await assert.rejects(session.prompt("research"), (error: unknown) => {
      assert.ok(error instanceof GrokSubscriptionAuthenticationRejectedError);
      assert.doesNotMatch(error.message, /canary|cleanup|RefreshTokenRejected/u);
      assert.ok(error.cause instanceof Error);
      assert.match(error.cause.message, /CLI engine exited 23/u);
      assert.doesNotMatch(error.cause.message, /canary|cleanup-secret/u);
      assert.ok(Buffer.byteLength(error.cause.message) < 1_024);
      return true;
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Grok removal auth rejection is typed before verbose diagnostics are truncated", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-grok-remove-auth-rejection-"));
  const grok = path.join(root, "grok.mjs");
  const secret = `refresh-start-${"r".repeat(1970)}-refresh-end`;
  await writeFile(grok, `const a=process.argv.slice(2);if(a.includes("remove")){process.stderr.write("RefreshTokenRejected "+${JSON.stringify(secret)}+" "+"tail".repeat(250));process.exit(23)}else if(a.includes("add"))process.exit(0);else process.stdout.write(${JSON.stringify(grokStream("complete"))});`);
  try {
    const { session } = await createCliSessionFactory({
      command: process.execPath, commandArgs: [grok], engine: "grok",
      credentialSecretValues: async () => [secret]
    })({ cwd: root });
    await assert.rejects(session.prompt("research"), (error: unknown) => {
      assert.ok(error instanceof GrokSubscriptionAuthenticationRejectedError);
      assert.doesNotMatch(error.message, /RefreshToken|refresh-start|refresh-end|r{32}|tail/u);
      return true;
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

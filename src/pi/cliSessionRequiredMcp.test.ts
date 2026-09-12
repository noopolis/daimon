import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createCliSessionFactory } from "./cliSession.js";

for (const mode of ["standalone", "strict"] as const) {
  test(`Codex ${mode} MCP startup failure rejects the wake without publishing or inventing usage`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "daimon-required-mcp-"));
    const engine = path.join(root, "codex-stub.mjs");
    const secret = "required-mcp-diagnostic-secret";
    // Simulate Codex's optional-server continuation and required-server exit.
    // The generated launch config must select the failure before a normal turn.
    await writeFile(engine, [
      "for await (const chunk of process.stdin) {}",
      "if (process.argv.includes('mcp_servers.daimon.enabled=true') && process.argv.includes('mcp_servers.daimon.required=true')) {",
      `  process.stderr.write(${JSON.stringify(`required MCP server daimon failed startup: ${secret}`)});`,
      "  process.exit(1);",
      "}",
      "process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'continued without tools' } }) + '\\n');",
      "process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 1 } }) + '\\n');"
    ].join("\n"));
    const published: unknown[] = [];
    const usage: unknown[] = [];
    try {
      const { session } = await createCliSessionFactory({
        command: process.execPath,
        commandArgs: [engine],
        engine: "codex",
        timeoutMs: 10_000,
        credentialSecretValues: async () => [secret],
        onTurnUsage: async (value) => { usage.push(value); },
        ...(mode === "strict" ? { codexSandbox: { mode: "workspace-write", networkAccess: false, webSearch: "disabled" } as const } : {})
      })({ cwd: root });
      session.subscribe((event) => { published.push(event); });
      try {
        await assert.rejects(session.prompt("wake"), (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /CLI engine exited 1: required MCP server daimon failed startup:/u);
          assert.equal(error.message.includes(secret), false);
          return true;
        });
        assert.deepEqual(published, []);
        assert.deepEqual(usage, []);
      } finally { await session.disposeAsync?.(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

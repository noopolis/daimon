import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { createCliSessionFactory } from "./cliSession.js";
import { renderCodexArgs } from "./cliEngineSpawn.js";

const require = createRequire(import.meta.url);
const clientEntry = pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/index.js")).href;
const transportEntry = pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js")).href;

for (const mode of ["standalone", "strict"] as const) {
  test(`Codex ${mode} isolates ambient discovery while the declared MCP tool remains callable`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "daimon-tool-isolation-"));
    const engine = path.join(root, "engine.mjs");
    await writeFile(engine, [
      `import { Client } from ${JSON.stringify(clientEntry)};`,
      `import { StreamableHTTPClientTransport } from ${JSON.stringify(transportEntry)};`,
      "for await (const chunk of process.stdin) {}",
      "const config = new Map(process.argv.flatMap((arg, index, args) => arg === '-c' ? [args[index + 1].split(/=(.*)/s).slice(0, 2)] : []));",
      // Codex 0.142.3 enables these stable features by default, even with
      // --ignore-user-config. The stub models that default; it does not supply
      // an opt-out to the adapter under test.
      "const ambient = ['apps', 'plugins'].filter(name => config.get('features.' + name) !== 'false');",
      "const client = new Client({ name: 'isolation-test', version: '1' });",
      "await client.connect(new StreamableHTTPClientTransport(new URL(config.get('mcp_servers.daimon.url'))));",
      "const listed = await client.listTools();",
      "const result = await client.callTool({ name: 'declared_lookup', arguments: {} });",
      "await client.close();",
      "const text = JSON.stringify({ ambient, listed: listed.tools.map(tool => tool.name), result });",
      "process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }) + '\\n');",
      "process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\\n');"
    ].join("\n"));
    let invoked = false;
    let output = "";
    const { session } = await createCliSessionFactory({
      command: process.execPath, commandArgs: [engine], engine: "codex", timeoutMs: 10_000,
      ...(mode === "strict" ? { codexSandbox: { mode: "workspace-write", networkAccess: false, webSearch: "disabled" } as const } : {})
    })({ cwd: root, customTools: [{
      name: "declared_lookup", label: "Declared lookup", description: "Return the declared result.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      async execute() {
        invoked = true;
        return { content: [{ type: "text", text: "verified" }] };
      }
    } as never] });
    session.subscribe((event) => {
      if (event.type === "turn_end" && "content" in event.message) {
        const content = event.message.content;
        output = typeof content === "string" ? content : content.filter(item => item.type === "text").map(item => item.text).join("");
      }
    });
    try {
      await session.prompt("Use the declared lookup.");
      const report = JSON.parse(output) as { ambient: string[]; listed: string[]; result: { content: unknown[] } };
      assert.deepEqual(report.ambient, []);
      assert.deepEqual(report.listed, ["declared_lookup"]);
      assert.equal(invoked, true);
      assert.deepEqual(report.result.content, [{ type: "text", text: "verified" }]);
    } finally {
      await session.disposeAsync?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Codex ${mode} caller cannot re-enable ambient discovery`, () => {
    for (const commandArgs of [["--enable", "apps"], ["--enable=plugins"], ["-c", "features.apps=true"]]) {
      assert.throws(() => renderCodexArgs({
        commandArgs,
        ...(mode === "strict" ? { codexSandbox: { mode: "workspace-write", networkAccess: false, webSearch: "disabled" } as const } : {})
      }, "/workspace", "http://127.0.0.1:1/mcp"), /Daimon-owned/u);
    }
  });
}

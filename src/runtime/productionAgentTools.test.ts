import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createProductionAgentTools } from "./productionAgentTools.js";
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
    assert.ok(JSON.stringify(result).includes(`release:home=${root}`)); assert.equal(await readFile(path.join(root, "mcp-home-writable"), "utf8"), "ok"); assert.match((await receipts(root)).join(""), /"kind":"mcp".*"agent_id":"alpha".*"engine":"codex".*"tool":"checkpoint"/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("production Moltnet tool enforces compiled scope and records accepted message receipt", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-production-moltnet-"));
  try {
    const cli = path.join(root, "moltnet"); await writeFile(cli, "#!/usr/bin/env node\nlet s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const q=JSON.parse(s);process.stdout.write(JSON.stringify({version:'moltnet.machine.v1',correlation_id:q.correlation_id,operation:'send_nudge',send_nudge:{accepted:true,message_id:'msg-1'}})+'\\n')})\n"); await chmod(cli, 0o755);
    const agent: OrganizationRuntimeAgentConfig = { id: "alpha", name: "Alpha", instructions: "work", workspacePath: root, runtimeHomePath: root, engine: { kind: "codex" }, moltnet: { cliPath: cli, configPath: path.join(root, "config.json"), networks: [{ id: "news", rooms: ["desk"], dms: false }] } };
    const tool = (await createProductionAgentTools(agent, { current: "schedule:occurrence" }))[0]!;
    await assert.rejects(tool.execute("call", { network: "news", target: "dm:beta", text: "no" } as never, undefined, undefined, {} as never), /not declared/u);
    await tool.execute("call", { network: "news", target: "room:desk", text: "é".repeat(1024) } as never, undefined, undefined, {} as never);
    await assert.rejects(tool.execute("call", { network: "news", target: "room:desk", text: `${"é".repeat(1024)}a` } as never, undefined, undefined, {} as never), /exceeds declared scope/u);
    await tool.execute("call", { network: "news", target: "room:desk", text: "hello" } as never, undefined, undefined, {} as never);
    await tool.execute("call", { network: "news", target: "room:desk", text: "hello" } as never, undefined, undefined, {} as never);
    const replacement = (await createProductionAgentTools(agent, { current: "schedule:occurrence" }))[0]!;
    await replacement.execute("call", { network: "news", target: "room:desk", text: "hello" } as never, undefined, undefined, {} as never);
    const stored = await receipts(root); assert.match(stored.join(""), /"kind":"moltnet".*"delivery_id":"daimon:.*"message_id":"msg-1"/u); assert.equal(stored.length, 2);
    await writeFile(path.join(root, "tool-state", "unrelated-torn.json"), "{");
    await replacement.execute("call", { network: "news", target: "room:desk", text: "hello" } as never, undefined, undefined, {} as never);
  } finally { await rm(root, { recursive: true, force: true }); }
});

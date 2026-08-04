import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { MemoryRuntime } from "@noopolis/mneme";

import { createPiMemoryTools } from "../pi/memoryTools.js";
import { createPiWorldTools } from "../pi/worldTools.js";
import type { PiWorldToolContextRef } from "../pi/worldNudge.js";
import {
  createPiToolMcpServer,
  McpToolTurnLimitError,
  McpWakeDeadlineError
} from "./toolServer.js";

const call = async (server: ReturnType<typeof createPiToolMcpServer>, name: string, args: Record<string, unknown>) => {
  const client = new Client({ name: "daimon-test-client", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
    await server.close();
  }
};

const counterTool = (calls: string[]): ToolDefinition => defineTool({
  name: "counter",
  label: "Counter",
  description: "Counts calls.",
  parameters: Type.Object({}, { additionalProperties: false }),
  async execute() {
    calls.push("called");
    return { content: [{ type: "text" as const, text: "ok" }], details: { ok: true } };
  }
});

test("MCP server refuses the call after the explicit tool-turn bound", async () => {
  const calls: string[] = [];
  const server = createPiToolMcpServer([counterTool(calls)], {
    maxToolTurns: 2,
    wakeDeadline: Date.now() + 10_000
  });
  const client = new Client({ name: "daimon-bound-client", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    await client.callTool({ name: "counter", arguments: {} });
    await client.callTool({ name: "counter", arguments: {} });
    const refused = await client.callTool({ name: "counter", arguments: {} });
    assert.equal(refused.isError, true);
    assert.match(JSON.stringify(refused), /McpToolTurnLimitError/u);
    assert.equal(calls.length, 2);
  } finally {
    await client.close();
    await server.close();
  }
  assert.throws(() => { throw new McpToolTurnLimitError(2); }, { name: "McpToolTurnLimitError" });
});

test("MCP server refuses calls after the wake deadline with a distinct error", async () => {
  const calls: string[] = [];
  const server = createPiToolMcpServer([counterTool(calls)], {
    maxToolTurns: 2,
    wakeDeadline: Date.now() - 1
  });
  const result = await call(server, "counter", {});
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result), /McpWakeDeadlineError/u);
  assert.equal(calls.length, 0);
  assert.throws(() => { throw new McpWakeDeadlineError(); }, { name: "McpWakeDeadlineError" });
});

test("MCP mount preserves bound world secrecy in schema and result envelopes", async () => {
  const contextRef: PiWorldToolContextRef = {
    current: {
      decisionToken: "private-decision",
      requestId: "request-1",
      runId: "run-1",
      tick: 1,
      wakeId: "wake-1"
    }
  };
  const tools = createPiWorldTools({
    world: { url: "http://world/v1/world", tokenEnv: "WORLD_TOKEN" },
    contextRef,
    readEnvironment: () => "private-bearer",
    fetch: async () => new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json" },
      status: 200
    })
  });
  const server = createPiToolMcpServer(tools, {
    maxToolTurns: 2,
    wakeDeadline: Date.now() + 10_000
  });
  const client = new Client({ name: "daimon-world-client", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const listed = await client.listTools();
    const act = listed.tools.find((tool) => tool.name === "world_act");
    const status = listed.tools.find((tool) => tool.name === "world_status");
    assert.ok(act);
    assert.ok(status);
    assert.equal(Object.hasOwn(act.inputSchema.properties ?? {}, "decision_token"), false);
    assert.deepEqual(status.inputSchema.properties, {});

    const result = await client.callTool({ name: "world_status", arguments: {} });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.equal(JSON.stringify(result).includes("private-bearer"), false);
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP validates world_ledger bounds through the client", async () => {
  const tools = createPiWorldTools({
    world: { url: "http://world/v1/world", tokenEnv: "WORLD_TOKEN" },
    contextRef: { current: { decisionToken: "decision", requestId: "request", runId: "run", tick: 1, wakeId: "wake" } },
    readEnvironment: () => "bearer",
    fetch: async () => new Response(JSON.stringify({ results: [] }), { headers: { "content-type": "application/json" } })
  });
  const refused = await call(createPiToolMcpServer(tools, { maxToolTurns: 2, wakeDeadline: Date.now() + 10_000 }), "world_ledger", {
    limit: 999999
  });
  assert.equal(refused.isError, true);
  const accepted = await call(createPiToolMcpServer(tools, { maxToolTurns: 2, wakeDeadline: Date.now() + 10_000 }), "world_ledger", {
    limit: 100
  });
  assert.notEqual(accepted.isError, true, JSON.stringify(accepted));
});

test("MCP carries every keyword from the real world and memory schemas", async () => {
  const worldTools = createPiWorldTools({
    world: { url: "http://world/v1/world", tokenEnv: "WORLD_TOKEN" },
    contextRef: {},
    readEnvironment: () => "bearer",
    fetch: async () => new Response(JSON.stringify({ ok: true }))
  });
  const memoryTools = createPiMemoryTools({
    agentId: "mapper",
    contextRef: {},
    memory: {} as MemoryRuntime
  });
  const sourceTools = [...worldTools, ...memoryTools];
  const server = createPiToolMcpServer(sourceTools, { maxToolTurns: 100, wakeDeadline: Date.now() + 10_000 });
  const client = new Client({ name: "schema-coverage-client", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const listed = await client.listTools();
    const listedByName = new Map(listed.tools.map((tool) => [tool.name, tool.inputSchema]));
    const keywords = new Set<string>();
    const scan = (value: unknown, schemaNode = true): void => {
      if (Array.isArray(value)) {
        for (const item of value) scan(item, schemaNode);
        return;
      }
      if (value === null || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        if (key === "properties" && child !== null && typeof child === "object" && !Array.isArray(child)) {
          for (const property of Object.values(child)) scan(property, true);
          continue;
        }
        if (schemaNode) keywords.add(key);
        scan(child, true);
      }
    };
    for (const tool of sourceTools) scan(tool.parameters);
    assert.ok(keywords.size > 0);
    for (const tool of sourceTools) {
      assert.deepEqual(listedByName.get(tool.name), tool.parameters);
    }
    for (const keyword of keywords) {
      assert.ok(sourceTools.some((tool) => JSON.stringify(tool.parameters).includes(`"${keyword}"`)));
      assert.ok([...listedByName.values()].some((schema) => JSON.stringify(schema).includes(`"${keyword}"`)));
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test("mounted tool execution receives no Pi ExtensionContext", async () => {
  let received: unknown = "not-called";
  const mounted = defineTool({
    name: "context_probe",
    label: "Context probe",
    description: "Checks the mount boundary.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_id, _params, _signal, _update, context) {
      received = context;
      return { content: [{ type: "text" as const, text: "ok" }], details: undefined };
    }
  });
  const result = await call(createPiToolMcpServer([mounted], { maxToolTurns: 1, wakeDeadline: Date.now() + 10_000 }), "context_probe", {});
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.equal(received, undefined);
});

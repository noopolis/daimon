import assert from "node:assert/strict";
import test from "node:test";
import { attentionTools, parseAttention, type AttentionRegistry } from "./attention.js";
import { parseOrganizationRuntimeConfig } from "./organizationRuntime.js";

test("attention bounds reject unknown, prototype-looking and out-of-range fields", () => {
  assert.deepEqual(parseAttention({}), {});
  for (const value of [{ constructor: 3 }, { toString: 2 }, { maxBatchMessages: 0 }, { maxBatchMessages: 33 }, { maxBatchBytes: 12001 }, { maxExecutions: 1.5 }, { maxTokens: -1 }]) assert.throws(() => parseAttention(value), /bound/);
  const base = { version: "noopolis.daimon.organization-runtime.v1", host: { bindHost: "localhost", port: 4318, controlTokenEnv: "CONTROL" }, agents: [{ id: "a", name: "A", instructions: "Act", workspacePath: "/w", runtimeHomePath: "/h", engine: { kind: "codex" }, attention: { maxBatchMessages: 4, maxExecutions: 2 } }] };
  assert.deepEqual(parseOrganizationRuntimeConfig(base).agents[0]!.attention, base.agents[0]!.attention);
});

test("inbox tools carry full payload in both channels and bind disposition to the current agent", async () => {
  const registry: AttentionRegistry = new Map(); const seen: unknown[] = [];
  const messages = [{ acceptance_id: "receipt", delivery_id: "delivery", kind: "message", text: "the actual request", occurred_at: "2026-09-11T00:00:00.000Z" }];
  registry.set("a", { executionId: "execution", messages, budget: async () => ({ executions_remaining: 3 }), disposition: async (id, disposition) => { seen.push([id, disposition]); } });
  const tools = attentionTools("a", registry);
  const read = await tools[0]!.execute("call", {}, undefined, undefined, {} as never);
  assert.deepEqual((read.details as { messages: unknown }).messages, messages);
  assert.match(JSON.stringify(read.content), /the actual request/);
  await tools[1]!.execute("call", { delivery_id: "delivery", disposition: "complete" }, undefined, undefined, {} as never);
  assert.deepEqual(seen, [["delivery", "complete"]]);
  await assert.rejects(attentionTools("other", registry)[0]!.execute("call", {}, undefined, undefined, {} as never), /No active inbox/);
});

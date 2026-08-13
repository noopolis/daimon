import assert from "node:assert/strict";
import test from "node:test";

import type {
  MemoryKernel,
  MemoryPrepareTurnResult,
  MemoryRuntime,
  MemoryToolCall,
  MemoryToolResult
} from "@noopolis/mneme";

import {
  createPiMemoryTools,
  createTrustedPiMemoryToolContext,
  type PiMemoryToolContextRef
} from "./memoryTools.js";

type TestPiMemoryTool = {
  execute: (...args: unknown[]) => Promise<unknown>;
  name: string;
};

const preparedTurn = (): MemoryPrepareTurnResult => ({
  allowedScopes: [
    "agent:mapper/scope:global",
    "agent:mapper/scope:team/qualifier:ops",
    "agent:mapper/scope:room/qualifier:noopolis:agora"
  ],
  packet: {
    principal: { agentId: "mapper", scope: "room", qualifier: "noopolis:agora" },
    sections: []
  },
  principal: { agentId: "mapper", scope: "room", qualifier: "noopolis:agora" },
  promptText: "trusted prompt",
  recall: {
    decisions: [],
    redactionCount: 0,
    selectedEventIds: [],
    tokenBudgetUsed: 0,
    totalCandidates: 0
  },
  recalledCausalEventIds: []
});

const resultFor = (call: MemoryToolCall): MemoryToolResult => ({
  audit: {
    latency_ms: 0,
    request_id: call.request_id,
    requester: call.envelope.principal,
    sources: [],
    transport: call.envelope.transport
  },
  content: [],
  decision: "deny",
  request_id: call.request_id,
  tool: call.tool
});

const memoryRuntime = (calls: MemoryToolCall[]): MemoryRuntime => {
  const invoke = async (call: MemoryToolCall): Promise<MemoryToolResult> => {
    calls.push(call);
    return resultFor(call);
  };
  const kernel: MemoryKernel = {
    forget: invoke,
    locate: invoke,
    promote: invoke,
    register: invoke,
    search: invoke,
    summarize: invoke
  };
  return {
    authority: {
      bankId: "mapper",
      issue: () => "trusted-authority",
      runtimeId: "runtime:test"
    },
    kernel,
    prepareTurn: async () => preparedTurn(),
    recordTurn: async () => {}
  };
};

test("trusted Pi memory context detaches prepared identity and lowers exact finite authority", async () => {
  const calls: MemoryToolCall[] = [];
  const memory = memoryRuntime(calls);
  const prepared = preparedTurn();
  const mutableScopes = prepared.allowedScopes as string[];
  const context = createTrustedPiMemoryToolContext({
    agentId: "mapper",
    memory,
    mode: "awake",
    prepared,
    threadId: "noopolis:agora",
    wakeId: "daimon:wake-room"
  });
  mutableScopes[2] = "agent:mapper/scope:room/qualifier:noopolis:attacker";
  prepared.principal.qualifier = "noopolis:attacker";

  assert.deepEqual(context.principal, {
    agentId: "mapper",
    qualifier: "noopolis:agora",
    scope: "room"
  });
  assert.deepEqual(context.allowedScopes, [
    "agent:mapper/scope:global",
    "agent:mapper/scope:team/qualifier:ops",
    "agent:mapper/scope:room/qualifier:noopolis:agora"
  ]);
  assert.equal(context.authority, memory.authority);
  assert.equal(context.conversationScope, "agent:mapper/scope:room/qualifier:noopolis:agora");
  assert.equal(context.audienceKey, context.conversationScope);
  assert.equal(Object.isFrozen(context), true);
  assert.equal(Object.isFrozen(context.principal), true);
  assert.equal(Object.isFrozen(context.allowedScopes), true);

  const contextRef: PiMemoryToolContextRef = { current: context };
  const search = (createPiMemoryTools({ agentId: "mapper", contextRef, memory }) as unknown as TestPiMemoryTool[])
    .find((tool) => tool.name === "memory_search");
  assert.ok(search);
  await search.execute("call-1", { limit: 2, query: "status", scope: "current" }, undefined, undefined, {});
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.envelope.principal, context.principal);
  assert.deepEqual(calls[0]?.envelope.allowed_scopes, context.allowedScopes);
  assert.equal(calls[0]?.envelope.authority, "trusted-authority");
});

test("Pi memory tools have no global fallback and reject authority substitutions before kernel invocation", async () => {
  const calls: MemoryToolCall[] = [];
  const memory = memoryRuntime(calls);
  const contextRef: PiMemoryToolContextRef = {};
  const search = (createPiMemoryTools({ agentId: "mapper", contextRef, memory }) as unknown as TestPiMemoryTool[])
    .find((tool) => tool.name === "memory_search");
  assert.ok(search);

  await assert.rejects(
    search.execute("no-context", { query: "status", scope: "current" }, undefined, undefined, {}),
    /active trusted turn context/u
  );

  contextRef.current = createTrustedPiMemoryToolContext({
    agentId: "mapper",
    memory,
    mode: "awake",
    prepared: preparedTurn(),
    threadId: "noopolis:agora",
    wakeId: "daimon:wake-room"
  });
  for (const field of [
    "agent", "agent_id", "agentId",
    "allowed_scopes", "allowedScopes",
    "audience_key", "audienceKey",
    "authority",
    "bank", "bank_id", "bankId",
    "capability",
    "conversation_scope", "conversationScope",
    "expires_at", "expiresAt",
    "mode",
    "nonce",
    "pair", "pair_id", "pairId", "pairPeers",
    "policy_version", "policyVersion",
    "principal",
    "room", "room_id", "roomId",
    "run_id", "runId",
    "runtime", "runtime_id", "runtimeId", "runtime_identity", "runtimeIdentity",
    "authority_runtime_id", "authorityRuntimeId",
    "team", "team_id", "teamId",
    "thread_id", "threadId",
    "transport",
    "wake_id", "wakeId"
  ]) {
    await assert.rejects(
      search.execute("forged", { query: "status", scope: "current", [field]: "attacker" }, undefined, undefined, {}),
      /unexpected top-level argument/u
    );
  }
  assert.equal(calls.length, 0);
});

test("each callable memory tool enforces its own exact top-level allowlist while preserving nested content", async () => {
  const calls: MemoryToolCall[] = [];
  const memory = memoryRuntime(calls);
  const contextRef: PiMemoryToolContextRef = {
    current: createTrustedPiMemoryToolContext({
      agentId: "mapper",
      memory,
      mode: "dream",
      prepared: preparedTurn(),
      threadId: "noopolis:agora",
      wakeId: "daimon:wake-room"
    })
  };
  const tools = createPiMemoryTools({ agentId: "mapper", contextRef, memory, mode: "dream" }) as unknown as TestPiMemoryTool[];
  const byName = (name: string): TestPiMemoryTool => {
    const tool = tools.find((candidate) => candidate.name === name);
    assert.ok(tool);
    return tool;
  };
  const probes: ReadonlyArray<[string, Record<string, unknown>]> = [
    ["memory_search", { limit: 1, memory_id: "foreign", query: "status", scope: "current" }],
    ["memory_locate", { query: "status", scope: "current" }],
    ["memory_register", {
      content: { kind: "artifact" },
      evidence_event_ids: ["forbidden"],
      kind: "artifact",
      scope: "current",
      sensitivity: "normal",
      source_type: "pi-test",
      visibility: "room"
    }],
    ["memory_summarize", { query: "status", scope: "current" }],
    ["memory_forget", { event_ids: ["memory-event"], horizon: 1, scope: "current" }],
    ["memory_promote", { memory_id: "memory-event", query: "status", scope: "current" }]
  ];
  for (const [name, params] of probes) {
    await assert.rejects(
      byName(name).execute("cross-tool-field", params, undefined, undefined, {}),
      /unexpected top-level argument/u
    );
  }
  assert.equal(calls.length, 0);

  await byName("memory_register").execute("nested-content", {
    confidence: 0.9,
    content: {
      bankId: "content-is-not-authority",
      kind: "artifact",
      metadata: { mode: "descriptive", runtimeId: "quoted-runtime" }
    },
    kind: "artifact",
    scope: "current",
    sensitivity: "normal",
    source_type: "pi-test",
    visibility: "room"
  }, undefined, undefined, {});
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.arguments.content, {
    bankId: "content-is-not-authority",
    kind: "artifact",
    metadata: { mode: "descriptive", runtimeId: "quoted-runtime" }
  });
});

test("trusted context rejects foreign banks and unbounded or substituted scope sets", () => {
  const memory = memoryRuntime([]);
  const base = preparedTurn();
  const create = (prepared: MemoryPrepareTurnResult, runtime: MemoryRuntime = memory) =>
    createTrustedPiMemoryToolContext({
      agentId: "mapper",
      memory: runtime,
      mode: "awake",
      prepared,
      threadId: "noopolis:agora",
      wakeId: "daimon:wake-room"
    });

  assert.throws(() => create({ ...base, principal: { ...base.principal, agentId: "attacker" } }), /does not match/u);
  assert.throws(() => create({ ...base, allowedScopes: [] }), /bounded finite/u);
  assert.throws(
    () => create({ ...base, allowedScopes: ["agent:attacker/scope:room/qualifier:noopolis:agora"] }),
    /foreign or duplicate/u
  );
  assert.throws(
    () => create({ ...base, allowedScopes: ["agent:mapper/scope:global"] }),
    /omits its active/u
  );
  assert.throws(
    () => create(base, { ...memory, authority: { ...memory.authority, bankId: "attacker" } }),
    /does not match/u
  );
});

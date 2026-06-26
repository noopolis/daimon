import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createMemoryRuntime } from "./runtime.js";
import { JsonlMemoryStore } from "./store.js";

const tempRoots: string[] = [];

const tempDir = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "noopolis-daimon-memory-"));
  tempRoots.push(directory);
  return directory;
};

test.afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("prepares a memory packet and wake prompt for message events", async () => {
  const root = await tempDir();
  const runtime = createMemoryRuntime({
    agentId: "agent-a",
    runtimeHomePath: root,
    tokenBudget: 600
  });

  const turn = await runtime.prepareTurn({
    eventId: "evt-1",
    kind: "message",
    from: "mapper",
    text: "What is the plan for this morning?",
    context: {
      networkId: "noopolis",
      roomId: "agora",
      teamId: "team-a",
      artifactPaths: ["repos/product"]
    }
  });

  assert.equal(turn.principal.scope, "pair");
  assert.equal(turn.principal.qualifier, "mapper");
  assert.ok(turn.promptText.includes("Wake event"));
  assert.ok(turn.packet.sections.length >= 0);
  assert.equal(turn.recall.totalCandidates, 0);
});

test("records turn output and recall artifacts to the jsonl store", async () => {
  const root = await tempDir();
  const runtime = createMemoryRuntime({
    agentId: "agent-a",
    runtimeHomePath: root
  });
  const principal = {
    agentId: "agent-a",
    scope: "room" as const,
    qualifier: "noopolis:agora"
  };

  await runtime.recordTurn({
    principal,
    prompt: {
      principal,
      sections: [{ heading: "Warmup", text: "Context loaded." }],
      rawHint: "none"
    },
    request: {
      eventId: "evt-record",
      kind: "manual",
      text: "Summarize progress.",
      context: {
        networkId: "noopolis",
        roomId: "agora"
      }
    },
    result: "completed",
    outputText: "Done. Progress summarized.",
    toolEvents: []
  });

  const store = new JsonlMemoryStore(root);
  const events = await store.read({ principalAgentId: "agent-a" });

  assert.ok(events.length >= 2);
  assert.ok(events.some((event) => event.type === "memory.claimed"));
  assert.ok(events.some((event) => event.type === "memory.observed"));
  assert.ok(events.some((event) => event.type === "memory.disclosed") === false);
});

test("marks failed turns and still records denied decision", async () => {
  const root = await tempDir();
  const runtime = createMemoryRuntime({
    agentId: "agent-a",
    runtimeHomePath: root
  });
  const principal = {
    agentId: "agent-a",
    scope: "global" as const
  };

  await runtime.recordTurn({
    principal,
    prompt: {
      principal,
      sections: [],
      rawHint: "failed"
    },
    request: {
      eventId: "evt-fail",
      kind: "schedule",
      text: "run",
      from: "operator",
      context: { networkId: "noopolis", roomId: "agora" }
    },
    result: "failed",
    outputText: "",
    error: "simulated runtime error",
    toolEvents: []
  });

  const store = new JsonlMemoryStore(root);
  const events = await store.read({ principalAgentId: "agent-a", types: ["memory.denied"] });
  assert.equal(events.length, 1);
  assert.equal(events[0].content.kind, "text");
  assert.ok(events[0].content.text.includes("simulated runtime error"));
});

test("broker lookup returns matching events by requested scope", async () => {
  const root = await tempDir();
  const runtime = createMemoryRuntime({
    agentId: "agent-a",
    runtimeHomePath: root
  });
  const storedPrincipal = {
    agentId: "agent-a",
    scope: "room" as const,
    qualifier: "noopolis:agora"
  };

  await runtime.recordTurn({
    principal: storedPrincipal,
    prompt: {
      principal: storedPrincipal,
      sections: [{ heading: "Note", text: "Task: map roadmap updates." }],
      rawHint: "seed"
    },
    request: {
      eventId: "evt-source",
      kind: "manual",
      text: "I updated the roadmap.",
      context: {
        networkId: "noopolis",
        roomId: "agora"
      }
    },
    result: "completed",
    outputText: "Done.",
    toolEvents: []
  });

  const result = await runtime.broker.lookup({
    requester: {
      agentId: "agent-a",
      scope: "pair",
      qualifier: "mapper"
    },
    query: "roadmap",
    activeContext: {
      networkId: "noopolis",
      roomId: "agora"
    },
    maxResults: 2
  });

  assert.equal(result.requestedBy, "agent-a");
  assert.ok(result.totalMatches >= 1);
  assert.ok(result.envelopes.length >= 1);
  assert.equal(result.envelopes[0].eventId, result.envelopes[0].eventId);
  assert.ok(result.envelopes[0].representation.includes("Task"));
});

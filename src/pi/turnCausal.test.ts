import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { MemoryPrepareTurnResult } from "@noopolis/mneme";

import type { WakeEvent } from "../core/types.js";
import { agentPrincipalId, stampTurnInputSubmitted } from "./turnCausal.js";

const tempRoots: string[] = [];

test.beforeEach(() => {
  process.env.NOOPOLIS_RUN_ID = "run-test-turn-causal";
});
test.afterEach(() => {
  delete process.env.NOOPOLIS_RUN_ID;
});

const tempDir = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "noopolis-daimon-turncausal-"));
  tempRoots.push(directory);
  return directory;
};

test.afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const readJsonl = async (runtimeHomePath: string): Promise<Record<string, unknown>[]> => {
  const raw = await readFile(path.join(runtimeHomePath, "telemetry", "causal.jsonl"), "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
};

const buildPrepared = (overrides: Partial<MemoryPrepareTurnResult> = {}): MemoryPrepareTurnResult => ({
  principal: { agentId: "agent-a", scope: "room" },
  allowedScopes: ["agent:agent-a/scope:room"],
  packet: { principal: { agentId: "agent-a", scope: "room" }, sections: [] },
  promptText: "prompt",
  recall: {
    totalCandidates: 1,
    // Deliberately a RAW kernel-log recall id (evt_<...>), the raw
    // namespace this fix must NOT chain into cause_event_ids anymore.
    selectedEventIds: ["evt_raw-recall-id"],
    decisions: [],
    tokenBudgetUsed: 10,
    redactionCount: 0
  },
  // The mneme:<uuid> causal id mneme actually stamped its own
  // memory.recalled event under — this is the id that must appear in
  // cause_event_ids instead.
  recalledCausalEventIds: ["mneme:11111111-1111-4111-8111-111111111111"],
  ...overrides
});

test("stampTurnInputSubmitted chains cause_event_ids to mneme's recalledCausalEventIds, not the raw recall.selectedEventIds", async () => {
  const runtimeHomePath = await tempDir();
  const event: WakeEvent = { id: "moltnet:msg-1", kind: "message", text: "hello" };
  const prepared = buildPrepared();

  const stamped = await stampTurnInputSubmitted({
    agentId: "agent-a",
    event,
    prepared,
    promptText: "prompt",
    runtimeHomePath
  });

  assert.deepEqual(stamped.cause_event_ids, [
    "moltnet:msg-1",
    "mneme:11111111-1111-4111-8111-111111111111"
  ]);
  assert.equal(stamped.cause_event_ids.includes("evt_raw-recall-id"), false);
  assert.equal(stamped.principal_id, agentPrincipalId("agent-a"));

  const [written] = await readJsonl(runtimeHomePath);
  assert.deepEqual(written?.cause_event_ids, stamped.cause_event_ids);
});

test("stampTurnInputSubmitted chains multiple recalledCausalEventIds in order", async () => {
  const runtimeHomePath = await tempDir();
  const event: WakeEvent = { id: "moltnet:msg-2", kind: "message", text: "hello again" };
  const prepared = buildPrepared({
    recall: {
      totalCandidates: 2,
      selectedEventIds: ["evt_raw-a", "evt_raw-b"],
      decisions: [],
      tokenBudgetUsed: 20,
      redactionCount: 0
    },
    recalledCausalEventIds: ["mneme:aaaa", "mneme:bbbb"]
  });

  const stamped = await stampTurnInputSubmitted({
    agentId: "agent-a",
    event,
    prepared,
    promptText: "prompt",
    runtimeHomePath
  });

  assert.deepEqual(stamped.cause_event_ids, ["moltnet:msg-2", "mneme:aaaa", "mneme:bbbb"]);
});

test("stampTurnInputSubmitted with no recall (undefined prepared) chains only the wake event id", async () => {
  const runtimeHomePath = await tempDir();
  const event: WakeEvent = { id: "moltnet:msg-3", kind: "manual", text: "no memory here" };

  const stamped = await stampTurnInputSubmitted({
    agentId: "agent-a",
    event,
    promptText: "prompt",
    runtimeHomePath
  });

  assert.deepEqual(stamped.cause_event_ids, ["moltnet:msg-3"]);
});

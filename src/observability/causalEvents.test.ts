import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CAUSAL_EVENT_VERSION,
  emitTurnInputSubmitted,
  emitTurnOutputCompleted,
  nextCausalSeq,
  NOOPOLIS_RUN_ID_ENV,
  replyCauseEventIds,
  resolveRunId,
  sha256Hex,
  turnInputSubmittedEventId,
  turnOutputCompletedEventId
} from "./causalEvents.js";

const tempRoots: string[] = [];

const tempDir = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "noopolis-daimon-causal-"));
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

test("causal seq counter is file-backed: a fresh module instance resumes from causal.seq.json across a restart", async () => {
  const runtimeHomePath = await tempDir();
  const stream = { runId: "run-1", runtimeHomePath, streamId: "agent:mapper" };

  // 1. Allocate a couple of seqs through the first module instance. This writes causal.seq.json.
  assert.equal(await nextCausalSeq(stream), 1);
  assert.equal(await nextCausalSeq(stream), 2);

  // 4. The persisted counter is on disk, not just in process memory.
  const persisted = JSON.parse(
    await readFile(path.join(runtimeHomePath, "telemetry", "causal.seq.json"), "utf8")
  ) as Record<string, Record<string, number>>;
  assert.equal(persisted["run-1"]["agent:mapper"], 2);

  // 2. Simulate a process restart: a genuinely fresh module instance (ESM cache-busted),
  //    so any continuation can only come from the file, never from module-level state.
  const fresh = (await import(`./causalEvents.js?restart=${Date.now()}`)) as typeof import("./causalEvents.js");
  assert.notEqual(fresh.nextCausalSeq, nextCausalSeq);

  // 3. The same (run_id, stream_id) resumes at 3, not reset to 1...
  assert.equal(await fresh.nextCausalSeq(stream), 3);
  assert.equal(await fresh.nextCausalSeq(stream), 4);
  // ...while a different stream still starts at 1 after the restart.
  assert.equal(await fresh.nextCausalSeq({ ...stream, streamId: "agent:reviewer" }), 1);
  // ...and a different run_id on the same stream also starts at 1.
  assert.equal(await fresh.nextCausalSeq({ ...stream, runId: "run-2" }), 1);
});

test("resolveRunId requires a non-blank NOOPOLIS_RUN_ID", () => {
  assert.equal(resolveRunId({ [NOOPOLIS_RUN_ID_ENV]: "run-42" }), "run-42");
  assert.throws(() => resolveRunId({}), /NOOPOLIS_RUN_ID/u);
  assert.throws(() => resolveRunId({ [NOOPOLIS_RUN_ID_ENV]: "   " }), /NOOPOLIS_RUN_ID/u);
});

test("emitTurnInputSubmitted stamps the envelope and payload minimums", async () => {
  const runtimeHomePath = await tempDir();

  const event = await emitTurnInputSubmitted({
    agentId: "mapper",
    causeEventIds: ["moltnet-msg-1", "mneme-mem-1"],
    inputContentSha256: sha256Hex("hello"),
    inputMessageIds: ["moltnet-msg-1"],
    principalId: "mapper",
    promptSha256: sha256Hex("prompt text"),
    runId: "run-1",
    runtimeHomePath,
    turnId: "wake-1"
  });

  assert.equal(event.version, CAUSAL_EVENT_VERSION);
  assert.equal(event.run_id, "run-1");
  assert.equal(event.event_id, turnInputSubmittedEventId("wake-1"));
  assert.equal(event.event_id, "daimon:wake-1:turn.input.submitted");
  assert.deepEqual(event.emitter, { system: "daimon", stream_id: "agent:mapper", seq: 1 });
  assert.equal(event.type, "turn.input.submitted");
  assert.equal(event.principal_id, "mapper");
  assert.equal(typeof event.recorded_at, "string");
  assert.equal(Number.isNaN(Date.parse(event.recorded_at)), false);
  assert.deepEqual(event.cause_event_ids, ["moltnet-msg-1", "mneme-mem-1"]);
  assert.equal(event.payload.turn_id, "wake-1");
  assert.deepEqual(event.payload.input_message_ids, ["moltnet-msg-1"]);
  assert.equal(event.payload.input_content_sha256, sha256Hex("hello"));
  assert.equal(event.payload.prompt_sha256, sha256Hex("prompt text"));

  const lines = await readJsonl(runtimeHomePath);
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0], event as unknown as Record<string, unknown>);
});

test("emitTurnOutputCompleted chains cause_event_ids back to the turn.input.submitted id", async () => {
  const runtimeHomePath = await tempDir();

  const input = await emitTurnInputSubmitted({
    agentId: "mapper",
    causeEventIds: ["moltnet-msg-1"],
    inputContentSha256: sha256Hex("hello"),
    inputMessageIds: ["moltnet-msg-1"],
    principalId: "mapper",
    promptSha256: sha256Hex("prompt text"),
    runId: "run-1",
    runtimeHomePath,
    turnId: "wake-1"
  });

  const output = await emitTurnOutputCompleted({
    agentId: "mapper",
    causeEventIds: [input.event_id],
    outputSha256: sha256Hex("reply text"),
    principalId: "mapper",
    runId: "run-1",
    runtimeHomePath,
    turnId: "wake-1"
  });

  assert.equal(output.event_id, turnOutputCompletedEventId("wake-1"));
  assert.deepEqual(output.cause_event_ids, [input.event_id]);
  assert.equal(output.payload.turn_id, "wake-1");
  assert.equal(output.payload.output_sha256, sha256Hex("reply text"));

  // seq is contiguous within (run_id, stream_id), across event types sharing one agent stream.
  assert.equal(input.emitter.seq, 1);
  assert.equal(output.emitter.seq, 2);

  const lines = await readJsonl(runtimeHomePath);
  assert.equal(lines.length, 2);
});

test("seq is contiguous per (run_id, stream_id) and independent across agents", async () => {
  const runtimeHomePathA = await tempDir();
  const runtimeHomePathB = await tempDir();

  const a1 = await emitTurnOutputCompleted({
    agentId: "mapper",
    causeEventIds: [],
    outputSha256: sha256Hex("a1"),
    principalId: "mapper",
    runId: "run-1",
    runtimeHomePath: runtimeHomePathA,
    turnId: "wake-a1"
  });
  const a2 = await emitTurnOutputCompleted({
    agentId: "mapper",
    causeEventIds: [],
    outputSha256: sha256Hex("a2"),
    principalId: "mapper",
    runId: "run-1",
    runtimeHomePath: runtimeHomePathA,
    turnId: "wake-a2"
  });
  const b1 = await emitTurnOutputCompleted({
    agentId: "reviewer",
    causeEventIds: [],
    outputSha256: sha256Hex("b1"),
    principalId: "reviewer",
    runId: "run-1",
    runtimeHomePath: runtimeHomePathB,
    turnId: "wake-b1"
  });

  assert.equal(a1.emitter.seq, 1);
  assert.equal(a2.emitter.seq, 2);
  assert.equal(b1.emitter.seq, 1);
});

test("replyCauseEventIds is pure and matches the emitted turn.output.completed id", async () => {
  const runtimeHomePath = await tempDir();

  const output = await emitTurnOutputCompleted({
    agentId: "mapper",
    causeEventIds: [],
    outputSha256: sha256Hex("reply text"),
    principalId: "mapper",
    runId: "run-1",
    runtimeHomePath,
    turnId: "wake-9"
  });

  assert.deepEqual(replyCauseEventIds("wake-9"), [output.event_id]);
  // Deterministic from turn_id alone: no model output, no I/O, no dependency on emission having happened.
  assert.deepEqual(replyCauseEventIds("wake-9"), replyCauseEventIds("wake-9"));
});

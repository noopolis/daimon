import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  capturePiWorldTrajectoryEvent,
  createPiWorldTrajectoryCapture,
  persistPiWorldTrajectory,
  redactWorldTrajectoryValue,
  WORLD_TRAJECTORY_SCHEMA
} from "./worldTrajectory.js";

test("captures exact scoped world calls while deleting forbidden private fields", () => {
  const capture = createPiWorldTrajectoryCapture();
  capturePiWorldTrajectoryEvent(capture, {
    type: "tool_execution_start",
    toolCallId: "call-1",
    toolName: "world_observe",
    args: {
      sense: "world://pitch/sense/player-view",
      decision_token: "secret-decision",
      nested: { x: 1 }
    }
  }, new Date("2026-01-01T00:00:00.000Z"));
  capturePiWorldTrajectoryEvent(capture, {
    type: "tool_execution_end",
    toolCallId: "call-1",
    toolName: "world_observe",
    result: {
      details: {
        self: { x: -3.5, y: 0 },
        ball: { x: 0, y: 0 },
        authorization: "Bearer secret-bearer"
      }
    },
    isError: false
  }, new Date("2026-01-01T00:00:00.012Z"));
  assert.deepEqual(capture.calls[0], {
    arguments: {
      sense: "world://pitch/sense/player-view",
      nested: { x: 1 }
    },
    completed_at: "2026-01-01T00:00:00.012Z",
    duration_ms: 12,
    name: "world_observe",
    result: {
      self: { x: -3.5, y: 0 },
      ball: { x: 0, y: 0 }
    },
    sequence: 0,
    started_at: "2026-01-01T00:00:00.000Z",
    status: "completed",
    tool_call_id: "call-1"
  });
  assert.equal(JSON.stringify(capture).includes("secret"), false);
});

test("redacts hidden cognition and credential-shaped values recursively", () => {
  const redacted = redactWorldTrajectoryValue({
    observation: { x: 1 },
    prompt: "private",
    memory: "private",
    reasoning: "private",
    api_key: "sk-proj-abcdefghijklmnopqrstuvwxyz",
    message: "Bearer abcdefghijklmnop /Users/apresmoi/.codex/auth.json"
  });
  const bytes = JSON.stringify(redacted);
  assert.match(bytes, /observation/u);
  assert.equal(bytes.includes("private"), false);
  assert.equal(bytes.includes("abcdefghijklmnopqrstuvwxyz"), false);
  assert.equal(bytes.includes("/Users/apresmoi"), false);
});

test("writes a versioned join-ready world trajectory without raw instructions or prompts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-world-trajectory-"));
  const capture = createPiWorldTrajectoryCapture();
  capturePiWorldTrajectoryEvent(capture, {
    type: "tool_execution_start",
    toolCallId: "act-1",
    toolName: "world_act",
    args: {
      affordance: "world://pitch/affordance/kick",
      target: "object:ball",
      input: { direction: { x: 1, y: 0 }, intensity: 1 }
    }
  }, new Date("2026-01-01T00:00:00.000Z"));
  capturePiWorldTrajectoryEvent(capture, {
    type: "tool_execution_end",
    toolCallId: "act-1",
    toolName: "world_act",
    result: { details: { decision_id: "decision-1", action_sequence: 3 } },
    isError: false
  }, new Date("2026-01-01T00:00:00.004Z"));
  try {
    await persistPiWorldTrajectory({
      agentId: "agent:red",
      capture,
      completedAt: new Date("2026-01-01T00:00:00.010Z"),
      context: {
        decisionToken: "never-write-this",
        requestId: "request-1",
        runId: "run-1",
        tick: 2,
        wakeId: "wake-1"
      },
      instructions: "private football instructions",
      model: { authMethod: "none", model: "qwen3:4b", provider: "local" },
      promptText: "private wake prompt",
      runtimeHomePath: root,
      startedAt: new Date("2026-01-01T00:00:00.000Z"),
      status: "completed",
      thinkingLevel: "off",
      totalMs: 10,
      turnId: "wake-1"
    });
    const bytes = await readFile(
      path.join(root, "telemetry", "world-trajectories", "wake-1.json"),
      "utf8"
    );
    const record = JSON.parse(bytes) as Record<string, any>;
    assert.equal(record.schema, WORLD_TRAJECTORY_SCHEMA);
    assert.equal(record.outcome.status, "pending_world_join");
    assert.equal(record.outcome.join.decision_id, "decision-1");
    assert.equal(record.instruction.sha256.length, 64);
    assert.equal(record.prompt.sha256.length, 64);
    assert.equal(bytes.includes("never-write-this"), false);
    assert.equal(bytes.includes("private football instructions"), false);
    assert.equal(bytes.includes("private wake prompt"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

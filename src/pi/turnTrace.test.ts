import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildPiTurnTraceRecord,
  redactTraceText,
  sanitizeTraceFileId,
  summarizePrompt,
  summarizeSessionEvent,
  writeTurnTraceRecord
} from "./turnTrace.js";

test("turn traces disclose world binding state without retaining authority", () => {
  const record = buildPiTurnTraceRecord({
    agentId: "red",
    completedAt: new Date("2026-01-01T00:00:01.000Z"),
    event: {
      id: "moltnet:wake-red",
      kind: "message",
      text: "enriched public prompt",
      transportText: "{\"decision_token\":\"private\"}",
      delivery: {
        contextId: "moltnet:pitch:dm:1",
        eventId: "moltnet:wake-red",
        sender: "world",
        target: "red"
      }
    },
    memoryEnabled: false,
    model: {
      authMethod: "none",
      model: "qwen3:4b",
      provider: "local"
    },
    outputText: "",
    promptText: "World decision wake",
    session: {
      disposeAfterWake: false,
      mode: "awake",
      threadId: "moltnet:pitch:dm:1"
    },
    startedAt: new Date("2026-01-01T00:00:00.000Z"),
    status: "completed",
    tools: [],
    totalMs: 1_000,
    worldContextBound: true
  });

  assert.deepEqual(record.wake, {
    delivery_authenticated: true,
    event_id: "moltnet:wake-red",
    kind: "message",
    transport_text_present: true,
    world_context_bound: true
  });
  assert.equal(JSON.stringify(record).includes("decision_token"), false);
  assert.equal(JSON.stringify(record).includes("private"), false);
});

test("turn trace helpers summarize prompts without raw prompt text", () => {
  const summary = summarizePrompt("## Dream Mode\nMemory context\nActive environment context:\nsecret");

  assert.equal(summary.chars, 63);
  assert.equal(summary.lines, 4);
  assert.equal(summary.has_dream_mode, true);
  assert.equal(summary.has_memory_context, true);
  assert.equal(summary.has_active_environment, true);
  assert.equal(summary.sha256.length, 64);
  assert.equal(JSON.stringify(summary).includes("secret"), false);
});

test("turn trace helpers redact secret-shaped values and host paths", () => {
  const redacted = redactTraceText(
    'failed Bearer abcdefghijklmnop sk-proj-abcdefghijklmnopqrstuvwxyz /Users/apresmoi/.codex/auth.json {"refresh_token":"secret"}'
  );

  assert.match(redacted, /Bearer \[REDACTED\]/u);
  assert.match(redacted, /\[path\]/u);
  assert.equal(redacted.includes("abcdefghijklmnopqrstuvwxyz"), false);
  assert.equal(redacted.includes("/Users/apresmoi"), false);
  assert.equal(redacted.includes("secret"), false);
});

test("turn trace helpers summarize session events structurally", () => {
  assert.deepEqual(summarizeSessionEvent({ type: "turn_end" }), undefined);
  assert.deepEqual(
    summarizeSessionEvent({
      duration_ms: 12,
      status: "completed",
      tool: { name: "bash", input: "cat /Users/apresmoi/token" },
      type: "tool_result"
    }),
    {
      durationMs: 12,
      kind: "session",
      name: "bash",
      status: "completed",
      type: "tool_result"
    }
  );
});

test("turn trace helpers write joinable per-turn artifacts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-turn-trace-"));
  try {
    await writeTurnTraceRecord(root, {
      agent_id: "mapper",
      completed_at: "2026-01-01T00:00:01.000Z",
      engine: {
        auth_method: "none",
        kind: "pi",
        model: "llama3.2",
        provider: "local"
      },
      memory: { enabled: false },
      prompt: summarizePrompt("hi"),
      reply: {
        output_chars: 2,
        reply_given: true
      },
      schema: "daimon.turn_trace.v1",
      session: {
        dispose_after_wake: false,
        mode: "awake",
        thread_id: "room:noopolis:agora"
      },
      started_at: "2026-01-01T00:00:00.000Z",
      status: "completed",
      timings_ms: { total: 1 },
      tools: [],
      turn_id: "room:noopolis/agora",
      wake: {
        event_id: "room:noopolis/agora",
        kind: "message"
      }
    });

    const single = await readFile(path.join(root, "telemetry", "turns", "room_noopolis_agora.json"), "utf8");
    const ndjson = await readFile(path.join(root, "telemetry", "turns.ndjson"), "utf8");
    assert.equal(JSON.parse(single).turn_id, "room:noopolis/agora");
    assert.equal(JSON.parse(ndjson.trim()).wake.event_id, "room:noopolis/agora");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { appendCausalEvent, CAUSAL_EVENT_VERSION, nextCausalSeq } from "../observability/causalEvents.js";
import { summarizePrompt, writeTurnTraceRecord } from "../pi/turnTrace.js";
import { RUNTIME_HOME_SUBDIRECTORY_MODE } from "./runtimeHomeLayout.js";

/**
 * A brokered Grok runtime home is traversable by its worker uid (0710), so
 * anything Daimon creates inside it must stay 0700 — a default `mkdir` would
 * make telemetry (prompts, replies, trajectories) readable by the model's own
 * sandboxed worker.
 */
const withTraversableHome = async (body: (home: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-home-layout-"));
  const home = path.join(root, "runtime-home");
  await mkdir(home, { mode: 0o710 });
  try { await body(home); } finally { await rm(root, { force: true, recursive: true }); }
};
const mode = async (target: string): Promise<number> => (await stat(target)).mode & 0o7777;

test("the runtime-home subdirectory mode grants nobody but the runtime user", () => {
  assert.equal(RUNTIME_HOME_SUBDIRECTORY_MODE, 0o700);
});

test("telemetry directories Daimon creates in a traversable runtime home are private", async () => {
  await withTraversableHome(async (home) => {
    await appendCausalEvent(home, {
      version: CAUSAL_EVENT_VERSION, id: "daimon:t1:turn.output.completed", type: "turn.output.completed",
      occurred_at: "2026-01-01T00:00:00.000Z", actor: { kind: "agent", id: "a" }, subject: { kind: "turn", id: "t1" },
      causes: [], run_id: "run", seq: 1, payload: {}
    } as never);
    assert.equal(await mode(path.join(home, "telemetry")), RUNTIME_HOME_SUBDIRECTORY_MODE);
    await rm(path.join(home, "telemetry"), { recursive: true });

    await nextCausalSeq({ runtimeHomePath: home, agentId: "a", turnId: "t1", count: 1 } as never);
    assert.equal(await mode(path.join(home, "telemetry")), RUNTIME_HOME_SUBDIRECTORY_MODE);

    await writeTurnTraceRecord(home, {
      agent_id: "mapper", completed_at: "2026-01-01T00:00:01.000Z",
      engine: { auth_method: "none", kind: "pi", model: "llama3.2", provider: "local" },
      memory: { enabled: false }, prompt: summarizePrompt("hi"), reply: { output_chars: 2, reply_given: true },
      schema: "daimon.turn_trace.v1", session: { dispose_after_wake: false, mode: "awake", thread_id: "t" },
      started_at: "2026-01-01T00:00:00.000Z", status: "completed", timings_ms: { total: 1 }, tools: [],
      turn_id: "turn-1", wake: { event_id: "w", kind: "message" }
    });
    assert.equal(await mode(path.join(home, "telemetry", "turns")), RUNTIME_HOME_SUBDIRECTORY_MODE);
  });
});

// Creations that are not inside an agent's runtime home.
const OUTSIDE_RUNTIME_HOME = [
  "src/runtime/native/copyArtifact.ts", "src/observability/emitCausalFixture.ts", "src/pi/auth.ts", "src/runtime/cli.ts"
];

const mkdirCalls = (source: string): string[] => {
  const calls: string[] = [];
  for (let index = source.indexOf("mkdir("); index !== -1; index = source.indexOf("mkdir(", index + 1)) {
    let depth = 0;
    for (let cursor = index + "mkdir".length; cursor < source.length; cursor += 1) {
      if (source[cursor] === "(") depth += 1;
      else if (source[cursor] === ")") { depth -= 1; if (depth === 0) { calls.push(source.slice(index, cursor + 1)); break; } }
    }
  }
  return calls;
};

test("no runtime-home directory is created without an explicit private mode", async () => {
  // Source policy: a default `mkdir` under an agent's runtime home would be 0755,
  // and the home of a brokered Grok agent is traversable by its worker uid.
  const offenders: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) { if (entry.name !== "fixtures" && entry.name !== "artifacts") await walk(target); continue; }
      if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts") || OUTSIDE_RUNTIME_HOME.includes(target)) continue;
      const source = await readFile(target, "utf8");
      for (const call of mkdirCalls(source)) {
        // The workspace is a caller-prepared root with its own contract (group-readable for Grok).
        if (call.includes("mode:") || call.includes("{ mode }") || call.includes("workspacePath")) continue;
        offenders.push(`${target}: ${call.replace(/\s+/gu, " ").slice(0, 90)}`);
      }
    }
  };
  await Promise.all(["src/pi", "src/observability", "src/runtime", "src/mcp", "src/core"].map(walk));
  assert.deepEqual(offenders, []);
});

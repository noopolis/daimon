import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { appendCausalEvent, CAUSAL_EVENT_VERSION, nextCausalSeq } from "../observability/causalEvents.js";
import { summarizePrompt, writeTurnTraceRecord } from "../pi/turnTrace.js";
import { ensureRuntimeHome, ensureRuntimeHomeDirectory, RUNTIME_HOME_SUBDIRECTORY_MODE } from "./runtimeHomeLayout.js";

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

const traceRecord = {
  agent_id: "mapper", completed_at: "2026-01-01T00:00:01.000Z",
  engine: { auth_method: "none", kind: "pi", model: "llama3.2", provider: "local" },
  memory: { enabled: false }, prompt: summarizePrompt("hi"), reply: { output_chars: 2, reply_given: true },
  schema: "daimon.turn_trace.v1", session: { dispose_after_wake: false, mode: "awake", thread_id: "t" },
  started_at: "2026-01-01T00:00:00.000Z", status: "completed", timings_ms: { total: 1 }, tools: [],
  turn_id: "turn-1", wake: { event_id: "w", kind: "message" }
} as unknown as Parameters<typeof writeTurnTraceRecord>[1];

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

    await writeTurnTraceRecord(home, traceRecord);
    assert.equal(await mode(path.join(home, "telemetry", "turns")), RUNTIME_HOME_SUBDIRECTORY_MODE);
  });
});

/**
 * The half the mode argument never covered.
 *
 * `mkdir(..., { mode })` decides nothing for a directory that already exists,
 * and `assertRuntimeDirectory` checks the home and not what Daimon creates
 * inside it. So a `telemetry/` left at 0755 by a pre-branch Daimon — or
 * pre-created by a deployment — stayed 0755 under a Grok agent's deliberately
 * traversable 0710 home, where it is the sandboxed worker reading its own
 * agent's prompts, replies and causal history.
 *
 * The boundary these assertions straddle: a fresh install against an existing
 * one. Every writer below is reached through its real entry point, because the
 * hole was never in the mode constant — it was in what the call sites did with
 * it.
 *
 * Mutation: restore `mkdir(directory, { recursive: true, mode })` in
 * `ensureRuntimeHomeDirectory` and every assertion here goes red while the
 * fresh-install test above stays green, which is exactly how this shipped.
 */
test("a runtime-home subdirectory that already exists is made private, not left as it was found", async () => {
  await withTraversableHome(async (home) => {
    // Pre-created by a deployment, or by a Daimon that predates the mode.
    await mkdir(path.join(home, "telemetry"), { mode: 0o755 });
    await appendCausalEvent(home, {
      version: CAUSAL_EVENT_VERSION, id: "daimon:t1:turn.output.completed", type: "turn.output.completed",
      occurred_at: "2026-01-01T00:00:00.000Z", actor: { kind: "agent", id: "a" }, subject: { kind: "turn", id: "t1" },
      causes: [], run_id: "run", seq: 1, payload: {}
    } as never);
    assert.equal(await mode(path.join(home, "telemetry")), RUNTIME_HOME_SUBDIRECTORY_MODE);

    // An existing ancestor is the same hole one level up: `telemetry/turns` can
    // be created privately under a `telemetry/` that stays world-readable.
    await chmod(path.join(home, "telemetry"), 0o755);
    await mkdir(path.join(home, "telemetry", "turns"), { mode: 0o755 });
    await writeTurnTraceRecord(home, traceRecord);
    assert.equal(await mode(path.join(home, "telemetry")), RUNTIME_HOME_SUBDIRECTORY_MODE, "the ancestor is corrected too");
    assert.equal(await mode(path.join(home, "telemetry", "turns")), RUNTIME_HOME_SUBDIRECTORY_MODE);

    // And the home itself is never touched: which mode it should carry is
    // `physicalReadiness.ts`'s judgement, and for a Grok agent it is 0710.
    assert.equal(await mode(home), 0o710);
  });
});

/**
 * Refuse rather than widen, and never follow a link to do it.
 *
 * A directory the runtime does not own cannot be made private by it, and
 * writing an agent's telemetry into it anyway is the failure the correction
 * exists to prevent. A symlink planted where a directory belongs is the same
 * fault with an attacker attached, so the correction goes through an
 * `O_DIRECTORY|O_NOFOLLOW` handle and the `fchmod` lands on the directory that
 * was stat'd.
 *
 * Mutation: drop the owner check and the first case silently proceeds; drop
 * `O_NOFOLLOW` and the second chmods the link's target instead of refusing.
 */
test("a runtime-home subdirectory owned by another user, or replaced by a symlink, is refused", async () => {
  await withTraversableHome(async (home) => {
    await mkdir(path.join(home, "telemetry"), { mode: 0o755 });
    const foreign = (process.getuid?.() ?? 0) + 4_242;
    await assert.rejects(ensureRuntimeHomeDirectory(home, "telemetry", foreign), /owned by the runtime user/u);
    assert.equal(await mode(path.join(home, "telemetry")), 0o755, "a refusal corrects nothing and widens nothing");

    const elsewhere = path.join(home, "elsewhere");
    await mkdir(elsewhere, { mode: 0o755 });
    await symlink(elsewhere, path.join(home, "tool-state"));
    await assert.rejects(ensureRuntimeHomeDirectory(home, "tool-state"));
    assert.equal(await mode(elsewhere), 0o755, "the link's target must not be chmod'ed through it");
  });
});

test("the home itself is created when absent and never re-moded when present", async () => {
  await withTraversableHome(async (home) => {
    const fresh = path.join(home, "fresh-home");
    assert.equal(await ensureRuntimeHome(fresh), fresh);
    assert.equal(await mode(fresh), RUNTIME_HOME_SUBDIRECTORY_MODE);
    await chmod(fresh, 0o710);
    await ensureRuntimeHome(fresh);
    assert.equal(await mode(fresh), 0o710, "a Grok agent's traversable home is not this helper's judgement");
  });
});

/**
 * The rule that keeps the correction from being reintroducible.
 *
 * `mkdir(..., { mode })` reads like a guarantee and is one only for a
 * directory that does not exist yet, so the mode constant stays private to
 * this module: a call site that wants a private directory under a runtime home
 * asks `ensureRuntimeHomeDirectory` for one and gets the assertion with it.
 *
 * Mutation: import the constant into any writer and pass it to `mkdir` again,
 * and this goes red — which is the shape the 0755 hole had.
 */
test("the private mode is used only where it is also asserted", async () => {
  const offenders: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) { if (entry.name !== "fixtures" && entry.name !== "artifacts") await walk(target); continue; }
      if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts") || target === "src/runtime/runtimeHomeLayout.ts") continue;
      if ((await readFile(target, "utf8")).includes("RUNTIME_HOME_SUBDIRECTORY_MODE")) offenders.push(target);
    }
  };
  await Promise.all(["src/pi", "src/observability", "src/runtime", "src/mcp", "src/core"].map(walk));
  assert.deepEqual(offenders, []);
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

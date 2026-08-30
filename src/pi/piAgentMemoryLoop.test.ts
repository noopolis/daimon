import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createMemoryRuntime, JsonlMemoryStore, type MemoryRuntime } from "@noopolis/mneme";
import type { WakeEvent } from "../core/types.js";
import { PiAgentHandle, type PiSessionLike } from "./piAgentHandle.js";
import type { PiTurnTraceModel } from "./turnTrace.js";

type PiEvent = { type: string; message?: { content?: string } };
type Listener = (event: PiEvent) => void;

const tempRoots: string[] = [];

test.beforeEach(() => {
  process.env.NOOPOLIS_RUN_ID = "run-test-pi-agent-memory-loop";
});
test.afterEach(() => {
  delete process.env.NOOPOLIS_RUN_ID;
});

const tempDir = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "noopolis-daimon-pi-memory-loop-"));
  tempRoots.push(directory);
  return directory;
};

test.afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const traceModel: PiTurnTraceModel = { authMethod: "none", model: "test", provider: "test" };

const wake = (id: string, text: string): WakeEvent => ({ id, kind: "manual", from: "operator", text });

interface StubSession extends PiSessionLike {
  prompts: string[];
}

/** Stub Pi session recording every prompt it receives and emitting a scripted reply. */
const makeStubSession = (
  replyFor: (promptIndex: number, text: string) => string,
  options: { failOn?: number } = {}
): StubSession => {
  const prompts: string[] = [];
  const listeners = new Set<Listener>();
  return {
    prompts,
    subscribe(listener) {
      listeners.add(listener as Listener);
      return () => listeners.delete(listener as Listener);
    },
    async prompt(text) {
      const index = prompts.length;
      prompts.push(text);
      if (options.failOn === index) {
        throw new Error(`stub session failure on prompt ${index}`);
      }
      const reply = replyFor(index, text);
      for (const listener of listeners) {
        listener({ type: "turn_end", message: { content: reply } });
      }
    },
    dispose() {
      listeners.clear();
    }
  };
};

test("second wake's prompt carries content recorded from the first wake (write-back loop closes)", async () => {
  const root = await tempDir();
  const runtimeHomePath = path.join(root, "runtime");
  const memory: MemoryRuntime = createMemoryRuntime({
    agentId: "loop-agent",
    runtimeHomePath,
    source: "test",
    tokenBudget: 4000
  });

  const marker = "GALAXY_BRAIN_MARKER_7421";
  const session = makeStubSession((index) => (index === 0 ? `Noted: ${marker}` : "ack-2"));
  const handle = new PiAgentHandle(
    "loop-agent",
    session,
    async () => session,
    runtimeHomePath,
    traceModel,
    memory
  );

  await handle.wake(wake("daimon:wake-1", `Remember this for later: ${marker}`));
  await handle.wake(wake("daimon:wake-2", "What did I tell you before?"));

  assert.equal(session.prompts.length, 2);
  assert.ok(
    session.prompts[1]?.includes(marker),
    `expected second wake's prompt to include marker recorded from the first turn, got: ${session.prompts[1]}`
  );

  await handle.stop();
});

test("a failed turn still writes a result:failed memory record, and the original error still propagates", async () => {
  const root = await tempDir();
  const runtimeHomePath = path.join(root, "runtime");
  const memory: MemoryRuntime = createMemoryRuntime({
    agentId: "fail-agent",
    runtimeHomePath,
    source: "test",
    tokenBudget: 2000
  });

  const session = makeStubSession(() => "unused", { failOn: 0 });
  const handle = new PiAgentHandle(
    "fail-agent",
    session,
    async () => session,
    runtimeHomePath,
    traceModel,
    memory
  );

  await assert.rejects(
    handle.wake(wake("daimon:wake-fail", "This turn will fail.")),
    /stub session failure on prompt 0/u
  );

  const events = await new JsonlMemoryStore(runtimeHomePath).read({ principalAgentId: "fail-agent" });
  const failureRecord = events.find((event) =>
    event.content.kind === "text" && event.content.text.includes("Turn failed:"));
  assert.ok(failureRecord, "expected a failed-turn memory.denied record");
  assert.ok(
    failureRecord?.content.kind === "text" &&
      failureRecord.content.text.includes("stub session failure on prompt 0")
  );

  await handle.stop();
});

test("a rejecting recordTurn does not fail an otherwise-successful turn, but surfaces via status().lastError", async () => {
  const root = await tempDir();
  const runtimeHomePath = path.join(root, "runtime");
  const memory: MemoryRuntime = createMemoryRuntime({
    agentId: "record-fail-agent",
    runtimeHomePath,
    source: "test",
    tokenBudget: 2000
  });
  memory.recordTurn = async () => {
    throw new Error("record boom");
  };

  const session = makeStubSession(() => "ack");
  const handle = new PiAgentHandle(
    "record-fail-agent",
    session,
    async () => session,
    runtimeHomePath,
    traceModel,
    memory
  );

  const result = await handle.wake(wake("daimon:wake-record-fail", "This turn should still succeed."));
  assert.equal(result.text, "ack");
  assert.equal(handle.status().lastError, "memory record failed: record boom");

  await handle.stop();
});

test("a wake whose event.id is not namespaced is still recorded, via the daimon: prefix satisfying mneme's guard", async () => {
  const root = await tempDir();
  const runtimeHomePath = path.join(root, "runtime");
  const memory: MemoryRuntime = createMemoryRuntime({
    agentId: "prefix-agent",
    runtimeHomePath,
    source: "test",
    tokenBudget: 2000
  });

  const session = makeStubSession(() => "ack");
  const handle = new PiAgentHandle(
    "prefix-agent",
    session,
    async () => session,
    runtimeHomePath,
    traceModel,
    memory
  );

  // "custom:wake-1" (colon present, but not one of mneme's four namespaces)
  // rather than a bare "wake-1": a bare id with no colon at all also trips a
  // separate, more generic causal-event-id shape check inside mneme's own
  // prepareTurn. Note: because PiAgentHandle passes the SAME request object
  // to both prepareTurn and recordTurn, prepareTurn's own memory.recall.mode
  // stamp validates wake_event_id against the identical
  // /^(simfile|moltnet|mneme|daimon):.+$/ pattern recordTurn's guard uses —
  // so a mutated (unprefixed) request.eventId is always caught by
  // prepareTurn first, never by recordTurn's own distinct error message.
  const result = await handle.wake(wake("custom:wake-1", "unnamespaced wake id"));
  assert.equal(result.text, "ack");
  assert.equal(
    handle.status().lastError,
    undefined,
    "recordTurn should succeed once the raw event.id is namespaced with daimon:"
  );

  const events = await new JsonlMemoryStore(runtimeHomePath).read({ principalAgentId: "prefix-agent" });
  assert.ok(
    events.some((event) => event.content.kind === "text" && event.content.text.includes("daimon:custom:wake-1")),
    "expected the recorded memory.claimed event to reference the daimon:-prefixed request event id"
  );

  await handle.stop();
});

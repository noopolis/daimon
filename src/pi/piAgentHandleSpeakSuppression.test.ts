import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { WakeEvent } from "../core/types.js";
import { PiAgentHandle, type PiSessionLike } from "./piAgentHandle.js";
import type { PiWakeEnvironmentContextRef } from "./piAgentWakeSupport.js";
import type { PiTurnTraceModel } from "./turnTrace.js";

/**
 * Covers the fix for the newsroom echo cascade: `moltnet_send` and the
 * bridge's terminal-text fallback (moltnet/internal/bridge/daimon/
 * receipt_tracker.go) share one publication slot, so a wake that already
 * spoke through `moltnet_send` must complete with empty text. These tests
 * simulate the tool side of that contract directly on the shared
 * `PiWakeEnvironmentContextRef` — `productionAgentTools.test.ts` covers that
 * `moltnetTool`'s `execute` is what actually sets `spokeFor`, and that
 * `moltnetReadTool` never does.
 */

type PiEvent = { type: string; message?: { content?: string } };
type Listener = (event: PiEvent) => void;

const tempRoots: string[] = [];
test.beforeEach(() => { process.env.NOOPOLIS_RUN_ID = "run-test-pi-agent-speak-suppression"; });
test.afterEach(() => { delete process.env.NOOPOLIS_RUN_ID; });
const tempDir = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "noopolis-daimon-pi-speak-suppression-"));
  tempRoots.push(directory);
  return directory;
};
test.afterEach(async () => { await Promise.all(tempRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

const traceModel: PiTurnTraceModel = { authMethod: "none", model: "test", provider: "test" };
const wake = (id: string, text: string): WakeEvent => ({ id, kind: "manual", from: "operator", text });

/**
 * Stub Pi session whose `prompt()` optionally simulates `moltnet_send`
 * having been called and accepted during the turn — exactly what
 * `moltnetTool`'s `execute` does on acceptance in
 * `src/runtime/productionAgentTools.ts` — before emitting the model's
 * terminal reply text.
 */
const makeStubSession = (
  reply: string,
  options: { wakeEnvironmentContext?: PiWakeEnvironmentContextRef; simulateSend?: boolean } = {}
): PiSessionLike => {
  const listeners = new Set<Listener>();
  return {
    subscribe(listener) { listeners.add(listener as Listener); return () => listeners.delete(listener as Listener); },
    async prompt() {
      if (options.simulateSend === true && options.wakeEnvironmentContext !== undefined) {
        options.wakeEnvironmentContext.spokeFor = options.wakeEnvironmentContext.current;
      }
      for (const listener of listeners) listener({ type: "turn_end", message: { content: reply } });
    },
    dispose() { listeners.clear(); }
  };
};

test("a wake that called moltnet_send completes with empty text, but the trace still records the full reply", async () => {
  const root = await tempDir();
  const wakeEnvironmentContext: PiWakeEnvironmentContextRef = {};
  const tracedOutputs: string[] = [];
  const session = makeStubSession("spoken reply text", { wakeEnvironmentContext, simulateSend: true });
  const handle = new PiAgentHandle(
    "agent", session, async () => session, path.join(root, "runtime"), traceModel,
    undefined, undefined,
    { traceTurn: async (input) => { tracedOutputs.push(input.outputText); } },
    undefined, undefined, undefined, undefined, undefined,
    wakeEnvironmentContext
  );

  const result = await handle.wake(wake("daimon:spoke-1", "hello"));

  assert.equal(result.text, "", "completion text must be blanked once moltnet_send was accepted");
  assert.deepEqual(tracedOutputs, ["spoken reply text"], "the turn trace must still record the model's actual reply");
  await handle.stop();
});

test("a wake that never called moltnet_send keeps its terminal text (the documented fallback)", async () => {
  const root = await tempDir();
  const wakeEnvironmentContext: PiWakeEnvironmentContextRef = {};
  const session = makeStubSession("fallback reply text", { wakeEnvironmentContext, simulateSend: false });
  const handle = new PiAgentHandle(
    "agent", session, async () => session, path.join(root, "runtime"), traceModel,
    undefined, undefined, {}, undefined, undefined, undefined, undefined, undefined,
    wakeEnvironmentContext
  );

  const result = await handle.wake(wake("daimon:no-speak-1", "hello"));

  assert.equal(result.text, "fallback reply text");
  await handle.stop();
});

test("reading Moltnet without sending does not suppress the terminal-text fallback", async () => {
  const root = await tempDir();
  // `moltnet_read` never writes `spokeFor` (see productionAgentTools.test.ts);
  // this reproduces that outcome by simply never simulating a send.
  const wakeEnvironmentContext: PiWakeEnvironmentContextRef = {};
  const session = makeStubSession("read-only reply text", { wakeEnvironmentContext, simulateSend: false });
  const handle = new PiAgentHandle(
    "agent", session, async () => session, path.join(root, "runtime"), traceModel,
    undefined, undefined, {}, undefined, undefined, undefined, undefined, undefined,
    wakeEnvironmentContext
  );

  const result = await handle.wake(wake("daimon:read-only-1", "hello"));

  assert.equal(result.text, "read-only reply text");
  await handle.stop();
});

test("the spoken flag from one wake never leaks into the next wake on the same agent", async () => {
  const root = await tempDir();
  // `engineDispatcher.ts` shares one `PiWakeEnvironmentContextRef` across
  // every wake of one agent's handle, and non-dream wakes reuse the same
  // Pi session (`selectPiSessionForWake`) — so one mutable stub session
  // driven by per-wake state faithfully reproduces both.
  const wakeEnvironmentContext: PiWakeEnvironmentContextRef = {};
  let reply = "first reply";
  let simulateSend = true;
  const listeners = new Set<Listener>();
  const session: PiSessionLike = {
    subscribe(listener) { listeners.add(listener as Listener); return () => listeners.delete(listener as Listener); },
    async prompt() {
      if (simulateSend) wakeEnvironmentContext.spokeFor = wakeEnvironmentContext.current;
      for (const listener of listeners) listener({ type: "turn_end", message: { content: reply } });
    },
    dispose() { listeners.clear(); }
  };
  const handle = new PiAgentHandle(
    "agent", session, async () => session, path.join(root, "runtime"), traceModel,
    undefined, undefined, {}, undefined, undefined, undefined, undefined, undefined,
    wakeEnvironmentContext
  );

  const first = await handle.wake(wake("daimon:leak-1", "hello"));
  assert.equal(first.text, "", "first wake spoke, so its text must be blanked");

  reply = "second reply";
  simulateSend = false;
  const second = await handle.wake(wake("daimon:leak-2", "hello again"));
  assert.equal(second.text, "second reply", "second wake never spoke, so the first wake's flag must not leak into it");

  await handle.stop();
});

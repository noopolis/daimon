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
 * receipt_tracker.go) share one publication slot. An agent with a mounted
 * `moltnet_send` tool must never publish through the fallback — whether it
 * spoke, stayed silent, or narrated a failure back as its terminal reply
 * (a tool error the model explains in its own words without ever calling
 * `moltnet_send`, which still completes the wake structurally and used to
 * leak that narration into the room). Publication is gated on
 * `hasSendCapability`, set once per agent in `piHarness.ts` from the
 * mounted tool list — never on `spokeFor`, which stays as per-wake
 * bookkeeping only (`productionAgentTools.test.ts` covers that `moltnetTool`'s
 * `execute` is what sets it, and that `moltnetReadTool` never does). These
 * tests simulate the tool side of that contract directly on the shared
 * `PiWakeEnvironmentContextRef`.
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

test("a send-capable agent that called moltnet_send completes with empty text, but the trace still records the full reply", async () => {
  const root = await tempDir();
  const wakeEnvironmentContext: PiWakeEnvironmentContextRef = { hasSendCapability: true };
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

  assert.equal(result.text, "", "completion text must be blanked for a send-capable agent");
  assert.deepEqual(tracedOutputs, ["spoken reply text"], "the turn trace must still record the model's actual reply");
  await handle.stop();
});

test("a send-capable agent that never called moltnet_send still completes with empty text (a narrated failure is not a second message)", async () => {
  const root = await tempDir();
  // Reproduces the defect directly: a tool error the model explains back as
  // its own terminal reply, without ever calling `moltnet_send`. The wake
  // still completes structurally (no thrown error), so `spokeFor` is never
  // set — but a mounted send tool means this text must never reach the room.
  const wakeEnvironmentContext: PiWakeEnvironmentContextRef = { hasSendCapability: true };
  const tracedOutputs: string[] = [];
  const session = makeStubSession("Blocked: Moltnet auth is not mounted, cannot send", { wakeEnvironmentContext, simulateSend: false });
  const handle = new PiAgentHandle(
    "agent", session, async () => session, path.join(root, "runtime"), traceModel,
    undefined, undefined,
    { traceTurn: async (input) => { tracedOutputs.push(input.outputText); } },
    undefined, undefined, undefined, undefined, undefined,
    wakeEnvironmentContext
  );

  const result = await handle.wake(wake("daimon:blocked-1", "hello"));

  assert.equal(result.text, "", "a narrated failure must never publish through the terminal-text fallback");
  assert.deepEqual(tracedOutputs, ["Blocked: Moltnet auth is not mounted, cannot send"], "the turn trace still records what the model actually said");
  await handle.stop();
});

test("an agent with no moltnet_send tool keeps its terminal text (the documented fallback)", async () => {
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

test("reading Moltnet without sending does not itself mark the wake as having spoken", async () => {
  const root = await tempDir();
  // `moltnet_read` never writes `spokeFor` (see productionAgentTools.test.ts).
  // `spokeFor` is bookkeeping only now — publication is gated on
  // `hasSendCapability`, left unset here to represent an agent with no send
  // tool mounted — so the fallback still applies.
  const wakeEnvironmentContext: PiWakeEnvironmentContextRef = {};
  const session = makeStubSession("read-only reply text", { wakeEnvironmentContext, simulateSend: false });
  const handle = new PiAgentHandle(
    "agent", session, async () => session, path.join(root, "runtime"), traceModel,
    undefined, undefined, {}, undefined, undefined, undefined, undefined, undefined,
    wakeEnvironmentContext
  );

  const result = await handle.wake(wake("daimon:read-only-1", "hello"));

  assert.equal(result.text, "read-only reply text");
  assert.equal(wakeEnvironmentContext.spokeFor, undefined);
  await handle.stop();
});

test("a send-capable agent's blanked text is not affected by the per-wake spokeFor reset, across spoke/silent/narrated wakes", async () => {
  const root = await tempDir();
  // `engineDispatcher.ts`/`piHarness.ts` set `hasSendCapability` once at
  // agent construction and share one `PiWakeEnvironmentContextRef` across
  // every wake of that agent's handle; non-dream wakes reuse the same Pi
  // session (`selectPiSessionForWake`) — so one mutable stub session driven
  // by per-wake state faithfully reproduces both.
  const wakeEnvironmentContext: PiWakeEnvironmentContextRef = { hasSendCapability: true };
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
  assert.equal(first.text, "", "first wake spoke, and is send-capable, so its text must be blanked");

  reply = "Blocked: cannot proceed";
  simulateSend = false;
  const second = await handle.wake(wake("daimon:leak-2", "hello again"));
  assert.equal(second.text, "", "second wake never spoke, but remains send-capable, so its narrated failure must also be blanked");

  await handle.stop();
});

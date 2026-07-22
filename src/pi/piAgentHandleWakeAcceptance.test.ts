import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai/base";
import { createAgentSession } from "@earendil-works/pi-coding-agent";
import { createMemoryRuntime, type MemoryRuntime } from "@noopolis/mneme";
import type { WakeEvent } from "../core/types.js";
import { PiAgentHandle, type PiSession, type PiSessionCreator } from "./piAgentHandle.js";
import { stampTurnInputSubmitted, stampTurnOutputCompleted } from "./turnCausal.js";
import type { PersistPiTurnTraceInput } from "./turnTrace.js";
import { WakeAcceptanceError, WakeAcceptanceStore, type WakeAcceptanceStoreLike, type WakeAcceptanceStoreState } from "./wakeAcceptance.js";

type Listener = Parameters<PiSession["subscribe"]>[0];
type PiEvent = Parameters<Listener>[0];
type Gate = { signal: Promise<void>; release: () => void };
type Hooks = Partial<Record<"begin" | "invoking" | "completed" | "incomplete", () => Promise<void>>>;
type InputStamp = Parameters<typeof stampTurnInputSubmitted>[0];
type OutputStamp = Parameters<typeof stampTurnOutputCompleted>[0];
type Options = { memory?: MemoryRuntime; createSession?: PiSessionCreator; fail?: Error; failAt?: "prompt" | "input" | "output" | "trace"; hooks?: Hooks; order?: string[]; inputs?: InputStamp[]; outputs?: OutputStamp[]; traces?: PersistPiTurnTraceInput[]; prompts?: string[] };

const roots: string[] = [];
const count = (xs: readonly string[], value: string): number => xs.filter((item) => item === value).length;
const gate = (): Gate => { let release = (): void => {}; const signal = new Promise<void>((resolve) => { release = resolve; }); return { signal, release }; };
const code = (expected: WakeAcceptanceError["code"]) => (value: unknown): boolean => value instanceof WakeAcceptanceError && value.code === expected;
const event = (id: string, text = `body-${id}`): WakeEvent => ({ id, kind: "message", from: "sender", text, context: { networkId: "net", roomId: "room", teamId: "team", pairPeers: ["one"], artifactPaths: ["a"] }, delivery: { eventId: id, sender: "sender", target: "agent", contextId: `ctx-${id}` } });
const tmp = async (): Promise<string> => { const root = await mkdtemp(path.join(os.tmpdir(), "b34-")); roots.push(root); return root; };
const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const state = async (home: string): Promise<WakeAcceptanceStoreState> => JSON.parse(await readFile(new WakeAcceptanceStore(home, "agent").getAcceptanceFilePath(), "utf8")) as WakeAcceptanceStoreState;
const assertState = async (home: string, expected: "completed" | "incomplete" | "invoking"): Promise<void> => assert.deepEqual((await state(home)).records.map((record) => record.state), [expected]);

test.afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const session = async (home: string, order: string[], failure?: Error, prompts?: string[]): Promise<PiSession> => {
  const real = (await createAgentSession({ cwd: home, agentDir: path.join(home, ".agent") })).session;
  const listeners = new Set<Listener>();
  real.subscribe = (listener: Listener) => { listeners.add(listener); return () => listeners.delete(listener); };
  real.prompt = async (text: string, _options?: Parameters<PiSession["prompt"]>[1]): Promise<void> => {
    order.push("prompt"); prompts?.push(text); if (failure !== undefined) throw failure;
    const message: AssistantMessage = { role: "assistant", content: [{ type: "text", text: "done" }], api: "openai-codex", provider: "openai-codex", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 0 };
    const end: PiEvent = { type: "turn_end", message, toolResults: [] };
    listeners.forEach((listener) => listener(end));
  };
  return real;
};

const trackedStore = (home: string, order: string[], hooks: Hooks = {}): WakeAcceptanceStoreLike => {
  const store = new WakeAcceptanceStore(home, "agent");
  return {
    candidateFromDelivery(value) { order.push("candidate"); return store.candidateFromDelivery(value); },
    async begin(value) { order.push("begin"); await hooks.begin?.(); const result = await store.begin(value); order.push(result.mode === "run" ? "accepted" : "replay"); return result; },
    async markInvoking(value) { order.push("invoking"); await hooks.invoking?.(); return store.markInvoking(value); },
    async markCompleted(value) { order.push("completed"); await hooks.completed?.(); return store.markCompleted(value); },
    async markIncomplete(value) { order.push("incomplete"); await hooks.incomplete?.(); return store.markIncomplete(value); }
  };
};

const harness = async (home: string, options: Options = {}): Promise<{ handle: PiAgentHandle; order: string[] }> => {
  const order = options.order ?? []; const main = await session(home, order, options.failAt === "prompt" ? options.fail : undefined, options.prompts);
  const handle = new PiAgentHandle("agent", main, options.createSession ?? (async () => main), home, { authMethod: "none", model: "test", provider: "test" }, options.memory, undefined, {
    createWakeAcceptance: () => trackedStore(home, order, options.hooks),
    runWake: async (input) => { order.push("causal input"); options.inputs?.push(input); if (options.failAt === "input") throw options.fail; return stampTurnInputSubmitted(input); },
    completeTurn: async (input) => { order.push("causal output"); options.outputs?.push(input); if (options.failAt === "output") throw options.fail; return stampTurnOutputCompleted(input); },
    traceTurn: async (input) => { order.push("trace"); options.traces?.push(input); if (options.failAt === "trace") throw options.fail; }
  });
  return { handle, order };
};

test("accepted delivery has the exact successful global order", async () => {
  const home = await tmp(); const { handle, order } = await harness(home);
  assert.equal((await handle.wake(event("ordered"))).text, "done");
  assert.deepEqual(order.filter((value) => value !== "candidate"), ["begin", "accepted", "causal input", "invoking", "prompt", "causal output", "trace", "completed"]);
  await assertState(home, "completed"); await handle.stop();
});

test("two handles permit only the valid replay-or-incomplete loser outcome", async () => {
  const home = await tmp(); const order: string[] = []; const entered = gate(); const release = gate(); let blocked = false;
  const hooks: Hooks = { begin: async () => { if (!blocked) { blocked = true; entered.release(); await release.signal; } } };
  let memoryId = 0; const memory = (): MemoryRuntime => { const value = createMemoryRuntime({ agentId: "agent", runtimeHomePath: path.join(home, `memory-${memoryId++}`), source: "test", tokenBudget: 1 }); const prepare = value.prepareTurn.bind(value); value.prepareTurn = async (input) => { order.push("memory"); return prepare(input); }; return value; };
  const left = await harness(home, { order, hooks, memory: memory() }); const right = await harness(home, { order, hooks, memory: memory() });
  const first = left.handle.wake(event("race")); await entered.signal; const second = right.handle.wake(event("race")); release.release();
  const settled = await Promise.allSettled([first, second]);
  const runs = settled.filter((result) => result.status === "fulfilled" && result.value.text === "done");
  const replays = settled.filter((result) => result.status === "fulfilled" && result.value.text === "");
  const rejected = settled.filter((result) => result.status === "rejected");
  assert.equal(runs.length, 1);
  assert.equal(replays.length + rejected.length, 1);
  if (replays.length === 1) {
    const replay = replays[0];
    if (replay.status !== "fulfilled") throw new Error("missing fulfilled replay");
    assert.equal(replay.value.text, "");
    assert.equal(replay.value.durationMs, 0);
  } else {
    const loser = rejected[0];
    if (loser?.status !== "rejected") throw new Error("missing rejected loser");
    assert.ok(code("wake_delivery_incomplete")(loser.reason));
  }
  assert.equal(count(order, "accepted"), 1); assert.equal(count(order, "memory"), 1); assert.equal(count(order, "causal input"), 1); assert.equal(count(order, "invoking"), 1); assert.equal(count(order, "prompt"), 1); assert.equal(count(order, "causal output"), 1); assert.equal(count(order, "trace"), 1); assert.equal(count(order, "completed"), 1);
  assert.equal(count(order, "incomplete"), 0); assert.deepEqual(order.filter((value) => value !== "candidate" && value !== "replay"), ["begin", "begin", "accepted", "memory", "causal input", "invoking", "prompt", "causal output", "trace", "completed"]);
  assert.equal(count(order, "replay") + rejected.length, 1); await assertState(home, "completed");
  const stateBeforeStableReplay = await state(home);
  const stableReplay = await left.handle.wake(event("race"));
  assert.equal(stableReplay.text, "");
  assert.equal(stableReplay.durationMs, 0);
  assert.equal(count(order, "memory"), 1); assert.equal(count(order, "causal input"), 1); assert.equal(count(order, "causal output"), 1);
  assert.equal(count(order, "trace"), 1); assert.equal(count(order, "invoking"), 1); assert.equal(count(order, "completed"), 1); assert.equal(count(order, "prompt"), 1);
  assert.deepEqual(await state(home), stateBeforeStableReplay);
  await left.handle.stop(); await right.handle.stop();
});

test("wake snapshots every delivered consumer before admission", async () => {
  const home = await tmp(); const entered = gate(); const release = gate(); const inputs: InputStamp[] = []; const outputs: OutputStamp[] = []; const traces: PersistPiTurnTraceInput[] = []; const prompts: string[] = [];
  const original = event("snap", "before"); const candidate = new WakeAcceptanceStore(home, "agent").candidateFromDelivery(original);
  const memory = createMemoryRuntime({ agentId: "agent", runtimeHomePath: path.join(home, "memory"), source: "test", tokenBudget: 1 }); const prepare = memory.prepareTurn.bind(memory); const requests: InputStamp["event"][] = [];
  memory.prepareTurn = async (request) => { requests.push({ id: request.eventId, kind: request.kind, from: request.from, text: request.text, context: request.context }); return prepare(request); };
  const { handle, order } = await harness(home, { memory, inputs, outputs, traces, prompts, hooks: { begin: async () => { entered.release(); await release.signal; } } });
  const waking = handle.wake(original); await entered.signal; original.text = "after"; original.from = "bad"; original.delivery = { eventId: "snap", sender: "bad", target: "agent", contextId: "bad" }; original.context?.pairPeers?.push("two"); original.context?.artifactPaths?.push("b"); release.release(); await waking;
  const expectedContext = { networkId: "net", roomId: "room", teamId: "team", pairPeers: ["one"], artifactPaths: ["a"] };
  const memoryCapture = requests.map((request) => { if (request.context === undefined) throw new Error("missing memory context"); return { id: request.id, kind: request.kind, from: request.from, text: request.text, context: { networkId: request.context.networkId, roomId: request.context.roomId, teamId: request.context.teamId, pairPeers: request.context.pairPeers, artifactPaths: request.context.artifactPaths } }; });
  assert.deepEqual(memoryCapture, [{ id: "snap", kind: "message", from: "sender", text: "before", context: expectedContext }]); assert.deepEqual(inputs.map((input) => input.event), [event("snap", "before")]); assert.deepEqual(outputs.map((output) => ({ cause: output.causeEventId, turn: output.turnId })), [{ cause: "daimon:snap:turn.input.submitted", turn: "snap" }]); assert.deepEqual(traces.map((trace) => ({ event: trace.event, prompt: trace.promptText })), [{ event: event("snap", "before"), prompt: prompts[0] }]); assert.match(prompts[0], /before/); assert.doesNotMatch(prompts[0], /\nafter\b|from: bad|pair\/qualifier:two/);
  const record = (await state(home)).records[0]; assert.deepEqual({ identity: record.identity, digest: record.digest, body: record.body_sha256, context: record.context_id, sender: record.sender }, { identity: candidate.identity, digest: candidate.digest, body: sha("before"), context: "ctx-snap", sender: "sender" });
  assert.equal((await handle.wake(event("snap", "before"))).durationMs, 0); assert.equal(count(order, "prompt"), 1); await handle.stop();
});

test("delivery validation bypass and typed Pi fixture behavior", async () => {
  const home = await tmp(); const { handle, order } = await harness(home);
  await assert.rejects(handle.wake({ ...event("bad"), kind: "manual" }), code("wake_delivery_invalid"));
  for (const kind of ["dream", "manual", "schedule"] as const) assert.equal((await handle.wake({ id: kind, kind, from: "x", text: kind })).text, "done");
  assert.equal(count(order, "begin"), 0); assert.equal(count(order, "prompt"), 3); await handle.stop();
});

test("failure matrix preserves original errors and exact durable outcomes", async () => {
  const rows: Array<{ stage: string; input: WakeEvent; failAt?: Options["failAt"]; memory?: boolean; dream?: boolean; hook?: "invoking" | "completed"; incompleteFails?: boolean; order: readonly string[]; final?: "incomplete" | "invoking" }> = [
    { stage: "memory prepare", input: event("memory"), memory: true, order: ["candidate", "begin", "accepted", "memory", "trace", "incomplete"], final: "incomplete" },
    { stage: "dream session create/select", input: { id: "dream", kind: "dream", from: "x", text: "x" }, dream: true, order: ["trace"], final: undefined },
    { stage: "engine prompt", input: event("prompt"), failAt: "prompt", order: ["candidate", "begin", "accepted", "causal input", "invoking", "prompt", "trace", "incomplete"], final: "incomplete" },
    { stage: "causal input", input: event("input"), failAt: "input", order: ["candidate", "begin", "accepted", "causal input", "trace", "incomplete"], final: "incomplete" },
    { stage: "causal output", input: event("output"), failAt: "output", order: ["candidate", "begin", "accepted", "causal input", "invoking", "prompt", "causal output", "trace", "incomplete"], final: "incomplete" },
    { stage: "trace", input: event("trace"), failAt: "trace", order: ["candidate", "begin", "accepted", "causal input", "invoking", "prompt", "causal output", "trace", "trace", "incomplete"], final: "incomplete" },
    { stage: "invoking transition", input: event("invoking"), hook: "invoking", order: ["candidate", "begin", "accepted", "causal input", "invoking", "trace", "incomplete"], final: "incomplete" },
    { stage: "completion transition marks incomplete", input: event("completed-incomplete"), hook: "completed", order: ["candidate", "begin", "accepted", "causal input", "invoking", "prompt", "causal output", "trace", "completed", "incomplete"], final: "incomplete" },
    { stage: "completion transition keeps invoking", input: event("completed-invoking"), hook: "completed", incompleteFails: true, order: ["candidate", "begin", "accepted", "causal input", "invoking", "prompt", "causal output", "trace", "completed", "incomplete"], final: "invoking" }
  ];
  for (const row of rows) {
    const home = await tmp(); const failure = new Error(row.stage); const order: string[] = []; let memory: MemoryRuntime | undefined;
    if (row.memory) {
      memory = createMemoryRuntime({ agentId: "agent", runtimeHomePath: path.join(home, "memory"), source: "test", tokenBudget: 1 });
      memory.prepareTurn = async () => { order.push("memory"); throw failure; };
    }
    const hooks: Hooks | undefined = row.hook === "invoking"
      ? { invoking: async () => { throw failure; } }
      : row.hook === "completed"
        ? { completed: async () => { throw failure; }, incomplete: row.incompleteFails ? async () => { throw new Error("incomplete secondary"); } : undefined }
        : undefined;
    const createSession: PiSessionCreator | undefined = row.dream ? async () => { throw failure; } : undefined;
    const { handle } = await harness(home, { order, memory, createSession, fail: failure, failAt: row.failAt, hooks });
    await assert.rejects(handle.wake(row.input), (value: unknown) => value === failure, row.stage);
    assert.deepEqual(order, row.order, row.stage);
    if (row.memory) assert.equal(count(order, "memory"), 1, `${row.stage} memory calls`);
    if (row.final !== undefined) {
      await assertState(home, row.final);
      const durableBeforeRetry = await state(home);
      const orderBeforeRetry = [...order];
      const countsBeforeRetry = {
        memory: count(order, "memory"),
        prompt: count(order, "prompt"),
        causalInput: count(order, "causal input"),
        causalOutput: count(order, "causal output"),
        trace: count(order, "trace"),
        invoking: count(order, "invoking"),
        completed: count(order, "completed"),
        incomplete: count(order, "incomplete")
      };
      await assert.rejects(handle.wake(row.input), code("wake_delivery_incomplete"));
      assert.deepEqual(order, [...orderBeforeRetry, "candidate", "begin"], `${row.stage} retry delta`);
      assert.deepEqual({
        memory: count(order, "memory"),
        prompt: count(order, "prompt"),
        causalInput: count(order, "causal input"),
        causalOutput: count(order, "causal output"),
        trace: count(order, "trace"),
        invoking: count(order, "invoking"),
        completed: count(order, "completed"),
        incomplete: count(order, "incomplete")
      }, countsBeforeRetry, `${row.stage} retry consumers`);
      assert.deepEqual(await state(home), durableBeforeRetry, `${row.stage} retry durable state`);
    } else {
      assert.equal(count(order, "candidate"), 0);
      assert.equal(count(order, "begin"), 0);
      assert.equal(count(order, "accepted"), 0);
      assert.equal(count(order, "invoking"), 0);
      assert.equal(count(order, "completed"), 0);
      assert.equal(count(order, "incomplete"), 0);
      await assert.rejects(readFile(new WakeAcceptanceStore(home, "agent").getAcceptanceFilePath(), "utf8"), /ENOENT/);
    }
    await handle.stop();
  }
});

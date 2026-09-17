import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import type { NativeBrokerTurn, NativeBrokerTurnResult } from "./engineBrokerNativeClient.js";
import type { EngineBrokerServiceRegistration } from "./engineBrokerServiceConfig.js";
import { EngineBrokerTurnRegistry } from "./engineBrokerTurnRegistry.js";
import { startGrokBrokerProxy } from "./grokBrokerProxy.js";
import { EngineBrokerTurnFailure, runGrokEngineBrokerTurn, type GrokEngineBrokerTurnDependencies } from "./grokEngineBrokerTurn.js";
import { TURN_REQUEST_LEDGER_VERSION } from "./turnRequestLedger.js";
import { TURN_USAGE_LEDGER_VERSION } from "./turnUsageLedger.js";

const lean = ["run_terminal_command", "read_file", "list_dir", "grep", "search_tool", "use_tool"].map((name) => ({ type: "function", function: { name } }));
const leanBody = JSON.stringify({ model: "grok-4.6", reasoning_effort: "low", stream: true, messages: [], tools: lean });
const upstreamUsage = { prompt_tokens: 2_696, completion_tokens: 79, total_tokens: 2_775, prompt_tokens_details: { cached_tokens: 128 } };
const turnIdFor = (agentId: string, wakeId: string): string => createHash("sha256").update(`${agentId}\0${wakeId}`).digest("hex");

const assistant = (id: string, usage: Record<string, number>, content: unknown[], stop: string) => ({ type: "assistant", message: { id, type: "message", role: "assistant", model: "daimon-broker-grok", content, stop_reason: stop, usage }, parent_tool_use_id: null, session_id: "01a0ad21-a90f-7f71-8054-93fdb4334d6a" });
const first = { input_tokens: 2_568, output_tokens: 79, cache_read_input_tokens: 128, cache_creation_input_tokens: 0 };
const second = { input_tokens: 109, output_tokens: 13, cache_read_input_tokens: 2_688, cache_creation_input_tokens: 0 };
const stream = (modelKey = "grok-4.6-build"): string => [
  { type: "system", subtype: "init", session_id: "01a0ad21-a90f-7f71-8054-93fdb4334d6a" },
  assistant("msg_0", first, [{ type: "tool_use", id: "call-0", name: "use_tool", input: {} }], "tool_use"),
  assistant("msg_1", second, [{ type: "text", text: "TANGERINE-7" }], "end_turn"),
  { type: "result", subtype: "success", is_error: false, num_turns: 2, result: "TANGERINE-7", stop_reason: "end_turn", total_cost_usd: 0.00248676, usage: { input_tokens: 2_677, output_tokens: 92, cache_read_input_tokens: 2_816, cache_creation_input_tokens: 0 }, modelUsage: { [modelKey]: {} }, session_id: "01a0ad21-a90f-7f71-8054-93fdb4334d6a" }
].map((frame) => JSON.stringify(frame)).join("\n");

function post(port: number, token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: "/v1/chat/completions", method: "POST", agent: false, headers: { authorization: `Bearer ${token}`, "x-grok-client-version": "1.0.34", "content-type": "application/json" } }, (response) => { response.resume(); response.on("end", () => resolve(response.statusCode ?? 0)); });
    req.on("error", reject); req.end(leanBody);
  });
}

type Worker = (post: () => Promise<number>, signal: AbortSignal) => Promise<string>;
const nativeResult = (text: string): NativeBrokerTurnResult => ({ text, workerPid: 4_242, workerUid: 2_200, startTicks: 99n, diagnostic: { status: "ok", stage: "output", failureClass: "none", profileApplied: false, exitCode: 0, termSignal: 0, workerPid: 4_242, workerUid: 2_200, startTicks: "99" } });
const untilAborted = (signal: AbortSignal): Promise<never> => new Promise((_resolve, reject) => { const fail = () => reject(new Error("engine broker turn failed")); if (signal.aborted) fail(); else signal.addEventListener("abort", fail, { once: true }); });

/**
 * The real turn registry, proxy, meter and ledgers around a scripted worker that
 * talks to the proxy exactly as the native worker does (capability bearer,
 * pinned client version, lean body). Only the launcher and attestation are fakes.
 */
const withBroker = async (body: (context: Readonly<{ root: string; turn: (wakeId: string, worker: Worker, overrides?: Parameters<typeof runGrokEngineBrokerTurn>[6], limits?: EngineBrokerServiceRegistration["limits"], turnStore?: string) => ReturnType<typeof runGrokEngineBrokerTurn>; usageRows: () => Promise<Record<string, unknown>[]>; requestRows: () => Promise<Record<string, unknown>[]>; upstreamCalls: () => number }>) => Promise<void>, usageLedgerPath?: string, upstreamDelayMs: (call: number) => number = () => 15): Promise<void> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-broker-usage-"));
  let calls = 0;
  const proxy = await startGrokBrokerProxy({ accessToken: async () => "provider-token", markRejected: async () => undefined }, async () => { calls++; await new Promise((resolve) => setTimeout(resolve, upstreamDelayMs(calls))); return { status: 200, headers: { "content-type": "text/event-stream" }, body: Buffer.from(`data: ${JSON.stringify({ choices: [], usage: upstreamUsage })}\n\ndata: [DONE]\n\n`) }; }, undefined, 0);
  const ledger = usageLedgerPath ?? path.join(root, "usage.jsonl");
  const rows = async (file: string) => (await readFile(file, "utf8").catch(() => "")).split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as Record<string, unknown>);
  try {
    await body({
      root,
      turn: (wakeId, worker, overrides, limits = { maxRequests: 32, maxTokens: 300_000, timeoutMs: 240_000 }, turnStore = path.join(root, "turns")) => {
        const registration: EngineBrokerServiceRegistration = { agentId: "foreman", slot: 0, workerUid: 2_200, workspace: "/workspace", profilePath: "/workers/0/.grok/sandbox.toml", eventsPath: "/workers/0/.grok/sessions/sandbox-events.jsonl", profileSha256: "a".repeat(64), usageLedgerPath: ledger, limits, model: { model: "grok-4.6", reasoningEffort: "low" } };
        const deps: GrokEngineBrokerTurnDependencies = {
          turns: new EngineBrokerTurnRegistry(turnStore), proxy, credentialStale: () => false,
          mcp: { register: () => "mcp-capability-0123456789abcdef", revoke: () => undefined },
          prepareIsolation: async () => async () => undefined,
          runNative: async (input: NativeBrokerTurn, signal: AbortSignal) => nativeResult(await worker(() => post(proxy.port, input.providerCapability), signal))
        };
        return runGrokEngineBrokerTurn(deps, registration, wakeId, "prompt", "http://127.0.0.1:43124/mcp", undefined, overrides);
      },
      usageRows: () => rows(ledger),
      requestRows: () => rows(path.join(path.dirname(ledger), "requests.jsonl")),
      upstreamCalls: () => calls
    });
  } finally { await proxy.close(); await rm(root, { recursive: true, force: true }); }
};

const twoRequests: Worker = async (send) => { assert.equal(await send(), 200); assert.equal(await send(), 200); return stream(); };

test("a completed turn seals its accounting, writes one usage row and per-request rows, and a replay never re-meters", async () => {
  await withBroker(async ({ root, turn, usageRows, requestRows }) => {
    const result = await turn("wake-1", twoRequests);
    assert.deepEqual({ ...result, text: undefined }, { text: undefined, workerPid: 4_242, workerUid: 2_200, workerStartTime: "99", outcome: "completed", usage: { input: 2_677, cacheRead: 2_816, cacheWrite: 0, output: 92, total: 5_585 }, model: "grok-4.6", requests: 2, limitReason: "none" });
    // Mutation guard: metering on the replay path appends a second row here.
    let replayedWorker = false;
    assert.deepEqual(await turn("wake-1", async () => { replayedWorker = true; return stream(); }), result);
    assert.deepEqual(await turn("wake-1", twoRequests, undefined, undefined, path.join(root, "turns")), result, "a fresh registry boot replays the sealed accounting");
    assert.equal(replayedWorker, false);
    const usage = await usageRows();
    assert.equal(usage.length, 1);
    assert.deepEqual({ ...usage[0], at: undefined }, { v: TURN_USAGE_LEDGER_VERSION, agent: "foreman", wake: "wake-1", engine: "grok", at: undefined, input: 2_677, output: 92, cache_read: 2_816, cache_write: 0, total: 5_585, calls: 2, notional_usd: 0.00248676, complete: true, outcome: "completed", turn: turnIdFor("foreman", "wake-1"), limit_reason: "none", model: "grok-4.6" });
    const requests = await requestRows();
    assert.deepEqual(requests.map((row) => [row.v, row.engine, row.request, row.requests, row.input, row.fresh_input, row.cached_input, row.total, row.turn]), [
      [TURN_REQUEST_LEDGER_VERSION, "grok", 0, 2, 2_696, 2_568, 128, 2_775, turnIdFor("foreman", "wake-1")],
      [TURN_REQUEST_LEDGER_VERSION, "grok", 1, 2, 2_797, 109, 2_688, 2_810, turnIdFor("foreman", "wake-1")]
    ]);
    // Mutation guard: stamping every request with the wake end collapses these.
    // The upstream stub takes 15 ms per request, so each request has a measurable interval.
    const [a, b] = requests.map((row) => [Date.parse(String(row.started_at)), Date.parse(String(row.ended_at))] as const);
    assert.ok(a![0] < a![1] && a![1] <= b![0] && b![0] < b![1], JSON.stringify(requests.map((row) => [row.started_at, row.ended_at])));
    assert.ok(b![1] <= Date.parse(String(requests[1]!.at)), "every request ended before the rows were appended");
  });
});

test("a turn past maxRequests is refused before upstream, killed, sealed as limit_exceeded, and its partial usage is metered", async () => {
  await withBroker(async ({ turn, usageRows, upstreamCalls }) => {
    const worker: Worker = async (send, signal) => { for (;;) { if (await send() === 429) return untilAborted(signal); } };
    await assert.rejects(turn("wake-2", worker, undefined, { maxRequests: 3, maxTokens: 300_000, timeoutMs: 240_000 }), (error: unknown) => {
      assert.ok(error instanceof EngineBrokerTurnFailure);
      assert.equal(error.code, "limit_exceeded");
      assert.deepEqual(error.accounting, { outcome: "failed", usage: { input: 7_704, cacheRead: 384, cacheWrite: 0, output: 237, total: 8_325 }, model: "grok-4.6", requests: 3, limitReason: "requests" });
      return true;
    });
    assert.equal(upstreamCalls(), 3);
    // Mutation guard: metering only completed turns leaves this ledger empty.
    const [row, extra] = await usageRows();
    assert.equal(extra, undefined);
    assert.deepEqual([row?.outcome, row?.reason, row?.limit_reason, row?.total, row?.calls, row?.complete], ["failed", "request_ceiling", "requests", 8_325, 3, false]);
    await assert.rejects(turn("wake-2", twoRequests), (error: unknown) => error instanceof EngineBrokerTurnFailure && error.accounting?.limitReason === "requests");
    assert.equal((await usageRows()).length, 1, "the replayed failure is not metered again");
  });
});

test("the token ceiling stops a turn one request past the ceiling at most", async () => {
  await withBroker(async ({ turn, upstreamCalls }) => {
    const worker: Worker = async (send, signal) => { for (;;) { if (await send() === 429) return untilAborted(signal); } };
    // 2,775 tokens per request against 5,000: requests 1 and 2 are admitted, 3 is refused.
    await assert.rejects(turn("wake-3", worker, { maxTokens: 5_000 }), (error: unknown) => error instanceof EngineBrokerTurnFailure && error.accounting?.limitReason === "tokens" && error.accounting.usage?.total === 5_550);
    assert.equal(upstreamCalls(), 2);
  });
});

test("the wall-clock limit aborts a worker that is mid-request", async () => {
  await withBroker(async ({ turn, usageRows, requestRows }) => {
    const started = Date.now();
    // Request 2 is still upstream (1.5 s) when the 1 s wall clock fires.
    const worker: Worker = async (send, signal) => { assert.equal(await send(), 200); void send().catch(() => undefined); return untilAborted(signal); };
    await assert.rejects(turn("wake-4", worker, { timeoutMs: 1_000 }), (error: unknown) => error instanceof EngineBrokerTurnFailure && error.code === "limit_exceeded" && error.accounting?.limitReason === "timeout" && error.accounting.requests === 2);
    assert.ok(Date.now() - started < 1_400, "the turn ends at the deadline, not when the in-flight request returns");
    assert.deepEqual((await usageRows()).map((row) => [row.reason, row.limit_reason, row.total, row.calls]), [["wake_timeout", "timeout", 2_775, 2]]);
    // One measured row, but both admitted requests count: the killed one was sent upstream.
    assert.deepEqual((await requestRows()).map((row) => [row.request, row.requests]), [[0, 2]]);
  }, undefined, (call) => call === 2 ? 1_500 : 15);
});

test("a wake may only lower a declared limit: raising one is refused before any turn record or worker", async () => {
  await withBroker(async ({ turn, usageRows, upstreamCalls }) => {
    let ran = false;
    // Mutation guard: clamping or accepting the raise runs the worker.
    await assert.rejects(turn("wake-5", async () => { ran = true; return stream(); }, { maxTokens: 300_001 }), (error: unknown) => error instanceof EngineBrokerTurnFailure && error.code === "invalid_request");
    assert.equal(ran, false); assert.equal(upstreamCalls(), 0); assert.deepEqual(await usageRows(), []);
    assert.equal((await turn("wake-5", twoRequests, { maxTokens: 299_999, timeoutMs: 1_000 })).outcome, "completed", "a lowered limit is accepted and the turn was never recorded");
  });
});

test("a turn whose stream reports an undeclared model fails as rejected but is still metered", async () => {
  await withBroker(async ({ turn, usageRows }) => {
    await assert.rejects(turn("wake-6", async (send) => { await send(); await send(); return stream("grok-4.5-build"); }), (error: unknown) => error instanceof EngineBrokerTurnFailure && error.code === "engine_failed");
    assert.deepEqual((await usageRows()).map((row) => [row.outcome, row.reason, row.model, row.total]), [["failed", "turn_rejected", "grok-4.6", 5_585]]);
  });
});

test("an unwritable ledger leaves the turn recorded as completed, not failed", async () => {
  await withBroker(async ({ root, turn }) => {
    assert.equal((await turn("wake-7", twoRequests)).outcome, "completed");
    assert.equal((await turn("wake-7", twoRequests, undefined, undefined, path.join(root, "turns"))).outcome, "completed");
  }, path.join(os.tmpdir(), `daimon-missing-${process.pid}`, "not-provisioned", "usage.jsonl"));
});

test("the broker meters only through the single sealing helper, on both terminal branches", async () => {
  const source = await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "grokEngineBrokerTurn.ts"), "utf8");
  const body = source.slice(source.indexOf("export async function runGrokEngineBrokerTurn"), source.indexOf("function replay("));
  assert.equal(body.includes("recordTurnUsage("), false);
  assert.equal(body.includes("turns.finish("), false, "every terminal record is sealed through the metering helper");
  assert.equal((body.match(/finishBrokerTurnWithUsage\(/gu) ?? []).length, 2);
  assert.ok(body.indexOf("return replay(") < body.indexOf("finishBrokerTurnWithUsage("), "a replay returns before any metering");
});

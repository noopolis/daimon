import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { decodeNativeBrokerResult, ENGINE_BROKER_NATIVE_RESULT_BYTES, type NativeBrokerTurn, type NativeBrokerTurnResult } from "./engineBrokerNativeClient.js";
import type { EngineBrokerServiceRegistration } from "./engineBrokerServiceConfig.js";
import { EngineBrokerTurnRegistry } from "./engineBrokerTurnRegistry.js";
import { startGrokBrokerProxy } from "./grokBrokerProxy.js";
import type { EngineBrokerMcpCallObservation } from "./engineBrokerMcpCallLog.js";
import { EngineBrokerTurnFailure, runGrokEngineBrokerTurn, type GrokEngineBrokerTurnDependencies } from "./grokEngineBrokerTurn.js";
import { TURN_REQUEST_LEDGER_VERSION } from "./turnRequestLedger.js";
import { dedupeTurnUsageRows, TURN_USAGE_LEDGER_VERSION } from "./turnUsageLedger.js";
import { WakeFuse } from "./wakeFuse.js";

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
/** The stub provider's own SSE response: usage only, and no tool call, unless a test says otherwise. */
const upstreamResponse = (): string => `data: ${JSON.stringify({ choices: [], usage: upstreamUsage })}\n\ndata: [DONE]\n\n`;
/** One streaming tool call per name, arguments in a following delta, then the usage event. */
const upstreamToolCallResponse = (names: readonly string[]): string => [
  ...names.map((name, index) => ({ choices: [{ index: 0, delta: { tool_calls: [{ index, id: `call-${index}`, type: "function", function: { name, arguments: "" } }] } }] })),
  ...names.map((_name, index) => ({ choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: '{"tool_name":"daimon__moltnet_read"}' } }] } }] })),
  { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: upstreamUsage }
].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";

const withBroker = async (body: (context: Readonly<{ root: string; turn: (wakeId: string, worker: Worker, overrides?: Parameters<typeof runGrokEngineBrokerTurn>[6], limits?: EngineBrokerServiceRegistration["limits"], turnStore?: string, syncDirectory?: (directory: string) => Promise<void>) => ReturnType<typeof runGrokEngineBrokerTurn>; usageRows: () => Promise<Record<string, unknown>[]>; requestRows: () => Promise<Record<string, unknown>[]>; upstreamCalls: () => number; upstreamAborts: () => number }>) => Promise<void>, usageLedgerPath?: string, upstreamDelayMs: (call: number) => number = () => 15, upstreamBody: (call: number) => string = upstreamResponse): Promise<void> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-broker-usage-"));
  let calls = 0, aborted = 0;
  const proxy = await startGrokBrokerProxy({ accessToken: async () => "provider-token", markRejected: async () => undefined }, async (_request, signal) => { calls++; await new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, upstreamDelayMs(calls)); signal?.addEventListener("abort", () => { clearTimeout(timer); aborted++; reject(new Error("aborted")); }, { once: true }); }); return { status: 200, headers: { "content-type": "text/event-stream" }, body: Buffer.from(upstreamBody(calls)) }; }, undefined, 0);
  const ledger = usageLedgerPath ?? path.join(root, "usage.jsonl");
  const rows = async (file: string) => (await readFile(file, "utf8").catch(() => "")).split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as Record<string, unknown>);
  try {
    await body({
      root,
      turn: (wakeId, worker, overrides, limits = { maxRequests: 32, maxTokens: 300_000, timeoutMs: 240_000 }, turnStore = path.join(root, "turns"), syncDirectory = undefined) => {
        const registration: EngineBrokerServiceRegistration = { agentId: "foreman", slot: 0, workerUid: 2_200, workspace: "/workspace", profilePath: "/workers/0/.grok/sandbox.toml", eventsPath: "/workers/0/.grok/sessions/sandbox-events.jsonl", profileSha256: "a".repeat(64), usageLedgerPath: ledger, limits, model: { model: "grok-4.6", reasoningEffort: "low" } };
        const deps: GrokEngineBrokerTurnDependencies = {
          turns: syncDirectory === undefined ? new EngineBrokerTurnRegistry(turnStore) : new EngineBrokerTurnRegistry(turnStore, undefined, syncDirectory), proxy, credentialStale: () => false,
          mcp: { register: () => "mcp-capability-0123456789abcdef", revoke: () => undefined, observe: () => mcpObservation },
          prepareIsolation: async () => async () => undefined,
          runNative: async (input: NativeBrokerTurn, signal: AbortSignal) => nativeResult(await worker(() => post(proxy.port, input.providerCapability), signal))
        };
        return runGrokEngineBrokerTurn(deps, registration, wakeId, "prompt", "http://127.0.0.1:43124/mcp", undefined, overrides);
      },
      usageRows: () => rows(ledger),
      requestRows: () => rows(path.join(path.dirname(ledger), "requests.jsonl")),
      upstreamCalls: () => calls,
      upstreamAborts: () => aborted
    });
  } finally { await proxy.close(); await rm(root, { recursive: true, force: true }); }
};

/** What the facade would have seen of this turn's tool calls; the turn only reads it. */
let mcpObservation: EngineBrokerMcpCallObservation | undefined;

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
  await withBroker(async ({ turn, usageRows, requestRows, upstreamAborts }) => {
    const started = Date.now();
    // Request 2 is still upstream (1.5 s) when the 1 s wall clock fires.
    const worker: Worker = async (send, signal) => { assert.equal(await send(), 200); void send().catch(() => undefined); return untilAborted(signal); };
    await assert.rejects(turn("wake-4", worker, { timeoutMs: 1_000 }), (error: unknown) => error instanceof EngineBrokerTurnFailure && error.code === "limit_exceeded" && error.accounting?.limitReason === "timeout" && error.accounting.requests === 2);
    assert.ok(Date.now() - started < 1_400, "the turn ends at the deadline, not when the in-flight request returns");
    assert.equal(upstreamAborts(), 1, "the stuck upstream call is aborted, not left running");
    // The aborted request reported nothing, so it is charged the estimate and says so.
    assert.deepEqual((await usageRows()).map((row) => [row.reason, row.limit_reason, row.total, row.calls, row.estimated_requests]), [["wake_timeout", "timeout", 2_775 + 4_297, 2, 1]]);
    assert.deepEqual((await requestRows()).map((row) => [row.request, row.requests, row.usage_source, row.total]), [[0, 2, "upstream", 2_775], [1, 2, "estimated", 4_297]]);
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

test("a crash between sealing and appending is completed by the replay exactly once, with the sealed bytes", async () => {
  await withBroker(async ({ root, turn, usageRows, requestRows }) => {
    await turn("wake-8", twoRequests);
    const [sealedUsage] = await usageRows(); const sealedRequests = await requestRows();
    // Simulate the crash window: the record is published but the append never happened.
    await rm(path.join(root, "usage.jsonl")); await rm(path.join(root, "requests.jsonl"));
    // Mutation guard: a replay that never ensures its ledger leaves this spend unmetered.
    assert.equal((await turn("wake-8", async () => { throw new Error("a replay runs no worker"); })).outcome, "completed");
    assert.deepEqual(await usageRows(), [sealedUsage]);
    assert.deepEqual(await requestRows(), sealedRequests);
    // A replay after the rows exist writes nothing further.
    await turn("wake-8", async () => { throw new Error("a replay runs no worker"); });
    assert.equal((await usageRows()).length, 1);
    assert.equal((await requestRows()).length, 2);
  });
});

test("a ledger append that fails after the turn was sealed leaves it completed and appends nothing twice", async () => {
  await withBroker(async ({ root, turn, usageRows }) => {
    // The request stream cannot be written (its path is a directory); the usage stream can.
    await mkdir(path.join(root, "requests.jsonl"));
    assert.equal((await turn("wake-9", twoRequests)).outcome, "completed");
    assert.deepEqual((await usageRows()).map((row) => [row.outcome, row.turn]), [["completed", turnIdFor("foreman", "wake-9")]]);
    assert.equal((await turn("wake-9", twoRequests, undefined, undefined, path.join(root, "turns"))).outcome, "completed", "the sealed record was never rewritten as failed");
    assert.equal((await usageRows()).length, 1);
  });
});

test("a directory-sync failure after the completed record is published never re-seals the turn as failed", async () => {
  await withBroker(async ({ root, turn, usageRows, requestRows }) => {
    let syncs = 0;
    // Sync 1 is begin()'s active record; sync 2 follows the completed record's rename.
    const failAfterPublish = async (): Promise<void> => { syncs += 1; if (syncs === 2) throw new Error("EIO"); };
    // Mutation guard: letting the post-rename failure reject makes the turn's catch write `failed` over the published record.
    const result = await turn("wake-10", twoRequests, undefined, undefined, path.join(root, "turns"), failAfterPublish);
    assert.equal(result.outcome, "completed");
    assert.equal(syncs, 2);
    assert.deepEqual((await usageRows()).map((row) => [row.outcome, row.turn]), [["completed", turnIdFor("foreman", "wake-10")]]);
    assert.equal((await requestRows()).length, 2);
    const replayed = await turn("wake-10", async () => { throw new Error("a replay runs no worker"); });
    assert.deepEqual(replayed, result);
    assert.equal((await usageRows()).length, 1);
  });
});

test("two concurrent replays of one sealed turn may both append, and every reader still counts the turn once", async () => {
  await withBroker(async ({ root, turn, usageRows }) => {
    await turn("wake-11", twoRequests);
    const [sealed] = await usageRows();
    await rm(path.join(root, "usage.jsonl")); await rm(path.join(root, "requests.jsonl"));
    const noWorker = async (): Promise<string> => { throw new Error("a replay runs no worker"); };
    const replays = await Promise.all([turn("wake-11", noWorker), turn("wake-11", noWorker), turn("wake-11", noWorker)]);
    assert.ok(replays.every((replayed) => replayed.outcome === "completed"));
    const rows = await usageRows();
    assert.ok(rows.length >= 1 && rows.every((row) => row.turn === sealed!.turn && row.total === sealed!.total), "duplicates, if any, are byte-equal sealed rows");
    // Readers dedupe on `turn`: the ledger helper and the wake fuse's sum both count it once.
    assert.deepEqual(dedupeTurnUsageRows(rows).map((row) => row.total), [sealed!.total]);
    const fuseDirectory = path.join(root, "fuse"); await mkdir(fuseDirectory);
    const fuse = await WakeFuse.open({ organizationKey: "org", now: () => new Date(Date.parse(String(sealed!.at)) - 1), environment: {
      DAIMON_WAKE_FUSE_DIRECTORY: fuseDirectory, DAIMON_WAKE_FUSE_EPOCH: "replay", DAIMON_WAKE_FUSE_MAX_WAKES: "10",
      DAIMON_WAKE_FUSE_MAX_TOKENS: String(Number(sealed!.total) + 1), DAIMON_TURN_USAGE_LEDGER_PATH: path.join(root, "usage.jsonl")
    } });
    // Counted once the turn is below the ceiling by one token; counted twice it would trip.
    const concurrentRows = [...rows, ...rows];
    await writeFile(path.join(root, "usage.jsonl"), concurrentRows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    assert.deepEqual(await fuse.admit("foreman", "next"), { state: "admitted" });
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

/**
 * The question two live turns could not answer: did the model ever *try* to
 * call a tool? The rows carried timings and tokens and nothing about an
 * attempt, so a turn with zero tool calls and a turn whose calls all failed
 * read identically after the fact.
 */
test("each per-request row records the tool-call names that request's response carried, names only", async () => {
  await withBroker(async ({ turn, requestRows }) => {
    await turn("wake-tools", twoRequests);
    const rows = await requestRows();
    // Mutation guard: without the field these are `[undefined, undefined]`.
    assert.deepEqual(rows.map((row) => row.tool_calls), [["use_tool", "search_tool"], ["use_tool", "search_tool"]]);
    const text = JSON.stringify(rows);
    // Names only: no arguments, no message content, no bearer.
    assert.equal(text.includes("daimon__moltnet_read"), false, "an argument value must never reach the ledger");
    assert.equal(text.includes("arguments"), false);
    assert.equal(text.includes("provider-token"), false);
  }, undefined, () => 1, () => upstreamToolCallResponse(["use_tool", "search_tool"]));
});

test("a response that called nothing records an empty list, and one that cannot be decoded records no field at all", async () => {
  await withBroker(async ({ turn, requestRows }) => {
    await turn("wake-silent", twoRequests);
    // Decoded, and it called nothing: that is an observation, not a gap.
    assert.deepEqual((await requestRows()).map((row) => row.tool_calls), [[], []]);
  }, undefined, () => 1);
  await withBroker(async ({ turn, requestRows }) => {
    await turn("wake-undecodable", twoRequests);
    const rows = await requestRows();
    // Mutation guard: a fabricated `[]` here would be byte-identical to the
    // measured empty list above, and the ledger would claim an observation the
    // proxy never made.
    assert.deepEqual(rows.map((row) => Object.hasOwn(row, "tool_calls")), [false, false]);
    assert.deepEqual(rows.map((row) => row.request), [0, 1], "the rows themselves are still written");
  }, undefined, () => 1, () => "<html>bad gateway</html>");
});


/**
 * The exact 128-byte frame `supervise()` emits when a worker crosses
 * `DBL_MAX_OUTPUT`: it stops reading, SIGKILLs the process group, and publishes
 * `output_length = 0` with `DBL_STATUS_OUTPUT_FAILED`. Built here at the wire
 * offsets the header's `_Static_assert`s pin, so the test drives the real
 * decoder rather than a hand-made exception.
 */
function outputLimitFrame(turnId: string): Buffer {
  const frame = Buffer.alloc(ENGINE_BROKER_NATIVE_RESULT_BYTES);
  frame.writeUInt32LE(2, 0); frame.writeUInt32LE(3, 4); frame.writeUInt32LE(2_200, 8); frame.writeUInt32LE(0, 12);
  frame.writeInt32LE(4_242, 16); frame.writeInt32LE(0, 20); frame.writeInt32LE(9, 24);
  frame.writeBigUInt64LE(99n, 32); frame.write(turnId, 40, "utf8");
  frame.writeUInt32LE(7, 108); frame.writeUInt32LE(7, 112); frame.writeUInt32LE(0, 116); frame.writeUInt32LE(0, 120);
  return frame;
}

test("a worker whose work succeeded but whose output crossed the launcher bound still seals the spend the proxy measured", async () => {
  await withBroker(async ({ turn, usageRows, requestRows, upstreamCalls }) => {
    // The worker does its real work through the real proxy — two admitted,
    // metered upstream requests — and only then loses its whole output: the
    // launcher refused to publish it and the turn's text never exists. The
    // frame is decoded by the shipped client, so the failure reaches the turn
    // exactly as the native transport delivers it.
    const worker: Worker = async (send) => {
      assert.equal(await send(), 200);
      assert.equal(await send(), 200);
      throw decodeNativeBrokerResult(outputLimitFrame(turnIdFor("foreman", "wake-output-limit")), turnIdFor("foreman", "wake-output-limit"), []) as never;
    };
    await assert.rejects(turn("wake-output-limit", worker), (error: unknown) => {
      assert.ok(error instanceof EngineBrokerTurnFailure);
      // No limit tripped and the credential is live: this is the worker's
      // transport failing, not the turn being refused.
      assert.equal(error.code, "engine_failed");
      assert.equal(error.diagnostic?.failureClass, "output_limit");
      // Mutation guard: the turn has no stream to read usage from, so this can
      // only come from the proxy's own per-request measurements. Falling back
      // to `null` here would report a fabricated zero for real spend.
      assert.deepEqual(error.accounting, { outcome: "failed", usage: { input: 5_136, cacheRead: 256, cacheWrite: 0, output: 158, total: 5_550 }, model: "grok-4.6", requests: 2, limitReason: "none" });
      return true;
    });
    assert.equal(upstreamCalls(), 2);
    const [row, extra] = await usageRows();
    assert.equal(extra, undefined);
    assert.deepEqual([row?.outcome, row?.reason, row?.total, row?.calls, row?.complete], ["failed", "unknown", 5_550, 2, false]);
    assert.notEqual(row?.total, 0, "a zero row would be byte-identical to a measured zero");
    assert.deepEqual((await requestRows()).map((value) => value.request), [0, 1], "every request the proxy answered keeps its own row");
    // The sealed record is the durable truth: a replay returns that spend and never meters again.
    await assert.rejects(turn("wake-output-limit", twoRequests), (error: unknown) =>
      error instanceof EngineBrokerTurnFailure && error.accounting?.usage?.total === 5_550);
    assert.equal((await usageRows()).length, 1, "the replayed failure is not metered again");
  });
});

/**
 * The hang this instrument was built for: the worker stops acting with every
 * provider request closed, the deadline kills it, and the only remaining
 * question is whether it was waiting on a tool call. The answer has to reach
 * the host, and the slot's control root is tmpfs that dies with the container —
 * so it rides the seam the worker's last words and the sealed usage already
 * ride: the sealed terminal response, which a replay hands back unchanged.
 */
test("a failed turn carries the facade's in-flight tool-call observation, and its replay still does", async () => {
  await withBroker(async ({ turn }) => {
    mcpObservation = { started: 3, answered: 2, undecoded: 0, outstanding: [{ name: "daimon__moltnet_read", outstandingMs: 419_000 }] };
    const worker: Worker = async (send) => { assert.equal(await send(), 200); assert.equal(await send(), 200); throw new Error("engine broker turn failed"); };
    const carried = (error: unknown): boolean => {
      assert.ok(error instanceof EngineBrokerTurnFailure);
      assert.deepEqual(error.mcpCalls, { started: 3, answered: 2, undecoded: 0, outstanding: [{ name: "daimon__moltnet_read", outstandingMs: 419_000 }] });
      return true;
    };
    await assert.rejects(turn("wake-mcp-outstanding", worker), carried);
    // The replay reads the durable record back through the frame parser, so
    // this is the sealed bytes answering, not the live facade.
    mcpObservation = undefined;
    await assert.rejects(turn("wake-mcp-outstanding", worker), carried);
  });
});

test("a turn whose facade observed nothing seals no observation at all", async () => {
  await withBroker(async ({ turn }) => {
    mcpObservation = undefined;
    await assert.rejects(turn("wake-mcp-absent", async (send) => { await send(); throw new Error("engine broker turn failed"); }), (error: unknown) => error instanceof EngineBrokerTurnFailure && error.mcpCalls === undefined);
  });
});

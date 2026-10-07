import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { decodeNativeBrokerResult, ENGINE_BROKER_NATIVE_RESULT_BYTES, type NativeBrokerTurn, type NativeBrokerTurnResult } from "./engineBrokerNativeClient.js";
import type { EngineBrokerServiceRegistration } from "./engineBrokerServiceConfig.js";
import { EngineBrokerTurnRegistry } from "./engineBrokerTurnRegistry.js";
import { startGrokBrokerProxy } from "./grokBrokerProxy.js";
import { boundGrokFinalReply, GROK_FINAL_REPLY_MAX_BYTES, GrokBrokerTurnMeter, parseGrokFinalReply } from "./grokBrokerTurnMeter.js";
import { EngineBrokerTurnFailure, runGrokEngineBrokerTurn, type GrokEngineBrokerTurnDependencies } from "./grokEngineBrokerTurn.js";
import { findGrokWorkerProcess } from "./grokEngineBrokerTurnEnd.js";

const lean = ["run_terminal_command", "read_file", "list_dir", "grep", "search_tool", "use_tool"].map((name) => ({ type: "function", function: { name } }));
const leanBody = JSON.stringify({ model: "grok-4.6", reasoning_effort: "low", stream: true, messages: [], tools: lean });
const usage = { prompt_tokens: 2_696, completion_tokens: 79, total_tokens: 2_775, prompt_tokens_details: { cached_tokens: 128 } };
const sse = (chunks: readonly unknown[]): string => chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
const toolCall = sse([{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-0", type: "function", function: { name: "use_tool", arguments: "{}" } }] } }] }, { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage }]);
const finalReply = (text: string): string => sse([{ choices: [{ index: 0, delta: { content: text.slice(0, 3) } }] }, { choices: [{ index: 0, delta: { content: text.slice(3) } }] }, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage }]);
const turnIdFor = (agentId: string, wakeId: string): string => createHash("sha256").update(`${agentId}\0${wakeId}`).digest("hex");
const untilAborted = (signal: AbortSignal): Promise<never> => new Promise((_resolve, reject) => { const fail = () => reject(new Error("engine broker turn failed")); if (signal.aborted) fail(); else signal.addEventListener("abort", fail, { once: true }); });

function post(port: number, token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: "/v1/chat/completions", method: "POST", agent: false, headers: { authorization: `Bearer ${token}`, "x-grok-client-version": "1.0.34", "content-type": "application/json" } }, (response) => { response.resume(); response.on("end", () => resolve(response.statusCode ?? 0)); });
    req.on("error", reject); req.end(leanBody);
  });
}

type Worker = (send: () => Promise<number>, signal: AbortSignal) => Promise<string>;
type Harness = Readonly<{ turn(wakeId: string, worker: Worker, timeoutMs?: number): ReturnType<typeof runGrokEngineBrokerTurn>; rows(): Promise<Record<string, unknown>[]>; endedStreams(): number }>;

/** The real proxy, meter, registry and ledgers; the launcher is a scripted worker that answers the upstream bodies in order. */
async function withBroker(bodies: readonly string[], run: (harness: Harness) => Promise<void>, turnEnd = { finalGraceMs: 60, idleMs: 400, pollMs: 10 }): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-turn-end-"));
  let call = 0, ended = 0;
  const proxy = await startGrokBrokerProxy({ accessToken: async () => "provider-token", markRejected: async () => undefined }, async () => ({ status: 200, headers: { "content-type": "text/event-stream" }, body: Buffer.from(bodies[Math.min(call++, bodies.length - 1)]!) }), undefined, 0);
  const ledger = path.join(root, "usage.jsonl");
  try {
    await run({
      turn: (wakeId, worker, timeoutMs = 30_000) => {
        const registration: EngineBrokerServiceRegistration = { agentId: "foreman", slot: 0, workerUid: 2_200, workspace: "/workspace", profilePath: "/workers/0/.grok/sandbox.toml", eventsPath: "/workers/0/.grok/sessions/sandbox-events.jsonl", profileSha256: "a".repeat(64), usageLedgerPath: ledger, limits: { maxRequests: 32, maxTokens: 300_000, timeoutMs }, model: { model: "grok-4.6", reasoningEffort: "low" } };
        const deps: GrokEngineBrokerTurnDependencies = {
          turns: new EngineBrokerTurnRegistry(path.join(root, "turns")), proxy, credentialStale: () => false,
          mcp: { register: () => "mcp-capability-0123456789abcdef", revoke: () => undefined, endStreams: () => { ended++; }, activity: () => ({ inFlight: 0, lastActivityAt: 0 }) },
          prepareIsolation: async () => async () => undefined,
          observeWorker: async (uid) => uid === 2_200 ? { pid: 5_151, startTicks: "777" } : undefined,
          turnEnd,
          runNative: async (input: NativeBrokerTurn, signal: AbortSignal): Promise<NativeBrokerTurnResult> => {
            const text = await worker(() => post(proxy.port, input.providerCapability), signal);
            return { text, workerPid: 4_242, workerUid: 2_200, startTicks: 99n, diagnostic: { status: "ok", stage: "output", failureClass: "none", profileApplied: false, exitCode: 0, termSignal: 0, workerPid: 4_242, workerUid: 2_200, startTicks: "99" } };
          }
        };
        return runGrokEngineBrokerTurn(deps, registration, wakeId, "prompt", "http://127.0.0.1:43124/mcp");
      },
      rows: async () => (await readFile(ledger, "utf8").catch(() => "")).split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as Record<string, unknown>),
      endedStreams: () => ended
    });
  } finally { await proxy.close(); await rm(root, { recursive: true, force: true }); }
}

/** The launcher's own output-limit frame (`supervise()` past `DBL_MAX_OUTPUT`), decoded by the shipped client. */
function outputLimitFrame(turnId: string): Buffer {
  const frame = Buffer.alloc(ENGINE_BROKER_NATIVE_RESULT_BYTES);
  frame.writeUInt32LE(2, 0); frame.writeUInt32LE(3, 4); frame.writeUInt32LE(2_200, 8); frame.writeUInt32LE(0, 12);
  frame.writeInt32LE(4_242, 16); frame.writeInt32LE(0, 20); frame.writeInt32LE(9, 24);
  frame.writeBigUInt64LE(99n, 32); frame.write(turnId, 40, "utf8");
  frame.writeUInt32LE(7, 108); frame.writeUInt32LE(7, 112); frame.writeUInt32LE(0, 116); frame.writeUInt32LE(0, 120);
  return frame;
}

test("a worker that gave its final reply and never exits is ended by the broker and sealed completed with that reply", async () => {
  await withBroker([toolCall, finalReply("FILED-REVISION-3")], async ({ turn, rows, endedStreams }) => {
    const started = Date.now();
    // The production hang: the model answers, Grok logs handle_prompt.done, and the process just stays.
    const result = await turn("wake-hang", async (send, signal) => { assert.equal(await send(), 200); assert.equal(await send(), 200); return untilAborted(signal); });
    // Mutation guard: without the watchdog this waits for the 30 s wall clock.
    assert.ok(Date.now() - started < 5_000, `ended after ${Date.now() - started} ms`);
    assert.deepEqual({ ...result }, { text: "FILED-REVISION-3", workerPid: 5_151, workerUid: 2_200, workerStartTime: "777", outcome: "completed", usage: { input: 5_136, cacheRead: 256, cacheWrite: 0, output: 158, total: 5_550 }, model: "grok-4.6", requests: 2, limitReason: "none" });
    assert.equal(endedStreams(), 1, "the MCP tunnel is closed the moment the final reply is seen");
    assert.deepEqual((await rows()).map((row) => [row.outcome, row.limit_reason, row.total, row.calls]), [["completed", "none", 5_550, 2]]);
  });
});

test("a worker that exits normally after its final reply is completed from its own stdout, not the proxy's copy", async () => {
  await withBroker([finalReply("PROXY-COPY")], async ({ turn }) => {
    const session = "01a0ad21-a90f-7f71-8054-93fdb4334d6a", frameUsage = { input_tokens: 2_568, output_tokens: 79, cache_read_input_tokens: 128, cache_creation_input_tokens: 0 };
    const stdout = [
      { type: "system", subtype: "init", session_id: session },
      { type: "assistant", message: { id: "msg_0", type: "message", role: "assistant", model: "daimon-broker-grok", content: [{ type: "text", text: "STDOUT-TEXT" }], stop_reason: "end_turn", usage: frameUsage }, parent_tool_use_id: null, session_id: session },
      { type: "result", subtype: "success", is_error: false, num_turns: 1, result: "STDOUT-TEXT", stop_reason: "end_turn", total_cost_usd: 0.001, usage: frameUsage, modelUsage: { "grok-4.6-build": {} }, session_id: session }
    ].map((frame) => JSON.stringify(frame)).join("\n");
    const result = await turn("wake-exit", async (send) => { assert.equal(await send(), 200); return stdout; });
    assert.equal(result.text, "STDOUT-TEXT");
    assert.equal(result.workerPid, 4_242);
  });
});

test("a text answer followed by another model request is not a final reply: the turn is not cut off", async () => {
  await withBroker([finalReply("thinking out loud"), toolCall, finalReply("DONE")], async ({ turn }) => {
    const result = await turn("wake-continue", async (send, signal) => {
      assert.equal(await send(), 200);
      // Longer than the grace would be if the first answer counted from here, but the next request clears it.
      await send(); await new Promise((resolve) => setTimeout(resolve, 150));
      if (signal.aborted) return untilAborted(signal);
      await send();
      return untilAborted(signal);
    });
    assert.equal(result.text, "DONE");
    assert.equal(result.requests, 3);
  });
});

test("finished work whose stdout crossed the launcher bound is completed with its final reply, truncated with a marker", async () => {
  const long = "x".repeat(GROK_FINAL_REPLY_MAX_BYTES + 5_000);
  await withBroker([toolCall, finalReply(long)], async ({ turn, rows }) => {
    const turnId = turnIdFor("foreman", "wake-output");
    const result = await turn("wake-output", async (send) => { await send(); await send(); throw decodeNativeBrokerResult(outputLimitFrame(turnId), turnId, []) as never; });
    // Mutation guard: without the output-limit branch this rejects as engine_failed/output_limit.
    assert.equal(result.outcome, "completed");
    assert.equal(result.workerPid, 4_242, "the worker is the one the launcher reported");
    assert.ok(Buffer.byteLength(result.text) <= GROK_FINAL_REPLY_MAX_BYTES);
    assert.match(result.text, /\[… \d+ bytes truncated by the Daimon broker …\]$/u);
    assert.deepEqual((await rows()).map((row) => row.outcome), ["completed"]);
  }, { finalGraceMs: 60_000, idleMs: 60_000, pollMs: 10 });
});

test("an output-limit failure with no final reply stays failed", async () => {
  await withBroker([toolCall], async ({ turn }) => {
    const turnId = turnIdFor("foreman", "wake-output-midturn");
    await assert.rejects(turn("wake-output-midturn", async (send) => { await send(); throw decodeNativeBrokerResult(outputLimitFrame(turnId), turnId, []) as never; }), (error: unknown) => error instanceof EngineBrokerTurnFailure && error.code === "engine_failed" && error.diagnostic?.failureClass === "output_limit");
  });
});

test("a worker that goes idle without ever answering is ended by the idle watchdog as a timeout", async () => {
  await withBroker([toolCall], async ({ turn, rows }) => {
    const started = Date.now();
    await assert.rejects(turn("wake-idle", async (send, signal) => { await send(); return untilAborted(signal); }), (error: unknown) => error instanceof EngineBrokerTurnFailure && error.code === "limit_exceeded" && error.accounting?.limitReason === "timeout");
    // Mutation guard: without the idle bound this waits for the 30 s wall clock.
    assert.ok(Date.now() - started < 5_000);
    assert.deepEqual((await rows()).map((row) => [row.outcome, row.reason]), [["failed", "wake_timeout"]]);
  });
});

test("a final reply that idles into the wall clock is still completed", async () => {
  await withBroker([finalReply("LATE-BUT-DONE")], async ({ turn }) => {
    const result = await turn("wake-deadline", async (send, signal) => { await send(); return untilAborted(signal); }, 300);
    assert.equal(result.outcome, "completed");
    assert.equal(result.text, "LATE-BUT-DONE");
  }, { finalGraceMs: 60_000, idleMs: 60_000, pollMs: 10 });
});

test("cached prompt reads count at a quarter against the token ceiling; fresh input and output in full", () => {
  const meter = new GrokBrokerTurnMeter({ maxRequests: 32, maxTokens: 4_000, timeoutMs: 60_000 });
  const first = meter.admit(); assert.ok("index" in first);
  // 10,000 prompt tokens, 9,000 of them cached, 100 output: 1,000 + 100 + 2,250.
  meter.settle(first.index, { input: 1_000, cacheRead: 9_000, cacheWrite: 0, output: 100, total: 10_100 }, 10);
  assert.equal(meter.snapshot().tokens, 3_350);
  assert.equal(meter.snapshot().usage?.total, 10_100, "sealed usage keeps the raw count");
  // Mutation guard: counting cached reads in full puts 10,100 against 4,000 and refuses this.
  assert.ok("index" in meter.admit());
});

test("the final-reply parser accepts only a stopped answer without tool calls, and bounds what it keeps", () => {
  const body = (text: string) => Buffer.from(text);
  assert.equal(parseGrokFinalReply(body(finalReply("hello world")), "text/event-stream"), "hello world");
  assert.equal(parseGrokFinalReply(body(toolCall), "text/event-stream"), undefined);
  assert.equal(parseGrokFinalReply(body(sse([{ choices: [{ index: 0, delta: { content: "no finish" } }] }])), "text/event-stream"), undefined);
  assert.equal(parseGrokFinalReply(body(JSON.stringify({ choices: [{ index: 0, message: { content: "json" }, finish_reason: "stop" }] })), "application/json"), "json");
  assert.equal(boundGrokFinalReply("short", 100), "short");
  const cut = boundGrokFinalReply("é".repeat(100), 80);
  assert.ok(Buffer.byteLength(cut) <= 80);
  assert.match(cut, /^é+\n\[… \d+ bytes truncated by the Daimon broker …\]$/u);
});

test("the worker process is the identity's one process whose parent it does not own", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-proc-"));
  const proc = async (pid: number, uid: number, parent: number, state = "S", start = `${pid}00`) => {
    await mkdir(path.join(root, String(pid)));
    await writeFile(path.join(root, String(pid), "status"), `Name:\tx\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
    await writeFile(path.join(root, String(pid), "stat"), `${pid} (a b) ${state} ${parent} ${Array.from({ length: 17 }, () => "0").join(" ")} ${start} 0 0`);
  };
  try {
    await proc(10, 0, 1); await proc(20, 2_200, 10); await proc(21, 2_200, 20); await proc(30, 2_201, 10);
    assert.deepEqual(await findGrokWorkerProcess(2_200, root), { pid: 20, startTicks: "2000" });
    assert.equal(await findGrokWorkerProcess(2_202, root), undefined);
    await proc(40, 2_200, 10);
    assert.equal(await findGrokWorkerProcess(2_200, root), undefined, "two roots is not an identity the contract allows");
  } finally { await rm(root, { recursive: true, force: true }); }
});

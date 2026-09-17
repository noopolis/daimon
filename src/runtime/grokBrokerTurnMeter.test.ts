import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test from "node:test";

import { startGrokBrokerProxy } from "./grokBrokerProxy.js";
import { GrokBrokerTurnMeter, parseGrokUpstreamUsage } from "./grokBrokerTurnMeter.js";

const lean = ["run_terminal_command", "read_file", "list_dir", "grep", "search_tool", "use_tool"].map((name) => ({ type: "function", function: { name } }));
const body = JSON.stringify({ model: "grok-4.6", reasoning_effort: "low", stream: true, messages: [], tools: lean });
const sse = (usage: Record<string, unknown>): Uint8Array => Buffer.from([{ choices: [{ index: 0, delta: { content: "x" } }] }, { choices: [], usage }].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n");

function post(port: number, token: string): Promise<Readonly<{ status: number; text: string }>> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: "/v1/chat/completions", method: "POST", agent: false, headers: { authorization: `Bearer ${token}`, "x-grok-client-version": "1.0.34", "content-type": "application/json" } }, (response) => {
      const chunks: Buffer[] = []; response.on("data", (chunk: Buffer) => chunks.push(chunk)); response.on("end", () => resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject); req.end(body);
  });
}

const withProxy = async (usage: Record<string, unknown> | undefined, meter: GrokBrokerTurnMeter, run: (post: () => Promise<Readonly<{ status: number; text: string }>>, calls: () => number) => Promise<void>): Promise<void> => {
  let calls = 0;
  const proxy = await startGrokBrokerProxy({ accessToken: async () => "provider-token", markRejected: async () => undefined }, async () => { calls++; return { status: 200, headers: { "content-type": "text/event-stream" }, body: usage === undefined ? Buffer.from("data: [DONE]\n\n") : sse(usage) }; }, undefined, 0);
  try {
    const token = proxy.capabilities.issue("agent", "turn");
    proxy.registerIsolationGuard("turn", async () => undefined);
    proxy.registerTurn("turn", { policy: { model: "grok-4.6", reasoningEffort: "low" }, meter });
    await run(() => post(proxy.port, token), () => calls);
  } finally { await proxy.close(); }
};

test("maxRequests is hard: request N+1 is refused with 429 before any upstream call, and the limit trips once", async () => {
  const tripped: string[] = [];
  const meter = new GrokBrokerTurnMeter({ maxRequests: 2, maxTokens: 1_000_000, timeoutMs: 60_000 }, (reason) => tripped.push(reason));
  await withProxy({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, meter, async (send, calls) => {
    assert.equal((await send()).status, 200);
    assert.equal((await send()).status, 200);
    const refused = await send();
    assert.equal(refused.status, 429);
    assert.deepEqual(JSON.parse(refused.text), { error: "turn limit reached", limit: "requests" });
    assert.equal((await send()).status, 429);
    assert.equal(calls(), 2, "upstream never sees a request past maxRequests");
  });
  assert.deepEqual(tripped, ["requests"]);
  const snapshot = meter.snapshot();
  assert.equal(snapshot.requests, 2);
  assert.equal(snapshot.limitReason, "requests");
  assert.deepEqual(snapshot.usage, { input: 20, cacheRead: 0, cacheWrite: 0, output: 10, total: 30 });
});

test("the token ceiling overshoots by at most one request, counting cached input", async () => {
  // 60 tokens per request (40 cached) against a 100-token ceiling: requests 1 and
  // 2 are admitted (0 and 60 < 100 before each), request 3 is refused at 120.
  // Mutation guard: checking the ceiling after forwarding, or ignoring cached
  // tokens, admits a third request and this goes red.
  const meter = new GrokBrokerTurnMeter({ maxRequests: 32, maxTokens: 100, timeoutMs: 60_000 });
  await withProxy({ prompt_tokens: 50, completion_tokens: 10, total_tokens: 60, prompt_tokens_details: { cached_tokens: 40 } }, meter, async (send, calls) => {
    const statuses = [];
    for (let index = 0; index < 5; index++) statuses.push((await send()).status);
    assert.deepEqual(statuses, [200, 200, 429, 429, 429]);
    assert.equal(calls(), 2);
  });
  const snapshot = meter.snapshot();
  assert.equal(snapshot.limitReason, "tokens");
  assert.equal(snapshot.tokens, 120);
  assert.ok(snapshot.tokens - meter.limits.maxTokens <= 60, "overshoot is bounded by the last admitted request");
  assert.deepEqual(snapshot.usage, { input: 20, cacheRead: 80, cacheWrite: 0, output: 20, total: 120 });
});

test("a request after the elapsed deadline is refused, and every admitted request is timed", async () => {
  let now = 1_000_000;
  const meter = new GrokBrokerTurnMeter({ maxRequests: 32, maxTokens: 1_000_000, timeoutMs: 5_000 }, undefined, () => now);
  await withProxy(undefined, meter, async (send, calls) => {
    assert.equal((await send()).status, 200);
    now += 5_000;
    assert.equal((await send()).status, 429);
    assert.equal(calls(), 1);
  });
  const snapshot = meter.snapshot();
  assert.equal(snapshot.limitReason, "timeout");
  // A body without usage is never a zero: it is charged the conservative estimate (402-byte body).
  const estimate = { input: 201, cacheRead: 0, cacheWrite: 0, output: 4_096, total: 4_297 };
  assert.deepEqual(snapshot.usage, estimate);
  assert.equal(snapshot.estimatedRequests, 1);
  assert.deepEqual(snapshot.timings, [{ startedAt: new Date(1_000_000).toISOString(), endedAt: new Date(1_000_000).toISOString(), usage: estimate, estimated: true }]);
});

test("a turn without a registered meter is never forwarded", async () => {
  let calls = 0;
  const proxy = await startGrokBrokerProxy({ accessToken: async () => "provider-token", markRejected: async () => undefined }, async () => { calls++; return { status: 200, headers: {}, body: Buffer.from("{}") }; }, undefined, 0);
  try {
    const token = proxy.capabilities.issue("agent", "turn");
    proxy.registerIsolationGuard("turn", async () => undefined);
    assert.equal((await post(proxy.port, token)).status, 503);
    assert.equal(calls, 0);
  } finally { await proxy.close(); }
});

test("upstream usage parsing takes the last usage block and never zero-fills", () => {
  assert.deepEqual(parseGrokUpstreamUsage(sse({ prompt_tokens: 100, completion_tokens: 7, total_tokens: 120, prompt_tokens_details: { cached_tokens: 30 }, completion_tokens_details: { reasoning_tokens: 13 } }), "text/event-stream"),
    { input: 70, cacheRead: 30, cacheWrite: 0, output: 20, total: 120, reasoning: 13 });
  assert.deepEqual(parseGrokUpstreamUsage(Buffer.from(JSON.stringify({ usage: { prompt_tokens: 4, completion_tokens: 1 } })), "application/json"), { input: 4, cacheRead: 0, cacheWrite: 0, output: 1, total: 5 });
  assert.equal(parseGrokUpstreamUsage(sse({ prompt_tokens: "4", completion_tokens: 1 }), "text/event-stream"), undefined);
  assert.equal(parseGrokUpstreamUsage(sse({ prompt_tokens: 4, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 9 } }), "text/event-stream"), undefined);
  assert.equal(parseGrokUpstreamUsage(Buffer.from("not json"), "application/json"), undefined);
});

test("at most one upstream request is in flight per turn: an overlapping request is refused, uncounted", async () => {
  // Mutation guard: without the in-flight gate both overlapping requests pass on
  // the same pre-settle token total and the one-request overshoot bound is gone.
  const meter = new GrokBrokerTurnMeter({ maxRequests: 32, maxTokens: 100, timeoutMs: 60_000 });
  const first = meter.admit();
  assert.ok("index" in first);
  assert.deepEqual(meter.admit(), { busy: true });
  assert.equal(meter.snapshot().requests, 1);
  meter.settle(first.index, { input: 60, cacheRead: 0, cacheWrite: 0, output: 60, total: 120 }, 0);
  assert.deepEqual(meter.admit(), { refused: "tokens" }, "once settled, the next request sees the reported total");

  let release!: () => void; let calls = 0;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const live = new GrokBrokerTurnMeter({ maxRequests: 32, maxTokens: 1_000_000, timeoutMs: 60_000 });
  const proxy = await startGrokBrokerProxy({ accessToken: async () => "provider-token", markRejected: async () => undefined }, async () => { calls++; await gate; return { status: 200, headers: { "content-type": "text/event-stream" }, body: sse({ prompt_tokens: 1, completion_tokens: 1 }) }; }, undefined, 0);
  try {
    const token = proxy.capabilities.issue("agent", "turn");
    proxy.registerIsolationGuard("turn", async () => undefined);
    proxy.registerTurn("turn", { policy: { model: "grok-4.6", reasoningEffort: "low" }, meter: live });
    const pending = post(proxy.port, token);
    while (calls === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    const overlapping = await post(proxy.port, token);
    assert.deepEqual([overlapping.status, JSON.parse(overlapping.text)], [429, { error: "turn request in flight" }]);
    assert.equal(calls, 1);
    release();
    assert.equal((await pending).status, 200);
    assert.equal((await post(proxy.port, token)).status, 200);
    assert.deepEqual([calls, live.snapshot().requests, live.snapshot().limitReason], [2, 2, "none"]);
  } finally { release(); await proxy.close(); }
});

test("tripping a limit aborts the in-flight upstream call instead of letting it run", async () => {
  let observed: AbortSignal | undefined;
  const meter = new GrokBrokerTurnMeter({ maxRequests: 32, maxTokens: 1_000_000, timeoutMs: 60_000 });
  const proxy = await startGrokBrokerProxy({ accessToken: async () => "provider-token", markRejected: async () => undefined }, async (_request, signal) => {
    observed = signal;
    await new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    throw new Error("unreachable");
  }, undefined, 0);
  try {
    const token = proxy.capabilities.issue("agent", "turn");
    proxy.registerIsolationGuard("turn", async () => undefined);
    proxy.registerTurn("turn", { policy: { model: "grok-4.6", reasoningEffort: "low" }, meter });
    const pending = post(proxy.port, token);
    while (observed === undefined) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(observed.aborted, false);
    // Mutation guard: a trip that leaves the upstream signal alone hangs this request.
    meter.trip("timeout");
    assert.equal(observed.aborted, true);
    assert.equal((await pending).status, 503);
    assert.deepEqual(meter.admit(), { refused: "timeout" });
  } finally { await proxy.close(); }
});

test("an implausible per-request usage block is never added, and missing usage still trips the token ceiling", async () => {
  // Mutation guard: without the plausibility bound this adds 400 billion tokens to the total.
  assert.equal(parseGrokUpstreamUsage(sse({ prompt_tokens: 400_000_000_000, completion_tokens: 1 }), "text/event-stream"), undefined);
  assert.equal(parseGrokUpstreamUsage(sse({ prompt_tokens: 499_990, completion_tokens: 11 }), "text/event-stream"), undefined);
  assert.equal(parseGrokUpstreamUsage(sse({ prompt_tokens: 499_990, completion_tokens: 10 }), "text/event-stream")?.total, 500_000);
  const huge = new GrokBrokerTurnMeter({ maxRequests: 32, maxTokens: 1_000_000, timeoutMs: 60_000 });
  await withProxy({ prompt_tokens: 400_000_000_000, completion_tokens: 1 }, huge, async (send) => { assert.equal((await send()).status, 200); });
  assert.deepEqual([huge.snapshot().tokens, huge.snapshot().estimatedRequests], [4_297, 1]);

  // Mutation guard: settling a usage-less response as zero lets this turn run to maxRequests.
  const blind = new GrokBrokerTurnMeter({ maxRequests: 32, maxTokens: 10_000, timeoutMs: 60_000 });
  await withProxy(undefined, blind, async (send, calls) => {
    const statuses = [];
    for (let index = 0; index < 5; index++) statuses.push((await send()).status);
    assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
    assert.equal(calls(), 3);
  });
  assert.deepEqual([blind.snapshot().limitReason, blind.snapshot().tokens, blind.snapshot().estimatedRequests], ["tokens", 12_891, 3]);
});

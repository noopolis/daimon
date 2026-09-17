import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test from "node:test";

import { startGrokBrokerProxy, type GrokBrokerCredentialAuthority, type GrokBrokerUpstream } from "./grokBrokerProxy.js";
import { GROK_SESSION_TITLE_SINK_KEY } from "./grokBrokerWorkerConfig.js";
import { GrokBrokerTurnMeter } from "./grokBrokerTurnMeter.js";
import { GrokInferenceGrants } from "./grokInferenceGrants.js";
import { GROK_INFERENCE_AUTH_STALE_BODY } from "./grokInferenceProxy.js";
import type { InferenceUsageEntry } from "./inferenceUsageLedger.js";

// The judge main request Grok 1.0.34 sends (live capture, `--json-schema` variant).
const judgeBody = (overrides: Record<string, unknown> = {}): string => JSON.stringify({
  messages: [{ role: "system", content: "You are a strict judge." }, { role: "user", content: "<user_info>...</user_info>" }, { role: "user", content: "Rate the answer." }],
  model: "grok-4.6", reasoning_effort: "low",
  response_format: { type: "json_schema", json_schema: { name: "structured_output", schema: { type: "object", properties: { score: { type: "number" } }, required: ["score"], additionalProperties: false }, strict: true } },
  stream: true, stream_options: { include_usage: true }, ...overrides
});
// The per-call session_title request the same CLI sends first (live capture).
const titleBody = JSON.stringify({ model: "grok-4.6", reasoning_effort: "low", temperature: 1, max_tokens: 100, messages: [{ role: "system", content: "title" }, { role: "user", content: "Rate the answer." }], tools: [{ type: "function", function: { name: "session_title", description: "", parameters: {} } }], tool_choice: { type: "function", function: { name: "session_title" } }, stream: true, stream_options: { include_usage: true } });
const usageStream = (total: number) => Buffer.from(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "{\"score\":1}" } }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: total - 5, completion_tokens: 5, total_tokens: total } })}\n\ndata: [DONE]\n\n`);

type Harness = Readonly<{ port: number; grants: GrokInferenceGrants; rows: InferenceUsageEntry[]; bodies: Record<string, unknown>[]; proxy: Awaited<ReturnType<typeof startGrokBrokerProxy>> }>;
async function withProxy(run: (harness: Harness) => Promise<void>, options: Readonly<{ authority?: GrokBrokerCredentialAuthority; upstream?: GrokBrokerUpstream }> = {}): Promise<void> {
  const rows: InferenceUsageEntry[] = [], bodies: Record<string, unknown>[] = [];
  const grants = new GrokInferenceGrants({ onSettled: (row) => rows.push(row) });
  const upstream: GrokBrokerUpstream = options.upstream ?? (async (request) => { bodies.push(JSON.parse(Buffer.from(request.body).toString("utf8")) as Record<string, unknown>); return { status: 200, headers: { "content-type": "text/event-stream" }, body: usageStream(105) }; });
  const proxy = await startGrokBrokerProxy(options.authority ?? { accessToken: async () => "provider-token", markRejected: async () => undefined }, upstream, undefined, 0, grants);
  try { await run({ port: proxy.port, grants, rows, bodies, proxy }); } finally { grants.close(); await proxy.close(); }
}

function post(port: number, bearer: string, body: string, version = "1.0.34"): Promise<Readonly<{ status: number; text: string }>> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: "/v1/chat/completions", method: "POST", agent: false, headers: { authorization: `Bearer ${bearer}`, "x-grok-client-version": version, "content-type": "application/json" } }, (response) => {
      const chunks: Buffer[] = []; response.on("data", (chunk: Buffer) => chunks.push(chunk)); response.on("end", () => resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject); req.end(body);
  });
}

test("a grant forwards the captured judge request re-serialized under the declared model and meters it into the inference rows only", async () => {
  await withProxy(async ({ port, grants, rows, bodies }) => {
    const issued = grants.issue({ model: "grok-4.6", reasoningEffort: "low", purpose: "judge" });
    const result = await post(port, issued.token, judgeBody().replace('"model":', '"model":"grok-4.5","model":'));
    assert.equal(result.status, 200); assert.match(result.text, /score/u);
    assert.equal(bodies.length, 1); assert.equal(bodies[0]!.model, "grok-4.6");
    assert.deepEqual(rows.map((row) => [row.grant, row.request, row.usage.total, row.usageSource, row.purpose]), [[issued.grantId, 0, 105, "upstream", "judge"]]);
    assert.equal((await post(port, issued.token, judgeBody({ response_format: undefined }))).status, 200);
    assert.equal(rows.length, 2);
  });
});

test("a grant refuses any tools member, the session_title request, and undeclared model or effort, before any upstream call or row", async () => {
  await withProxy(async ({ port, grants, rows, bodies }) => {
    const { token } = grants.issue({ model: "grok-4.6", reasoningEffort: "low", purpose: "judge" });
    const refused = [
      judgeBody({ tools: [] }), judgeBody({ tools: [{ type: "function", function: { name: "read_file" } }] }), judgeBody({ tool_choice: "none" }), titleBody,
      judgeBody({ model: "grok-4.5" }), judgeBody({ reasoning_effort: "high" }), judgeBody({ reasoning_effort: undefined }),
      judgeBody({ stream: false }), judgeBody({ stream_options: undefined }), judgeBody({ temperature: 1 }),
      judgeBody({ messages: [{ role: "tool", content: "x" }] }), judgeBody({ messages: [{ role: "assistant", content: null, tool_calls: [] }] }),
      judgeBody({ response_format: { type: "json_object" } })
    ];
    for (const body of refused) assert.equal((await post(port, token, body)).status, 503, body.slice(0, 120));
    assert.equal((await post(port, token, judgeBody(), "1.0.30")).status, 503);
    assert.equal((await post(port, GROK_SESSION_TITLE_SINK_KEY, titleBody)).status, 503);
    assert.equal(bodies.length, 0); assert.equal(rows.length, 0);
  });
});

test("an expired, released or unknown grant is refused", async () => {
  await withProxy(async ({ port, grants, bodies }) => {
    const released = grants.issue({ model: "grok-4.6", reasoningEffort: "low", purpose: "judge" }); grants.release(released.grantId);
    assert.equal((await post(port, released.token, judgeBody())).status, 503);
    assert.equal((await post(port, `inference_${"A".repeat(43)}`, judgeBody())).status, 503);
    assert.equal(bodies.length, 0);
  });
  let now = 5_000;
  const grants = new GrokInferenceGrants({ now: () => now });
  const proxy = await startGrokBrokerProxy({ accessToken: async () => "provider-token", markRejected: async () => undefined }, async () => ({ status: 200, headers: { "content-type": "text/event-stream" }, body: usageStream(10) }), undefined, 0, grants);
  try {
    const { token } = grants.issue({ model: "grok-4.6", reasoningEffort: "low", purpose: "judge" });
    assert.equal((await post(proxy.port, token, judgeBody())).status, 200);
    now += 600_000;
    assert.equal((await post(proxy.port, token, judgeBody())).status, 503);
  } finally { grants.close(); await proxy.close(); }
});

test("a grant token never authorizes a subject turn and a turn capability never authorizes a grant request", async () => {
  await withProxy(async ({ port, grants, proxy, bodies }) => {
    const { token: grantToken } = grants.issue({ model: "grok-4.6", reasoningEffort: "low", purpose: "judge" });
    const turnToken = proxy.capabilities.issue("agent-a", "turn-a");
    proxy.registerIsolationGuard("turn-a", async () => undefined);
    proxy.registerTurn("turn-a", { policy: { model: "grok-4.6", reasoningEffort: "low" }, meter: new GrokBrokerTurnMeter({ maxRequests: 4, maxTokens: 10_000, timeoutMs: 60_000 }) });
    const lean = ["run_terminal_command", "read_file", "list_dir", "grep", "search_tool", "use_tool"].map((name) => ({ type: "function", function: { name } }));
    const leanBody = JSON.stringify({ model: "grok-4.6", reasoning_effort: "low", stream: true, messages: [], tools: lean });
    assert.equal((await post(port, grantToken, leanBody)).status, 503);
    assert.equal((await post(port, turnToken, judgeBody())).status, 503);
    assert.equal(bodies.length, 0);
    assert.equal((await post(port, turnToken, leanBody)).status, 200);
    assert.equal((await post(port, grantToken, judgeBody())).status, 200);
  });
});

test("a stale realm answers a grant request with the distinct auth_stale failure, and a rejected refresh too", async () => {
  let stale = true;
  await withProxy(async ({ port, grants, bodies }) => {
    const { token } = grants.issue({ model: "grok-4.6", reasoningEffort: "low", purpose: "judge" });
    const result = await post(port, token, judgeBody());
    assert.equal(result.status, 401); assert.equal(result.text, GROK_INFERENCE_AUTH_STALE_BODY); assert.equal(bodies.length, 0);
  }, { authority: { accessToken: async () => { if (stale) throw new Error("stale"); return "t"; }, markRejected: async () => undefined, isStale: () => stale } });
  stale = false; let rejected = 0;
  await withProxy(async ({ port, grants, rows }) => {
    const { token } = grants.issue({ model: "grok-4.6", reasoningEffort: "low", purpose: "optimizer" });
    const result = await post(port, token, judgeBody());
    assert.equal(result.status, 401); assert.equal(result.text, GROK_INFERENCE_AUTH_STALE_BODY); assert.equal(rejected, 1);
    assert.deepEqual(rows.map((row) => row.usageSource), ["estimated"]);
  }, { authority: { accessToken: async (force) => force ? "second" : "first", markRejected: async () => { rejected++; stale = true; throw new Error("stale"); }, isStale: () => stale }, upstream: async () => ({ status: 401, headers: { "content-type": "application/json" }, body: new Uint8Array() }) });
});

test("a grant's request ceiling and one-in-flight rule hold on the wire", async () => {
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  await withProxy(async ({ port, grants, rows }) => {
    const { token } = grants.issue({ model: "grok-4.6", reasoningEffort: "low", purpose: "judge" });
    const first = post(port, token, judgeBody());
    while (calls === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    const busy = await post(port, token, judgeBody()); assert.equal(busy.status, 429); assert.match(busy.text, /in flight/u);
    release(); assert.equal((await first).status, 200);
    const grant = grants.authorize(token)!;
    for (let index = 1; index < 64; index++) { const admission = grant.meter.admit(); assert.ok("index" in admission); grants.settle(grant, admission.index, { input: 1, cacheRead: 0, cacheWrite: 0, output: 1, total: 2 }, 10); }
    const over = await post(port, token, judgeBody()); assert.equal(over.status, 429); assert.match(over.text, /requests/u);
    assert.equal(calls, 1); assert.equal(rows.length, 64);
  }, { upstream: async () => { calls++; await gate; return { status: 200, headers: { "content-type": "text/event-stream" }, body: usageStream(50) }; } });
});

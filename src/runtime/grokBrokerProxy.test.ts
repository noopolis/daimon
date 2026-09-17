import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test from "node:test";
import { startGrokBrokerProxy } from "./grokBrokerProxy.js";
import { GROK_SESSION_TITLE_SINK_KEY } from "./grokBrokerWorkerConfig.js";
import { GrokBrokerTurnMeter } from "./grokBrokerTurnMeter.js";
import { ENGINE_BROKER_AUTH_STALE } from "./engineBrokerProtocol.js";
import { GROK_INFERENCE_AUTH_STALE_BODY } from "./grokInferenceProxy.js";

type Proxy = Awaited<ReturnType<typeof startGrokBrokerProxy>>;
const arm = (proxy: Proxy, guard: () => Promise<void>, meter = new GrokBrokerTurnMeter({ maxRequests: 32, maxTokens: 300_000, timeoutMs: 240_000 })): GrokBrokerTurnMeter => {
  proxy.registerIsolationGuard("turn", guard);
  proxy.registerTurn("turn", { policy: { model: "grok-4.6", reasoningEffort: "low" }, meter });
  return meter;
};

const lean = ["run_terminal_command", "read_file", "list_dir", "grep", "search_tool", "use_tool"].map((name) => ({ type: "function", function: { name } }));
const leanBody = (overrides: Record<string, unknown> = {}): string => JSON.stringify({ model: "grok-4.6", reasoning_effort: "low", stream: true, messages: [], tools: lean, ...overrides });

test("proxy retries one 401 with refreshed broker bearer and shuts down", async () => {
  const calls: string[] = []; let refreshes = 0;
  const proxy = await startGrokBrokerProxy({ accessToken: async (force) => force ? "second" : "first", markRejected: async () => { refreshes += 1; } }, async (request) => {
    calls.push(request.headers.authorization); return calls.length === 1 ? { status: 401, headers: { "content-type": "application/json" }, body: new Uint8Array() } : { status: 200, headers: { "content-type": "text/event-stream" }, body: Buffer.from("data: done\n\n") };
  });
  const token = proxy.capabilities.issue("agent", "turn");
  arm(proxy, async () => undefined);
  const result = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-grok-client-version": "1.0.34" }, body: leanBody() });
  assert.equal(result.status, 200); assert.equal(await result.text(), "data: done\n\n"); assert.deepEqual(calls, ["Bearer first", "Bearer second"]); assert.equal(refreshes, 0);
  await proxy.close(); await assert.rejects(fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`));
});

test("proxy stale-fences a refreshed credential rejected by upstream",async()=>{let rejected=0;const proxy=await startGrokBrokerProxy({accessToken:async(force)=>force?"second":"first",markRejected:async()=>{rejected++;throw new Error("stale");}},async()=>({status:401,headers:{"content-type":"application/json"},body:new Uint8Array()}));const token=proxy.capabilities.issue("agent","turn");arm(proxy, async()=>undefined);const response=await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`,{method:"POST",headers:{authorization:`Bearer ${token}`,"x-grok-client-version":"1.0.34"},body:leanBody()});assert.equal(response.status,503);assert.equal(rejected,1);await proxy.close();});

test("proxy failures expose only a fixed diagnostic", async () => {
  const proxy = await startGrokBrokerProxy({ accessToken: async () => { throw new Error("secret-token"); }, markRejected: async () => undefined }, async () => { throw new Error("unreachable"); });
  const token = proxy.capabilities.issue("agent", "turn");
  arm(proxy, async () => undefined);
  const result = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${token}`, "x-grok-client-version": "1.0.34" }, body: leanBody() });
  assert.equal(result.status, 503); const body = await result.text(); assert.equal(body, '{"error":"broker unavailable"}'); assert.doesNotMatch(body, /secret/u); await proxy.close();
});

test("one turn capability supports multiple guarded cognition requests",async()=>{let guarded=0,calls=0;const proxy=await startGrokBrokerProxy({accessToken:async()=>"provider-token",markRejected:async()=>undefined},async()=>{calls++;return{status:200,headers:{"content-type":"application/json"},body:Buffer.from("{}")};});try{const token=proxy.capabilities.issue("agent","turn");arm(proxy, async()=>{guarded++;});for(let index=0;index<2;index++){const response=await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`,{method:"POST",headers:{authorization:`Bearer ${token}`,"x-grok-client-version":"1.0.34"},body:leanBody()});assert.equal(response.status,200);}assert.equal(calls,2);assert.equal(guarded,2);}finally{await proxy.close();}});

test("proxy refuses a fail-open tool set or an undeclared effort without calling upstream", async () => {
  let calls = 0; let accessed = 0;
  const proxy = await startGrokBrokerProxy({ accessToken: async () => { accessed++; return "provider-token"; }, markRejected: async () => undefined }, async () => { calls++; return { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from("{}") }; }, { model: "grok-4.6", reasoningEffort: "low" });
  try {
    const token = proxy.capabilities.issue("agent", "turn"); arm(proxy, async () => undefined);
    const full = [...lean, ...["search_replace", "todo_write", "write", "monitor"].map((name) => ({ type: "function", function: { name } }))];
    for (const payload of [leanBody({ tools: full }), leanBody({ tools: [{ type: "function", function: { name: "session_title" } }] }), leanBody({ reasoning_effort: "high" }), leanBody({ reasoning_effort: undefined })]) {
      // A policy miss is non-retryable: 400, so Grok fails fast instead of retrying a 503.
      assert.equal(await post(proxy.port, token, payload), 400);
    }
    assert.equal(calls, 0);
    assert.equal(await post(proxy.port, token, leanBody()), 200); assert.equal(calls, 1); assert.ok(accessed >= 1);
  } finally { await proxy.close(); }
});

// One unpooled connection per request: the proxy listens on a fixed port that the
// previous test just closed, and a pooled keep-alive socket to it would be stale.
function post(port: number, token: string, body: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: "/v1/chat/completions", method: "POST", agent: false, headers: { authorization: `Bearer ${token}`, "x-grok-client-version": "1.0.34", "content-type": "application/json" } }, (response) => { response.resume(); response.on("end", () => resolve(response.statusCode ?? 0)); });
    req.on("error", reject); req.end(body);
  });
}

test("the session-title sink is refused before capability, guard, credential, or upstream use", async () => {
  let calls = 0, accessed = 0, guarded = 0;
  const proxy = await startGrokBrokerProxy({ accessToken: async () => { accessed++; return "provider-token"; }, markRejected: async () => undefined }, async () => { calls++; return { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from("{}") }; });
  try {
    const token = proxy.capabilities.issue("agent", "turn", 60_000, 1); arm(proxy, async () => { guarded++; });
    const title = JSON.stringify({ model: "disabled", max_tokens: 100, temperature: 0, stream: true, messages: [{ role: "user", content: "prompt-derived" }], tool_choice: { type: "function", function: { name: "session_title" } }, tools: [{ type: "function", function: { name: "session_title" } }] });
    // The title sink keeps its transient 503 shape: a 4xx there ends Grok's session.
    assert.equal(await post(proxy.port, GROK_SESSION_TITLE_SINK_KEY, title), 503);
    assert.deepEqual({ calls, accessed, guarded }, { calls: 0, accessed: 0, guarded: 0 });
    // The turn capability (budget 1 request) is untouched and still serves the real request.
    assert.equal(await post(proxy.port, token, leanBody()), 200);
    assert.equal(calls, 1);
  } finally { await proxy.close(); }
});

test("the isolation guard is awaited before the first upstream call, and a failing guard makes no upstream call", async () => {
  const order: string[] = []; let upstreamCalls = 0; let fail = true;
  const proxy = await startGrokBrokerProxy({ accessToken: async () => { order.push("credential"); return "provider-token"; }, markRejected: async () => undefined }, async () => { upstreamCalls++; order.push("upstream"); return { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from("{}") }; });
  try {
    const token = proxy.capabilities.issue("agent", "turn");
    arm(proxy, async () => {
      order.push("guard-start"); await new Promise((resolve) => setTimeout(resolve, 30)); order.push("guard-end");
      if (fail) throw new Error("no enforcement evidence");
    });
    assert.equal(await post(proxy.port, token, leanBody()), 400);
    assert.equal(upstreamCalls, 0);
    assert.deepEqual(order, ["guard-start", "guard-end"]);
    fail = false; order.length = 0;
    assert.equal(await post(proxy.port, token, leanBody()), 200);
    assert.deepEqual(order, ["guard-start", "guard-end", "credential", "upstream"]);
  } finally { await proxy.close(); }
});

test("the two requests every healthy turn makes are not named as refusals", async () => {
  const lines: string[] = []; const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => { lines.push(String(chunk)); return original(chunk as string, ...rest as []); }) as typeof process.stderr.write;
  const proxy = await startGrokBrokerProxy({ accessToken: async () => "provider-token", markRejected: async () => undefined }, async () => ({ status: 200, headers: { "content-type": "application/json" }, body: Buffer.from("{}") }));
  try {
    arm(proxy, async () => undefined);
    const title = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${GROK_SESSION_TITLE_SINK_KEY}`, "content-type": "application/json" }, body: leanBody() });
    assert.equal(title.status, 503, "the title sink keeps its transient shape");
    const probe = await fetch(`http://127.0.0.1:${proxy.port}/`);
    assert.equal(probe.status, 400, "the unauthenticated probe keeps its non-retryable shape");
    assert.deepEqual(lines, [], "expected per-turn traffic must not read as a refusal on the broker's stderr");
    const miss = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${"z".repeat(48)}`, "content-type": "application/json" }, body: leanBody() });
    assert.equal(miss.status, 400);
    assert.deepEqual(lines, ["[grok-proxy] refused: unknown_capability\n"], "a genuine policy miss is still named with its reason code");
  } finally { process.stderr.write = original; await proxy.close(); }
});

test("a non-refusal fault names its own class and message on one bounded line, credentials withheld", async () => {
  const lines: string[] = []; const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
  const provider = "provider-vqmxdfhlzptgnbwc"; let capability = "";
  // The fault's own words carry both credentials verbatim — the worker's turn
  // capability and the broker's provider bearer, neither in a shape any generic
  // pattern recognises — plus a newline, a control character, and far more text
  // than the bound admits.
  const proxy = await startGrokBrokerProxy(
    { accessToken: async () => provider, markRejected: async () => undefined },
    async () => { throw new RangeError(`socket hang up forwarding ${capability}\nwith ${provider}\u0007 ${"pad ".repeat(400)}`); });
  try {
    capability = proxy.capabilities.issue("agent", "turn"); arm(proxy, async () => undefined);
    assert.equal(await post(proxy.port, capability, leanBody()), 503, "a genuine transient fault keeps its 503");
    assert.equal(lines.length, 1, "one line per fault");
    const line = lines[0]!;
    assert.match(line, /^\[grok-proxy\] refused: broker_unavailable \(RangeError: socket hang up forwarding /u, "the fault names its own class and message");
    assert.ok(!line.includes(capability), `the worker's own capability is withheld: ${line}`);
    assert.ok(!line.includes(provider), `the broker's provider bearer is withheld: ${line}`);
    assert.match(line, /\[REDACTED\]/u, "the withheld values are marked, not silently dropped");
    assert.match(line, /^[^\n]+\n$/u, "one line: newlines and control characters are flattened");
    assert.ok(Buffer.byteLength(line, "utf8") <= 900, `the line stays bounded: ${Buffer.byteLength(line, "utf8")} bytes`);
  } finally { process.stderr.write = original; await proxy.close(); }
});

test("a fault's own cause is named too, because `fetch failed` on its own names nothing", async () => {
  const lines: string[] = []; const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
  // Exactly the shape undici throws when the provider is unreachable.
  const fault = new TypeError("fetch failed"); (fault as { cause?: unknown }).cause = Object.assign(new Error(""), { code: "ENOTFOUND" });
  const proxy = await startGrokBrokerProxy({ accessToken: async () => "provider-token", markRejected: async () => undefined }, async () => { throw fault; });
  try {
    const token = proxy.capabilities.issue("agent", "turn"); arm(proxy, async () => undefined);
    assert.equal(await post(proxy.port, token, leanBody()), 503);
    assert.deepEqual(lines, ["[grok-proxy] refused: broker_unavailable (TypeError: fetch failed <- Error: ENOTFOUND)\n"]);
  } finally { process.stderr.write = original; await proxy.close(); }
});

/**
 * A fenced realm is the one fault this proxy answered worst: the credential is
 * gone until an operator logs in again, and 503 made Grok retry it fifteen
 * times over five minutes for nothing. It is a named, non-retryable refusal
 * now — and it wears the same name as the turn failure code and the grant
 * path's 401 body, so one word finds it on every surface.
 */
test("a fenced credential realm is a named 400 auth_stale, before any credential read or upstream call", async () => {
  const lines: string[] = []; const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
  let reads = 0, calls = 0, stale = true;
  const proxy = await startGrokBrokerProxy(
    { accessToken: async () => { reads += 1; return "provider-token"; }, markRejected: async () => undefined, isStale: () => stale },
    async () => { calls += 1; return { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from("{}") }; });
  try {
    const token = proxy.capabilities.issue("agent", "turn"); arm(proxy, async () => undefined);
    assert.equal(await post(proxy.port, token, leanBody()), 400, "a stale realm is not transient, so it must not be retryable");
    assert.deepEqual({ reads, calls }, { reads: 0, calls: 0 }, "no credential is read and nothing is forwarded for a fenced realm");
    assert.deepEqual(lines, [`[grok-proxy] refused: ${ENGINE_BROKER_AUTH_STALE}\n`]);
    // The title sink keeps the 503 it has always had, fenced realm or not.
    assert.equal(await post(proxy.port, GROK_SESSION_TITLE_SINK_KEY, leanBody()), 503);
    // And the same capability serves the real request once the realm is healthy.
    stale = false; lines.length = 0;
    assert.equal(await post(proxy.port, token, leanBody()), 200);
    assert.deepEqual({ reads, calls, lines }, { reads: 1, calls: 1, lines: [] });
  } finally { process.stderr.write = original; await proxy.close(); }
});

test("the request that discovers the fence is named auth_stale too, not one transient fault", async () => {
  const lines: string[] = []; const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
  // The live shape: `accessToken` fences the realm and throws the authority's
  // own generic error, which on its own reads as a transient fault.
  let stale = false;
  const proxy = await startGrokBrokerProxy(
    { accessToken: async () => { stale = true; throw new Error("Grok broker credential authority unavailable"); }, markRejected: async () => undefined, isStale: () => stale },
    async () => ({ status: 200, headers: { "content-type": "application/json" }, body: Buffer.from("{}") }));
  try {
    const token = proxy.capabilities.issue("agent", "turn"); arm(proxy, async () => undefined);
    assert.equal(await post(proxy.port, token, leanBody()), 400);
    assert.deepEqual(lines, [`[grok-proxy] refused: ${ENGINE_BROKER_AUTH_STALE}\n`]);
  } finally { process.stderr.write = original; await proxy.close(); }
});

test("the turn path and the grant path name a fenced realm the same way", () => {
  assert.ok(GROK_INFERENCE_AUTH_STALE_BODY.includes(ENGINE_BROKER_AUTH_STALE), "one name, not three spellings");
});

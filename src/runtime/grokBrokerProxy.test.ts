import assert from "node:assert/strict";
import test from "node:test";
import { startGrokBrokerProxy } from "./grokBrokerProxy.js";

const lean = ["run_terminal_command", "read_file", "list_dir", "grep", "search_tool", "use_tool"].map((name) => ({ type: "function", function: { name } }));
const leanBody = (overrides: Record<string, unknown> = {}): string => JSON.stringify({ model: "grok-4.6", reasoning_effort: "low", stream: true, messages: [], tools: lean, ...overrides });

test("proxy retries one 401 with refreshed broker bearer and shuts down", async () => {
  const calls: string[] = []; let refreshes = 0;
  const proxy = await startGrokBrokerProxy({ accessToken: async (force) => force ? "second" : "first", markRejected: async () => { refreshes += 1; } }, async (request) => {
    calls.push(request.headers.authorization); return calls.length === 1 ? { status: 401, headers: { "content-type": "application/json" }, body: new Uint8Array() } : { status: 200, headers: { "content-type": "text/event-stream" }, body: Buffer.from("data: done\n\n") };
  });
  const token = proxy.capabilities.issue("agent", "turn");
  proxy.registerIsolationGuard("turn", async () => undefined);
  const result = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-grok-client-version": "1.0.34" }, body: leanBody() });
  assert.equal(result.status, 200); assert.equal(await result.text(), "data: done\n\n"); assert.deepEqual(calls, ["Bearer first", "Bearer second"]); assert.equal(refreshes, 0);
  await proxy.close(); await assert.rejects(fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`));
});

test("proxy stale-fences a refreshed credential rejected by upstream",async()=>{let rejected=0;const proxy=await startGrokBrokerProxy({accessToken:async(force)=>force?"second":"first",markRejected:async()=>{rejected++;throw new Error("stale");}},async()=>({status:401,headers:{"content-type":"application/json"},body:new Uint8Array()}));const token=proxy.capabilities.issue("agent","turn");proxy.registerIsolationGuard("turn",async()=>undefined);const response=await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`,{method:"POST",headers:{authorization:`Bearer ${token}`,"x-grok-client-version":"1.0.34"},body:leanBody()});assert.equal(response.status,503);assert.equal(rejected,1);await proxy.close();});

test("proxy failures expose only a fixed diagnostic", async () => {
  const proxy = await startGrokBrokerProxy({ accessToken: async () => { throw new Error("secret-token"); }, markRejected: async () => undefined }, async () => { throw new Error("unreachable"); });
  const token = proxy.capabilities.issue("agent", "turn");
  proxy.registerIsolationGuard("turn", async () => undefined);
  const result = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${token}`, "x-grok-client-version": "1.0.34" }, body: leanBody() });
  assert.equal(result.status, 503); const body = await result.text(); assert.equal(body, '{"error":"broker unavailable"}'); assert.doesNotMatch(body, /secret/u); await proxy.close();
});

test("one turn capability supports multiple guarded cognition requests",async()=>{let guarded=0,calls=0;const proxy=await startGrokBrokerProxy({accessToken:async()=>"provider-token",markRejected:async()=>undefined},async()=>{calls++;return{status:200,headers:{"content-type":"application/json"},body:Buffer.from("{}")};});try{const token=proxy.capabilities.issue("agent","turn");proxy.registerIsolationGuard("turn",async()=>{guarded++;});for(let index=0;index<2;index++){const response=await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`,{method:"POST",headers:{authorization:`Bearer ${token}`,"x-grok-client-version":"1.0.34"},body:leanBody()});assert.equal(response.status,200);}assert.equal(calls,2);assert.equal(guarded,2);}finally{await proxy.close();}});

test("proxy refuses a fail-open tool set or an undeclared effort without calling upstream", async () => {
  let calls = 0; let accessed = 0;
  const proxy = await startGrokBrokerProxy({ accessToken: async () => { accessed++; return "provider-token"; }, markRejected: async () => undefined }, async () => { calls++; return { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from("{}") }; }, { model: "grok-4.6", reasoningEffort: "low" });
  try {
    const token = proxy.capabilities.issue("agent", "turn"); proxy.registerIsolationGuard("turn", async () => undefined);
    const full = [...lean, ...["search_replace", "todo_write", "write", "monitor"].map((name) => ({ type: "function", function: { name } }))];
    for (const payload of [leanBody({ tools: full }), leanBody({ tools: [{ type: "function", function: { name: "session_title" } }] }), leanBody({ reasoning_effort: "high" }), leanBody({ reasoning_effort: undefined })]) {
      const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${token}`, "x-grok-client-version": "1.0.34" }, body: payload });
      assert.equal(response.status, 503); await response.text();
    }
    assert.equal(calls, 0);
    const accepted = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${token}`, "x-grok-client-version": "1.0.34" }, body: leanBody() });
    assert.equal(accepted.status, 200); await accepted.text(); assert.equal(calls, 1); assert.ok(accessed >= 1);
  } finally { await proxy.close(); }
});

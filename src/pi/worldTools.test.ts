import assert from "node:assert/strict";
import test from "node:test";

import {
  createPiWorldTools,
  PI_WORLD_TOOL_NAMES,
  PiWorldToolError,
  type PiWorldFetch,
  WORLD_ACTION_RESULT_PAGE_REQUEST_VERSION
} from "./worldTools.js";
import type { PiWorldToolContextRef } from "./worldNudge.js";

type WorldTool = ReturnType<typeof createPiWorldTools>[number];
type ToolResult = { content: Array<{ text: string; type: string }>; details: unknown };
const execute = async (tool: WorldTool, params: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> =>
  tool.execute("tool-call", params as never, signal, undefined, {} as never) as Promise<ToolResult>;
const tool = (tools: WorldTool[], name: string): WorldTool => {
  const selected = tools.find((candidate) => candidate.name === name);
  assert.ok(selected);
  return selected;
};
const response = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), {
  status,
  headers: { "content-type": "application/json" }
});
const rejectedCode = (code: PiWorldToolError["code"], canaries: string[] = []) => (error: unknown): boolean =>
  error instanceof PiWorldToolError && error.code === code
    && canaries.every((canary) => !String(error).includes(canary));
const promptly = <T>(promise: Promise<T>, maximumMs = 250): Promise<T> => new Promise<T>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("world tool did not settle promptly")), maximumMs);
  promise.then(
    (value) => { clearTimeout(timer); resolve(value); },
    (error: unknown) => { clearTimeout(timer); reject(error); }
  );
});

test("preserves the exact six unbound tools and projects each call onto the base JSON contract", async () => {
  const calls: Array<{ url: string; authorization: string; body: unknown }> = [];
  let environmentReads = 0;
  const fetch: PiWorldFetch = async (url, init) => {
    const authorization = new Headers(init?.headers).get("authorization") ?? "";
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ url: String(url), authorization, body });
    return response({ operation: String(url).split("/").at(-1) });
  };
  const tools = createPiWorldTools({
    world: { url: "http://simfile-world:19972/v1/world", tokenEnv: "RED_WORLD_TOKEN" },
    readEnvironment: (name) => { environmentReads += 1; return name === "RED_WORLD_TOKEN" ? "red-bearer" : undefined; },
    fetch
  });
  assert.deepEqual(tools.map((candidate) => candidate.name),
    PI_WORLD_TOOL_NAMES.filter((name) => name !== "world_claim"));

  const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ["world_status", { decision_token: "decision-red" }, { decision_token: "decision-red" }],
    ["world_capabilities", { decision_token: "decision-red" }, { decision_token: "decision-red" }],
    ["world_observe", { decision_token: "decision-red", sense: "world://pitch/sense/vision" }, { decision_token: "decision-red", sense: "world://pitch/sense/vision" }],
    ["world_affordances", { decision_token: "decision-red" }, { decision_token: "decision-red" }],
    ["world_act", { decision_token: "decision-red", request_id: "request-1", affordance: "world://pitch/affordance/kick", target: "world://pitch/entity/ball", input: { force: 1 } },
      { decision_token: "decision-red", request_id: "request-1", affordance: "world://pitch/affordance/kick", target: "world://pitch/entity/ball", input: { force: 1 } }],
    ["world_ledger", { decision_token: "decision-red", limit: 10 }, { decision_token: "decision-red", version: WORLD_ACTION_RESULT_PAGE_REQUEST_VERSION, limit: 10 }]
  ];
  for (const [name, params] of cases) {
    const output = await execute(tool(tools, name), params);
    assert.equal(output.content[0]?.type, "text");
    assert.equal((output.details as { operation: string }).operation, name.slice("world_".length));
  }
  assert.equal(environmentReads, cases.length);
  assert.deepEqual(calls.map((call) => call.url), cases.map(([name]) => `http://simfile-world:19972/v1/world/${name.slice("world_".length)}`));
  assert.ok(calls.every((call) => call.authorization === "Bearer red-bearer"));
  assert.deepEqual(calls.map((call) => call.body), cases.map((entry) => entry[2]));
  for (const candidate of tools) {
    const properties = (candidate.parameters as unknown as { properties: Record<string, unknown> }).properties;
    for (const forbidden of ["principal", "actor", "url", "token", "tokenEnv", "authorization"]) {
      assert.equal(Object.hasOwn(properties, forbidden), false);
    }
  }
});

test("claims schedule-wake authority without exposing the returned token", async () => {
  const bodies: Array<{ url: string; body: Record<string, unknown> }> = [];
  const contextRef: PiWorldToolContextRef = {
    current: Object.freeze({ requestId: "request-schedule-1", wakeId: "schedule-red-1" }),
  };
  const tools = createPiWorldTools({
    world: { url: "http://world/v1/world", tokenEnv: "WORLD_TOKEN" },
    contextRef,
    readEnvironment: () => "principal-red-bearer",
    fetch: async (url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push({ url: String(url), body });
      return String(url).endsWith("/claim")
        ? response({ decision_id: "decision-1", decision_token: "opaque-decision-1",
          issued_at_tick: 8, valid_through_tick: 30_008 })
        : response({ ok: true });
    },
  });
  const claim = tool(tools, "world_claim");
  const status = tool(tools, "world_status");
  assert.deepEqual(Object.keys((claim.parameters as { properties: object }).properties), []);
  await assert.rejects(execute(status, {}), rejectedCode("world_request_invalid"));
  const output = await execute(claim, {});
  assert.deepEqual(output.details, { claimed: true, decision_id: "decision-1",
    issued_at_tick: 8, valid_through_tick: 30_008 });
  assert.equal(JSON.stringify(output).includes("opaque-decision-1"), false);
  assert.equal(contextRef.current?.decisionToken, "opaque-decision-1");
  assert.equal(contextRef.current?.requestId, "request-schedule-1");
  assert.equal(contextRef.current?.wakeId, "schedule-red-1");
  await execute(status, {});
  await assert.rejects(execute(claim, {}), rejectedCode("world_request_invalid"));
  assert.deepEqual(bodies, [
    { url: "http://world/v1/world/claim",
      body: { request_id: "request-schedule-1", wake_id: "schedule-red-1" } },
    { url: "http://world/v1/world/status",
      body: { decision_token: "opaque-decision-1" } },
  ]);
});

test("binds wake authority outside the model-visible schemas", async () => {
  const bodies: unknown[] = [];
  const contextRef: PiWorldToolContextRef = {
    current: {
      decisionToken: "decision-bound",
      requestId: "request-bound",
      runId: "run-bound",
      tick: 7,
      wakeId: "wake-bound"
    }
  };
  const tools = createPiWorldTools({
    world: { url: "http://world/v1/world", tokenEnv: "WORLD_TOKEN" },
    contextRef,
    readEnvironment: () => "bound-bearer",
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as unknown);
      return response({ ok: true });
    }
  });
  const observe = tool(tools, "world_observe");
  const act = tool(tools, "world_act");
  assert.deepEqual(Object.keys((observe.parameters as { properties: object }).properties), ["sense"]);
  assert.deepEqual(
    Object.keys((act.parameters as { properties: object }).properties),
    ["affordance", "target", "input"]
  );
  await execute(observe, { sense: "world://pitch/sense/vision" });
  await execute(act, {
    affordance: "world://pitch/affordance/kick",
    target: "world://pitch/entity/ball",
    input: { force: 1 }
  });
  assert.deepEqual(bodies, [
    { decision_token: "decision-bound", sense: "world://pitch/sense/vision" },
    {
      decision_token: "decision-bound",
      request_id: "request-bound",
      affordance: "world://pitch/affordance/kick",
      target: "world://pitch/entity/ball",
      input: { force: 1 }
    }
  ]);
  contextRef.current = undefined;
  await assert.rejects(
    execute(observe, { sense: "world://pitch/sense/vision" }),
    rejectedCode("world_request_invalid")
  );
});

test("accepts only an exact canonical world base and named environment binding", () => {
  const invalid = [
    { url: "http://world/v1/world/", tokenEnv: "WORLD_TOKEN" },
    { url: "http://world/v1/world?member=red", tokenEnv: "WORLD_TOKEN" },
    { url: "http://world/v1/world?", tokenEnv: "WORLD_TOKEN" },
    { url: "http://world/v1/world#", tokenEnv: "WORLD_TOKEN" },
    { url: "HTTP://world/v1/world", tokenEnv: "WORLD_TOKEN" },
    { url: "http://world:80/v1/world", tokenEnv: "WORLD_TOKEN" },
    { url: "http://world/segment/../v1/world", tokenEnv: "WORLD_TOKEN" },
    { url: "http://bearer@world/v1/world", tokenEnv: "WORLD_TOKEN" },
    { url: "http://world/v1/world", tokenEnv: "world_token" },
    { url: "http://world/v1/world", tokenEnv: "WORLD_TOKEN", authorization: "Bearer override" }
  ];
  for (const world of invalid) {
    assert.throws(
      () => createPiWorldTools({ world: world as never, fetch: async () => response({ ok: true }) }),
      { name: "TypeError", message: "invalid Pi world tool configuration" }
    );
  }
});

test("reads the named bearer at call time and isolates per-agent bindings", async () => {
  const environment: Record<string, string> = { RED_WORLD_TOKEN: "red-first", BLUE_WORLD_TOKEN: "blue-only" };
  const seen: string[] = [];
  const fetch: PiWorldFetch = async (_url, init) => {
    seen.push(new Headers(init?.headers).get("authorization") ?? "");
    return response({ ok: true });
  };
  const red = createPiWorldTools({ world: { url: "http://world/v1/world", tokenEnv: "RED_WORLD_TOKEN" }, fetch, readEnvironment: (name) => environment[name] });
  const blue = createPiWorldTools({ world: { url: "http://world/v1/world", tokenEnv: "BLUE_WORLD_TOKEN" }, fetch, readEnvironment: (name) => environment[name] });
  environment.RED_WORLD_TOKEN = "red-second";
  await execute(tool(red, "world_status"), { decision_token: "red-decision" });
  await execute(tool(blue, "world_status"), { decision_token: "blue-decision" });
  assert.deepEqual(seen, ["Bearer red-second", "Bearer blue-only"]);
});

test("retries one ambiguous transport failure with identical act bytes and no credential reread", async () => {
  const bodies: string[] = [];
  const headers: string[] = [];
  let attempts = 0, reads = 0;
  const tools = createPiWorldTools({
    world: { url: "http://world/v1/world", tokenEnv: "WORLD_TOKEN" },
    readEnvironment: () => { reads += 1; return "stable-bearer"; },
    fetch: async (_url, init) => {
      attempts += 1;
      bodies.push(String(init?.body));
      headers.push(new Headers(init?.headers).get("authorization") ?? "");
      if (attempts === 1) throw new TypeError("ambiguous socket close secret-canary");
      return response({ disposition: "queued", receipt_id: "world-act-1" });
    }
  });
  const output = await execute(tool(tools, "world_act"), {
    decision_token: "decision-red",
    request_id: "stable-request-1",
    affordance: "world://pitch/affordance/kick",
    target: "world://pitch/entity/ball",
    input: { force: 1 }
  });
  assert.equal((output.details as { disposition: string }).disposition, "queued");
  assert.equal(attempts, 2);
  assert.equal(reads, 1);
  assert.equal(bodies[0], bodies[1]);
  assert.deepEqual(headers, ["Bearer stable-bearer", "Bearer stable-bearer"]);
});

test("retries one HTTP 408 act response with the exact same serialized request", async () => {
  const bodies: string[] = [];
  let attempts = 0;
  const tools = createPiWorldTools({
    world: { url: "http://world/v1/world", tokenEnv: "WORLD_TOKEN" },
    readEnvironment: () => "stable-bearer",
    fetch: async (_url, init) => {
      attempts += 1;
      bodies.push(String(init?.body));
      return attempts === 1 ? new Response("secret-timeout-body", { status: 408 }) : response({ disposition: "queued" });
    }
  });
  const output = await execute(tool(tools, "world_act"), {
    decision_token: "decision-red",
    request_id: "stable-request-408",
    affordance: "world://pitch/affordance/kick",
    target: "world://pitch/entity/ball",
    input: { force: 1 }
  });
  assert.equal((output.details as { disposition: string }).disposition, "queued");
  assert.equal(attempts, 2);
  assert.equal(bodies[0], bodies[1]);
});

test("never retries HTTP rejection and never exposes bearer, response, or transport diagnostics", async () => {
  const bearer = "secret-bearer-canary";
  const responseCanary = "secret-response-canary";
  let calls = 0;
  const rejected = createPiWorldTools({
    world: { url: "http://world/v1/world", tokenEnv: "WORLD_TOKEN" },
    readEnvironment: () => bearer,
    fetch: async () => { calls += 1; return new Response(responseCanary, { status: 401 }); }
  });
  await assert.rejects(execute(tool(rejected, "world_status"), { decision_token: "decision-red" }),
    rejectedCode("world_request_denied", [bearer, responseCanary]));
  assert.equal(calls, 1);

  calls = 0;
  const unavailable = createPiWorldTools({
    world: { url: "http://world/v1/world", tokenEnv: "WORLD_TOKEN" },
    readEnvironment: () => bearer,
    fetch: async () => { calls += 1; throw new TypeError("secret-transport-canary"); }
  });
  await assert.rejects(execute(tool(unavailable, "world_status"), { decision_token: "decision-red" }),
    rejectedCode("world_transport_unavailable", [bearer, "secret-transport-canary"]));
  assert.equal(calls, 1);
});

test("honors caller cancellation and an overall timeout without retry", async () => {
  let calls = 0;
  const waitingFetch: PiWorldFetch = async () => {
    calls += 1;
    return new Promise<Response>(() => {});
  };
  const cancelledTools = createPiWorldTools({
    world: { url: "http://world/v1/world", tokenEnv: "WORLD_TOKEN" }, fetch: waitingFetch, readEnvironment: () => "bearer"
  });
  const caller = new AbortController();
  const cancelled = execute(tool(cancelledTools, "world_status"), { decision_token: "decision-red" }, caller.signal);
  caller.abort();
  await assert.rejects(cancelled, rejectedCode("world_request_cancelled", ["secret-canary"]));
  assert.equal(calls, 1);

  calls = 0;
  const timedTools = createPiWorldTools({
    world: { url: "http://world/v1/world", tokenEnv: "WORLD_TOKEN" }, fetch: waitingFetch,
    readEnvironment: () => "bearer", timeoutMs: 10
  });
  await assert.rejects(execute(tool(timedTools, "world_status"), { decision_token: "decision-red" }),
    rejectedCode("world_request_timeout", ["secret-canary"]));
  assert.equal(calls, 1);
});

test("fails closed for missing auth and oversized or malformed successful responses", async () => {
  let calls = 0;
  const missing = createPiWorldTools({
    world: { url: "http://world/v1/world", tokenEnv: "WORLD_TOKEN" }, readEnvironment: () => undefined,
    fetch: async () => { calls += 1; return response({ ok: true }); }
  });
  await assert.rejects(execute(tool(missing, "world_status"), { decision_token: "decision-red" }), rejectedCode("world_auth_unavailable"));
  assert.equal(calls, 0);

  for (const value of [
    new Response("x".repeat(129), { headers: { "content-type": "application/json" } }),
    new Response("secret-response-canary", { headers: { "content-type": "application/json" } }),
    new Response("{}", { headers: { "content-type": "application/jsonx" } })
  ]) {
    const tools = createPiWorldTools({
      world: { url: "http://world/v1/world", tokenEnv: "WORLD_TOKEN" }, readEnvironment: () => "bearer",
      maxResponseBytes: 128, fetch: async () => value
    });
    await assert.rejects(execute(tool(tools, "world_status"), { decision_token: "decision-red" }),
      rejectedCode("world_response_invalid", ["secret-response-canary"]));
  }
});

test("fails closed when a successful response echoes the call-time bearer", async () => {
  const bearer = "secret-bearer-canary";
  const tools = createPiWorldTools({
    world: { url: "http://world/v1/world", tokenEnv: "WORLD_TOKEN" },
    readEnvironment: () => bearer,
    fetch: async () => response({ result: { authorization: `Bearer ${bearer}` } })
  });
  await assert.rejects(execute(tool(tools, "world_status"), { decision_token: "decision-red" }),
    rejectedCode("world_response_invalid", [bearer, `Bearer ${bearer}`]));
});

test("turns hostile response inspection and a locked successful body into fixed diagnostics", async () => {
  const bearer = "secret-bearer-canary";
  const hostileCanary = "secret-hostile-response-canary";
  const hostile = new Proxy(response({ ok: true }), {
    get(target, property, receiver) {
      if (property === "ok") throw new Error(hostileCanary);
      return Reflect.get(target, property, receiver);
    }
  });
  const hostileTools = createPiWorldTools({
    world: { url: "http://world/v1/world", tokenEnv: "WORLD_TOKEN" },
    readEnvironment: () => bearer,
    fetch: async () => hostile
  });
  await assert.rejects(execute(tool(hostileTools, "world_status"), { decision_token: "decision-red" }),
    rejectedCode("world_response_invalid", [bearer, hostileCanary]));

  const locked = response({ ok: true });
  const reader = locked.body?.getReader();
  assert.ok(reader);
  const lockedTools = createPiWorldTools({
    world: { url: "http://world/v1/world", tokenEnv: "WORLD_TOKEN" },
    readEnvironment: () => bearer,
    fetch: async () => locked
  });
  await assert.rejects(execute(tool(lockedTools, "world_status"), { decision_token: "decision-red" }),
    rejectedCode("world_response_invalid", [bearer, "locked"]));
  reader.releaseLock();
});

test("caller abort and timeout settle while hostile response cancellation remains pending", async () => {
  let cancelCalls = 0;
  const hostileResponse = (): Response => new Response(new ReadableStream<Uint8Array>({
    pull: () => new Promise<void>(() => {}),
    cancel: () => { cancelCalls += 1; return new Promise<void>(() => {}); }
  }), { headers: { "content-type": "application/json" } });
  const cancelledTools = createPiWorldTools({
    world: { url: "http://world/v1/world", tokenEnv: "WORLD_TOKEN" },
    readEnvironment: () => "bearer",
    fetch: async () => hostileResponse()
  });
  const caller = new AbortController();
  const executing = execute(tool(cancelledTools, "world_status"), { decision_token: "decision-red" }, caller.signal);
  setImmediate(() => caller.abort());
  await assert.rejects(promptly(executing), rejectedCode("world_request_cancelled", ["locked", "release"]));

  const timedTools = createPiWorldTools({
    world: { url: "http://world/v1/world", tokenEnv: "WORLD_TOKEN" },
    readEnvironment: () => "bearer",
    fetch: async () => hostileResponse(),
    timeoutMs: 10
  });
  await assert.rejects(promptly(execute(tool(timedTools, "world_status"), { decision_token: "decision-red" })),
    rejectedCode("world_request_timeout", ["locked", "release"]));
  assert.equal(cancelCalls, 2);
});

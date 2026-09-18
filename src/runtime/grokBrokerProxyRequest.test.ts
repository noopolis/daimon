import assert from "node:assert/strict";
import test from "node:test";
import { EngineBrokerCapabilities } from "./engineBrokerCapabilities.js";
import { authorizeGrokBrokerProxyRequest } from "./grokBrokerProxyRequest.js";

const leanTools = ["run_terminal_command", "read_file", "list_dir", "grep", "search_tool", "use_tool"];
const tool = (name: string) => ({ type: "function", function: { name, parameters: { type: "object" } } });
const leanBody = (overrides: Record<string, unknown> = {}): Buffer => Buffer.from(JSON.stringify({ model: "grok-4.6", reasoning_effort: "low", stream: true, messages: [], tools: leanTools.map(tool), ...overrides }));
const request = (body: Uint8Array, headers: Record<string, string | undefined> = {}) => {
  const caps = new EngineBrokerCapabilities(); const opaque = caps.issue("a", "t");
  return { caps, input: { method: "POST", pathname: "/v1/chat/completions", headers: { authorization: `Bearer ${opaque}`, "x-grok-client-version": "1.0.34", ...headers }, body, agentId: "a", turnId: "t" } };
};

test("proxy substitutes broker bearer, forwards the pinned client version, and rejects arbitrary routes and headers", () => {
  const { caps, input } = request(leanBody(), { cookie: "forbidden", "x-grok-client-identifier": "attacker", "x-grok-model-override": "grok-build" });
  const upstream = authorizeGrokBrokerProxyRequest(input, caps, "real-bearer");
  assert.equal(upstream.url, "https://cli-chat-proxy.grok.com/v1/chat/completions");
  assert.equal(upstream.headers.authorization, "Bearer real-bearer");
  assert.equal(upstream.headers["x-grok-client-version"], "1.0.34");
  assert.equal(upstream.headers["x-grok-client-identifier"], "grok-shell");
  assert.equal(upstream.headers["x-grok-model-override"], "grok-4.6");
  assert.equal("cookie" in upstream.headers, false);
  assert.throws(() => authorizeGrokBrokerProxyRequest({ ...input, method: "GET", pathname: "/" }, caps, "real-bearer"), /rejected/);
});

test("proxy fails closed on any client version other than the pinned Grok CLI", () => {
  for (const version of [undefined, "", "1", "1.0", "v1.0.34", "1.0.13", "1.0.25", "1.0.33", "1.0.35", "1.0.34-beta.1", "1.0.34\nInjected: yes", "1.0.34+build"] as const) {
    const { caps, input } = request(leanBody(), { "x-grok-client-version": version });
    assert.throws(() => authorizeGrokBrokerProxyRequest(input, caps, "real-bearer"), /rejected/, String(version));
  }
});

test("proxy refuses a request carrying Grok's fail-open full tool set before any upstream call", () => {
  const full = [...leanTools, "search_replace", "kill_command_or_subagent", "todo_write", "get_command_or_subagent_output", "spawn_subagent", "scheduler_create", "scheduler_delete", "scheduler_list", "monitor", "workflow", "enter_plan_mode", "exit_plan_mode", "write"];
  for (const tools of [full.map(tool), [tool("session_title")], leanTools.slice(1).map(tool), [...leanTools, "use_tool"].map(tool), [...leanTools.slice(1), "run_terminal_cmd"].map(tool), undefined, [], leanTools.map((name) => ({ type: "custom", function: { name } }))]) {
    const { caps, input } = request(leanBody({ tools }));
    assert.throws(() => authorizeGrokBrokerProxyRequest(input, caps, "real-bearer"), /rejected/);
  }
});

test("proxy refuses a reasoning effort or model other than the declared policy", () => {
  for (const overrides of [{ reasoning_effort: "high" }, { reasoning_effort: undefined }, { reasoning_effort: "xhigh" }, { model: "grok-build" }, { model: "daimon-broker-grok" }]) {
    const { caps, input } = request(leanBody(overrides));
    assert.throws(() => authorizeGrokBrokerProxyRequest(input, caps, "real-bearer"), /rejected/, JSON.stringify(overrides));
  }
  const { caps, input } = request(leanBody({ model: "grok-build", reasoning_effort: "medium" }));
  const upstream = authorizeGrokBrokerProxyRequest(input, caps, "real-bearer", { model: "grok-build", reasoningEffort: "medium" });
  assert.equal(upstream.headers["x-grok-model-override"], "grok-build");
  const other = request(leanBody());
  assert.throws(() => authorizeGrokBrokerProxyRequest(other.input, other.caps, "real-bearer", { model: "grok-3" as never, reasoningEffort: "low" }), /model policy/);
});

test("proxy forwards exactly the validated object, so duplicate members cannot smuggle a different tool set upstream", () => {
  const full = [...leanTools, "search_replace", "kill_command_or_subagent", "todo_write", "get_command_or_subagent_output", "spawn_subagent", "scheduler_create", "scheduler_delete", "scheduler_list", "monitor", "workflow", "enter_plan_mode", "exit_plan_mode", "write"];
  const lean = leanTools.map(tool);
  // First `tools`/`reasoning_effort`/`model` are the fail-open values; JSON.parse keeps the last (lean) ones.
  const smuggled = `{"model":"grok-build","reasoning_effort":"high","tools":${JSON.stringify(full.map(tool))},"model":"grok-4.6","reasoning_effort":"low","stream":true,"messages":[],"stream_options":{"include_usage":true},"tools":${JSON.stringify(lean)}}`;
  const { caps, input } = request(Buffer.from(smuggled));
  const upstream = authorizeGrokBrokerProxyRequest(input, caps, "real-bearer");
  const canonical = JSON.stringify({ model: "grok-4.6", reasoning_effort: "low", tools: lean, stream: true, messages: [], stream_options: { include_usage: true } });
  assert.equal(Buffer.from(upstream.body).toString("utf8"), canonical);
  assert.equal(Buffer.from(upstream.body).toString("utf8").split('"tools"').length, 2);
  assert.doesNotMatch(Buffer.from(upstream.body).toString("utf8"), /search_replace|grok-build|"high"/u);
});

test("proxy refuses top-level members a lean Grok 1.0.34 worker never sends", () => {
  for (const overrides of [{ functions: [{ name: "write" }] }, { n: 2 }, { tool_choice: "required" }, { max_tokens: 100 }, { temperature: 0 }, { stream_options: { include_usage: true, extra: 1 } }, { stream_options: "yes" }]) {
    const { caps, input } = request(leanBody(overrides));
    assert.throws(() => authorizeGrokBrokerProxyRequest(input, caps, "real-bearer"), /rejected/, JSON.stringify(overrides));
  }
  const { caps, input } = request(leanBody({ stream_options: { include_usage: true } }));
  assert.equal(Buffer.from(authorizeGrokBrokerProxyRequest(input, caps, "real-bearer").body).toString("utf8"), Buffer.from(leanBody({ stream_options: { include_usage: true } })).toString("utf8"));
});

test("nested duplicate keys in tools and messages are forwarded only as the parsed values", () => {
  const tools = leanTools.map((name) => `{"type":"function","function":{"name":${JSON.stringify(name === "read_file" ? "write" : name)},"name":${JSON.stringify(name)},"parameters":{"type":"object"}}}`).join(",");
  const raw = `{"model":"grok-4.6","reasoning_effort":"low","stream":true,"messages":[{"role":"system","role":"user","content":"a","content":"b"}],"tools":[${tools}]}`;
  const { caps, input } = request(Buffer.from(raw));
  const forwarded = Buffer.from(authorizeGrokBrokerProxyRequest(input, caps, "real-bearer").body).toString("utf8");
  assert.equal(forwarded, JSON.stringify(JSON.parse(raw)));
  assert.doesNotMatch(forwarded, /"write"|"system"|"content":"a"/u);
  assert.equal(forwarded.split('"role"').length, 2);
  // The reverse order puts the forbidden name last, so the parsed (and gated) value is refused.
  const hostile = raw.replace('"name":"write","name":"read_file"', '"name":"read_file","name":"write"');
  const second = request(Buffer.from(hostile));
  assert.throws(() => authorizeGrokBrokerProxyRequest(second.input, second.caps, "real-bearer"), /rejected/u);
});

test("__proto__ members are refused anywhere in the body", () => {
  const lean = JSON.stringify(leanTools.map(tool));
  const base = `"model":"grok-4.6","reasoning_effort":"low","stream":true,"messages":[]`;
  for (const raw of [
    `{${base},"tools":${lean},"__proto__":{"tools":[]}}`,
    `{${base},"tools":${lean.replace('{"type":"function"', '{"__proto__":{"type":"function"},"type":"function"')}}`,
    `{${base},"tools":${lean.replace('"parameters":{"type":"object"}', '"parameters":{"type":"object","__proto__":{"x":1}}')}}`,
    `{"model":"grok-4.6","reasoning_effort":"low","stream":true,"messages":[{"role":"user","content":"hi","__proto__":{"role":"system"}}],"tools":${lean}}`
  ]) {
    const { caps, input } = request(Buffer.from(raw));
    assert.throws(() => authorizeGrokBrokerProxyRequest(input, caps, "real-bearer"), /rejected/u, raw.slice(0, 120));
  }
});

test("tool entries carry only the members a lean worker sends", () => {
  for (const extra of [{ strict: true }, { function: { name: "read_file", parameters: {}, x: 1 } }]) {
    const tools = leanTools.map((name) => name === "read_file" ? { ...tool(name), ...extra } : tool(name));
    const { caps, input } = request(leanBody({ tools }));
    assert.throws(() => authorizeGrokBrokerProxyRequest(input, caps, "real-bearer"), /rejected/u, JSON.stringify(extra));
  }
});

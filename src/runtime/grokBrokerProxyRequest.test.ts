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

import assert from "node:assert/strict";
import test from "node:test";

import { EngineBrokerMcpCallLog, ENGINE_BROKER_MCP_CALL_INVALID, ENGINE_BROKER_MCP_CALL_TRUNCATED, ENGINE_BROKER_MCP_OUTSTANDING_MAX } from "./engineBrokerMcpCallLog.js";

const body = (value: unknown): Buffer => Buffer.from(JSON.stringify(value), "utf8");
const call = (name: unknown, id = 1): Buffer => body({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: { text: "argument-bytes" } } });

/** A controllable clock: an outstanding call's whole value is how long it has been outstanding. */
const clock = (): { log: EngineBrokerMcpCallLog; advance: (ms: number) => void } => {
  let at = 1_000;
  return { log: new EngineBrokerMcpCallLog(() => at), advance: (ms: number): void => { at += ms; } };
};

test("an unanswered tool call is outstanding with its name and its elapsed time; an answered one is neither", () => {
  const { log, advance } = clock();
  log.open("turn");
  const answered = log.begin("turn", call("daimon__moltnet_send"));
  advance(20); answered.answer(); answered.close();
  const hung = log.begin("turn", call("daimon__moltnet_read", 2));
  advance(420_000);
  const observed = log.observe("turn");
  assert.deepEqual(observed?.outstanding, [{ name: "daimon__moltnet_read", outstandingMs: 420_000 }]);
  assert.equal(observed?.started, 2); assert.equal(observed?.answered, 1); assert.equal(observed?.undecoded, 0);
  // A relay torn down by the turn's death answered nothing, and the elapsed
  // time freezes where it stopped rather than growing with the report.
  hung.close(); advance(5_000);
  assert.deepEqual(log.observe("turn")?.outstanding, [{ name: "daimon__moltnet_read", outstandingMs: 420_000 }]);
  assert.ok(!JSON.stringify(log.observe("turn")).includes("argument-bytes"), "names and timings only");
});

test("absence stays absence: an unopened turn observes undefined, a turn that called nothing observes zero", () => {
  const { log } = clock();
  assert.equal(log.observe("turn"), undefined);
  log.open("turn");
  assert.deepEqual(log.observe("turn"), { started: 0, answered: 0, undecoded: 0, outstanding: [] });
  // Everything that is not a tool call records nothing at all, so `started`
  // stays a count of tool calls and not of traffic.
  for (const value of [body({ jsonrpc: "2.0", id: 1, method: "tools/list" }), body({ jsonrpc: "2.0", method: "notifications/initialized" }), Buffer.alloc(0)]) log.begin("turn", value).answer();
  log.begin("turn", undefined).answer();
  assert.deepEqual(log.observe("turn"), { started: 0, answered: 0, undecoded: 0, outstanding: [] });
  log.close("turn");
  assert.equal(log.observe("turn"), undefined, "a revoked turn keeps nothing");
});

test("a body the facade could not read counts as undecoded, never as a call with a name", () => {
  const { log } = clock();
  log.open("turn");
  log.begin("turn", Buffer.from("{not json", "utf8"));
  log.undecodable("turn");
  assert.deepEqual(log.observe("turn"), { started: 0, answered: 0, undecoded: 2, outstanding: [] });
  log.undecodable("absent");
});

test("a tool name that is not a plain identifier is recorded as invalid, and a batch names each of its calls", () => {
  const { log } = clock();
  log.open("turn");
  log.begin("turn", call("moltnet read\nBearer sk-live-000"));
  log.begin("turn", body([]));
  log.begin("turn", Buffer.from(`[${call("memory_recall", 2).toString("utf8")},${call("world_probe", 3).toString("utf8")}]`, "utf8"));
  assert.deepEqual(log.observe("turn")?.outstanding.map((entry) => entry.name), [ENGINE_BROKER_MCP_CALL_INVALID, "memory_recall", "world_probe"]);
});

test("the outstanding list is bounded, and the earliest calls are the ones kept", () => {
  const { log, advance } = clock();
  log.open("turn");
  for (let index = 0; index < ENGINE_BROKER_MCP_OUTSTANDING_MAX + 4; index += 1) { log.begin("turn", call(`tool_${index}`, index)); advance(1); }
  const observed = log.observe("turn");
  assert.equal(observed?.started, ENGINE_BROKER_MCP_OUTSTANDING_MAX + 4);
  assert.equal(observed?.outstanding.length, ENGINE_BROKER_MCP_OUTSTANDING_MAX);
  assert.equal(observed?.outstanding[0]?.name, "tool_0");
  assert.equal(observed?.outstanding.at(-1)?.name, ENGINE_BROKER_MCP_CALL_TRUNCATED);
});

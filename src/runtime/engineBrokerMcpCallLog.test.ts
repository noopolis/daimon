import assert from "node:assert/strict";
import test from "node:test";

import { EngineBrokerMcpCallLog, ENGINE_BROKER_MCP_CALL_INVALID, ENGINE_BROKER_MCP_CALL_TRUNCATED, ENGINE_BROKER_MCP_OUTSTANDING_MAX, ENGINE_BROKER_MCP_TUNNEL_MAX } from "./engineBrokerMcpCallLog.js";

const body = (value: unknown): Buffer => Buffer.from(JSON.stringify(value), "utf8");
const call = (name: unknown, id = 1): Buffer => body({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: { text: "argument-bytes" } } });

/** A controllable clock: an outstanding call's whole value is how long it has been outstanding. */
/** An observed turn whose facade never relayed a GET tunnel — a measurement, not an absence. */
const NO_TUNNEL = { opened: 0, closed: 0, delivered: 0, open: [] };
/** An observed turn the facade never refused — also a measurement, and not the same statement as a turn it never observed. */
const NO_REFUSALS = { route: 0, expired: 0, exhausted: 0, unrouted: 0, oversized: 0 };

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
  assert.deepEqual(log.observe("turn"), { started: 0, answered: 0, undecoded: 0, outstanding: [], refusals: NO_REFUSALS, tunnels: NO_TUNNEL });
  // Everything that is not a tool call records nothing at all, so `started`
  // stays a count of tool calls and not of traffic.
  for (const value of [body({ jsonrpc: "2.0", id: 1, method: "tools/list" }), body({ jsonrpc: "2.0", method: "notifications/initialized" }), Buffer.alloc(0)]) log.begin("turn", value).answer();
  log.begin("turn", undefined).answer();
  assert.deepEqual(log.observe("turn"), { started: 0, answered: 0, undecoded: 0, outstanding: [], refusals: NO_REFUSALS, tunnels: NO_TUNNEL });
  log.close("turn");
  assert.equal(log.observe("turn"), undefined, "a revoked turn keeps nothing");
});

test("a body the facade could not read counts as undecoded, never as a call with a name", () => {
  const { log } = clock();
  log.open("turn");
  log.begin("turn", Buffer.from("{not json", "utf8"));
  log.undecodable("turn");
  assert.deepEqual(log.observe("turn"), { started: 0, answered: 0, undecoded: 2, outstanding: [], refusals: NO_REFUSALS, tunnels: NO_TUNNEL });
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

/**
 * The channel a brokered turn had no light on at all.
 *
 * Seven live runs closed every provider request, answered every tool call, and
 * still sat idle to the deadline. The one thing none of them could say is
 * whether the worker was parked on the session's standalone GET SSE tunnel,
 * because the facade relayed it and recorded nothing. The boundary these
 * assertions straddle is exactly that: a tunnel still open at observation
 * against one that ended before it — one is a worker that may still be reading,
 * the other is a channel already closed and therefore not the blocker.
 *
 * Mutation: drop `openTunnels.delete(record)` from `close`, and the closed
 * tunnel keeps reporting itself open; drop `tunnelsOpened += 1`, and an open
 * tunnel becomes indistinguishable from a turn that never opened one.
 */
test("a GET tunnel still open reports its age; one that closed first reports closed and nothing open", () => {
  const { log, advance } = clock();
  log.open("turn");
  const parked = log.openTunnel("turn");
  advance(430_000);
  const open = log.observe("turn")?.tunnels;
  assert.deepEqual(open, { opened: 1, closed: 0, delivered: 0, open: [{ openMs: 430_000, delivered: false }] });

  parked.close();
  advance(5_000);
  assert.deepEqual(log.observe("turn")?.tunnels, { opened: 1, closed: 1, delivered: 0, open: [] });
});

test("a turn that never opened a GET tunnel is not a turn that opened one, and neither is an unobserved turn", () => {
  const { log, advance } = clock();
  log.open("turn");
  // Observed, and it measured zero: every count is a measurement.
  assert.deepEqual(log.observe("turn")?.tunnels, { opened: 0, closed: 0, delivered: 0, open: [] });
  log.begin("turn", call("daimon__moltnet_read")).answer();
  assert.deepEqual(log.observe("turn")?.tunnels, { opened: 0, closed: 0, delivered: 0, open: [] }, "a POST is not a tunnel");
  const tunnel = log.openTunnel("turn");
  advance(1_000);
  assert.equal(log.observe("turn")?.tunnels?.open.length, 1);
  tunnel.close();
  // And the third state, which is not zero: a turn the facade never registered.
  assert.equal(log.observe("absent"), undefined);
  log.openTunnel("absent").deliver();
  assert.equal(log.observe("absent"), undefined, "an unopened turn keeps nothing");
});

test("a tunnel the mount pushed through is a different fact from one held open in silence", () => {
  const { log, advance } = clock();
  log.open("turn");
  const silent = log.openTunnel("turn");
  const pushing = log.openTunnel("turn");
  advance(90_000);
  pushing.deliver(); pushing.deliver();
  assert.deepEqual(log.observe("turn")?.tunnels, {
    opened: 2, closed: 0, delivered: 1,
    open: [{ openMs: 90_000, delivered: false }, { openMs: 90_000, delivered: true }]
  });
  silent.close(); silent.close();
  assert.deepEqual(log.observe("turn")?.tunnels?.closed, 1, "closing twice closes one tunnel");
});

test("the open-tunnel list is bounded, and the counts still name every tunnel beyond it", () => {
  const { log, advance } = clock();
  log.open("turn");
  for (let index = 0; index < ENGINE_BROKER_MCP_TUNNEL_MAX + 3; index += 1) { log.openTunnel("turn"); advance(1); }
  const tunnels = log.observe("turn")?.tunnels;
  assert.equal(tunnels?.opened, ENGINE_BROKER_MCP_TUNNEL_MAX + 3);
  assert.equal(tunnels?.open.length, ENGINE_BROKER_MCP_TUNNEL_MAX);
  assert.equal(tunnels?.open[0]?.openMs, ENGINE_BROKER_MCP_TUNNEL_MAX + 3, "the earliest tunnels are the ones kept");
});

/**
 * The refusal is the sharpest form of the silence this log exists to end.
 *
 * A refused request never reaches the relay, so a turn every one of whose
 * requests was 403'd observed as `started: 0, answered: 0, outstanding: []` —
 * the same three numbers a turn that simply had nothing to call observes. The
 * boundary these assertions straddle is that one: a turn refused against a
 * turn served, and an exhausted capability budget against a route the facade
 * does not serve, because the two call for opposite fixes.
 *
 * Mutation: drop the `refusals` member from `observe`, or make `refuse` a
 * no-op, and a refused turn reads as an idle one again.
 */
test("a refused request is counted by reason class, and refusing is not calling", () => {
  const { log } = clock();
  log.open("turn");
  assert.deepEqual(log.observe("turn")?.refusals, NO_REFUSALS, "an observed turn that was never refused measured zero");
  log.refuse("turn", "exhausted"); log.refuse("turn", "exhausted"); log.refuse("turn", "route");
  const observed = log.observe("turn");
  assert.deepEqual(observed?.refusals, { ...NO_REFUSALS, exhausted: 2, route: 1 });
  // The reading the instrument has to keep honest: a refused turn is not a
  // turn that called nothing and answered everything.
  assert.deepEqual([observed?.started, observed?.answered, observed?.outstanding], [0, 0, []]);
  // Every reason class is its own count, and the observation is a copy: a
  // later refusal cannot rewrite a report already handed out.
  log.refuse("turn", "unrouted");
  assert.deepEqual(observed?.refusals, { ...NO_REFUSALS, exhausted: 2, route: 1 });
  assert.deepEqual(log.observe("turn")?.refusals, { ...NO_REFUSALS, exhausted: 2, route: 1, unrouted: 1 });
});

test("a refusal the facade cannot attribute is recorded against no turn at all", () => {
  const { log } = clock();
  log.refuse("absent", "expired");
  assert.equal(log.observe("absent"), undefined, "an unopened turn keeps nothing");
  log.open("absent");
  assert.deepEqual(log.observe("absent")?.refusals, NO_REFUSALS, "a refusal before the turn existed is not this turn's");
  log.refuse("absent", "oversized");
  log.close("absent");
  log.open("absent");
  assert.deepEqual(log.observe("absent")?.refusals, NO_REFUSALS, "re-opening an id resets its refusals with everything else");
});

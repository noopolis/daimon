import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { EngineBrokerMcpCallObservation } from "./engineBrokerMcpCallLog.js";
import { engineBrokerSealLedgerPathFor, type EngineBrokerServiceRegistration } from "./engineBrokerServiceConfig.js";
import { TURN_SEAL_LEDGER_VERSION } from "./engineBrokerSealLedger.js";
import { EngineBrokerTurnRegistry } from "./engineBrokerTurnRegistry.js";
import { EngineBrokerTurnFailure, runGrokEngineBrokerTurn, type GrokEngineBrokerTurnDependencies } from "./grokEngineBrokerTurn.js";

/**
 * The hung turn's evidence, across the one boundary it has to cross.
 *
 * A cancelled or timed-out turn never answers its client, so the sealed
 * terminal response — the only carrier of `mcpCalls` and the worker's redacted
 * last words — dies with the slot. These tests pin the other route: the same
 * sealed response, projected into the broker's own ledger directory, which
 * Paideia already recovers `usage.jsonl` and `requests.jsonl` from.
 *
 * The turn runs through its real registry, meter, seal and ledger path; only
 * the launcher, the proxy registrations and the MCP facade's observation are
 * stubbed, exactly as the live hang presented them.
 */
const registration = (usageLedgerPath: string): EngineBrokerServiceRegistration => ({
  agentId: "foreman", slot: 0, workerUid: 2_200, workspace: "/workspace",
  profilePath: "/workers/0/.grok/sandbox.toml", eventsPath: "/workers/0/.grok/sessions/sandbox-events.jsonl",
  profileSha256: "a".repeat(64), usageLedgerPath, limits: { maxRequests: 32, maxTokens: 300_000, timeoutMs: 240_000 },
  model: { model: "grok-4.6", reasoningEffort: "low" }
});

const proxy: GrokEngineBrokerTurnDependencies["proxy"] = {
  capabilities: { issue: () => "provider-capability-0123456789ab", revoke: () => undefined },
  registerIsolationGuard: () => undefined, revokeIsolationGuard: () => undefined,
  registerTurn: () => undefined, revokeTurn: () => undefined
};

/** A worker that does real work and then stops acting, until the deadline aborts it. */
const hangs = (signal: AbortSignal): Promise<never> => new Promise((_resolve, reject) => {
  const fail = (): void => reject(new Error("engine broker turn failed"));
  if (signal.aborted) fail(); else signal.addEventListener("abort", fail, { once: true });
});

async function cancelledTurn(observe: () => EngineBrokerMcpCallObservation | undefined): Promise<Readonly<{ seal: Record<string, unknown> | undefined; usage: string; failure: EngineBrokerTurnFailure }>> {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-broker-seal-"));
  try {
    const usageLedgerPath = path.join(root, "usage.jsonl");
    const deps: GrokEngineBrokerTurnDependencies = {
      turns: new EngineBrokerTurnRegistry(path.join(root, "turns")), proxy, credentialStale: () => false,
      mcp: { register: () => "mcp-capability-0123456789abcdef", revoke: () => undefined, observe },
      prepareIsolation: async () => async () => undefined,
      runNative: async (_input, signal) => hangs(signal)
    };
    const controller = new AbortController();
    const running = runGrokEngineBrokerTurn(deps, registration(usageLedgerPath), "wake-hung", "prompt", "http://127.0.0.1:43124/mcp", controller.signal);
    setTimeout(() => controller.abort(), 5);
    const failure = await running.then(() => { throw new Error("the hung turn resolved"); }, (error: unknown) => error as EngineBrokerTurnFailure);
    const text = await readFile(engineBrokerSealLedgerPathFor(usageLedgerPath), "utf8").catch(() => "");
    const lines = text.split("\n").filter((line) => line.length > 0);
    assert.ok(lines.length <= 1, "one sealed turn writes at most one seal row");
    return { seal: lines[0] === undefined ? undefined : JSON.parse(lines[0]) as Record<string, unknown>, usage: await readFile(usageLedgerPath, "utf8").catch(() => ""), failure };
  } finally { await rm(root, { recursive: true, force: true }); }
}

/**
 * The finding this whole instrument exists for, on the host side of the seam.
 *
 * Live: ten provider requests, all closed, one tool receipt, then 430 s of
 * silence and an abort at 489 s. The facade's log says the worker was blocked
 * on `use_tool` the whole time, the sealed response carries it — and the
 * sealed response never travels, because a cancelled turn has no client left to
 * answer. The row in `turns.jsonl` is that evidence on a durable file the
 * evaluator already reads.
 *
 * Mutation: drop the `seal` append from `appendBrokerTurnLedger`, or the `mcp`
 * member from `renderBrokerTurnSealLine`, and this goes red. So does reverting
 * `renderBrokerTurnLedger` to return `EMPTY_BROKER_TURN_LEDGER` for a turn with
 * no attributable usage — which is exactly this turn.
 */
test("a cancelled turn's outstanding MCP call reaches the host on the broker's own ledger directory", async () => {
  const { seal, usage, failure } = await cancelledTurn(() => ({ started: 1, answered: 0, undecoded: 0, outstanding: [{ name: "use_tool", outstandingMs: 430_112 }] }));
  assert.equal(failure.code, "cancelled");
  // The usage ledger stays silent for a turn with nothing to attribute, so the
  // seal row is the only host-visible account this turn has.
  assert.equal(usage, "");
  assert.ok(seal, "a cancelled turn seals a row");
  assert.equal(seal.v, TURN_SEAL_LEDGER_VERSION);
  assert.equal(seal.agent, "foreman");
  assert.equal(seal.wake, "wake-hung");
  assert.equal(seal.outcome, "failed");
  assert.equal(seal.code, "cancelled");
  assert.equal(seal.limit_reason, "none");
  assert.equal(seal.model, "grok-4.6");
  assert.deepEqual(seal.mcp, { started: 1, answered: 0, undecoded: 0, outstanding: [{ name: "use_tool", outstanding_ms: 430_112 }] });
});

/**
 * Absence stays absence, and the two absences are not the same statement.
 *
 * A turn that called no tool measured `started: 0`; a turn the facade never
 * registered measured nothing at all and writes no `mcp` member; a turn that
 * never sealed writes no row. Reading them as one another is precisely the
 * mistake this session kept making.
 *
 * Mutation: render `mcp` unconditionally (as `{}` or as zeros) when the
 * observation is `undefined`, and the second assertion goes red.
 */
test("a cancelled turn that called no tool is distinguishable from one the facade never observed, and both from no row at all", async () => {
  const called = await cancelledTurn(() => ({ started: 0, answered: 0, undecoded: 0, outstanding: [] }));
  assert.deepEqual(called.seal?.mcp, { started: 0, answered: 0, undecoded: 0, outstanding: [] });

  const unobserved = await cancelledTurn(() => undefined);
  assert.ok(unobserved.seal, "an unobserved turn still seals its row");
  assert.equal(Object.hasOwn(unobserved.seal, "mcp"), false);

  // And the third state: no seal row at all, which is what every one of the six
  // live runs published before this stream existed.
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-broker-seal-none-"));
  try { await assert.rejects(readFile(engineBrokerSealLedgerPathFor(path.join(root, "usage.jsonl")), "utf8")); }
  finally { await rm(root, { recursive: true, force: true }); }
});

/**
 * The channel the seal row could not see, on the same durable route.
 *
 * Seven live runs sealed with every provider request closed and every tool call
 * answered, and still went idle to the deadline. The facade relays one more
 * thing for the whole session — the standalone GET SSE tunnel — and recorded
 * nothing about it, so a worker parked reading that stream and a worker doing
 * nothing wrote identical rows. These three seal the boundary that separates
 * them: still open at seal time, closed before it, and never opened at all.
 *
 * Mutation: drop the `tunnels` member from `renderBrokerTurnSealLine` and the
 * first three go red; render it unconditionally as zeros when the observation
 * carries none, and the fourth does — a zero nobody measured reads exactly
 * like a zero somebody did.
 */
test("a cancelled turn's GET tunnel is sealed open with its age, closed, or never opened — three distinct rows", async () => {
  const mcp = (tunnels: Record<string, unknown>): EngineBrokerMcpCallObservation =>
    ({ started: 1, answered: 1, undecoded: 0, outstanding: [], ...tunnels } as EngineBrokerMcpCallObservation);

  const parked = await cancelledTurn(() => mcp({ tunnels: { opened: 1, closed: 0, delivered: 0, open: [{ openMs: 428_004, delivered: false }] } }));
  assert.deepEqual((parked.seal?.mcp as Record<string, unknown>).tunnels, {
    opened: 1, closed: 0, delivered: 0, open: [{ open_ms: 428_004, delivered: false }]
  }, "a turn sealed with a tunnel still open must say so, and say how long it had been open");

  const ended = await cancelledTurn(() => mcp({ tunnels: { opened: 1, closed: 1, delivered: 2, open: [] } }));
  assert.deepEqual((ended.seal?.mcp as Record<string, unknown>).tunnels, { opened: 1, closed: 1, delivered: 2, open: [] },
    "a tunnel that closed before the seal is not an open one");

  const never = await cancelledTurn(() => mcp({ tunnels: { opened: 0, closed: 0, delivered: 0, open: [] } }));
  assert.deepEqual((never.seal?.mcp as Record<string, unknown>).tunnels, { opened: 0, closed: 0, delivered: 0, open: [] },
    "a turn whose facade never relayed a GET measured zero, which is not the same as not having looked");

  // And the fourth state, which is the absence: a turn sealed before this
  // channel was observed at all carries no `tunnels` member.
  const unobserved = await cancelledTurn(() => ({ started: 1, answered: 1, undecoded: 0, outstanding: [] }));
  assert.equal(Object.hasOwn(unobserved.seal?.mcp as Record<string, unknown>, "tunnels"), false);
});

/**
 * The refusal, on the same durable route as the hang it looks like.
 *
 * A request the facade 403'd never reached the relay, so before it was counted
 * a turn whose capability was spent — 128 requests, two per worker round —
 * sealed `answered == started, outstanding: []`, which is exactly what a
 * healthy turn seals. The row has to carry the reason class, because an
 * exhausted budget and an unserved route are opposite fixes.
 *
 * Mutation: drop the `refusals` member from `renderBrokerTurnSealLine` and the
 * first assertion goes red; render it unconditionally as zeros for an
 * observation that carries none, and the second does — a zero nobody measured
 * reads exactly like a zero somebody did.
 */
test("a turn whose MCP requests were refused seals the refusals by reason, and a turn sealed before they were counted seals none", async () => {
  const refused = await cancelledTurn(() => ({
    started: 0, answered: 0, undecoded: 0, outstanding: [],
    refusals: { route: 0, expired: 0, exhausted: 41, unrouted: 1, oversized: 0 }
  }));
  assert.deepEqual((refused.seal?.mcp as Record<string, unknown>).refusals, { route: 0, expired: 0, exhausted: 41, unrouted: 1, oversized: 0 });
  // Without it this row is `started: 0, answered: 0` — an idle turn's row.
  assert.deepEqual([(refused.seal?.mcp as Record<string, unknown>).started, (refused.seal?.mcp as Record<string, unknown>).answered], [0, 0]);

  const unobserved = await cancelledTurn(() => ({ started: 1, answered: 1, undecoded: 0, outstanding: [] }));
  assert.equal(Object.hasOwn(unobserved.seal?.mcp as Record<string, unknown>, "refusals"), false);
});

/**
 * The projection is an allow-list, and this is the assertion that makes it one.
 *
 * `renderBrokerTurnSealLine` copies a closed field set out of the sealed
 * terminal response. Replacing that copy with `...terminal` passed every other
 * test in this suite while writing `usage`, `diagnostic`, `mcpCalls` — and, for
 * a completed turn, `text`: the model's entire reply, into a ledger whose whole
 * rule is that it carries no prompt, body or reply. Nothing sealed a completed
 * turn and read the file back, so nothing was watching the one row that
 * carries a reply at all.
 *
 * The boundary: the exact key set of a written row, for the turn kind that has
 * the most to leak.
 *
 * Mutation: spread the terminal into the row (`...terminal, v: ..., agent: ...`)
 * and this goes red on both halves — the key set gains `text`, `kind`,
 * `version`, `requestId`, `workerPid`, `workerUid`, `workerStartTime` and
 * `usage`, and the reply itself appears in the file's bytes.
 */
const reply = "TANGERINE-7-IS-THE-MODELS-OWN-REPLY";
const answered = (text: string): string => {
  const session = "01a0ad21-a90f-7f71-8054-93fdb4334d6a";
  const usage = { input_tokens: 2_677, output_tokens: 92, cache_read_input_tokens: 2_816, cache_creation_input_tokens: 0 };
  return [
    { type: "system", subtype: "init", session_id: session },
    { type: "assistant", message: { id: "msg_0", type: "message", role: "assistant", model: "daimon-broker-grok", content: [{ type: "text", text }], stop_reason: "end_turn", usage }, parent_tool_use_id: null, session_id: session },
    { type: "result", subtype: "success", is_error: false, num_turns: 1, result: text, stop_reason: "end_turn", total_cost_usd: 0.0024, usage, modelUsage: { "grok-4.6-build": {} }, session_id: session }
  ].map((frame) => JSON.stringify(frame)).join("\n");
};

test("a completed turn's seal row carries exactly its declared fields, and never the model's reply", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-broker-seal-completed-"));
  try {
    const usageLedgerPath = path.join(root, "usage.jsonl");
    const deps: GrokEngineBrokerTurnDependencies = {
      turns: new EngineBrokerTurnRegistry(path.join(root, "turns")), proxy, credentialStale: () => false,
      mcp: { register: () => "mcp-capability-0123456789abcdef", revoke: () => undefined, observe: () => ({ started: 1, answered: 1, undecoded: 0, outstanding: [] }) },
      prepareIsolation: async () => async () => undefined,
      runNative: async () => ({ text: answered(reply), workerPid: 4_242, workerUid: 2_200, startTicks: 99n })
    };
    const result = await runGrokEngineBrokerTurn(deps, registration(usageLedgerPath), "wake-done", "prompt", "http://127.0.0.1:43124/mcp");
    assert.equal(result.text, reply, "the turn itself still answers with the model's reply");

    const bytes = await readFile(engineBrokerSealLedgerPathFor(usageLedgerPath), "utf8");
    const lines = bytes.split("\n").filter((line) => line.length > 0);
    assert.equal(lines.length, 1);
    const row = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.deepEqual(Object.keys(row).sort(), ["agent", "at", "engine", "limit_reason", "model", "outcome", "requests", "turn", "v", "wake"]);
    assert.deepEqual([row.v, row.agent, row.wake, row.engine, row.outcome, row.model, row.limit_reason, row.requests], [TURN_SEAL_LEDGER_VERSION, "foreman", "wake-done", "grok", "completed", "grok-4.6", "none", 1]);
    // The second half of the same guarantee, on the bytes rather than the keys:
    // a reply that reached the ledger under any name is the failure.
    assert.ok(!bytes.includes(reply), "the model's reply must never reach the ledger");
    // A completed turn carries no failure members at all, and the facade's
    // observation is a failed turn's member: neither may appear here.
    for (const absent of ["text", "code", "diagnostic", "mcp", "usage", "workerPid", "workerUid", "kind", "version"]) {
      assert.equal(Object.hasOwn(row, absent), false, absent);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

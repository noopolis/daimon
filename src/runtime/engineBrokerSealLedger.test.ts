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

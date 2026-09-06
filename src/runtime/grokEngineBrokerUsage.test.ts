import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { EngineBrokerTurnRegistry } from "./engineBrokerTurnRegistry.js";
import { finishBrokerTurnWithUsage } from "./grokEngineBroker.js";
import { TURN_USAGE_LEDGER_VERSION } from "./turnUsageLedger.js";

const usage = { input: 8_746, output: 29, cacheRead: 5_760, cacheWrite: 12, total: 14_547, calls: 1, notionalUsd: 0.0035, complete: true };

const startRequest = (agentId: string, wakeId: string) => ({
  version: "noopolis.daimon.engine-broker.v1", kind: "start_turn", requestId: randomUUID(),
  turnId: createHash("sha256").update(`${agentId}\0${wakeId}`).digest("hex"),
  agentId, wakeId, prompt: "prompt", mcpEndpoint: "http://127.0.0.1:43124/mcp"
} as const);

const completedFor = (request: ReturnType<typeof startRequest>) => ({
  version: request.version, kind: "completed", requestId: request.requestId, turnId: request.turnId,
  text: "ACK", workerPid: 4_242, workerUid: 2_200, workerStartTime: "99"
} as const);

/**
 * Reproduces the broker's turn control flow around the registry: replayed turns
 * return before any work, and a fresh turn seals the record and then meters it.
 * Everything but the engine call itself is the real production code.
 */
const runTurn = async (turns: EngineBrokerTurnRegistry, ledger: string, agentId: string, wakeId: string): Promise<"start" | "replay"> => {
  const request = startRequest(agentId, wakeId);
  const begun = await turns.begin(request);
  if (begun !== "start") return "replay";
  await finishBrokerTurnWithUsage(turns, request, completedFor(request), ledger, usage, agentId, wakeId);
  return "start";
};

const withStore = async (body: (turnStore: string, ledger: string, root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-broker-usage-"));
  try { await body(path.join(root, "turns"), path.join(root, "usage.jsonl"), root); } finally { await rm(root, { recursive: true, force: true }); }
};

const ledgerLines = async (file: string): Promise<Record<string, unknown>[]> => {
  const text = await readFile(file, "utf8").catch(() => "");
  return text.split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as Record<string, unknown>);
};

test("a completed broker turn writes exactly one metered line, and a replayed turn writes no second one", async () => {
  await withStore(async (turnStore, ledger) => {
    const turns = new EngineBrokerTurnRegistry(turnStore);
    assert.equal(await runTurn(turns, ledger, "cogsworth", "wake-1"), "start");
    assert.deepEqual(await runTurn(turns, ledger, "cogsworth", "wake-1"), "replay");

    // Mutation guard: removing the replay suppression makes the same wake
    // append a second line and double-count the subscription.
    const written = await ledgerLines(ledger);
    assert.equal(written.length, 1);
    assert.deepEqual(written[0], {
      v: TURN_USAGE_LEDGER_VERSION, agent: "cogsworth", wake: "wake-1", engine: "grok",
      at: written[0]?.at, input: 8_746, output: 29, cache_read: 5_760, cache_write: 12,
      total: 14_547, calls: 1, notional_usd: 0.0035, complete: true,
      // The broker only ever appends for a turn it finished, so its rows are
      // completed by construction; the field still states it explicitly.
      outcome: "completed"
    });

    assert.equal(await runTurn(turns, ledger, "cogsworth", "wake-2"), "start");
    assert.equal((await ledgerLines(ledger)).length, 2);
  });
});

test("crash recovery replays the same completed turn without metering it again", async () => {
  await withStore(async (turnStore, ledger) => {
    assert.equal(await runTurn(new EngineBrokerTurnRegistry(turnStore), ledger, "foreman", "wake-9"), "start");
    // A fresh boot id is what the broker gets after a crash.
    assert.equal(await runTurn(new EngineBrokerTurnRegistry(turnStore), ledger, "foreman", "wake-9"), "replay");
    assert.equal((await ledgerLines(ledger)).length, 1);
  });
});

test("an unwritable ledger leaves the turn recorded as completed, not failed", async () => {
  // Mutation guard: deleting the advisory try/catch in recordTurnUsage makes
  // finishBrokerTurnWithUsage reject. In the broker that rejection lands in the
  // catch that calls finish(..., failed), which renames over this already
  // completed record — turning a published turn into a failed one.
  await withStore(async (turnStore, _ledger, root) => {
    const turns = new EngineBrokerTurnRegistry(turnStore);
    const unwritable = path.join(root, "not-provisioned", "usage.jsonl");
    const request = startRequest("brass", "wake-3");
    assert.equal(await turns.begin(request), "start");
    await assert.doesNotReject(finishBrokerTurnWithUsage(turns, request, completedFor(request), unwritable, usage, "brass", "wake-3"));

    const replayed = await new EngineBrokerTurnRegistry(turnStore).begin(request);
    assert.notEqual(replayed, "start");
    assert.equal((replayed as { replay: { kind: string } }).replay.kind, "completed");
  });
});

test("a turn whose usage could not be decoded is sealed but writes no line", async () => {
  await withStore(async (turnStore, ledger) => {
    const turns = new EngineBrokerTurnRegistry(turnStore);
    const request = startRequest("brass", "wake-4");
    assert.equal(await turns.begin(request), "start");
    await finishBrokerTurnWithUsage(turns, request, completedFor(request), ledger, undefined, "brass", "wake-4");
    assert.deepEqual(await ledgerLines(ledger), []);
    assert.notEqual(await new EngineBrokerTurnRegistry(turnStore).begin(request), "start");
  });
});

test("usage is never written into the completed frame the strict wire parser re-validates", async () => {
  await withStore(async (turnStore, ledger) => {
    const turns = new EngineBrokerTurnRegistry(turnStore);
    assert.equal(await runTurn(turns, ledger, "cogsworth", "wake-5"), "start");
    // The durable record is re-parsed on the next begin(); an extra field there
    // makes it throw permanently and breaks crash-recovery replay for good.
    const replayed = await new EngineBrokerTurnRegistry(turnStore).begin(startRequest("cogsworth", "wake-5"));
    const response = (replayed as { replay: Record<string, unknown> }).replay;
    assert.deepEqual(Object.keys(response).sort(), ["kind", "requestId", "text", "turnId", "version", "workerPid", "workerStartTime", "workerUid"]);
  });
});

test("the broker meters only on the success path, through the single sealing helper", async () => {
  const source = await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "grokEngineBroker.ts"), "utf8");
  const body = source.slice(source.indexOf("async turn("));
  assert.equal(body.includes("recordTurnUsage("), false, "the broker must meter only through finishBrokerTurnWithUsage");
  assert.equal((body.match(/finishBrokerTurnWithUsage\(/gu) ?? []).length, 1, "exactly one metering call, in the success branch");
  assert.equal(body.includes("turns.finish(request,completed)"), false, "the success branch must seal through the metering helper");
  assert.ok(body.indexOf("finishBrokerTurnWithUsage(") < body.indexOf("catch(error)"), "metering belongs to the success branch");
});

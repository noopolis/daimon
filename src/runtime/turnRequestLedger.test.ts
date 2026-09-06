import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import type { CodexRequestUsage } from "../pi/codexRolloutUsage.js";
import {
  recordCodexTurnRequests,
  recordTurnRequests,
  renderTurnRequestLines,
  resolveTurnRequestLedgerPath,
  TURN_REQUEST_LEDGER,
  TURN_REQUEST_LEDGER_PATH_ENV,
  TURN_REQUEST_LEDGER_VERSION
} from "./turnRequestLedger.js";
import { TURN_USAGE_LEDGER, TURN_USAGE_LEDGER_VERSION } from "./turnUsageLedger.js";

const FIXTURE_THREAD = "01a06f31-0000-7000-8000-000000000001";
const fixturePath = fileURLToPath(new URL("../pi/fixtures/codex-rollout-token-usage.jsonl", import.meta.url));

const request = (overrides: Partial<CodexRequestUsage> = {}): CodexRequestUsage =>
  ({ index: 0, input: 22_119, cachedInput: 21_888, cacheWrite: 0, output: 358, reasoning: 169, total: 22_477, ...overrides });

const withDirectory = async (body: (directory: string) => Promise<void>): Promise<void> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "daimon-turn-requests-"));
  try { await body(directory); } finally { await rm(directory, { recursive: true, force: true }); }
};

const lines = async (file: string): Promise<string[]> =>
  (await readFile(file, "utf8")).split("\n").filter((line) => line.length > 0);

const plantRollout = async (home: string, threadId: string): Promise<void> => {
  const directory = path.join(home, "sessions", "2026", "09", "05");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `rollout-2026-09-05T03-31-52-${threadId}.jsonl`), await readFile(fixturePath, "utf8"), "utf8");
};

test("one line per model request, carrying the thread and the cached/fresh split", () => {
  const rendered = renderTurnRequestLines({
    agent: "agent-one", wake: "wake-1", thread: FIXTURE_THREAD, at: "2026-09-05T01:32:00.000Z",
    requests: [request(), request({ index: 1, input: 30_000, cachedInput: 21_888, total: 30_400, output: 400, reasoning: 200 })]
  });
  const parsed = rendered.split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line));
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0], {
    v: TURN_REQUEST_LEDGER_VERSION, agent: "agent-one", wake: "wake-1", engine: "codex",
    at: "2026-09-05T01:32:00.000Z", thread: FIXTURE_THREAD,
    request: 0, requests: 2,
    input: 22_119, cached_input: 21_888, fresh_input: 231, cache_write: 0,
    output: 358, reasoning: 169, total: 22_477
  });
  assert.equal(parsed[1].fresh_input, 30_000 - 21_888);
  assert.equal(rendered.endsWith("\n"), true);
});

test("the stream is a sibling of the usage ledger and never that ledger's version", () => {
  assert.notEqual(TURN_REQUEST_LEDGER_VERSION, TURN_USAGE_LEDGER_VERSION);
  assert.notEqual(TURN_REQUEST_LEDGER.filePath, TURN_USAGE_LEDGER.filePath);
  assert.equal(path.dirname(TURN_REQUEST_LEDGER.filePath), TURN_USAGE_LEDGER.directoryPath);
});

test("an absolute override relocates the stream and anything else is ignored", () => {
  assert.equal(resolveTurnRequestLedgerPath({}), TURN_REQUEST_LEDGER.filePath);
  assert.equal(resolveTurnRequestLedgerPath({ [TURN_REQUEST_LEDGER_PATH_ENV]: "/tmp/requests.jsonl" }), "/tmp/requests.jsonl");
  assert.equal(resolveTurnRequestLedgerPath({ [TURN_REQUEST_LEDGER_PATH_ENV]: "requests.jsonl" }), TURN_REQUEST_LEDGER.filePath);
  assert.equal(resolveTurnRequestLedgerPath({ [TURN_REQUEST_LEDGER_PATH_ENV]: "  " }), TURN_REQUEST_LEDGER.filePath);
});

test("a wake with no decodable requests writes nothing at all", async () => {
  await withDirectory(async (directory) => {
    const file = path.join(directory, "requests.jsonl");
    assert.equal(await recordTurnRequests(file, { agent: "a", wake: "w", thread: FIXTURE_THREAD, requests: [] }), false);
    await assert.rejects(readFile(file), /ENOENT/u, "a zero row is indistinguishable from a real zero, so none is written");
  });
});

test("appends accumulate and never fail the caller", async () => {
  await withDirectory(async (directory) => {
    const file = path.join(directory, "requests.jsonl");
    assert.equal(await recordTurnRequests(file, { agent: "a", wake: "w1", thread: FIXTURE_THREAD, requests: [request()] }), true);
    assert.equal(await recordTurnRequests(file, { agent: "a", wake: "w2", thread: FIXTURE_THREAD, requests: [request(), request({ index: 1 })] }), true);
    assert.equal((await lines(file)).length, 3);
    assert.equal(await recordTurnRequests(path.join(directory, "missing", "requests.jsonl"), { agent: "a", wake: "w", thread: FIXTURE_THREAD, requests: [request()] }), false);
  });
});

test("a real rollout reaches the stream end to end, one line per request", async () => {
  await withDirectory(async (directory) => {
    const home = path.join(directory, "codex-home");
    await plantRollout(home, FIXTURE_THREAD);
    const file = path.join(directory, "requests.jsonl");
    assert.equal(await recordCodexTurnRequests({ agent: "agent-one", wake: "wake-1", codexHome: home, threadId: FIXTURE_THREAD, file }), true);
    const rows = (await lines(file)).map((line) => JSON.parse(line));
    assert.equal(rows.length, 4);
    assert.equal(rows.every((row) => row.thread === FIXTURE_THREAD && row.wake === "wake-1" && row.requests === 4), true);
    assert.deepEqual(rows.map((row) => row.fresh_input), [15_742, 248, 4_276, 10_068]);
  });
});

test("a missing or malformed rollout writes nothing and still resolves", async () => {
  await withDirectory(async (directory) => {
    const home = path.join(directory, "codex-home");
    const file = path.join(directory, "requests.jsonl");
    assert.equal(await recordCodexTurnRequests({ agent: "a", wake: "w", codexHome: home, threadId: FIXTURE_THREAD, file }), false);
    await mkdir(path.join(home, "sessions", "2026", "09", "05"), { recursive: true });
    await writeFile(path.join(home, "sessions", "2026", "09", "05", `rollout-x-${FIXTURE_THREAD}.jsonl`),
      "{\"type\":\"token_usage_record\",\"payload\":{\"usage\":{\"input_tokens\":-1,\"cached_input_tokens\":0,\"output_tokens\":0,\"reasoning_output_tokens\":0}}}\n", "utf8");
    assert.equal(await recordCodexTurnRequests({ agent: "a", wake: "w", codexHome: home, threadId: FIXTURE_THREAD, file }), false);
    await assert.rejects(readFile(file), /ENOENT/u);
  });
});

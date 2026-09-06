import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  findCodexRolloutPath,
  isCodexThreadId,
  parseCodexRolloutRequests,
  readCodexRolloutRequests
} from "./codexRolloutUsage.js";

const FIXTURE_THREAD = "01a06f31-0000-7000-8000-000000000001";
const fixturePath = fileURLToPath(new URL("./fixtures/codex-rollout-token-usage.jsonl", import.meta.url));
const fixture = async (): Promise<string> => readFile(fixturePath, "utf8");

const withCodexHome = async (body: (home: string) => Promise<void>): Promise<void> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "daimon-codex-rollout-"));
  try { await body(directory); } finally { await rm(directory, { recursive: true, force: true }); }
};

const plant = async (home: string, threadId: string, contents: string, day = "2026/09/05"): Promise<string> => {
  const directory = path.join(home, "sessions", ...day.split("/"));
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `rollout-2026-09-05T03-31-52-${threadId}.jsonl`);
  await writeFile(file, contents, "utf8");
  return file;
};

test("a real multi-request rollout yields one row per model request, cached and fresh input split", async () => {
  const requests = parseCodexRolloutRequests(await fixture(), FIXTURE_THREAD);
  assert.equal(requests.length, 4, "the captured turn made four model requests");
  assert.deepEqual(requests.map((request) => request.index), [0, 1, 2, 3]);
  assert.deepEqual(requests.map((request) => [request.input, request.cachedInput, request.input - request.cachedInput]), [
    [34_686, 18_944, 15_742],
    [35_960, 35_712, 248],
    [40_116, 35_840, 4_276],
    [50_004, 39_936, 10_068]
  ]);
  assert.deepEqual(requests.map((request) => [request.output, request.reasoning, request.total]), [
    [489, 438, 35_175],
    [279, 126, 36_239],
    [381, 220, 40_497],
    [288, 228, 50_292]
  ]);
  assert.deepEqual(requests.map((request) => request.cacheWrite), [0, 0, 0, 0]);
});

test("reasoning tokens, which the per-wake ledger drops entirely, survive per request", async () => {
  const requests = parseCodexRolloutRequests(await fixture(), FIXTURE_THREAD);
  assert.equal(requests.every((request) => request.reasoning > 0), true);
  assert.equal(requests.every((request) => request.reasoning <= request.output), true);
});

test("the token_count fallback deduplicates the repeats a rate-limit refresh emits", async () => {
  // A Codex version without `token_usage_record` leaves only `token_count`. The
  // captured rollout carries six of those for four requests, so a fallback that
  // counted frames would report ten requests where four were made.
  const text = await fixture();
  const countOnly = text.split("\n").filter((line) => !line.includes("\"token_usage_record\"")).join("\n");
  assert.equal(countOnly.split("\n").filter((line) => line.includes("\"token_count\"")).length, 6);
  const requests = parseCodexRolloutRequests(countOnly, FIXTURE_THREAD);
  assert.equal(requests.length, 4);
  assert.deepEqual(requests.map((request) => request.input), [34_686, 35_960, 40_116, 50_004]);
});

test("a record naming a different thread is never billed to this wake", async () => {
  const requests = parseCodexRolloutRequests(await fixture(), "01a06f31-0000-7000-8000-00000000ffff");
  // Every `token_usage_record` is rejected by thread, and the surviving
  // `token_count` frames carry no thread of their own, so only they remain.
  assert.equal(requests.length, 4);
});

test("a malformed usage block abandons the whole wake rather than reporting part of it", () => {
  const good = JSON.stringify({ type: "token_usage_record", payload: { thread_id: FIXTURE_THREAD, usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2, reasoning_output_tokens: 1 } } });
  const bad = JSON.stringify({ type: "token_usage_record", payload: { thread_id: FIXTURE_THREAD, usage: { input_tokens: 10, cached_input_tokens: "4", output_tokens: 2, reasoning_output_tokens: 1 } } });
  assert.equal(parseCodexRolloutRequests(`${good}\n${good}\n`, FIXTURE_THREAD).length, 2);
  assert.deepEqual(parseCodexRolloutRequests(`${good}\n${bad}\n`, FIXTURE_THREAD), []);
});

test("a usage block violating Codex's own subset relationships is refused", () => {
  const cachedAboveInput = JSON.stringify({ type: "token_usage_record", payload: { usage: { input_tokens: 10, cached_input_tokens: 11, output_tokens: 2, reasoning_output_tokens: 1 } } });
  const reasoningAboveOutput = JSON.stringify({ type: "token_usage_record", payload: { usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2, reasoning_output_tokens: 3 } } });
  assert.deepEqual(parseCodexRolloutRequests(cachedAboveInput, FIXTURE_THREAD), []);
  assert.deepEqual(parseCodexRolloutRequests(reasoningAboveOutput, FIXTURE_THREAD), []);
});

test("a torn trailing line is skipped, because Codex appends to this file while the turn runs", async () => {
  const text = await fixture();
  const requests = parseCodexRolloutRequests(`${text}{"type":"token_usage_rec`, FIXTURE_THREAD);
  assert.equal(requests.length, 4);
});

test("a rollout with no usage frame at all yields nothing rather than a zero row", () => {
  assert.deepEqual(parseCodexRolloutRequests("", FIXTURE_THREAD), []);
  assert.deepEqual(parseCodexRolloutRequests("{\"type\":\"session_meta\",\"payload\":{}}\n", FIXTURE_THREAD), []);
});

test("the rollout is found by thread id, not by recency", async () => {
  await withCodexHome(async (home) => {
    const mine = await plant(home, FIXTURE_THREAD, await fixture(), "2026/09/05");
    await plant(home, "01a06f31-0000-7000-8000-0000000000ff", "{\"type\":\"token_usage_record\",\"payload\":{\"usage\":{\"input_tokens\":1,\"cached_input_tokens\":0,\"output_tokens\":1,\"reasoning_output_tokens\":0}}}\n", "2026/09/06");
    assert.equal(await findCodexRolloutPath(home, FIXTURE_THREAD), mine);
    const requests = await readCodexRolloutRequests(home, FIXTURE_THREAD);
    assert.equal(requests.length, 4, "a newer sibling rollout belonging to another wake is not read");
  });
});

test("an absent rollout, an absent CODEX_HOME, and an unreadable file all read as nothing", async () => {
  await withCodexHome(async (home) => {
    assert.deepEqual(await readCodexRolloutRequests(home, FIXTURE_THREAD), []);
    assert.equal(await findCodexRolloutPath(path.join(home, "not-a-home"), FIXTURE_THREAD), undefined);
    const file = await plant(home, FIXTURE_THREAD, await fixture());
    await rm(file);
    await mkdir(file);
    assert.deepEqual(await readCodexRolloutRequests(home, FIXTURE_THREAD), [], "a directory where the rollout should be is not an exception");
  });
});

test("a thread id that is not a Codex thread id never reaches the filesystem", async () => {
  assert.equal(isCodexThreadId("01a06f31-0000-7000-8000-000000000001"), true);
  assert.equal(isCodexThreadId("../../../etc"), false);
  assert.equal(isCodexThreadId("a/b"), false);
  assert.equal(isCodexThreadId(""), false);
  assert.equal(isCodexThreadId(42), false);
  await withCodexHome(async (home) => {
    await plant(home, FIXTURE_THREAD, await fixture());
    assert.equal(await findCodexRolloutPath(home, "../../../etc"), undefined);
  });
});

test("the captured fixture carries no capturing machine's environment", async () => {
  const text = await fixture();
  assert.equal(/apresmoi|\/Users\//u.test(text), false);
  assert.equal(text.includes("01a06f31-89f7-7633"), false, "the live thread id was replaced");
  assert.equal(text.includes("[sanitized: Codex base instructions"), true);
});

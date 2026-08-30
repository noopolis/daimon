import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  recordTurnUsage,
  resolveTurnUsageLedgerPath,
  TURN_USAGE_ENGINES,
  TURN_USAGE_LEDGER_PATH_ENV,
  renderTurnUsageLine,
  TURN_USAGE_LEDGER,
  TURN_USAGE_LEDGER_VERSION,
  TURN_USAGE_MAX_IDENTIFIER_CHARS,
  TURN_USAGE_ROTATE_BYTES,
  type TurnUsageEntry
} from "./turnUsageLedger.js";

const measurement = { input: 8_746, output: 29, cacheRead: 5_760, cacheWrite: 12, total: 14_547, calls: 1, notionalUsd: 0.0035, complete: true };
const entry = (overrides: Partial<TurnUsageEntry> = {}): TurnUsageEntry =>
  ({ agent: "cogsworth", wake: "wake-1", engine: "grok", usage: measurement, at: "2026-08-29T01:12:04.000Z", ...overrides });

const withLedger = async (body: (file: string, directory: string) => Promise<void>): Promise<void> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "daimon-turn-usage-"));
  try { await body(path.join(directory, "usage.jsonl"), directory); } finally { await rm(directory, { recursive: true, force: true }); }
};

const lines = async (file: string): Promise<string[]> =>
  (await readFile(file, "utf8")).split("\n").filter((line) => line.length > 0);

test("a record is one complete newline-terminated line carrying only numbers plus agent, wake, and engine", async () => {
  const line = renderTurnUsageLine(entry());
  assert.equal(line.endsWith("\n"), true);
  assert.equal(line.slice(0, -1).includes("\n"), false);
  assert.deepEqual(JSON.parse(line), {
    v: TURN_USAGE_LEDGER_VERSION, agent: "cogsworth", wake: "wake-1", engine: "grok",
    at: "2026-08-29T01:12:04.000Z",
    input: 8_746, output: 29, cache_read: 5_760, cache_write: 12,
    total: 14_547, calls: 1, notional_usd: 0.0035, complete: true
  });
  assert.equal("org" in JSON.parse(line), false, "identity comes from which container was queried, not from the record");
});

test("caller-supplied agent and wake text is truncated and cannot inject a second line", async () => {
  const parsed = JSON.parse(renderTurnUsageLine(entry({ agent: "a".repeat(5_000), wake: `w\n${JSON.stringify({ v: "forged" })}\n${"b".repeat(5_000)}` })));
  assert.equal([...parsed.agent].length, TURN_USAGE_MAX_IDENTIFIER_CHARS);
  assert.equal([...parsed.wake].length, TURN_USAGE_MAX_IDENTIFIER_CHARS);
  const line = renderTurnUsageLine(entry({ wake: "w\n{\"v\":\"forged\"}" }));
  assert.equal(line.split("\n").filter((part) => part.length > 0).length, 1);
});

test("appends accumulate one line per turn and survive concurrent writers", async () => {
  await withLedger(async (file) => {
    await Promise.all(Array.from({ length: 64 }, (_, index) =>
      recordTurnUsage(file, entry({ agent: `agent-${index % 8}`, wake: `wake-${index}` }))));
    const written = await lines(file);
    assert.equal(written.length, 64);
    for (const line of written) assert.equal(JSON.parse(line).v, TURN_USAGE_LEDGER_VERSION);
    assert.equal(new Set(written.map((line) => JSON.parse(line).wake)).size, 64);
    assert.equal(((await stat(file)).mode & 0o777) & 0o007, 0, "the ledger must not be world-readable");
  });
});

test("a failed append never throws, so a completed turn is never rewritten as failed", async () => {
  // Mutation guard: deleting the try/catch in recordTurnUsage turns every one
  // of these into a rejection, which in the broker escapes into the catch that
  // calls finish(..., failed) over an already-completed turn record.
  await withLedger(async (file, directory) => {
    const unwritable = path.join(directory, "nested", "missing", "usage.jsonl");
    await assert.doesNotReject(recordTurnUsage(unwritable, entry()));

    const asDirectory = path.join(directory, "as-directory.jsonl");
    await mkdir(asDirectory);
    await assert.doesNotReject(recordTurnUsage(asDirectory, entry()));

    await writeFile(file, "");
    await chmod(file, 0o400);
    await assert.doesNotReject(recordTurnUsage(file, entry()));
    await chmod(file, 0o600);

    await assert.doesNotReject(recordTurnUsage(file, entry({ usage: { ...measurement, notionalUsd: Number.NaN } })));
  });
});

test("the ledger rotates once at the size bound and keeps exactly one generation", async () => {
  await withLedger(async (file) => {
    await writeFile(file, "old\n");
    await truncate(file, TURN_USAGE_ROTATE_BYTES);
    await recordTurnUsage(file, entry({ wake: "after-rotation" }));

    assert.deepEqual((await lines(file)).map((line) => JSON.parse(line).wake), ["after-rotation"]);
    assert.equal((await stat(`${file}.1`)).size, TURN_USAGE_ROTATE_BYTES);

    await recordTurnUsage(file, entry({ wake: "still-current" }));
    assert.equal((await lines(file)).length, 2, "a below-bound ledger must not rotate again");
  });
});

test("the shared ledger location is the root-provisioned usage volume, not the broker realm", () => {
  assert.equal(TURN_USAGE_LEDGER.directoryPath, "/var/lib/spawnfile/daimon/usage");
  assert.equal(TURN_USAGE_LEDGER.filePath, `${TURN_USAGE_LEDGER.directoryPath}/usage.jsonl`);
  assert.equal(TURN_USAGE_LEDGER.rotatedFilePath, `${TURN_USAGE_LEDGER.filePath}.1`);
  assert.equal(TURN_USAGE_LEDGER.directoryMode, 0o750);
  assert.equal(TURN_USAGE_LEDGER.fileMode, 0o640);
});

test("an AGY turn renders the same record shape, labelled agy", () => {
  const parsed = JSON.parse(renderTurnUsageLine(entry({
    engine: "agy",
    usage: { input: 44_937, output: 444, cacheRead: 0, cacheWrite: 0, total: 45_381, calls: 1, notionalUsd: 0, complete: true }
  })));
  assert.deepEqual(parsed, {
    v: TURN_USAGE_LEDGER_VERSION, agent: "cogsworth", wake: "wake-1", engine: "agy",
    at: "2026-08-29T01:12:04.000Z",
    input: 44_937, output: 444, cache_read: 0, cache_write: 0,
    total: 45_381, calls: 1, notional_usd: 0, complete: true
  });
  assert.deepEqual([...TURN_USAGE_ENGINES], ["agy", "grok"], "codex is uninstrumented and must not claim zero usage");
});

test("the ledger path override is honoured only when it is absolute", () => {
  assert.equal(resolveTurnUsageLedgerPath({}), TURN_USAGE_LEDGER.filePath);
  assert.equal(resolveTurnUsageLedgerPath({ [TURN_USAGE_LEDGER_PATH_ENV]: "  " }), TURN_USAGE_LEDGER.filePath);
  assert.equal(resolveTurnUsageLedgerPath({ [TURN_USAGE_LEDGER_PATH_ENV]: "relative/usage.jsonl" }), TURN_USAGE_LEDGER.filePath);
  assert.equal(resolveTurnUsageLedgerPath({ [TURN_USAGE_LEDGER_PATH_ENV]: " /tmp/usage.jsonl " }), "/tmp/usage.jsonl");
});

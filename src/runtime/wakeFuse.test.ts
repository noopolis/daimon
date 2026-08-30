import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { WakeFuse, WAKE_FUSE_VERSION } from "./wakeFuse.js";

const withDirectory = async (body: (directory: string) => Promise<void>): Promise<void> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "daimon-wake-fuse-"));
  try { await body(directory); } finally { await rm(directory, { recursive: true, force: true }); }
};
const environment = (directory: string, values: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  DAIMON_WAKE_FUSE_DIRECTORY: directory,
  DAIMON_WAKE_FUSE_EPOCH: "test-epoch",
  DAIMON_WAKE_FUSE_MAX_WAKES: "2",
  DAIMON_WAKE_FUSE_MAX_TOKENS: "1000",
  DAIMON_TURN_USAGE_LEDGER_PATH: path.join(directory, "usage.jsonl"),
  ...values
});
const records = async (directory: string): Promise<Array<Record<string, unknown>>> =>
  (await readFile(path.join(directory, "admissions.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);

test("admission below the ceiling appends exactly one admission", async () => await withDirectory(async (directory) => {
  const fuse = await WakeFuse.open({ organizationKey: "org", environment: environment(directory) });
  assert.deepEqual(await fuse.admit("alpha", "one"), { state: "admitted" });
  assert.equal((await records(directory)).filter((record) => record.kind === "admission").length, 1);
}));

test("the n+1 admission trips before append", async () => await withDirectory(async (directory) => {
  const fuse = await WakeFuse.open({ organizationKey: "org", environment: environment(directory) });
  await fuse.admit("alpha", "one"); await fuse.admit("alpha", "two");
  assert.deepEqual(await fuse.admit("alpha", "three"), { state: "tripped", reason: "wake_ceiling" });
  assert.equal((await records(directory)).filter((record) => record.kind === "admission").length, 2);
}));

test("concurrent organization admissions cannot overshoot the wake ceiling", async () => await withDirectory(async (directory) => {
  const fuse = await WakeFuse.open({ organizationKey: "org", environment: environment(directory, { DAIMON_WAKE_FUSE_MAX_WAKES: "8" }) });
  const verdicts = await Promise.all(Array.from({ length: 9 }, (_, index) => fuse.admit(`agent-${index % 4}`, `delivery-${index}`)));
  assert.equal(verdicts.filter((verdict) => verdict.state === "admitted").length, 8);
  assert.ok(verdicts.some((verdict) => verdict.state === "tripped"));
  assert.equal((await records(directory)).filter((record) => record.kind === "admission").length, 8);
}));

test("token accounting excludes pre-epoch and skips malformed usage", async () => await withDirectory(async (directory) => {
  const times = [new Date("2026-08-30T00:00:00.000Z"), new Date("2026-08-30T00:00:00.000Z")];
  await writeFile(path.join(directory, "usage.jsonl"), [
    JSON.stringify({ at: "2026-08-29T23:59:59.999Z", total: 5000 }),
    "not-json",
    JSON.stringify({ at: "2026-08-30T00:00:00.000Z", total: 1000 })
  ].join("\n") + "\n");
  const fuse = await WakeFuse.open({ organizationKey: "org", environment: environment(directory), now: () => times.shift() ?? new Date("2026-08-30T00:00:00.000Z") });
  assert.deepEqual(await fuse.admit("alpha", "one"), { state: "tripped", reason: "token_ceiling" });
}));

test("pre-epoch token rows alone cannot trip the ceiling", async () => await withDirectory(async (directory) => {
  await writeFile(path.join(directory, "usage.jsonl"), [
    JSON.stringify({ at: "2026-08-29T23:59:59.999Z", total: 5000 }),
    JSON.stringify({ at: "2026-08-30T00:00:00.001Z", total: 10 })
  ].join("\n") + "\n");
  const fuse = await WakeFuse.open({ organizationKey: "org", environment: environment(directory, { DAIMON_WAKE_FUSE_MAX_TOKENS: "100" }), now: () => new Date("2026-08-30T00:00:00.000Z") });
  assert.deepEqual(await fuse.admit("alpha", "one"), { state: "admitted" });
}));

test("same-epoch open reloads prior admissions", async () => await withDirectory(async (directory) => {
  const first = await WakeFuse.open({ organizationKey: "org", environment: environment(directory) });
  await first.admit("alpha", "one");
  await first.admit("alpha", "two");
  await first.close();
  const reopened = await WakeFuse.open({ organizationKey: "org", environment: environment(directory) });
  assert.deepEqual(await reopened.admit("alpha", "three"), { state: "tripped", reason: "wake_ceiling" });
}));

test("a wake ceiling trip is restored with its reason in the same epoch", async () => await withDirectory(async (directory) => {
  const first = await WakeFuse.open({ organizationKey: "org", environment: environment(directory, { DAIMON_WAKE_FUSE_MAX_WAKES: "1" }) });
  await first.admit("alpha", "one");
  assert.deepEqual(await first.admit("alpha", "two"), { state: "tripped", reason: "wake_ceiling" });
  const reopened = await WakeFuse.open({ organizationKey: "org", environment: environment(directory, { DAIMON_WAKE_FUSE_MAX_WAKES: "1" }) });
  assert.equal(reopened.tripped(), "wake_ceiling");
}));

test("a corrupt trip marker fails closed", async () => await withDirectory(async (directory) => {
  await writeFile(path.join(directory, "fuse.trip.json"), "not-json\n");
  const fuse = await WakeFuse.open({ organizationKey: "org", environment: environment(directory) });
  assert.equal(fuse.tripped(), "ledger_unavailable");
}));

test("a valid trip marker from a previous epoch does not trip a new epoch", async () => await withDirectory(async (directory) => {
  const first = await WakeFuse.open({ organizationKey: "org", environment: environment(directory, { DAIMON_WAKE_FUSE_EPOCH: "old", DAIMON_WAKE_FUSE_MAX_WAKES: "1" }) });
  await first.admit("alpha", "one");
  await first.admit("alpha", "two");
  const fresh = await WakeFuse.open({ organizationKey: "org", environment: environment(directory, { DAIMON_WAKE_FUSE_EPOCH: "new", DAIMON_WAKE_FUSE_MAX_WAKES: "1" }) });
  assert.equal(fresh.tripped(), undefined);
}));

test("token accounting follows the relocated usage ledger", async () => await withDirectory(async (directory) => {
  const elsewhere = path.join(directory, "elsewhere.jsonl");
  await writeFile(elsewhere, `${JSON.stringify({ at: "2026-08-30T00:00:00.000Z", total: 1000 })}\n`);
  const fuse = await WakeFuse.open({ organizationKey: "org", environment: environment(directory, { DAIMON_TURN_USAGE_LEDGER_PATH: elsewhere }), now: () => new Date("2026-08-30T00:00:00.000Z") });
  assert.deepEqual(await fuse.admit("alpha", "one"), { state: "tripped", reason: "token_ceiling" });
}));

test("a malformed usage line alone is skipped", async () => await withDirectory(async (directory) => {
  await writeFile(path.join(directory, "usage.jsonl"), "broken\n");
  const fuse = await WakeFuse.open({ organizationKey: "org", environment: environment(directory) });
  assert.deepEqual(await fuse.admit("alpha", "one"), { state: "admitted" });
}));

test("admissions from another epoch do not count", async () => await withDirectory(async (directory) => {
  await writeFile(path.join(directory, "admissions.jsonl"), `${JSON.stringify({ v: WAKE_FUSE_VERSION, kind: "admission", epoch: "old", at: new Date().toISOString(), agent: "alpha", delivery: "old" })}\n`);
  const fuse = await WakeFuse.open({ organizationKey: "org", environment: environment(directory, { DAIMON_WAKE_FUSE_MAX_WAKES: "1" }) });
  assert.deepEqual(await fuse.admit("alpha", "new"), { state: "admitted" });
}));

test("operator stop trips on the next admission", async () => await withDirectory(async (directory) => {
  const fuse = await WakeFuse.open({ organizationKey: "org", environment: environment(directory) });
  await writeFile(path.join(directory, "fuse.stop"), "ignored");
  assert.deepEqual(await fuse.admit("alpha", "one"), { state: "tripped", reason: "operator_stop" });
}));

test("an append failure refuses admission and fails closed", async () => await withDirectory(async (directory) => {
  const fuse = await WakeFuse.open({ organizationKey: "org", environment: environment(directory) });
  await unlink(path.join(directory, "admissions.jsonl"));
  await mkdir(path.join(directory, "admissions.jsonl"));
  assert.deepEqual(await fuse.admit("alpha", "one"), { state: "tripped", reason: "ledger_unavailable" });
}));

test("invalid wake ceilings throw instead of applying defaults", async () => await withDirectory(async (directory) => {
  for (const value of ["0", "-1", "1.5", "abc"]) {
    await assert.rejects(WakeFuse.open({ organizationKey: "org", environment: environment(directory, { DAIMON_WAKE_FUSE_MAX_WAKES: value }) }), /positive integer/);
  }
}));

test("off admits unconditionally without storage and every other setting is rejected", async () => await withDirectory(async (directory) => {
  const missing = path.join(directory, "missing");
  const warnings: string[] = [];
  const original = console.error;
  console.error = (...values: unknown[]) => { warnings.push(values.join(" ")); };
  try {
    const fuse = await WakeFuse.open({ organizationKey: "org", environment: environment(missing, { DAIMON_WAKE_FUSE: "off", DAIMON_WAKE_FUSE_MAX_WAKES: "1" }) });
    await WakeFuse.open({ organizationKey: "org", environment: environment(missing, { DAIMON_WAKE_FUSE: "off" }) });
    assert.deepEqual(await fuse.admit("alpha", "one"), { state: "admitted" });
    assert.deepEqual(await fuse.admit("alpha", "two"), { state: "admitted" });
  } finally { console.error = original; }
  assert.deepEqual(warnings, ["DAIMON WAKE FUSE IS OFF: wake admission is unbounded"]);
  await assert.rejects(WakeFuse.open({ organizationKey: "org", environment: environment(directory, { DAIMON_WAKE_FUSE: "on" }) }), /exactly 'off'/);
}));

test("once tripped the fuse never admits again", async () => await withDirectory(async (directory) => {
  const fuse = await WakeFuse.open({ organizationKey: "org", environment: environment(directory, { DAIMON_WAKE_FUSE_MAX_WAKES: "1" }) });
  await fuse.admit("alpha", "one");
  assert.equal((await fuse.admit("alpha", "two")).state, "tripped");
  assert.equal((await fuse.admit("alpha", "one")).state, "tripped");
}));

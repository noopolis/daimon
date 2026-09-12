import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WakeAcceptanceStore } from "./wakeAcceptanceStore.js";
import { parseStoredWakeAcceptance, sanitizeExecutionError } from "./wakeAcceptanceRecord.js";
import { parseWakeAcceptanceRequest } from "./wakeAcceptanceTypes.js";

const storeOptions = process.platform === "linux" ? {} : {
  processIdentity: async () => ({ pid: 1, process_start: "test-start", boot_id: "test-boot", pid_namespace_dev: 1, pid_namespace_ino: 1 }),
  ownerLiveness: async () => true
};
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-error-record-")); await chmod(root, 0o700);
  let store = await WakeAcceptanceStore.open(root, storeOptions);
  const { record } = await store.accept(parseWakeAcceptanceRequest({ token: undefined, agent_id: "alpha", delivery_id: "test",
    event: { version: "noopolis.daimon.wake.v2", kind: "message", text: "work", occurred_at: "2026-09-12T11:30:00.000Z" } }));
  const acquired = await store.acquireClaim(record.acceptance_id, randomUUID(), [record.acceptance_id], randomUUID());
  assert.equal(acquired.state, "acquired"); if (acquired.state !== "acquired") throw new Error("claim missing");
  await store.transitionClaimed(record.acceptance_id, acquired.claim, "running");
  return { root, record, claim: acquired.claim, get store() { return store; },
    async restart() { await store.releaseClaim(acquired.claim); await store.close(); store = await WakeAcceptanceStore.open(root, storeOptions); },
    async cleanup() { await store.close(); await rm(root, { recursive: true, force: true }); }
  };
}

test("empty execution diagnostics are omitted rather than writing an unreadable record", async () => {
  const f = await fixture();
  try {
    await f.store.transitionClaimed(f.record.acceptance_id, f.claim, "accepted", undefined, undefined, { deferred: true, execution_error: " \t\n " });
    await f.restart();
    const [row] = await f.store.recoverable(new Set(["alpha"]));
    assert.equal(row!.execution_error, undefined);
    assert.equal((await f.store.status(f.record.acceptance_id))!.state, "accepted");
  } finally { await f.cleanup(); }
});

test("large multibyte diagnostics remain bounded, redacted, and readable after restart", async () => {
  const f = await fixture();
  try {
    const original = "provider failed Bearer secret-review-token " + "€".repeat(2000);
    await f.store.transitionClaimed(f.record.acceptance_id, f.claim, "accepted", undefined, undefined, { deferred: true, execution_error: original });
    await f.restart();
    const [row] = await f.store.recoverable(new Set(["alpha"]));
    assert.ok(Buffer.byteLength(row!.execution_error!) <= 2048);
    assert.match(row!.execution_error!, /provider failed/); assert.doesNotMatch(row!.execution_error!, /secret-review-token|\uFFFD/);
    assert.equal(row!.execution_error, sanitizeExecutionError(original));
    const { readdir } = await import("node:fs/promises");
    for (const file of await readdir(f.root)) if (file.endsWith(".json")) assert.doesNotMatch(await readFile(path.join(f.root, file), "utf8"), /secret-review-token/);
    const [publicRow] = await f.store.activity(); assert.equal(Object.hasOwn(publicRow!, "execution_error"), false);
  } finally { await f.cleanup(); }
});

test("diagnostics are re-sanitized on read without invalidating otherwise valid stored work", async () => {
  const f = await fixture();
  try {
    const parsed = parseStoredWakeAcceptance({ ...f.record, execution_error: "provider failed Bearer secret-review-token" });
    assert.match(parsed.execution_error!, /provider failed/); assert.doesNotMatch(parsed.execution_error!, /secret-review-token/);
    assert.throws(() => parseStoredWakeAcceptance({ ...f.record, execution_error: "x".repeat(2049) }), /execution error/);
  } finally { await f.cleanup(); }
});

test("running and shutdown transitions preserve an unresolved execution diagnostic", async () => {
  const f = await fixture();
  try {
    await f.store.transitionClaimed(f.record.acceptance_id, f.claim, "accepted", undefined, undefined, { deferred: true, execution_error: "engine_failed: unavailable" });
    await f.store.transitionClaimed(f.record.acceptance_id, f.claim, "running", undefined, undefined, { deferred: false });
    await f.store.transitionClaimed(f.record.acceptance_id, f.claim, "accepted");
    await f.restart();
    assert.equal((await f.store.recoverable(new Set(["alpha"])))[0]!.execution_error, "engine_failed: unavailable");
  } finally { await f.cleanup(); }
});

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ORGANIZATION_RUNTIME_VERSION, type OrganizationRuntimeHost, type OrganizationRuntimeWakeRequest } from "./organizationRuntime.js";
import { createOrganizationRuntimeControlHostWithCoreForTest } from "./organizationRuntimeControl.js";
import { WakeFuse } from "./wakeFuse.js";
import { WakeAcceptanceStore, WakeTransitionLockBlockedError } from "./wakeAcceptanceStore.js";
import { MAX_WAKE_COMPLETION_TEXT_BYTES, parseWakeAcceptanceRequest, wakeAcceptanceDigest } from "./wakeAcceptanceTypes.js";
import { TERMINAL_RECEIPT_IDEMPOTENCY_HORIZON } from "./wakeAcceptanceRetention.js";

const token = "control-secret";
const config = {
  version: ORGANIZATION_RUNTIME_VERSION,
  host: { bindHost: "0.0.0.0", port: 4318, controlTokenEnv: "DAIMON_CONTROL_TEST_TOKEN" },
  agents: [{ id: "alpha", name: "Alpha", instructions: "Act.", workspacePath: "/runtime/workspace", runtimeHomePath: "/runtime/home", engine: { kind: "codex" as const } }]
};
const request = (delivery = "delivery-1", text = "hello") => ({ token, agent_id: "alpha", delivery_id: delivery, event: { version: "noopolis.daimon.wake.v2", kind: "manual" as const, text, occurred_at: "2026-08-17T00:00:00.000Z" } });
const testStoreOptions = { processIdentity: async () => ({ pid: 1, process_start: "test-start", boot_id: "test-boot", pid_namespace_dev: 1, pid_namespace_ino: 1 }), ownerLiveness: async () => true };

test("acceptance store is durable, idempotent, bounded, and recovers accepted work", async () => {
  const root = await privateRoot();
  try {
    const first = await WakeAcceptanceStore.open(root, testStoreOptions);
    const accepted = await first.accept(parseWakeAcceptanceRequest(request()));
    const duplicate = await first.accept(parseWakeAcceptanceRequest(request()));
    assert.equal(accepted.created, true);
    assert.equal(duplicate.created, false);
    assert.equal(accepted.record.acceptance_id, duplicate.record.acceptance_id);
    await assert.rejects(first.accept(parseWakeAcceptanceRequest(request("delivery-1", "different"))), /different request/);
    await first.close();

    const recovered = await WakeAcceptanceStore.open(root, testStoreOptions);
    const pending = await recovered.recoverable(new Set(["alpha"]));
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.delivery_id, "delivery-1");
    const status = await recovered.status(accepted.record.acceptance_id);
    assert.deepEqual(Object.keys(status ?? {}).sort(), ["acceptance_id", "accepted_at", "agent_id", "delivery_id", "request_digest", "state", "updated_at", "version"]);
    await recovered.close();
    const core = new FakeCoreHost();
    const restarted = createOrganizationRuntimeControlHostWithCoreForTest(config, core, { acceptanceStorePath: root, controlToken: token, storeOptions: testStoreOptions });
    await restarted.start();
    await core.waitForWakes(1);
    core.release();
    await waitFor(async () => (await restarted.wakeReceipt(token, accepted.record.acceptance_id))?.state === "completed");
    assert.equal((await restarted.wakeReceipt(token, accepted.record.acceptance_id))?.text, "private");
    await restarted.stop();
    const persisted = await WakeAcceptanceStore.open(root, testStoreOptions);
    assert.equal((await persisted.status(accepted.record.acceptance_id))?.text, "private");
    await persisted.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("control accepts before a fake turn finishes, redacts status, and rejects conflicts", async () => {
  const root = await privateRoot();
  const core = new FakeCoreHost();
  const control = createOrganizationRuntimeControlHostWithCoreForTest(config, core, { acceptanceStorePath: root, controlToken: token, storeOptions: testStoreOptions });
  try {
    await control.start();
    const accepted = await control.accept(request());
    assert.equal(accepted.state, "accepted");
    if (accepted.state !== "accepted") throw new Error("expected acceptance");
    await waitFor(() => core.wakes.length === 1);
    const running = await control.wakeReceipt(token, accepted.acceptance_id);
    assert.equal(running?.state, "running");
    assert.equal("text" in (running ?? {}), false);
    assert.equal((await control.accept(request("delivery-1", "different"))).state, "rejected");
    core.release();
    await waitFor(async () => (await control.wakeReceipt(token, accepted.acceptance_id))?.state === "completed");
    assert.equal((await control.wakeReceipt(token, accepted.acceptance_id))?.text, "private");
    assert.equal(await control.wakeReceipt("wrong", accepted.acceptance_id), undefined);
    await control.stop();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a fuse trip terminalizes queued deliveries, refuses arrivals, and awaits running work", async () => {
  const root = await privateRoot();
  const usage = await mkdtemp(path.join(os.tmpdir(), "daimon-fuse-usage-"));
  const core = new FakeCoreHost();
  const control = createOrganizationRuntimeControlHostWithCoreForTest(config, core, {
    acceptanceStorePath: root, controlToken: token, storeOptions: testStoreOptions,
    fuseEnvironment: fuseEnvironment(usage, 2)
  });
  try {
    await control.start();
    await control.accept(request("running"));
    await core.waitForWakes(1);
    await control.accept(request("queued"));
    let settled = false;
    const trip = control.accept(request("trip")).then((value) => { settled = true; return value; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const items = (await control.activityV2(token))?.items ?? [];
    assert.equal(items.filter((item) => item.state === "accepted").length, 0, "a trip must leave zero records in state accepted");
    assert.equal(items.find((item) => item.delivery_id === "queued")?.state, "stopped");
    assert.equal(items.find((item) => item.delivery_id === "queued")?.code, "host_stopping");
    assert.equal(items.find((item) => item.delivery_id === "running")?.state, "running");
    assert.equal(settled, false, "the trip waits for a running turn");
    core.release();
    assert.deepEqual(await trip, { version: "noopolis.daimon.wake-acceptance.v2", state: "stopped", code: "host_stopping" });
    assert.deepEqual(await control.accept(request("later")), { version: "noopolis.daimon.wake-acceptance.v2", state: "stopped", code: "host_stopping" });
    const wakeCount = core.wakes.length;
    assert.deepEqual(await control.wake({ token, agentId: "alpha", event: { version: "noopolis.daimon.wake.v1", id: "direct-after-trip", kind: "manual", text: "blocked", occurredAt: "2026-08-17T00:00:00.000Z" } }), {
      version: "noopolis.daimon.wake-result.v1", status: "stopped", agentId: "alpha", wakeId: "direct-after-trip", code: "host_stopping"
    });
    assert.equal(core.wakes.length, wakeCount);
    await control.stop();
  } finally { core.release(); await control.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); await rm(usage, { recursive: true, force: true }); }
});

test("a persistence that lands after the trip snapshot is terminalized", async () => {
  const root = await privateRoot();
  const usage = await mkdtemp(path.join(os.tmpdir(), "daimon-fuse-usage-"));
  let reachedTransition!: () => void;
  const transitionReached = new Promise<void>((resolve) => { reachedTransition = resolve; });
  let releaseTransition!: () => void;
  const transitionRelease = new Promise<void>((resolve) => { releaseTransition = resolve; });
  let blockOnce = true;
  const core = new FakeCoreHost();
  const control = createOrganizationRuntimeControlHostWithCoreForTest(config, core, {
    acceptanceStorePath: root, controlToken: token,
    storeOptions: { ...testStoreOptions, afterFinalLockAssertion: async () => {
      if (!blockOnce) return;
      blockOnce = false;
      reachedTransition();
      await transitionRelease;
    } },
    fuseEnvironment: fuseEnvironment(usage, 2)
  });
  try {
    await control.start();
    const first = await control.accept(request("claim-blocked"));
    assert.equal(first.state, "accepted");
    await transitionReached;
    const latePersistence = control.accept(request("persist-after-snapshot"));
    const trip = control.accept(request("trip-after-snapshot"));
    releaseTransition();
    assert.equal((await latePersistence).state, "accepted");
    core.release();
    assert.deepEqual(await trip, { version: "noopolis.daimon.wake-acceptance.v2", state: "stopped", code: "host_stopping" });
    const items = (await control.activityV2(token))?.items ?? [];
    assert.equal(items.filter((item) => item.state === "accepted").length, 0);
    assert.equal(items.find((item) => item.delivery_id === "persist-after-snapshot")?.state, "stopped");
    await control.stop();
  } finally { releaseTransition(); core.release(); await control.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); await rm(usage, { recursive: true, force: true }); }
});

test("invalid authorities consume no admission and duplicate delivery is fuse-idempotent", async () => {
  const root = await privateRoot();
  const usage = await mkdtemp(path.join(os.tmpdir(), "daimon-fuse-usage-"));
  const core = new FakeCoreHost();
  const control = createOrganizationRuntimeControlHostWithCoreForTest(config, core, {
    acceptanceStorePath: root, controlToken: token, storeOptions: testStoreOptions,
    fuseEnvironment: fuseEnvironment(usage, 1)
  });
  try {
    await control.start();
    assert.deepEqual(await control.accept({ nope: true }), { version: "noopolis.daimon.wake-acceptance.v2", state: "rejected", code: "invalid_request" });
    assert.deepEqual(await control.accept({ ...request("unauthorized"), token: "wrong" }), { version: "noopolis.daimon.wake-acceptance.v2", state: "rejected", code: "unauthorized" });
    assert.deepEqual(await control.accept({ ...request("unknown"), agent_id: "missing" }), { version: "noopolis.daimon.wake-acceptance.v2", state: "rejected", code: "unknown_agent" });
    const first = await control.accept(request("paid-once"));
    assert.equal(first.state, "accepted");
    await waitFor(() => core.wakes.length === 1);
    core.release();
    if (first.state === "accepted") await waitFor(async () => (await control.wakeReceipt(token, first.acceptance_id))?.state === "completed");
    assert.equal((await control.accept(request("paid-once"))).state, "accepted");
    const tripped = control.accept(request("second-unique"));
    assert.deepEqual(await tripped, { version: "noopolis.daimon.wake-acceptance.v2", state: "stopped", code: "host_stopping" });
    await control.stop();
  } finally { await rm(root, { recursive: true, force: true }); await rm(usage, { recursive: true, force: true }); }
});

test("startup into an operator-tripped fuse terminalizes recovery without dispatch", async () => {
  const root = await privateRoot();
  const usage = await mkdtemp(path.join(os.tmpdir(), "daimon-fuse-usage-"));
  try {
    const setup = await WakeAcceptanceStore.open(root, testStoreOptions);
    const parked = await setup.accept(parseWakeAcceptanceRequest(request("parked")));
    await setup.close();
    await writeFile(path.join(usage, "fuse.stop"), "");
    const core = new FakeCoreHost();
    const control = createOrganizationRuntimeControlHostWithCoreForTest(config, core, {
      acceptanceStorePath: root, controlToken: token, storeOptions: testStoreOptions,
      fuseEnvironment: fuseEnvironment(usage, 10)
    });
    await control.start();
    assert.equal(core.wakes.length, 0);
    assert.equal((await control.wakeReceipt(token, parked.record.acceptance_id))?.state, "stopped");
    await control.stop();
  } finally { await rm(root, { recursive: true, force: true }); await rm(usage, { recursive: true, force: true }); }
});

test("startup into a ceiling-tripped fuse terminalizes accepted recovery without dispatch", async () => {
  const root = await privateRoot();
  const usage = await mkdtemp(path.join(os.tmpdir(), "daimon-fuse-usage-"));
  try {
    const setup = await WakeAcceptanceStore.open(root, testStoreOptions);
    const parked = await setup.accept(parseWakeAcceptanceRequest(request("ceiling-parked")));
    await setup.close();
    const fuse = await WakeFuse.open({ organizationKey: "alpha", environment: fuseEnvironment(usage, 1) });
    await fuse.admit("alpha", "paid");
    assert.deepEqual(await fuse.admit("alpha", "trip"), { state: "tripped", reason: "wake_ceiling" });
    await fuse.close();
    const core = new FakeCoreHost();
    const control = createOrganizationRuntimeControlHostWithCoreForTest(config, core, {
      acceptanceStorePath: root, controlToken: token, storeOptions: testStoreOptions,
      fuseEnvironment: fuseEnvironment(usage, 1)
    });
    await control.start();
    const items = (await control.activityV2(token))?.items ?? [];
    assert.equal(core.wakes.length, 0);
    assert.equal(items.filter((item) => item.state === "accepted").length, 0);
    assert.equal((await control.wakeReceipt(token, parked.record.acceptance_id))?.state, "stopped");
    await control.stop();
  } finally { await rm(root, { recursive: true, force: true }); await rm(usage, { recursive: true, force: true }); }
});

test("startup fails before the core host when the fuse cannot open", async () => {
  const root = await privateRoot();
  let starts = 0;
  const core = new FakeCoreHost(); core.start = async () => { starts += 1; };
  const control = createOrganizationRuntimeControlHostWithCoreForTest(config, core, {
    acceptanceStorePath: root, controlToken: token, storeOptions: testStoreOptions,
    fuseEnvironment: fuseEnvironment(path.join(root, "missing"), 10)
  });
  try {
    await assert.rejects(control.start(), /ENOENT/);
    assert.equal(starts, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a rejecting polled trip does not become an unhandled rejection", async () => {
  const root = await privateRoot();
  const usage = await mkdtemp(path.join(os.tmpdir(), "daimon-fuse-usage-"));
  const unhandled: unknown[] = [];
  const listener = (reason: unknown): void => { unhandled.push(reason); };
  process.on("unhandledRejection", listener);
  let tripAttempted!: () => void;
  const attempted = new Promise<void>((resolve) => { tripAttempted = resolve; });
  const core = new FakeCoreHost();
  const control = createOrganizationRuntimeControlHostWithCoreForTest(config, core, {
    acceptanceStorePath: root, controlToken: token, storeOptions: testStoreOptions,
    fuseEnvironment: fuseEnvironment(usage, 10), fusePollIntervalMsForTest: 1,
    beforeTripTerminalizationForTest: async () => { tripAttempted(); throw new Error("injected terminalization failure"); }
  });
  try {
    await control.start();
    await writeFile(path.join(usage, "fuse.stop"), "");
    await Promise.race([attempted, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("trip poll timed out")), 1_000))]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
    assert.deepEqual(await control.accept(request("after-partial-trip")), { version: "noopolis.daimon.wake-acceptance.v2", state: "stopped", code: "host_stopping" });
  } finally {
    process.off("unhandledRejection", listener);
    await control.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    await rm(usage, { recursive: true, force: true });
  }
});

test("schedule acceptance preserves its WakeEvent kind through the durable FIFO", async () => {
  const root = await privateRoot();
  const core = new FakeCoreHost();
  const control = createOrganizationRuntimeControlHostWithCoreForTest(config, core, { acceptanceStorePath: root, controlToken: token, storeOptions: testStoreOptions });
  try {
    await control.start();
    await control.accept({ ...request("scheduled"), event: { ...request().event, kind: "schedule" as const } });
    await waitFor(() => core.wakes.length === 1);
    assert.equal(core.wakes[0]?.event.kind, "schedule");
    core.release();
    await control.stop();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("completed replies are bounded and credential-redacted while failures carry no text", async () => {
  const root = await privateRoot();
  try {
    const store = await WakeAcceptanceStore.open(root, testStoreOptions);
    const completed = await store.accept(parseWakeAcceptanceRequest(request("bounded-reply")));
    const completedClaim = await store.acquireClaim(completed.record.acceptance_id, "88888888-8888-4888-8888-888888888888");
    if (completedClaim.state !== "acquired") throw new Error("claim missing");
    await store.transitionClaimed(completed.record.acceptance_id, completedClaim.claim, "running");
    const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz123456";
    await store.transitionClaimed(completed.record.acceptance_id, completedClaim.claim, "completed", undefined, `reply ${secret} ${"é".repeat(MAX_WAKE_COMPLETION_TEXT_BYTES)}`);
    const receipt = await store.status(completed.record.acceptance_id);
    assert.equal(receipt?.state, "completed");
    assert.equal(receipt?.text?.includes(secret), false);
    assert.ok(Buffer.byteLength(receipt?.text ?? "", "utf8") <= MAX_WAKE_COMPLETION_TEXT_BYTES);

    const failed = await store.accept(parseWakeAcceptanceRequest(request("failed-reply")));
    const failedClaim = await store.acquireClaim(failed.record.acceptance_id, "99999999-9999-4999-8999-999999999999");
    if (failedClaim.state !== "acquired") throw new Error("claim missing");
    await store.transitionClaimed(failed.record.acceptance_id, failedClaim.claim, "running");
    await store.transitionClaimed(failed.record.acceptance_id, failedClaim.claim, "failed", "engine_failed");
    assert.equal("text" in (await store.status(failed.record.acceptance_id) ?? {}), false);
    await assert.rejects(
      store.transitionClaimed(failed.record.acceptance_id, failedClaim.claim, "failed", "engine_failed", "must not persist"),
      /completion text requires completed state/
    );
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("durable inbox stays FIFO, exposes v2 active and queued work, and heartbeats", async () => {
  const root = await privateRoot();
  const core = new FakeCoreHost();
  const control = createOrganizationRuntimeControlHostWithCoreForTest(config, core, {
    acceptanceStorePath: root, controlToken: token, storeOptions: { ...testStoreOptions, claimTtlMs: 30_000 }
  });
  try {
    await control.start();
    const first = await control.accept(request("fifo-1"));
    const second = await control.accept(request("fifo-2"));
    assert.equal(first.state, "accepted"); assert.equal(second.state, "accepted");
    await waitFor(() => core.wakes.length === 1);
    const before = await control.activityV2(token);
    assert.equal(before?.items.find((item) => item.delivery_id === "fifo-1")?.active, true);
    assert.equal(before?.items.find((item) => item.delivery_id === "fifo-2")?.queue_position, 1);
    const updated = before?.items.find((item) => item.delivery_id === "fifo-1")?.updated_at;
    await waitFor(async () => (await control.activityV2(token))?.items.find((item) => item.delivery_id === "fifo-1")?.updated_at !== updated, 20_000);
    assert.equal(core.wakes.length, 1);
    core.release();
    await core.waitForWakes(2);
    assert.equal(core.wakes[1]?.event.id, "fifo-2");
    core.release();
    await control.stop();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("two control hosts cannot execute one accepted delivery concurrently", async () => {
  const root = await privateRoot();
  const firstCore = new FakeCoreHost();
  const secondCore = new FakeCoreHost();
  const first = createOrganizationRuntimeControlHostWithCoreForTest(config, firstCore, { acceptanceStorePath: root, controlToken: token, storeOptions: testStoreOptions });
  const second = createOrganizationRuntimeControlHostWithCoreForTest(config, secondCore, { acceptanceStorePath: root, controlToken: token, storeOptions: testStoreOptions });
  try {
    await Promise.all([first.start(), second.start()]);
    const accepted = await first.accept(request("shared"));
    assert.equal(accepted.state, "accepted");
    await second.accept(request("shared"));
    await waitFor(() => firstCore.wakes.length + secondCore.wakes.length === 1);
    assert.equal(firstCore.wakes.length + secondCore.wakes.length, 1);
    firstCore.release();
    secondCore.release();
    await first.stop();
    await second.stop();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a held per-agent head blocks later delivery on a replacement host", async () => {
  const root = await privateRoot();
  const firstCore = new FakeCoreHost(); const replacementCore = new FakeCoreHost();
  const leaseOptions = { ...testStoreOptions, claimTtlMs: 1_000 };
  const first = createOrganizationRuntimeControlHostWithCoreForTest(config, firstCore, { acceptanceStorePath: root, controlToken: token, storeOptions: leaseOptions });
  const replacement = createOrganizationRuntimeControlHostWithCoreForTest(config, replacementCore, { acceptanceStorePath: root, controlToken: token, storeOptions: leaseOptions });
  try {
    await Promise.all([first.start(), replacement.start()]);
    await first.accept(request("head"));
    await firstCore.waitForWakes(1);
    await replacement.accept(request("head"));
    await replacement.accept(request("later"));
    await firstCore.waitForWakes(1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(replacementCore.wakes.length, 0);
    firstCore.release();
    await replacementCore.waitForWakes(1);
    assert.equal(replacementCore.wakes[0]?.event.id, "later");
    replacementCore.release();
    await Promise.all([first.stop(), replacement.stop()]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("held head automatically retries at claim expiry with its stable wake id", async () => {
  const root = await privateRoot();
  try {
    const setup = await WakeAcceptanceStore.open(root, { ...testStoreOptions, claimTtlMs: 250 });
    const head = await setup.accept(parseWakeAcceptanceRequest(request("post-engine-pre-receipt")));
    await setup.accept(parseWakeAcceptanceRequest(request("blocked-later")));
    const claim = await setup.acquireClaim(head.record.acceptance_id, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    if (claim.state !== "acquired") throw new Error("claim missing");
    await setup.transitionClaimed(head.record.acceptance_id, claim.claim, "running");
    await setup.close();
    const core = new FakeCoreHost();
    const replacement = createOrganizationRuntimeControlHostWithCoreForTest(config, core, { acceptanceStorePath: root, controlToken: token, storeOptions: { ...testStoreOptions, claimTtlMs: 250 } });
    await replacement.start();
    await waitFor(() => core.wakes.length === 1);
    assert.equal(core.wakes[0]?.event.id, "post-engine-pre-receipt");
    core.release();
    await waitFor(() => core.wakes.length === 2);
    assert.equal(core.wakes[1]?.event.id, "blocked-later");
    core.release(); await replacement.stop();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("terminal compaction keeps the declared 2048-receipt delivery-idempotency horizon", async () => {
  const root = await privateRoot();
  try {
    let firstId = "";
    await Promise.all(Array.from({ length: 2_112 }, async (_, index) => {
      const parsed = parseWakeAcceptanceRequest(request(`terminal-${index}`));
      const acceptanceId = randomUUID(); if (index === 0) firstId = acceptanceId;
      const timestamp = new Date(index).toISOString();
      const record = { acceptance_id: acceptanceId, agent_id: parsed.agent_id, delivery_id: parsed.delivery_id, request_digest: wakeAcceptanceDigest(parsed), event: parsed.event, state: "completed", accepted_at: timestamp, updated_at: timestamp };
      const file = `${createHash("sha256").update(`${parsed.agent_id}\u0000${parsed.delivery_id}`).digest("hex")}.json`;
      await writeFile(path.join(root, file), JSON.stringify(record), { mode: 0o600 });
    }));
    const store = await WakeAcceptanceStore.open(root, testStoreOptions);
    const latest = await store.accept(parseWakeAcceptanceRequest(request("terminal-2112")));
    assert.equal(await store.status(firstId), undefined);
    assert.equal((await store.status(latest.record.acceptance_id))?.state, "accepted");
    assert.ok((await store.activity()).length >= TERMINAL_RECEIPT_IDEMPOTENCY_HORIZON);
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("stale running claims recover with a new fence and reject an old terminal write", async () => {
  const root = await privateRoot();
  try {
    const store = await WakeAcceptanceStore.open(root, { ...testStoreOptions, claimTtlMs: 500 });
    const accepted = await store.accept(parseWakeAcceptanceRequest(request("crash-window")));
    const first = await store.acquireClaim(accepted.record.acceptance_id, "11111111-1111-4111-8111-111111111111");
    assert.equal(first.state, "acquired");
    if (first.state !== "acquired") throw new Error("claim missing");
    await store.transitionClaimed(accepted.record.acceptance_id, first.claim, "running");
    await new Promise((resolve) => setTimeout(resolve, 600));
    const second = await store.acquireClaim(accepted.record.acceptance_id, "22222222-2222-4222-8222-222222222222");
    assert.equal(second.state, "acquired");
    await assert.rejects(store.transitionClaimed(accepted.record.acceptance_id, first.claim, "completed"), /claim was lost/);
    if (second.state === "acquired") {
      await store.transitionClaimed(accepted.record.acceptance_id, second.claim, "running");
      await store.transitionClaimed(accepted.record.acceptance_id, second.claim, "failed", "engine_failed");
    }
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("active work renews its durable claim beyond the original lease", async () => {
  const root = await privateRoot();
  try {
    const store = await WakeAcceptanceStore.open(root, { ...testStoreOptions, claimTtlMs: 5_000 });
    const accepted = await store.accept(parseWakeAcceptanceRequest(request("long-running")));
    const claimed = await store.acquireClaim(accepted.record.acceptance_id, "66666666-6666-4666-8666-666666666666");
    if (claimed.state !== "acquired") throw new Error("claim missing");
    await store.transitionClaimed(accepted.record.acceptance_id, claimed.claim, "running");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const renewed = await store.renewClaim(accepted.record.acceptance_id, claimed.claim);
    await new Promise((resolve) => setTimeout(resolve, 950));
    assert.equal((await store.acquireClaim(accepted.record.acceptance_id, "77777777-7777-4777-8777-777777777777")).state, "held");
    await store.transitionClaimed(accepted.record.acceptance_id, renewed, "completed");
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a takeover between claim check and replacement fences the old writer", async () => {
  const root = await privateRoot();
  try {
    let now = 0;
    const clock = { ...testStoreOptions, claimTtlMs: 200, nowForTest: () => now };
    const setup = await WakeAcceptanceStore.open(root, clock);
    const accepted = await setup.accept(parseWakeAcceptanceRequest(request("interleaving")));
    const first = await setup.acquireClaim(accepted.record.acceptance_id, "33333333-3333-4333-8333-333333333333");
    if (first.state !== "acquired") throw new Error("initial claim missing");
    await setup.transitionClaimed(accepted.record.acceptance_id, first.claim, "running");
    await setup.close();

    let checked!: () => void;
    let resume!: () => void;
    const reached = new Promise<void>((resolve) => { checked = resolve; });
    const paused = new Promise<void>((resolve) => { resume = resolve; });
    let firstOwnerLive = true;
    const ownerLiveness = async (lock: { readonly owner_id: string }): Promise<boolean> => lock.owner_id === first.claim.owner_id && firstOwnerLive;
    const old = await WakeAcceptanceStore.open(root, { ...clock, afterFinalLockAssertion: async () => { checked(); await paused; }, ownerLiveness });
    const replacement = await WakeAcceptanceStore.open(root, { ...clock, ownerLiveness });
    const oldTerminal = old.transitionClaimed(accepted.record.acceptance_id, first.claim, "completed");
    await reached;
    now = 250;
    assert.equal((await replacement.acquireClaim(accepted.record.acceptance_id, "44444444-4444-4444-8444-444444444444")).state, "held");
    firstOwnerLive = false;
    const second = await replacement.acquireClaim(accepted.record.acceptance_id, "44444444-4444-4444-8444-444444444444");
    if (second.state !== "acquired") throw new Error("takeover claim missing");
    await replacement.transitionClaimed(accepted.record.acceptance_id, second.claim, "running");
    resume();
    await assert.rejects(oldTerminal, /claim was lost/);
    await replacement.transitionClaimed(accepted.record.acceptance_id, second.claim, "failed", "engine_failed");
    await old.close();
    await replacement.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a mismatched PID namespace blocks transition-lock reclamation", async () => {
  const root = await privateRoot();
  try {
    const setup = await WakeAcceptanceStore.open(root, testStoreOptions);
    const accepted = await setup.accept(parseWakeAcceptanceRequest(request("namespace-lock")));
    const first = await setup.acquireClaim(accepted.record.acceptance_id, "55555555-5555-4555-8555-555555555555");
    if (first.state !== "acquired") throw new Error("initial claim missing");
    await setup.transitionClaimed(accepted.record.acceptance_id, first.claim, "running");
    await setup.close();

    let continueCommit!: () => void;
    const held = new Promise<void>((resolve) => { continueCommit = resolve; });
    let locked!: () => void;
    const reached = new Promise<void>((resolve) => { locked = resolve; });
    const owner = await WakeAcceptanceStore.open(root, { ...testStoreOptions, afterFinalLockAssertion: async () => { locked(); await held; } });
    const replacement = await WakeAcceptanceStore.open(root, {
      processIdentity: async () => ({ pid: 2, process_start: "replacement-start", boot_id: "test-boot", pid_namespace_dev: 2, pid_namespace_ino: 2 }),
      ownerLiveness: async () => false
    });
    const completing = owner.transitionClaimed(accepted.record.acceptance_id, first.claim, "completed");
    await reached;
    await assert.rejects(replacement.transitionClaimed(accepted.record.acceptance_id, first.claim, "completed"), (error: unknown) => error instanceof WakeTransitionLockBlockedError && error.code === "offline_reconciliation_required");
    continueCommit();
    await completing;
    await owner.close();
    await replacement.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("strict v2 parser rejects hidden fields, loose time, and oversized text", () => {
  assert.throws(() => parseWakeAcceptanceRequest({ ...request(), extra: true }), /exactly/);
  assert.throws(() => parseWakeAcceptanceRequest({ ...request(), event: { ...request().event, occurred_at: "2026-08-17T00:00:00Z" } }), /RFC3339/);
  assert.throws(() => parseWakeAcceptanceRequest(request("large", "x".repeat(16_385))), /bounded string/);
});

test("production transition locking fails closed outside Linux", async (context) => {
  if (process.platform === "linux") return context.skip("Linux has the required process identity authority");
  const root = await privateRoot();
  try { await assert.rejects(WakeAcceptanceStore.open(root), /require Linux process identity/); } finally { await rm(root, { recursive: true, force: true }); }
});

class FakeCoreHost implements Pick<OrganizationRuntimeHost, "start" | "wake" | "health" | "stop"> {
  readonly wakes: OrganizationRuntimeWakeRequest[] = [];
  private releaseTurn: (() => void) | undefined;
  private readonly wakeWaiters: Array<{ count: number; resolve: () => void }> = [];
  async start(): Promise<void> {}
  async wake(request_: OrganizationRuntimeWakeRequest) {
    this.wakes.push(request_);
    for (const waiter of this.wakeWaiters.splice(0)) {
      if (this.wakes.length >= waiter.count) waiter.resolve();
      else this.wakeWaiters.push(waiter);
    }
    await new Promise<void>((resolve) => { this.releaseTurn = resolve; });
    return { version: "noopolis.daimon.wake-result.v1", status: "completed", agentId: request_.agentId, wakeId: request_.event.id, text: "private", durationMs: 1 } as const;
  }
  async health(_agentId?: string) { return { version: "noopolis.daimon.organization-runtime-health.v1" as const, state: "running" as const, agents: [{ agentId: "alpha", engine: "codex" as const, state: "idle" as const }] }; }
  async activity() { return { version: "noopolis.daimon.organization-runtime-activity.v1" as const, items: [] }; }
  async stop() { this.release(); return { version: "noopolis.daimon.organization-runtime-stop.v1" as const, state: "stopped" as const }; }
  async waitForWakes(count: number): Promise<void> { if (this.wakes.length >= count) return; await new Promise<void>((resolve) => this.wakeWaiters.push({ count, resolve })); }
  release(): void { this.releaseTurn?.(); }
}

async function privateRoot(): Promise<string> { const root = await mkdtemp(path.join(os.tmpdir(), "daimon-acceptance-")); await chmod(root, 0o700); return root; }
function fuseEnvironment(directory: string, maxWakes: number): NodeJS.ProcessEnv {
  return { DAIMON_WAKE_FUSE_DIRECTORY: directory, DAIMON_TURN_USAGE_LEDGER_PATH: path.join(directory, "usage.jsonl"), DAIMON_WAKE_FUSE_EPOCH: "integration", DAIMON_WAKE_FUSE_MAX_WAKES: String(maxWakes), DAIMON_WAKE_FUSE_MAX_TOKENS: "1000000" };
}
async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  throw new Error("timed out");
}

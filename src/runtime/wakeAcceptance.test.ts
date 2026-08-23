import assert from "node:assert/strict";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ORGANIZATION_RUNTIME_VERSION, type OrganizationRuntimeHost, type OrganizationRuntimeWakeRequest } from "./organizationRuntime.js";
import { createOrganizationRuntimeControlHostWithCoreForTest } from "./organizationRuntimeControl.js";
import { WakeAcceptanceStore, WakeTransitionLockBlockedError } from "./wakeAcceptanceStore.js";
import { parseWakeAcceptanceRequest } from "./wakeAcceptanceTypes.js";

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
    await waitFor(() => core.wakes.length === 1);
    core.release();
    await waitFor(async () => (await restarted.wakeReceipt(token, accepted.record.acceptance_id))?.state === "completed");
    await restarted.stop();
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
    assert.equal(await control.wakeReceipt("wrong", accepted.acceptance_id), undefined);
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

test("a takeover between claim check and replacement fences the old writer", async () => {
  const root = await privateRoot();
  try {
    const setup = await WakeAcceptanceStore.open(root, { ...testStoreOptions, claimTtlMs: 200 });
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
    const old = await WakeAcceptanceStore.open(root, { ...testStoreOptions, claimTtlMs: 200, afterFinalLockAssertion: async () => { checked(); await paused; }, ownerLiveness });
    const replacement = await WakeAcceptanceStore.open(root, { ...testStoreOptions, claimTtlMs: 200, ownerLiveness });
    const oldTerminal = old.transitionClaimed(accepted.record.acceptance_id, first.claim, "completed");
    await reached;
    await new Promise((resolve) => setTimeout(resolve, 250));
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
  async start(): Promise<void> {}
  async wake(request_: OrganizationRuntimeWakeRequest) {
    this.wakes.push(request_);
    await new Promise<void>((resolve) => { this.releaseTurn = resolve; });
    return { version: "noopolis.daimon.wake-result.v1", status: "completed", agentId: request_.agentId, wakeId: request_.event.id, text: "private", durationMs: 1 } as const;
  }
  async health(_agentId?: string) { return { version: "noopolis.daimon.organization-runtime-health.v1" as const, state: "running" as const, agents: [{ agentId: "alpha", state: "idle" as const }] }; }
  async activity() { return { version: "noopolis.daimon.organization-runtime-activity.v1" as const, items: [] }; }
  async stop() { this.release(); return { version: "noopolis.daimon.organization-runtime-stop.v1" as const, state: "stopped" as const }; }
  release(): void { this.releaseTurn?.(); }
}

async function privateRoot(): Promise<string> { const root = await mkdtemp(path.join(os.tmpdir(), "daimon-acceptance-")); await chmod(root, 0o700); return root; }
async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  do {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  throw new Error("timed out");
}

import assert from "node:assert/strict";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ORGANIZATION_RUNTIME_VERSION, type OrganizationRuntimeHost, type OrganizationRuntimeWakeRequest } from "./organizationRuntime.js";
import { createOrganizationRuntimeControlHostWithCoreForTest } from "./organizationRuntimeControl.js";
import { ACTIVITY_V2_VERSION } from "./wakeAcceptanceTypes.js";

const token = "control-secret";
const config = {
  version: ORGANIZATION_RUNTIME_VERSION,
  host: { bindHost: "127.0.0.1", port: 4318, controlTokenEnv: "DAIMON_CONTROL_CLOSURE_TOKEN" },
  agents: [{ id: "alpha", name: "Alpha", instructions: "Act.", workspacePath: "/runtime/workspace", runtimeHomePath: "/runtime/home", engine: { kind: "codex" as const } }]
};
const storeOptions = { processIdentity: async () => ({ pid: 1, process_start: "test-start", boot_id: "test-boot", pid_namespace_dev: 1, pid_namespace_ino: 1 }), ownerLiveness: async () => true };
const delivery = (deliveryId = "delivery-1") => ({ token, agent_id: "alpha", delivery_id: deliveryId, event: { version: "noopolis.daimon.wake.v2", kind: "manual" as const, text: "hello", occurred_at: "2026-09-18T00:00:00.000Z" } });

const core = {
  async start(): Promise<void> {},
  async wake(request: OrganizationRuntimeWakeRequest) { return { version: "noopolis.daimon.wake-result.v1", status: "completed", agentId: request.agentId, wakeId: request.event.id, text: "private", durationMs: 1 } as const; },
  async health() { return { version: "noopolis.daimon.organization-runtime-health.v1" as const, state: "running" as const, agents: [{ agentId: "alpha", engine: "codex" as const, state: "idle" as const }] }; },
  async activity() { return { version: "noopolis.daimon.organization-runtime-activity.v1" as const, items: [] }; },
  async stop() { return { version: "noopolis.daimon.organization-runtime-stop.v1" as const, state: "stopped" as const }; }
} as unknown as OrganizationRuntimeHost;

/**
 * A caller proving that a native execution closed has exactly one authority to
 * read — the v2 activity projection — and the runtime that owns it is stopped by
 * the time the proof is taken: the worker stops its own host as soon as a delivery
 * closes its execution and stays deferred. Before this, `activityV2` answered
 * `undefined` there (HTTP 503 `native_host_unavailable` through the caller's
 * worker route), so a trial whose subject really ran, spent its budget and simply
 * did not do the work reported as an unscorable infrastructure failure.
 */
test("a stopped control host still answers the closure query it alone can settle", async () => {
  const root = await privateRoot();
  const control = createOrganizationRuntimeControlHostWithCoreForTest(config, core, { acceptanceStorePath: root, controlToken: token, storeOptions });
  try {
    // Nothing has started: there is no projection to seal and none is invented.
    assert.equal(await control.activityV2(token), undefined);
    await control.start();
    const accepted = await control.accept(delivery());
    assert.equal(accepted.state, "accepted");
    const live = await control.activityV2(token);
    assert.equal(live?.state, "running");
    assert.equal(live?.items.length, 1);

    assert.equal((await control.stop()).state, "stopped");
    const sealed = await control.activityV2(token);
    assert.equal(sealed?.version, ACTIVITY_V2_VERSION);
    // The same projection, said to be final: nothing can be admitted after it, so
    // an empty execution list is a stronger quiescence statement than a live poll.
    assert.equal(sealed?.state, "stopped");
    assert.deepEqual(sealed?.executions, []);
    assert.equal(sealed?.items.length, 1);
    assert.equal(sealed?.items[0]?.delivery_id, "delivery-1");
    assert.equal(sealed?.items[0]?.active, false);
    // Repeating the query repeats the seal rather than draining it.
    assert.deepEqual(await control.activityV2(token), sealed);
    // The seal is not a bypass of authentication, and the store-backed routes that
    // have no post-stop answer still report absence instead of an empty runtime.
    assert.equal(await control.activityV2("wrong-token"), undefined);
    assert.equal(await control.availability(token), undefined);
    assert.equal(await control.wakeReceipt(token, accepted.state === "accepted" ? accepted.acceptance_id : ""), undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

/** A host that was never started cannot attest anything, and a second stop keeps the seal. */
test("an unstarted host seals nothing and a repeated stop does not erase the seal", async () => {
  const root = await privateRoot();
  const unstarted = createOrganizationRuntimeControlHostWithCoreForTest(config, core, { acceptanceStorePath: root, controlToken: token, storeOptions });
  try {
    assert.equal((await unstarted.stop()).state, "stopped");
    assert.equal(await unstarted.activityV2(token), undefined);

    const control = createOrganizationRuntimeControlHostWithCoreForTest(config, core, { acceptanceStorePath: root, controlToken: token, storeOptions });
    await control.start();
    await control.accept(delivery("delivery-2"));
    await control.stop();
    const sealed = await control.activityV2(token);
    assert.equal(sealed?.state, "stopped");
    await control.stop();
    assert.deepEqual(await control.activityV2(token), sealed);
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function privateRoot(): Promise<string> { const root = await mkdtemp(path.join(os.tmpdir(), "daimon-closure-")); await chmod(root, 0o700); return root; }

/**
 * A delivery returned to the inbox for restart must say which outcome returned it.
 *
 * `attentionDispatcher` reclaims an undisposed delivery to `accepted` on two
 * conditions — the dispatcher halting, and a wake that came back `stopped` — and it
 * recorded neither, so the receipt an evaluator reads was identical for both. A
 * live trial closed its execution, spent real money and reported an `accepted`
 * delivery with no marker and no reason, and four investigations went into telling
 * those two apart from the outside. The wake's own code is exact and is now kept;
 * a halt has no code of its own and stays absent, because a plausible name for an
 * undetermined cause gets acted on and a missing one does not.
 */
test("a delivery reclaimed for restart records the stopped wake's own code", async () => {
  const root = await privateRoot();
  const attention = { version: ORGANIZATION_RUNTIME_VERSION, host: config.host,
    agents: [{ ...config.agents[0]!, attention: { maxBatchMessages: 4, maxBatchBytes: 4096, maxExecutions: 8, maxTokens: 100_000 } }] };
  let stopWake = false;
  const stopping = {
    ...core,
    async wake(request: OrganizationRuntimeWakeRequest) {
      if (!stopWake) return { version: "noopolis.daimon.wake-result.v1", status: "completed", agentId: request.agentId, wakeId: request.event.id, text: "private", durationMs: 1 } as const;
      // Exactly what organizationRuntimeHost settles an in-flight wake with at shutdown.
      return { version: "noopolis.daimon.wake-result.v1", status: "stopped", agentId: request.agentId, wakeId: request.event.id, code: "active_wake_aborted" } as const;
    }
  } as unknown as OrganizationRuntimeHost;
  const control = createOrganizationRuntimeControlHostWithCoreForTest(attention, stopping, { acceptanceStorePath: root, controlToken: token, storeOptions });
  try {
    await control.start();
    stopWake = true;
    const accepted = await control.accept(delivery("restart-delivery"));
    assert.equal(accepted.state, "accepted");
    await waitFor(async () => (await control.activityV2(token))?.items.some((item) => item.state === "accepted" && item.code !== undefined) === true);
    const item = (await control.activityV2(token))?.items.find((row) => row.delivery_id === "restart-delivery");
    // Returned for restart, undisposed, and no longer silent about which outcome did it.
    assert.equal(item?.state, "accepted");
    // Exactly the live shape: the running transition left deferred FALSE and the
    // reclaim does not clear it, which is what distinguishes it from a real deferral.
    assert.equal(item?.deferred, false);
    assert.equal(item?.code, "active_wake_aborted");
  } finally { await control.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  do { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 10)); } while (Date.now() < deadline);
  throw new Error("timed out waiting for the reclaimed delivery");
}

/**
 * The other half, and the one the reclaim path kept getting wrong. A wake that
 * COMPLETED is a wake outcome; the dispatcher happening to be halting when it
 * lands is not. Keying the reclaim on the host's own `stopping` latch discarded
 * that outcome and wrote `accepted, deferred: false, execution retained, no code`
 * — a record byte-identical to "never ran" and to "ran but forgotten". Production
 * survived it because a restart re-delivers and the agent redoes the work; a
 * one-shot isolated trial has no restart, so the evidence was simply lost and a
 * subject that really ran and made a choice reported as infrastructure failure.
 * An agent that read a delivery and declined to dispose of it is DEFERRED,
 * whichever way the host is heading, and a restart must not re-deliver it as
 * fresh work.
 */
test("a completed wake under a halting dispatcher is deferred, not reclaimed for restart", async () => {
  const root = await privateRoot();
  const attention = { version: ORGANIZATION_RUNTIME_VERSION, host: config.host,
    agents: [{ ...config.agents[0]!, attention: { maxBatchMessages: 4, maxBatchBytes: 4096, maxExecutions: 8, maxTokens: 100_000 } }] };
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let arrived!: () => void;
  const waking = new Promise<void>((resolve) => { arrived = resolve; });
  const blocking = { ...core,
    async wake(request: OrganizationRuntimeWakeRequest) {
      arrived();
      await held;
      return { version: "noopolis.daimon.wake-result.v1", status: "completed", agentId: request.agentId, wakeId: request.event.id, text: "private", durationMs: 1 } as const;
    }
  } as unknown as OrganizationRuntimeHost;
  const control = createOrganizationRuntimeControlHostWithCoreForTest(attention, blocking, { acceptanceStorePath: root, controlToken: token, storeOptions });
  try {
    await control.start();
    await control.accept(delivery("halted-delivery"));
    await waking;
    // The halt lands while the wake is in flight; the wake then completes anyway.
    const stopping = control.stop();
    release();
    await stopping;
    const item = (await control.activityV2(token))?.items.find((row) => row.delivery_id === "halted-delivery");
    assert.equal(item?.state, "accepted");
    // The wake's own outcome decides the record: read, undisposed, deferred.
    assert.equal(item?.deferred, true);
    // A completed wake releases its execution, so a restart waits for new input
    // instead of replaying the delivery as work nobody has seen.
    assert.equal(item?.execution_id, undefined);
    // Still silent: a completed wake is no more a named reclaim outcome than a
    // halt is, and a plausible name for an undetermined cause gets acted on.
    assert.equal(item?.code, undefined);
  } finally { await control.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

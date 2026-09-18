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

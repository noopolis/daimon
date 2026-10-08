import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ORGANIZATION_RUNTIME_VERSION, type OrganizationRuntimeHost, type OrganizationRuntimeWakeRequest } from "./organizationRuntime.js";
import { createOrganizationRuntimeControlHostWithCoreForTest } from "./organizationRuntimeControl.js";
import { parseOrganizationRuntimeConfig } from "./organizationRuntime.js";
import { AttentionDispatcher } from "./attentionDispatcher.js";
import { WakeAcceptanceStore, type WakeExecutionClaim } from "./wakeAcceptanceStore.js";
import { WakeFuse } from "./wakeFuse.js";
import { parseWakeAcceptanceRequest, type WakeReceiptState } from "./wakeAcceptanceTypes.js";

const token = "control-secret";
const config = {
  version: ORGANIZATION_RUNTIME_VERSION,
  host: { bindHost: "0.0.0.0", port: 4318, controlTokenEnv: "DAIMON_CONTROL_TEST_TOKEN" },
  agents: [{ id: "alpha", name: "Alpha", instructions: "Act.", workspacePath: "/runtime/workspace", runtimeHomePath: "/runtime/home", engine: { kind: "codex" as const } }]
};
const request = (delivery: string) => ({ token, agent_id: "alpha", delivery_id: delivery, event: { version: "noopolis.daimon.wake.v2", kind: "manual" as const, text: "hello", occurred_at: "2026-08-17T00:00:00.000Z" } });
const storeOptions = { processIdentity: async () => ({ pid: 1, process_start: "test-start", boot_id: "test-boot", pid_namespace_dev: 1, pid_namespace_ino: 1 }), ownerLiveness: async () => true };

test("drain refuses new wakes as work-blocked, keeps the queue, lets the running turn finish, and resume dispatches it", async () => {
  const root = await privateRoot(); const usage = await fuseDirectory();
  const core = new HeldCoreHost();
  const control = createOrganizationRuntimeControlHostWithCoreForTest(config, core, { acceptanceStorePath: root, controlToken: token, storeOptions, fuseEnvironment: fuseEnvironment(usage) });
  try {
    await control.start();
    const running = await control.accept(request("running"));
    await core.waitForWakes(1);
    const queued = await control.accept(request("queued"));
    assert.equal(queued.state, "accepted");

    assert.equal(await control.drain("wrong-token"), undefined);
    const draining = await control.drain(token);
    assert.equal(draining?.state, "paused");
    assert.equal(draining?.drain?.state, "draining", "a running turn keeps the host draining");

    const refused = await control.accept(request("during-drain"));
    assert.equal(refused.state, "stopped");
    assert.deepEqual(refused.state === "stopped" ? refused.blocked : undefined, { version: "noopolis.daimon.work-blocked.v1", reason: "operator_stop", retry_after_ms: 30000 });

    core.release();
    await waitFor(async () => (await control.wakeReceipt(token, receiptId(running)))?.state === "completed");
    await waitFor(async () => (await control.availability(token))?.drain?.state === "drained");
    assert.equal(core.wakes.length, 1, "no new turn is admitted while drained");
    assert.equal((await control.wakeReceipt(token, receiptId(queued)))?.state, "accepted", "the queued wake survives the drain");
    assert.equal((await control.activityV2(token))?.items.some((item) => item.delivery_id === "during-drain"), false, "a refused wake never became durable");

    const resumed = await control.resume(token);
    assert.equal(resumed?.drain, undefined);
    await core.waitForWakes(2);
    assert.equal(core.wakes[1]?.event.id, "queued");
    core.release();
    await waitFor(async () => (await control.wakeReceipt(token, receiptId(queued)))?.state === "completed");
    assert.equal((await control.accept(request("after-resume"))).state, "accepted");
    await core.waitForWakes(3); core.release();
  } finally { core.release(); await control.stop(); await rm(root, { recursive: true, force: true }); await rm(usage, { recursive: true, force: true }); }
});

test("resume never clears the latched operator stop", async () => {
  const root = await privateRoot(); const usage = await fuseDirectory();
  const core = new HeldCoreHost();
  const control = createOrganizationRuntimeControlHostWithCoreForTest(config, core, { acceptanceStorePath: root, controlToken: token, storeOptions, fuseEnvironment: fuseEnvironment(usage), fusePollIntervalMsForTest: 1 });
  try {
    await control.start();
    await control.drain(token);
    const parked = await control.accept(request("parked"));
    assert.equal(parked.state, "stopped");
    await control.resume(token);
    const queued = await control.accept(request("queued")); await core.waitForWakes(1);
    const behind = await control.accept(request("behind"));
    await writeFile(path.join(usage, "fuse.stop"), "");
    await waitFor(async () => (await control.availability(token))?.state === "stopped");
    await control.drain(token);
    const afterResume = await control.resume(token);
    assert.equal(afterResume?.state, "stopped");
    await unlink(path.join(usage, "fuse.stop"));
    await control.resume(token);
    core.release();
    await waitFor(async () => (await control.wakeReceipt(token, receiptId(queued)))?.state === "completed");
    assert.equal((await control.availability(token))?.state, "stopped", "the operator stop stays latched in the running process");
    const afterStop = await control.accept(request("after-stop"));
    assert.equal(afterStop.state === "stopped" ? afterStop.blocked?.reason : afterStop.state, "operator_stop");
    assert.equal(core.wakes.length, 1);
    assert.equal((await control.wakeReceipt(token, receiptId(behind)))?.state, "accepted");
  } finally { core.release(); await control.stop(); await rm(root, { recursive: true, force: true }); await rm(usage, { recursive: true, force: true }); }
});

test("a resume that lands while a paused loop is still unwinding its claim still dispatches the queue", async () => {
  const root = await privateRoot();
  const store = await WakeAcceptanceStore.open(root, storeOptions);
  const fuse = await WakeFuse.open({ organizationKey: "alpha", environment: { DAIMON_WAKE_FUSE: "off" } });
  const core = new HeldCoreHost();
  // Holds the first transition to each state until the test opens it.
  const running = gate(); const rollback = gate();
  const gated = new Proxy(store, { get(target, key, receiver) {
    if (key !== "transitionClaimed") { const value = Reflect.get(target, key, receiver); return typeof value === "function" ? value.bind(target) : value; }
    return async (id: string, claim: WakeExecutionClaim, state: WakeReceiptState, ...rest: unknown[]) => {
      const hold = state === "running" ? running : state === "accepted" ? rollback : undefined;
      if (hold !== undefined && !hold.passed) { hold.passed = true; hold.arrive(); await hold.opened; }
      return await (target.transitionClaimed as (...args: unknown[]) => Promise<unknown>)(id, claim, state, ...rest);
    };
  } });
  const dispatcher = new AttentionDispatcher({ store: gated, host: core as unknown as OrganizationRuntimeHost, fuse, agents: parseOrganizationRuntimeConfig(config).agents, registry: new Map(), token, onIdle: () => undefined });
  try {
    await store.accept(parseWakeAcceptanceRequest(request("queued")));
    dispatcher.notify("alpha");
    await running.entered;
    dispatcher.pause();
    running.open();
    await rollback.entered;
    // The loop saw the drain and is rolling its claim back; resume finds it busy.
    dispatcher.resume();
    rollback.open();
    await core.waitForWakes(1);
    assert.equal(core.wakes[0]?.event.id, "queued");
  } finally { core.release(); await dispatcher.stop(); await fuse.close(); await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("a synchronous v1 turn keeps the host draining until it ends", async () => {
  const root = await privateRoot(); const usage = await fuseDirectory();
  const core = new HeldCoreHost();
  const control = createOrganizationRuntimeControlHostWithCoreForTest(config, core, { acceptanceStorePath: root, controlToken: token, storeOptions, fuseEnvironment: fuseEnvironment(usage) });
  try {
    await control.start();
    const turn = control.wake({ token, agentId: "alpha", event: { version: "noopolis.daimon.wake.v1", id: "v1-turn", kind: "manual", text: "go", occurredAt: "2026-08-17T00:00:00.000Z" } });
    await core.waitForWakes(1);
    assert.equal((await control.drain(token))?.drain?.state, "draining");
    const refused = await control.wake({ token, agentId: "alpha", event: { version: "noopolis.daimon.wake.v1", id: "v1-late", kind: "manual", text: "go", occurredAt: "2026-08-17T00:00:00.000Z" } });
    assert.equal(refused.status, "stopped");
    core.release();
    assert.equal((await turn).status, "completed");
    assert.equal((await control.availability(token))?.drain?.state, "drained");
    assert.equal(core.wakes.length, 1);
  } finally { core.release(); await control.stop(); await rm(root, { recursive: true, force: true }); await rm(usage, { recursive: true, force: true }); }
});

test("resume never re-runs a delivery an attention turn deferred during the drain", async () => {
  const root = await privateRoot(); const usage = await fuseDirectory();
  const core = new HeldCoreHost();
  const attentionConfig = { ...config, agents: [{ ...config.agents[0]!, attention: { maxBatchMessages: 4 } }] };
  const control = createOrganizationRuntimeControlHostWithCoreForTest(attentionConfig, core, { acceptanceStorePath: root, controlToken: token, storeOptions, fuseEnvironment: fuseEnvironment(usage) });
  try {
    await control.start();
    const first = await control.accept(request("read-not-disposed"));
    await core.waitForWakes(1);
    await control.drain(token);
    core.release();
    await waitFor(async () => (await control.availability(token))?.drain?.state === "drained");
    await control.resume(token);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(core.wakes.length, 1, "a resume is not new input for a deferred delivery");
    assert.equal((await control.activityV2(token))?.items.find((item) => item.acceptance_id === receiptId(first))?.deferred, true);
    await control.accept(request("new-mail"));
    await core.waitForWakes(2); core.release();
  } finally { core.release(); await control.stop(); await rm(root, { recursive: true, force: true }); await rm(usage, { recursive: true, force: true }); }
});

test("resume dispatches queued work a budget pause parked before the drain", async () => {
  const root = await privateRoot();
  const store = await WakeAcceptanceStore.open(root, storeOptions);
  const core = new HeldCoreHost();
  let budget: "available" | "paused" = "paused";
  const fuse = { snapshot: async () => ({ state: budget }), admit: async () => ({ state: "admitted" as const }) } as unknown as WakeFuse;
  const dispatcher = new AttentionDispatcher({ store, host: core as unknown as OrganizationRuntimeHost, fuse, agents: parseOrganizationRuntimeConfig(config).agents, registry: new Map(), token, onIdle: () => undefined });
  try {
    await store.accept(parseWakeAcceptanceRequest(request("parked")));
    dispatcher.notify("alpha", true);
    await waitFor(() => dispatcher.quiescent());
    dispatcher.pause();
    budget = "available";
    dispatcher.resume(["alpha"]);
    await core.waitForWakes(1);
    assert.equal(core.wakes[0]?.event.id, "parked");
  } finally { core.release(); await dispatcher.stop(); await store.close(); await rm(root, { recursive: true, force: true }); }
});

type Gate = { passed: boolean; entered: Promise<void>; arrive: () => void; opened: Promise<void>; open: () => void };
function gate(): Gate {
  let arrive!: () => void; let open!: () => void;
  const entered = new Promise<void>((resolve) => { arrive = resolve; }); const opened = new Promise<void>((resolve) => { open = resolve; });
  return { passed: false, entered, arrive: () => arrive(), opened, open: () => open() };
}
function receiptId(result: { state: string; acceptance_id?: string }): string { assert.equal(result.state, "accepted"); return result.acceptance_id!; }
async function privateRoot(): Promise<string> { const root = await mkdtemp(path.join(os.tmpdir(), "daimon-drain-")); await chmod(root, 0o700); return root; }
async function fuseDirectory(): Promise<string> { const directory = await mkdtemp(path.join(os.tmpdir(), "daimon-drain-fuse-")); await writeFile(path.join(directory, "usage.jsonl"), ""); return directory; }
function fuseEnvironment(directory: string): NodeJS.ProcessEnv {
  return { DAIMON_WAKE_FUSE_DIRECTORY: directory, DAIMON_TURN_USAGE_LEDGER_PATH: path.join(directory, "usage.jsonl"), DAIMON_WAKE_FUSE_EPOCH: "drain", DAIMON_WAKE_FUSE_MAX_WAKES: "100", DAIMON_WAKE_FUSE_MAX_TOKENS: "1000000" };
}
async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  do { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 10)); } while (Date.now() < deadline);
  throw new Error("timed out");
}

/** Every turn is held until released, so a test decides exactly when one finishes. */
class HeldCoreHost implements Pick<OrganizationRuntimeHost, "start" | "wake" | "health" | "stop"> {
  readonly wakes: OrganizationRuntimeWakeRequest[] = [];
  private releaseTurn: (() => void) | undefined;
  async start(): Promise<void> {}
  async wake(request_: OrganizationRuntimeWakeRequest) {
    this.wakes.push(request_);
    await new Promise<void>((resolve) => { this.releaseTurn = resolve; });
    return { version: "noopolis.daimon.wake-result.v1", status: "completed", agentId: request_.agentId, wakeId: request_.event.id, text: "done", durationMs: 1 } as const;
  }
  async health(_agentId?: string) { return { version: "noopolis.daimon.organization-runtime-health.v1" as const, state: "running" as const, agents: [{ agentId: "alpha", engine: "codex" as const, state: "idle" as const }] }; }
  async activity() { return { version: "noopolis.daimon.organization-runtime-activity.v1" as const, items: [] }; }
  async stop() { this.release(); return { version: "noopolis.daimon.organization-runtime-stop.v1" as const, state: "stopped" as const }; }
  async waitForWakes(count: number): Promise<void> { await waitFor(() => this.wakes.length >= count); }
  release(): void { const release = this.releaseTurn; this.releaseTurn = undefined; release?.(); }
}

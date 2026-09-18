import { randomUUID } from "node:crypto";
import { AttentionDispatcher, inboxPrompt } from "./attentionDispatcher.js";
import { DAIMON_GROK_TOOL_PREFIX, grokDaimonToolName } from "../contracts/grokWorkerContract.js";
import { createOrganizationRuntimeHost } from "./organizationRuntimeHost.js";
import { WakeAcceptanceStore, WakeExecutionClaimLostError } from "./wakeAcceptanceStore.js";
import { parseWakeAcceptanceRequest } from "./wakeAcceptanceTypes.js";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AttentionRegistry } from "./attention.js";
import { createOrganizationRuntimeControlHostWithCoreForTest } from "./organizationRuntimeControl.js";
import type { OrganizationRuntimeHost, OrganizationRuntimeWakeRequest, OrganizationRuntimeWakeResult } from "./organizationRuntime.js";

const token = "attention-test";
const storeOptions = { processIdentity: async () => ({ pid: 1, process_start: "test-start", boot_id: "test-boot", pid_namespace_dev: 1, pid_namespace_ino: 1 }), ownerLiveness: async () => true };
const config = (maxExecutions = 20, engine: "codex" | "grok" = "codex") => ({ version: "noopolis.daimon.organization-runtime.v1", host: { bindHost: "127.0.0.1", port: 4318, controlTokenEnv: "ATTENTION_TEST" }, agents: ["alpha", "beta"].map((id) => ({ id, name: id, instructions: "Act", workspacePath: `/workspace/${id}`, runtimeHomePath: `/home/${id}`, engine: { kind: engine }, attention: { maxBatchMessages: 3, maxExecutions } })) });
const request = (id: string, agent_id = "alpha") => ({ token, agent_id, delivery_id: id, event: { version: "noopolis.daimon.wake.v2", kind: "message", text: `Handle ${id}`, occurred_at: "2026-09-11T00:00:00.000Z" } });
const pause = (ms = 5) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(test: () => boolean | Promise<boolean>): Promise<void> { for (let n = 0; n < 200; n++) { if (await test()) return; await pause(); } throw new Error("expected side effect did not appear"); }
class Core implements OrganizationRuntimeHost {
  stops = 0;
  wakes: OrganizationRuntimeWakeRequest[] = [];
  releases: Array<(value: OrganizationRuntimeWakeResult) => void> = [];
  async start() {}
  wake(request: OrganizationRuntimeWakeRequest): Promise<OrganizationRuntimeWakeResult> { this.wakes.push(request); return new Promise((resolve) => this.releases.push(resolve)); }
  complete(index: number) { const wake = this.wakes[index]!; this.releases[index]!({ version: "noopolis.daimon.wake-result.v1", status: "completed", agentId: wake.agentId, wakeId: wake.event.id, text: "done", durationMs: 1 }); }
  async health() { return { version: "noopolis.daimon.organization-runtime-health.v1" as const, state: "running" as const, agents: [] }; }
  async activity() { return { version: "noopolis.daimon.organization-runtime-activity.v1" as const, items: [] }; }
  async stop() { this.stops++; this.releases.forEach((release, index) => release({ version: "noopolis.daimon.wake-result.v1", status: "stopped", agentId: this.wakes[index]!.agentId, wakeId: this.wakes[index]!.event.id, code: "active_wake_aborted" })); return { version: "noopolis.daimon.organization-runtime-stop.v1" as const, state: "stopped" as const }; }
}
async function fixture(limit = 20, maxWakes = 100, claimTtlMs = 240000, engine: "codex" | "grok" = "codex") {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-attention-")); await chmod(root, 0o700);
  const usage = await mkdtemp(path.join(os.tmpdir(), "daimon-attention-usage-")); await writeFile(path.join(usage, "usage.jsonl"), "");
  const registry: AttentionRegistry = new Map();
  const core = new Core();
  const options = { acceptanceStorePath: root, controlToken: token, storeOptions: { ...storeOptions, claimTtlMs }, attentionRegistryForTest: registry, fuseEnvironment: { DAIMON_WAKE_FUSE_DIRECTORY: usage, DAIMON_WAKE_FUSE_EPOCH: "attention", DAIMON_WAKE_FUSE_MAX_WAKES: String(maxWakes), DAIMON_WAKE_FUSE_MAX_TOKENS: "10000", DAIMON_TURN_USAGE_LEDGER_PATH: path.join(usage, "usage.jsonl") } };
  const control = createOrganizationRuntimeControlHostWithCoreForTest(config(limit, engine), core, options); await control.start();
  return { root, usage, registry, core, options, control, cleanup: async () => { await control.stop(); await rm(root, { recursive: true, force: true }); await rm(usage, { recursive: true, force: true }); } };
}

test("idle messages wake promptly, busy messages become one bounded next execution", async () => {
  const f = await fixture();
  try {
    await f.control.accept(request("first")); await until(() => f.core.wakes.length === 1);
    for (const id of ["second", "third", "fourth"]) await f.control.accept(request(id));
    assert.equal(f.core.wakes.length, 1);
    assert.equal((await f.control.availability(token))!.agents[0]!.budget.executions_used, 1);
    await f.registry.get("alpha")!.disposition("first", "complete");
    // Completion does not erase the active execution's authority mid-turn.
    assert.equal((await f.control.activityV2(token))!.executions!.length, 1);
    f.core.complete(0); await until(() => f.core.wakes.length === 2);
    assert.deepEqual(f.registry.get("alpha")!.messages.map((value) => value.delivery_id), ["second", "third", "fourth"]);
    const rows = (await f.control.activityV2(token))!.items.filter((value) => value.state === "running");
    assert.equal(rows.length, 3); assert.equal(rows.filter((value) => value.active).length, 1);
    assert.ok(rows.every((value) => value.execution_id === f.core.wakes[1]!.event.id));
    for (const id of ["second", "third", "fourth"]) await f.registry.get("alpha")!.disposition(id, "complete");
    f.core.complete(1); await until(() => !f.registry.has("alpha"));
    assert.equal((await f.control.activityV2(token))!.items.filter((value) => value.state === "completed").length, 4);
    const ledger = (await readFile(path.join(f.usage, "admissions.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(ledger.filter((value) => value.kind === "admission").length, 2);
  } finally { await f.cleanup(); }
});

test("unmarked deliveries remain pending without a busy loop, later input revisits them", async () => {
  const f = await fixture();
  try {
    await f.control.accept(request("omitted")); await until(() => f.core.wakes.length === 1);
    f.core.complete(0); await until(() => !f.registry.has("alpha")); await pause(30);
    assert.equal(f.core.wakes.length, 1);
    const row = (await f.control.activityV2(token))!.items[0]!;
    assert.equal(row.state, "accepted"); assert.equal(row.deferred, true);
    await f.control.accept(request("fresh")); await until(() => f.core.wakes.length === 2);
    assert.deepEqual(f.registry.get("alpha")!.messages.map((value) => value.delivery_id), ["omitted", "fresh"]);
    await assert.rejects(f.registry.get("alpha")!.disposition("foreign", "complete"), /outside/);
  } finally { await f.cleanup(); }
});

test("one agent's execution allowance pauses its inbox without consuming its peers' allowance", async () => {
  const f = await fixture(1);
  try {
    await f.control.accept(request("one")); await until(() => f.core.wakes.length === 1);
    await f.registry.get("alpha")!.disposition("one", "complete"); f.core.complete(0);
    await f.control.accept(request("two"));
    await f.control.accept(request("peer", "beta")); await until(() => f.core.wakes.length === 2);
    assert.equal(f.core.wakes[1]!.agentId, "beta");
    const alpha = (await f.control.availability(token))!.agents[0]!;
    assert.equal(alpha.pending, 1); assert.equal(alpha.budget.reason, "agent_execution_ceiling");
    assert.equal(alpha.budget.agent_executions_remaining, 0);
  } finally { await f.cleanup(); }
});

test("global budget pause still accepts durable deliveries and restart preserves every pending item", async () => {
  const f = await fixture(10, 1);
  let restarted: ReturnType<typeof createOrganizationRuntimeControlHostWithCoreForTest> | undefined;
  try {
    await f.control.accept(request("one")); await until(() => f.core.wakes.length === 1);
    await f.registry.get("alpha")!.disposition("one", "complete"); f.core.complete(0);
    const accepted = await f.control.accept(request("two")); assert.equal(accepted.state, "accepted");
    await until(async () => (await f.control.availability(token))!.agents[0]!.pending === 1);
    await f.control.stop();
    const core = new Core(); restarted = createOrganizationRuntimeControlHostWithCoreForTest(config(), core, f.options); await restarted.start(); await pause(30);
    assert.equal(core.wakes.length, 0);
    assert.equal((await restarted.activityV2(token))!.items.find((value) => value.delivery_id === "two")!.state, "accepted");
    assert.equal((await restarted.availability(token))!.state, "paused");
    await writeFile(path.join(f.usage, "fuse.stop"), "");
    const blocked = await restarted.accept(request("operator-blocked"));
    assert.equal(blocked.state, "stopped"); assert.equal(blocked.blocked!.reason, "operator_stop");
  } finally { await restarted?.stop(); await f.cleanup(); }
});

test("partially completed execution restores the same identity and never replays completed deliveries", async () => {
  const f = await fixture();
  let restarted: ReturnType<typeof createOrganizationRuntimeControlHostWithCoreForTest> | undefined;
  try {
    await f.control.accept(request("first")); await until(() => f.core.wakes.length === 1);
    await f.control.accept(request("second")); await f.control.accept(request("third"));
    await f.registry.get("alpha")!.disposition("first", "complete"); f.core.complete(0); await until(() => f.core.wakes.length === 2);
    const executionId = f.core.wakes[1]!.event.id;
    await f.registry.get("alpha")!.disposition("second", "complete");
    await f.control.stop();
    const registry: AttentionRegistry = new Map(); const core = new Core();
    restarted = createOrganizationRuntimeControlHostWithCoreForTest(config(), core, { ...f.options, attentionRegistryForTest: registry }); await restarted.start();
    await until(() => core.wakes.length === 1);
    assert.equal(core.wakes[0]!.event.id, executionId);
    assert.deepEqual(registry.get("alpha")!.messages.map((value) => value.delivery_id), ["third"]);
    assert.equal((await restarted.activityV2(token))!.items.find((value) => value.delivery_id === "second")!.state, "completed");
  } finally { await restarted?.stop(); await f.cleanup(); }
});


test("atomic agent claim restores the full selected membership after a crash between record writes", async () => {
  const f = await fixture(); let restarted: ReturnType<typeof createOrganizationRuntimeControlHostWithCoreForTest> | undefined;
  try {
    await f.control.stop();
    const store = await WakeAcceptanceStore.open(f.root, { ...storeOptions, claimTtlMs: 150 });
    const records = [];
    for (const id of ["one", "two", "three"]) records.push((await store.accept(parseWakeAcceptanceRequest(request(id)))).record);
    const executionId = randomUUID();
    const acquired = await store.acquireClaim(records[0]!.acceptance_id, randomUUID(), records.map((record) => record.acceptance_id), executionId);
    if (acquired.state !== "acquired") throw new Error("missing claim");
    // One metadata write succeeded, then the process disappeared. The atomic
    // claim is the membership authority even for the two untouched records.
    await store.transitionClaimed(records[0]!.acceptance_id, acquired.claim, "running", undefined, undefined, { execution_id: executionId });
    await store.close(); await pause(170);
    const registry: AttentionRegistry = new Map(); const core = new Core();
    restarted = createOrganizationRuntimeControlHostWithCoreForTest(config(), core, { ...f.options, attentionRegistryForTest: registry }); await restarted.start();
    await until(() => core.wakes.length === 1);
    assert.equal(core.wakes[0]!.event.id, executionId);
    assert.deepEqual(registry.get("alpha")!.messages.map((message) => message.delivery_id), ["one", "two", "three"]);
  } finally { await restarted?.stop(); await f.cleanup(); }
});


test("defer can be upgraded to durable complete and completed work cannot be deferred", async () => {
  const f = await fixture();
  try {
    await f.control.accept(request("change-disposition")); await until(() => f.registry.has("alpha"));
    const turn = f.registry.get("alpha")!;
    await turn.disposition("change-disposition", "defer");
    await turn.disposition("change-disposition", "complete");
    const receipt = (await f.control.activityV2(token))!.items[0]!;
    assert.equal(receipt.state, "completed"); assert.equal(receipt.deferred, false);
    assert.equal(receipt.execution_id, turn.executionId);
    await assert.rejects(turn.disposition("change-disposition", "defer"), /cannot be deferred/);
    assert.equal((await f.control.activityV2(token))!.executions!.length, 1);
  } finally { await f.cleanup(); }
});

test("attention refuses entrypoints without durable inbox ownership before cognition", async () => {
  const f = await fixture();
  try {
    const result = await f.control.wake({ token, agentId: "alpha", event: { version: "noopolis.daimon.wake.v1", id: "manual", kind: "manual", text: "Work", occurredAt: "2026-09-11T00:00:00.000Z" } });
    assert.equal(result.status, "rejected"); assert.equal(result.code, "durable_inbox_required");
    assert.equal(f.core.wakes.length, 0); assert.equal((await f.control.availability(token))!.agents[0]!.budget.executions_used, 0);
    assert.throws(() => createOrganizationRuntimeHost(config()), /requires createOrganizationRuntimeControlHost/);
  } finally { await f.cleanup(); }
});

test("persistent inbox read errors park without spinning, and successful retry clears the error", async () => {
  let reads = 0, failing = true;
  const dispatcher = new AttentionDispatcher({ agents: [{ id: "alpha" }], store: { recoverable: async () => { reads++; if (failing) throw new Error("storage outage"); return []; }, releaseClaims: async () => {} }, onIdle: () => {} } as never);
  dispatcher.notify("alpha", true); await until(() => dispatcher.failure("alpha") !== undefined); await pause(30);
  assert.equal(reads, 1);
  failing = false; dispatcher.notify("alpha", true); await until(() => reads === 2); await until(() => !dispatcher.busy("alpha"));
  assert.equal(dispatcher.failure("alpha"), undefined); await dispatcher.stop();
});

test("claim-renewal failure revokes execution authority, stops cognition, and latches new dispatch", async () => {
  const f = await fixture(20, 100, 600);
  const original = WakeAcceptanceStore.prototype.renewClaim;
  try {
    await f.control.accept(request("fenced")); await until(() => f.registry.has("alpha"));
    WakeAcceptanceStore.prototype.renewClaim = async () => { throw new WakeExecutionClaimLostError(); };
    await until(() => f.core.stops > 0);
    assert.equal(f.registry.size, 0); assert.deepEqual((await f.control.activityV2(token))!.executions, []);
    const status = (await f.control.availability(token))!;
    assert.equal(status.state, "stopped"); assert.equal(status.agents[0]!.running, false);
    assert.equal(status.agents[0]!.pending, 1); assert.match(status.agents[0]!.error!, /claim/);
    const accepted = await f.control.accept(request("after-fence")); assert.equal(accepted.state, "stopped"); assert.equal(accepted.blocked!.reason, "ledger_unavailable");
  } finally { WakeAcceptanceStore.prototype.renewClaim = original; await f.cleanup(); }
});

test("an inbox turn leads with each delivery's own text and keeps the accounting after the work", async () => {
  const f = await fixture();
  try {
    await f.control.accept(request("d-1")); await until(() => f.core.wakes.length === 1);
    const text = f.core.wakes[0]!.event.text;
    // The task comes first: a delivery's text is the work, not a JSON payload to account for.
    assert.match(text, /^Carry out this delivery\./u);
    assert.match(text, /<delivery id="d-1" kind="message">/u);
    const task = text.indexOf("Handle d-1"), accounting = text.indexOf("daimon_inbox_disposition");
    assert.ok(task >= 0 && accounting > task, "accounting must follow the delivery text");
    assert.ok(text.indexOf("Machine-readable payload:") > accounting, "payload stays a trailing appendix");
  } finally { await f.cleanup(); }
});

/**
 * `daimon_inbox_disposition` is the tool that records a finished wake as
 * complete; an agent that cannot name it leaves its work recorded as deferred.
 * On Grok the bare name reaches nothing, so the inbox prompt must name the
 * `daimon__` form the engine can actually invoke.
 */
test("a Grok inbox turn names both inbox tools the way use_tool can call them", async () => {
  const f = await fixture(20, 100, 240000, "grok");
  try {
    await f.control.accept(request("g-1")); await until(() => f.core.wakes.length === 1);
    const text = f.core.wakes[0]!.event.text!;
    assert.ok(text.includes(grokDaimonToolName("daimon_inbox_disposition")), "disposition tool carries the daimon__ prefix");
    assert.ok(text.includes(grokDaimonToolName("daimon_inbox")), "inbox tool carries the daimon__ prefix");
    // No bare occurrence survives: every mention is the prefixed one.
    assert.equal(text.split("daimon_inbox").length - 1, text.split(DAIMON_GROK_TOOL_PREFIX).length - 1);
  } finally { await f.cleanup(); }
});

test("every other engine's inbox turn keeps the bare tool names", async () => {
  const f = await fixture();
  try {
    await f.control.accept(request("c-1")); await until(() => f.core.wakes.length === 1);
    const text = f.core.wakes[0]!.event.text!;
    assert.ok(text.includes("with daimon_inbox_disposition (complete)"));
    assert.equal(text.includes(DAIMON_GROK_TOOL_PREFIX), false);
  } finally { await f.cleanup(); }
});

/**
 * Every branch of the inbox prompt, not only the one a small delivery takes:
 * the oversized-payload fallback is the branch a busy agent meets, and it names
 * `daimon_inbox` too.
 */
test("every branch of the inbox prompt names its tools the way the engine can call them", () => {
  const delivery = { acceptance_id: "a-1", delivery_id: "d-1", kind: "message", text: "Do the thing", occurred_at: "2026-09-11T00:00:00.000Z" };
  const oversized = { ...delivery, text: "x".repeat(2_000) };
  for (const [messages, budget] of [[[delivery], 12_000], [[oversized], 64], [[oversized], 8]] as const) {
    const grok = inboxPrompt(messages, "grok", budget), codex = inboxPrompt(messages, "codex", budget);
    // Mutation guard: an unprefixed branch leaves a bare name in the Grok text.
    assert.equal(grok.split("daimon_inbox").length - 1, grok.split(DAIMON_GROK_TOOL_PREFIX).length - 1, grok);
    assert.ok(grok.includes(grokDaimonToolName("daimon_inbox")), grok);
    assert.equal(codex.includes(DAIMON_GROK_TOOL_PREFIX), false, codex);
    assert.ok(codex.includes("daimon_inbox"), codex);
  }
  // The smallest budget is the fallback that only points at the tool.
  assert.match(inboxPrompt([oversized], "grok", 8), new RegExp(`exceeds the prompt budget; read it with ${grokDaimonToolName("daimon_inbox")}\\.$`, "u"));
});

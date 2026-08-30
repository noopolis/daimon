import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createScheduleController, MAX_TIMER_DELAY_MS, nextOccurrence, occurrenceFor } from "./schedule.js";
import { WakeAcceptanceStore } from "./wakeAcceptanceStore.js";
import { parseWakeAcceptanceRequest } from "./wakeAcceptanceTypes.js";

const every = { kind: "every" as const, interval_ms: 60_000, prompt: "work" };
const agent = (schedule: typeof every | { kind: "cron"; cron: string; timezone: string; prompt: string } | { kind: "disabled" }) =>
  ({ id: "alpha", name: "Alpha", instructions: "work", workspacePath: "/workspace/alpha", runtimeHomePath: "/home/alpha", engine: { kind: "codex" as const }, schedule });

test("every schedules keep a stable anchor and coalesce downtime to the latest cadence", () => {
  assert.equal(nextOccurrence("alpha", every, 0, 305_000), 360_000);
  assert.equal(nextOccurrence("alpha", every, 0, 59_000), 60_000);
});

test("cron field origins, impossible dates, and sparse leap work are deterministic", () => {
  const stepped = { kind: "cron" as const, cron: "0 0 */2 */2 *", timezone: "UTC", prompt: "work" };
  assert.equal(nextOccurrence("alpha", stepped, undefined, Date.parse("2026-01-01T00:00:00.000Z")), Date.parse("2026-01-03T00:00:00.000Z"));
  const leap = { kind: "cron" as const, cron: "0 0 29 2 *", timezone: "UTC", prompt: "work" };
  assert.equal(nextOccurrence("alpha", leap, undefined, Date.parse("2025-03-01T00:00:00.000Z")), Date.parse("2028-02-29T00:00:00.000Z"));
  assert.throws(() => nextOccurrence("alpha", { ...leap, cron: "0 0 31 2 *" }, undefined, 0), /impossible/);
});

test("cron forward search chooses the immediately next minute from a partial minute", () => {
  const schedule = { kind: "cron" as const, cron: "* * * * *", timezone: "UTC", prompt: "work" };
  assert.equal(nextOccurrence("alpha", schedule, undefined, Date.parse("2026-01-01T00:00:30.500Z")), Date.parse("2026-01-01T00:01:00.000Z"));
  assert.equal(nextOccurrence("alpha", { ...schedule, cron: "  *   *  * *   * " }, undefined, Date.parse("2026-01-01T00:00:30.500Z")), Date.parse("2026-01-01T00:01:00.000Z"));
  assert.throws(() => nextOccurrence("alpha", { ...schedule, cron: `*/${"9".repeat(400)} * * * *` }, undefined, 0), /invalid/);
});

test("cron occurrence identities include the named-zone offset across DST fall-back", () => {
  const schedule = { kind: "cron" as const, cron: "30 2 * * *", timezone: "Europe/Berlin", prompt: "work" };
  const first = occurrenceFor("alpha", schedule, Date.parse("2026-10-25T00:30:00.000Z"));
  const second = occurrenceFor("alpha", schedule, Date.parse("2026-10-25T01:30:00.000Z"));
  assert.notEqual(first.deliveryId, second.deliveryId);
});

test("cron skips nonexistent spring time and restart picks the second fall occurrence", () => {
  const schedule = { kind: "cron" as const, cron: "30 2 * * *", timezone: "Europe/Berlin", prompt: "work" };
  assert.equal(nextOccurrence("alpha", schedule, undefined, Date.parse("2026-03-29T00:00:00.000Z")), Date.parse("2026-03-30T00:30:00.000Z"));
  assert.equal(nextOccurrence("alpha", schedule, undefined, Date.parse("2026-10-25T00:31:00.000Z")), Date.parse("2026-10-25T01:30:00.000Z"));
});

test("cron combines restricted day-of-month and day-of-week with standard OR semantics across DST", () => {
  const schedule = { kind: "cron" as const, cron: "0 0 1 * 1", timezone: "Europe/Berlin", prompt: "work" };
  assert.equal(nextOccurrence("alpha", schedule, undefined, Date.parse("2026-03-28T00:00:00.000Z")), Date.parse("2026-03-29T22:00:00.000Z"));
  assert.equal(nextOccurrence("alpha", { ...schedule, cron: "0 0 * * 1" }, undefined, Date.parse("2026-03-28T00:00:00.000Z")), Date.parse("2026-03-29T22:00:00.000Z"));
  assert.equal(nextOccurrence("alpha", { ...schedule, cron: "0 0 1 * *" }, undefined, Date.parse("2026-03-28T00:00:00.000Z")), Date.parse("2026-03-31T22:00:00.000Z"));
});

test("state remains inside the mounted root and replacement drains a missed occurrence once", async () => {
  const root = await privateRoot();
  let now = 0;
  const timers = fakeTimers();
  try {
    const first = createScheduleController({ acceptanceStorePath: root, agents: [agent(every)], accept: async () => false, now: () => now, ...timers.options });
    await first.start();
    assert.equal((await stat(path.join(root, "schedule-state.v1.json"))).mode & 0o777, 0o600);
    await first.stop();
    now = 181_000;
    const accepted: ReturnType<typeof occurrenceFor>[] = [];
    const replacement = createScheduleController({ acceptanceStorePath: root, agents: [agent(every)], accept: async (occurrence) => { accepted.push(occurrence); }, now: () => now, ...fakeTimers().options });
    await replacement.start(); await replacement.stop();
    assert.deepEqual(accepted, [occurrenceFor("alpha", every, 180_000)]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("every cadence samples now once and persists the immediate next 1ms occurrence", async () => {
  const root = await privateRoot(); const oneMs = { ...every, interval_ms: 1 }; let tick = 0;
  try {
    await seedState(root, oneMs, 1);
    const controller = createScheduleController({ acceptanceStorePath: root, agents: [agent(oneMs)], accept: async () => false, now: () => ++tick, ...fakeTimers().options });
    await controller.start(); await controller.stop();
    const state = JSON.parse(await readState(root)); const entry = state.schedules[Object.keys(state.schedules)[0]];
    assert.equal(entry.next_due_ms, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("state persistence orders write, file sync, rename, and directory sync", async () => {
  const root = await privateRoot(); const stages: string[] = [];
  try {
    const controller = createScheduleController({ acceptanceStorePath: root, agents: [agent(every)], accept: async () => false, now: () => 0, onPersistStageForTest: (stage) => stages.push(stage), ...fakeTimers().options });
    await controller.start(); await controller.stop();
    assert.deepEqual(stages, ["write", "file-sync", "rename", "directory-sync"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("busy fires durably replace latest pending and restart drains only the newest", async () => {
  const root = await privateRoot(); let now = 0; const timers = fakeTimers();
  try {
    const busy = createScheduleController({ acceptanceStorePath: root, agents: [agent(every)], accept: async () => false, now: () => now, ...timers.options });
    await busy.start();
    now = 61_000; timers.fire();
    await eventually(async () => {
      const value = JSON.parse(await readState(root)); const entry = value.schedules[Object.keys(value.schedules)[0]];
      return entry?.latest_pending?.occurredAt === new Date(60_000).toISOString();
    });
    now = 121_000; timers.fire();
    await eventually(async () => (await readState(root)).includes(new Date(120_000).toISOString()));
    await busy.stop();
    const accepted: ReturnType<typeof occurrenceFor>[] = [];
    const replacement = createScheduleController({ acceptanceStorePath: root, agents: [agent(every)], accept: async (occurrence) => { accepted.push(occurrence); }, now: () => now, ...fakeTimers().options });
    await replacement.start();
    await Promise.all([replacement.drain("alpha"), replacement.drain("alpha")]);
    await replacement.stop();
    assert.deepEqual(accepted, [occurrenceFor("alpha", every, 120_000)]);
    assert.equal((await readdir(root)).some((file) => file.startsWith(".schedule-state-")), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("restored pending work is bound to its exact agent, schedule, identity, and due time", async (context) => {
  for (const [name, mutate] of [
    ["agent", (pending: Record<string, unknown>, _entry: Record<string, unknown>) => { pending.agentId = "beta"; }],
    ["prompt", (pending: Record<string, unknown>, _entry: Record<string, unknown>) => { pending.prompt = "rerouted"; }],
    ["delivery", (pending: Record<string, unknown>, _entry: Record<string, unknown>) => { pending.deliveryId = `${pending.deliveryId as string}:changed`; }],
    ["timestamp", (pending: Record<string, unknown>, _entry: Record<string, unknown>) => { pending.occurredAt = new Date(61_000).toISOString(); }],
    ["due", (_pending: Record<string, unknown>, entry: Record<string, unknown>) => { entry.next_due_ms = 180_000; }]
  ] as const) {
    await context.test(name, async () => {
      const root = await privateRoot(); const timers = fakeTimers(); let now = 0;
      try {
        const controller = createScheduleController({ acceptanceStorePath: root, agents: [agent(every)], accept: async () => false, now: () => now, ...timers.options });
        await controller.start(); now = 61_000; timers.fire();
        await eventually(async () => (await readState(root)).includes("latest_pending"));
        await controller.stop();
        const state = JSON.parse(await readState(root)) as { schedules: Record<string, Record<string, unknown>> };
        const entry = state.schedules[Object.keys(state.schedules)[0]!]!;
        mutate(entry.latest_pending as Record<string, unknown>, entry);
        await writeFile(path.join(root, "schedule-state.v1.json"), JSON.stringify(state), { mode: 0o600 });
        const replacement = createScheduleController({ acceptanceStorePath: root, agents: [agent(every)], accept: async () => true, now: () => now, ...fakeTimers().options });
        await assert.rejects(replacement.start(), /schedule state is invalid/);
        await replacement.stop();
      } finally { await rm(root, { recursive: true, force: true }); }
    });
  }
});

test("timers above Node's maximum are armed in bounded chunks", async () => {
  const root = await privateRoot(); const delays: number[] = [];
  try {
    const controller = createScheduleController({
      acceptanceStorePath: root, agents: [agent({ ...every, interval_ms: 31_536_000_000 })], accept: async () => undefined, now: () => 0,
      setTimer: ((callback: () => void, delay: number) => { delays.push(delay); return { callback, unref() {} } as never; }), clearTimer: () => undefined
    });
    await controller.start(); await controller.stop();
    assert.deepEqual(delays, [MAX_TIMER_DELAY_MS]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("disabled schedules persist no pending work", async () => {
  const root = await privateRoot(); const accepted: unknown[] = [];
  try {
    const controller = createScheduleController({ acceptanceStorePath: root, agents: [agent({ kind: "disabled" })], accept: async (value) => { accepted.push(value); } });
    await controller.start(); await controller.stop(); assert.deepEqual(accepted, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("post-acceptance cut deduplicates one stable occurrence on a fresh replacement", async () => {
  const root = await privateRoot(); const now = 61_000; const storeOptions = {
    processIdentity: async () => ({ pid: 1, process_start: "schedule-test", boot_id: "test-boot", pid_namespace_dev: 1, pid_namespace_ino: 1 }),
    ownerLiveness: async () => true
  };
  try {
    await seedState(root, every, 60_000);
    const firstStore = await WakeAcceptanceStore.open(root, storeOptions);
    let durableAcceptanceId: string | undefined;
    const crash = createScheduleController({ acceptanceStorePath: root, agents: [agent(every)], accept: async (occurrence) => {
      const accepted = await firstStore.accept(scheduleRequest(occurrence));
      assert.equal(accepted.created, true); durableAcceptanceId = accepted.record.acceptance_id;
      throw new Error("forced post-acceptance cut");
    }, now: () => now, ...fakeTimers().options });
    await assert.rejects(crash.start(), /forced post-acceptance cut/); await crash.stop(); await firstStore.close();

    const replacementStore = await WakeAcceptanceStore.open(root, storeOptions);
    const drained: string[] = [];
    const replacement = createScheduleController({ acceptanceStorePath: root, agents: [agent(every)], accept: async (occurrence) => {
      drained.push(occurrence.deliveryId);
      const duplicate = await replacementStore.accept(scheduleRequest(occurrence));
      assert.equal(duplicate.created, false); assert.equal(duplicate.record.acceptance_id, durableAcceptanceId);
      return true;
    }, now: () => now, ...fakeTimers().options });
    await replacement.start(); await replacement.drain("alpha"); await replacement.stop();
    assert.deepEqual(drained, [occurrenceFor("alpha", every, 60_000).deliveryId]);
    assert.equal((await replacementStore.recoverable(new Set(["alpha"]))).length, 1);
    assert.equal((await readState(root)).includes("latest_pending"), false);
    await replacementStore.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function privateRoot(): Promise<string> { const root = await mkdtemp(path.join(os.tmpdir(), "daimon-schedule-")); await chmod(root, 0o700); return root; }
async function readState(root: string): Promise<string> { return await import("node:fs/promises").then(({ readFile }) => readFile(path.join(root, "schedule-state.v1.json"), "utf8")); }
async function seedState(root: string, schedule: typeof every, due: number): Promise<void> {
  const key = occurrenceFor("alpha", schedule, due).deliveryId.split(":")[1]!;
  await writeFile(path.join(root, "schedule-state.v1.json"), JSON.stringify({ version: "noopolis.daimon.schedule-state.v1", schedules: { [key]: { next_due_ms: due } } }), { mode: 0o600 });
}
function scheduleRequest(occurrence: ReturnType<typeof occurrenceFor>) {
  return parseWakeAcceptanceRequest({ token: undefined, agent_id: occurrence.agentId, delivery_id: occurrence.deliveryId, event: { version: "noopolis.daimon.wake.v2", kind: "schedule", text: occurrence.prompt, occurred_at: occurrence.occurredAt } });
}
function fakeTimers(): { options: { setTimer: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>; clearTimer: (timer: ReturnType<typeof setTimeout>) => void }; fire(): void } {
  let latest: (() => void) | undefined;
  return { options: { setTimer: ((callback: () => void) => { latest = callback; return { unref() {} } as never; }), clearTimer: () => undefined }, fire: () => latest?.() };
}
async function eventually(predicate: () => Promise<boolean>): Promise<void> { const end = Date.now() + 2_000; while (Date.now() < end) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 5)); } throw new Error("timed out"); }

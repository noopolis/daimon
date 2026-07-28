import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { WakeEvent } from "../core/types.js";
import { WakeAcceptanceFs } from "./wakeAcceptanceFs.js";
import { WakeAcceptanceError, WakeAcceptanceStore, type WakeAcceptanceStoreState } from "./wakeAcceptance.js";

type Gate = { signal: Promise<void>; release: () => void };
const roots: string[] = [];
const gate = (): Gate => { let release = (): void => {}; const signal = new Promise<void>((resolve) => { release = resolve; }); return { signal, release }; };
const event = (id: string): WakeEvent => ({ id, kind: "message", from: "sender", text: id, context: { roomId: "room" }, delivery: { eventId: id, sender: "sender", target: "agent", contextId: `ctx-${id}` } });
const tmp = async (): Promise<string> => { const root = await mkdtemp(path.join(os.tmpdir(), "b34-")); roots.push(root); return root; };
const incomplete = (value: unknown): boolean => value instanceof WakeAcceptanceError && value.code === "wake_delivery_incomplete";
const state = async (store: WakeAcceptanceStore): Promise<WakeAcceptanceStoreState> => JSON.parse(await readFile(store.getAcceptanceFilePath(), "utf8")) as WakeAcceptanceStoreState;
test.afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

test("same-delivery stores permit replay or fixed incomplete, then stable replay", async () => {
  const home = await tmp(); const left = new WakeAcceptanceStore(home, "agent"); const right = new WakeAcceptanceStore(home, "agent");
  const settled = await Promise.allSettled([left.begin(event("same")), right.begin(event("same"))]); const runs = settled.filter((result) => result.status === "fulfilled" && result.value.mode === "run"); const rejected = settled.filter((result) => result.status === "rejected");
  assert.equal(runs.length, 1); assert.ok(rejected.length === 0 || (rejected.length === 1 && rejected[0].status === "rejected" && incomplete(rejected[0].reason)));
  const run = runs[0]; const owner = settled[0] === run ? left : right; if (run.status !== "fulfilled" || run.value.mode !== "run") throw new Error("missing run"); await owner.markCompleted(await owner.markInvoking(run.value.capability));
  assert.equal((await right.begin(event("same"))).mode, "replay"); assert.deepEqual((await state(left)).records.map((record) => ({ event: record.event_id, state: record.state })), [{ event: "same", state: "completed" }]);
});

test("distinct deliveries contend deterministically then retry without duplication", async () => {
  const home = await tmp(); const entered = gate(); const release = gate();
  const held = new WakeAcceptanceStore(home, "agent", new WakeAcceptanceFs(home, { hooks: { preDirectorySync: async () => { entered.release(); await release.signal; } } })); const contender = new WakeAcceptanceStore(home, "agent");
  const first = held.begin(event("first")); await entered.signal; await assert.rejects(contender.begin(event("second")), incomplete); release.release(); const admitted = await first; if (admitted.mode !== "run") throw new Error("first must run"); await held.markCompleted(await held.markInvoking(admitted.capability));
  const retry = await contender.begin(event("second")); assert.equal(retry.mode, "run"); assert.deepEqual((await state(held)).records.map((record) => record.event_id), ["first", "second"]);
});

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { WakeAcceptanceIndex } from "./wakeAcceptanceIndex.js";
import { WakeAcceptanceStore, type WakeAcceptanceStoreTestOptions } from "./wakeAcceptanceStore.js";
import { parseWakeAcceptanceRequest, wakeAcceptanceDigest } from "./wakeAcceptanceTypes.js";
import { MAX_WAKE_ACCEPTANCE_RECORDS } from "./wakeAcceptanceRetention.js";

const request = (delivery: string) => parseWakeAcceptanceRequest({ token: "control-secret", agent_id: "alpha", delivery_id: delivery, event: { version: "noopolis.daimon.wake.v2", kind: "manual" as const, text: "hello", occurred_at: "2026-08-17T00:00:00.000Z" } });
const identity = { processIdentity: async () => ({ pid: 1, process_start: "test-start", boot_id: "test-boot", pid_namespace_dev: 1, pid_namespace_ino: 1 }), ownerLiveness: async () => true };
/** Every write in a test is younger than the racy-timestamp window; a clock past it proves the steady state an idle host is in. */
const settledClock = () => Date.now() + 60_000;
const recordFile = (delivery: string) => `${createHash("sha256").update(`alpha\u0000${delivery}`).digest("hex")}.json`;

async function counted(root: string, options: WakeAcceptanceStoreTestOptions = {}): Promise<{ store: WakeAcceptanceStore; reads: () => number }> {
  let reads = 0;
  const store = await WakeAcceptanceStore.open(root, { ...identity, nowForTest: settledClock, ...options, onRecordReadForTest: () => { reads += 1; } } as WakeAcceptanceStoreTestOptions);
  return { store, reads: () => { const value = reads; reads = 0; return value; } };
}
async function privateRoot(): Promise<string> { const root = await mkdtemp(path.join(os.tmpdir(), "daimon-index-")); await chmod(root, 0o700); return root; }

test("an unknown receipt id against an unchanged store reads no record file", async () => {
  const root = await privateRoot();
  try {
    const { store, reads } = await counted(root);
    const accepted = await Promise.all(Array.from({ length: 6 }, async (_, index) => (await store.accept(request(`d-${index}`))).record));
    reads();
    const unknown = randomUUID();
    assert.equal(await store.status(unknown), undefined);
    assert.ok(reads() <= accepted.length, "the first miss after writes syncs once");
    for (let poll = 0; poll < 5; poll += 1) assert.equal(await store.status(unknown), undefined);
    assert.equal(reads(), 0, "repeated misses must not rescan the store");
    assert.equal((await store.status(accepted[2]!.acceptance_id))?.delivery_id, "d-2");
    assert.equal(reads(), 1, "a known id reads exactly its own record");

    // Transition: the next miss re-reads only the record whose file changed.
    await store.transition(accepted[3]!.acceptance_id, "running");
    reads();
    assert.equal(await store.status(unknown), undefined);
    assert.equal(reads(), 1);
    assert.equal(await store.status(unknown), undefined);
    assert.equal(reads(), 0);
    assert.equal((await store.status(accepted[3]!.acceptance_id))?.state, "running");
    await store.close();

    // Restart: a fresh index syncs once, then misses are free again.
    const reopened = await counted(root);
    assert.equal((await reopened.store.status(accepted[5]!.acceptance_id))?.delivery_id, "d-5");
    reopened.reads();
    assert.equal(await reopened.store.status(unknown), undefined);
    assert.equal(reopened.reads(), 0);
    await reopened.store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the index follows another process's create, delete and recreate of a record", async () => {
  const root = await privateRoot();
  try {
    const { store, reads } = await counted(root);
    const other = await WakeAcceptanceStore.open(root, { ...identity, nowForTest: settledClock });
    const mine = (await store.accept(request("mine"))).record;
    const foreign = (await other.accept(request("foreign"))).record;
    assert.equal((await store.status(foreign.acceptance_id))?.delivery_id, "foreign", "a foreign create is found after the directory changed");
    // A foreign delete and recreate behind a cached binding: the file now carries
    // another id, and the hit path must refuse to serve it for the old one.
    await unlink(path.join(root, recordFile("foreign")));
    const recreated = (await other.accept(request("foreign"))).record;
    assert.notEqual(recreated.acceptance_id, foreign.acceptance_id);
    assert.equal(await store.status(foreign.acceptance_id), undefined);
    assert.equal((await store.status(recreated.acceptance_id))?.acceptance_id, recreated.acceptance_id);
    // A plain foreign delete: the stale binding is dropped, never served.
    await unlink(path.join(root, recordFile("foreign")));
    assert.equal(await store.status(recreated.acceptance_id), undefined);
    assert.equal((await store.status(mine.acceptance_id))?.delivery_id, "mine");
    reads();
    assert.equal(await store.status(foreign.acceptance_id), undefined);
    assert.equal(reads(), 0);
    await other.close(); await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a directory stamp inside the racy-timestamp window is never trusted as unchanged", async () => {
  // A coarse filesystem clock can leave the directory stamp identical across a later create.
  const stamp = { ino: 1n, size: 64n, mtimeNs: 1_000_000_000_000n, ctimeNs: 1_000_000_000_000n };
  const files = new Map<string, string>([["a.json", "11111111-1111-4111-8111-111111111111"]]);
  const source = { directoryStat: async () => stamp, files: async () => [...files.keys()], readId: async (file: string) => files.get(path.basename(file))!, fileStat: async () => ({ ...stamp, ino: 2n }) };
  const late = "22222222-2222-4222-8222-222222222222";
  const read = async (file: string) => ({ acceptance_id: files.get(path.basename(file))! });
  const racy = new WakeAcceptanceIndex("/store", source, () => stamp.mtimeNs + 1_000_000n);
  assert.equal(await racy.find(late, read), undefined);
  files.set("b.json", late);
  assert.equal((await racy.find(late, read))?.acceptance_id, late, "a write in the stamp's own tick is found");
  // Racy is judged when the stamp was taken, not when a slow scan ends.
  let clock = stamp.mtimeNs + 1_000_000n;
  const slowScan = new WakeAcceptanceIndex("/store", source, () => { const value = clock; clock += 3_000_000_000n; return value; });
  files.delete("b.json");
  assert.equal(await slowScan.find(late, read), undefined);
  files.set("b.json", late);
  assert.equal((await slowScan.find(late, read))?.acceptance_id, late, "a scan that outlived the window does not vouch for a stamp taken inside it");
  const settled = new WakeAcceptanceIndex("/store", source, () => stamp.mtimeNs + 10_000_000_000n);
  files.delete("b.json");
  assert.equal(await settled.find(late, read), undefined);
  files.set("b.json", late);
  assert.equal(await settled.find(late, read), undefined, "a settled, unchanged stamp is trusted: a miss reads nothing");
});

test("a stale lookup never unbinds the newer binding a concurrent sync installed", async () => {
  const old = "11111111-1111-4111-8111-111111111111"; const fresh = "22222222-2222-4222-8222-222222222222";
  let directory = { ino: 1n, size: 64n, mtimeNs: 1n, ctimeNs: 1n };
  const files = new Map<string, { id: string; ino: bigint }>([["f.json", { id: old, ino: 10n }]]);
  let gate: (() => void) | undefined;
  const source = {
    directoryStat: async () => directory, files: async () => [...files.keys()],
    fileStat: async (file: string) => { const entry = files.get(path.basename(file)); return entry && { ino: entry.ino, size: 1n, mtimeNs: 1n, ctimeNs: 1n }; },
    readId: async (file: string) => { if (path.basename(file) === "g.json" && gate === undefined) await new Promise<void>((resolve) => { gate = resolve; }); return files.get(path.basename(file))!.id; }
  };
  const index = new WakeAcceptanceIndex("/store", source, () => 10_000_000_000n);
  const read = async (file: string) => files.has(path.basename(file)) ? { acceptance_id: files.get(path.basename(file))!.id } : undefined;
  assert.equal((await index.find(old, read))?.acceptance_id, old);
  // Another process recreates f.json under a new id and adds g.json.
  files.set("f.json", { id: fresh, ino: 11n }); files.set("g.json", { id: "33333333-3333-4333-8333-333333333333", ino: 12n });
  directory = { ...directory, mtimeNs: 2n, ctimeNs: 2n };
  // The old-id lookup reads f.json before the sync rebinds it, and sees the new id only after.
  let releaseRead: (() => void) | undefined;
  const slowOld = index.find(old, async (file) => { await new Promise<void>((resolve) => { releaseRead = resolve; }); return await read(file); });
  const freshLookup = index.find(fresh, read);
  while (gate === undefined) await new Promise((resolve) => setImmediate(resolve));
  releaseRead!();
  // Let the stale lookup see its mismatch and unbind while the sync is still in flight.
  for (let turn = 0; turn < 10; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  gate();
  assert.equal(await slowOld, undefined);
  assert.equal((await freshLookup)?.acceptance_id, fresh, "the concurrent sync's binding survived the stale unbind");
  assert.equal((await index.find(fresh, read))?.acceptance_id, fresh);
});

test("a record that fails to read never lets the index outgrow the directory", async () => {
  let round = 0;
  const stat = () => ({ ino: BigInt(round), size: 1n, mtimeNs: BigInt(round), ctimeNs: BigInt(round) });
  const source = {
    directoryStat: async () => stat(), files: async () => [`good-${round}.json`, "bad.json"], fileStat: async () => stat(),
    readId: async (file: string) => { if (file.endsWith("/bad.json")) throw new SyntaxError("corrupt record"); return `00000000-0000-4000-8000-${String(round).padStart(12, "0")}`; }
  };
  const index = new WakeAcceptanceIndex("/store", source, () => 10_000_000_000n);
  for (round = 1; round <= 50; round += 1) await assert.rejects(index.find(randomUUID(), async () => undefined), /corrupt record/);
  assert.ok((index as unknown as { byFile: Map<string, unknown> }).byFile.size <= 2, "entries for files the directory no longer lists are pruned");
});

test("own writes behind a foreign compactor never grow the index past its bound", async () => {
  const files = new Map<string, string>();
  const source = { directoryStat: async () => ({ ino: 1n, size: 1n, mtimeNs: 1n, ctimeNs: 1n }), files: async () => [...files.keys()].map((file) => path.basename(file)), fileStat: async () => ({ ino: 1n, size: 1n, mtimeNs: 1n, ctimeNs: 1n }), readId: async (file: string) => files.get(file)! };
  const index = new WakeAcceptanceIndex("/store", source, () => 10_000_000_000n);
  for (let generation = 0; generation < 5_000; generation += 1) {
    files.clear();
    const id = `00000000-0000-4000-8000-${String(generation).padStart(12, "0")}`; const file = `/store/${generation}.json`;
    files.set(file, id); index.set(id, file);
    assert.equal((await index.find(id, async (candidate) => ({ acceptance_id: files.get(candidate)! })))?.acceptance_id, id);
  }
  assert.ok((index as unknown as { byFile: Map<string, unknown> }).byFile.size <= MAX_WAKE_ACCEPTANCE_RECORDS * 2);
});

test("compaction drops deleted receipts from the index and keeps survivors reachable", async () => {
  const root = await privateRoot();
  try {
    const ids: string[] = [];
    await Promise.all(Array.from({ length: 2_112 }, async (_, index) => {
      const parsed = request(`terminal-${index}`);
      const acceptanceId = randomUUID(); ids[index] = acceptanceId;
      const timestamp = new Date(index).toISOString();
      const record = { acceptance_id: acceptanceId, agent_id: parsed.agent_id, delivery_id: parsed.delivery_id, request_digest: wakeAcceptanceDigest(parsed), event: parsed.event, state: "completed", accepted_at: timestamp, updated_at: timestamp };
      await writeFile(path.join(root, recordFile(`terminal-${index}`)), JSON.stringify(record), { mode: 0o600 });
    }));
    const { store, reads } = await counted(root);
    assert.equal((await store.status(ids[0]!))?.delivery_id, "terminal-0");
    const latest = (await store.accept(request("terminal-2112"))).record;
    assert.equal(await store.status(ids[0]!), undefined, "a compacted receipt is gone");
    assert.equal((await store.status(ids[2_111]!))?.delivery_id, "terminal-2111");
    assert.equal((await store.status(latest.acceptance_id))?.state, "accepted");
    reads();
    for (let poll = 0; poll < 3; poll += 1) assert.equal(await store.status(ids[0]!), undefined);
    assert.equal(reads(), 0, "polling a compacted id does not rescan ~2,100 records");
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

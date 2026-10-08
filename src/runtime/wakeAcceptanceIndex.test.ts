import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { WakeAcceptanceIndex } from "./wakeAcceptanceIndex.js";
import { WakeAcceptanceStore, type WakeAcceptanceStoreTestOptions } from "./wakeAcceptanceStore.js";
import { parseWakeAcceptanceRequest, wakeAcceptanceDigest } from "./wakeAcceptanceTypes.js";

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
    // A foreign delete: the stale binding is dropped, never served.
    await unlink(path.join(root, recordFile("foreign")));
    assert.equal(await store.status(foreign.acceptance_id), undefined);
    // A foreign recreate of the same delivery binds a new id to the same file.
    const recreated = (await other.accept(request("foreign"))).record;
    assert.notEqual(recreated.acceptance_id, foreign.acceptance_id);
    assert.equal((await store.status(recreated.acceptance_id))?.acceptance_id, recreated.acceptance_id);
    assert.equal(await store.status(foreign.acceptance_id), undefined);
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
  const settled = new WakeAcceptanceIndex("/store", source, () => stamp.mtimeNs + 10_000_000_000n);
  files.delete("b.json");
  assert.equal(await settled.find(late, read), undefined);
  files.set("b.json", late);
  assert.equal(await settled.find(late, read), undefined, "a settled, unchanged stamp is trusted: a miss reads nothing");
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

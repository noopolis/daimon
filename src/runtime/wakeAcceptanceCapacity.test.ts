import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { WakeAcceptanceStore, WakeInboxFullError } from "./wakeAcceptanceStore.js";
import { parseWakeAcceptanceRequest } from "./wakeAcceptanceTypes.js";
import { MAX_WAKE_ACCEPTANCE_RECORDS, STALE_QUEUED_DELIVERY_MS, WAKE_ACCEPTANCE_COMPACTION_THRESHOLD, staleQueuedFilesToStop, terminalFilesToCompact, type RetentionCandidate } from "./wakeAcceptanceRetention.js";

// 2026-10-05 production: 1,940 terminal receipts, 213 deliveries parked in
// `accepted` for up to two weeks, and 148 `.host-online-*` markers left by
// dead hosts. Terminal compaction only ever dropped receipts past the newest
// 2,048 terminal ones, so it never ran; the store crossed its bound and every
// POST /v2/wakes answered 400 for an hour while the newsroom waited.
const identity = { pid: 1, process_start: "test-start", boot_id: "test-boot", pid_namespace_dev: 1, pid_namespace_ino: 1 };
const options = { processIdentity: async () => identity, ownerLiveness: async () => true };
const request = (delivery: string) => parseWakeAcceptanceRequest({ token: "t", agent_id: "alpha", delivery_id: delivery, event: { version: "noopolis.daimon.wake.v2", kind: "message", text: "hello", occurred_at: "2026-08-17T00:00:00.000Z" } });
// Age every queued record on disk, as two weeks of real time would have.
const ageQueued = async (root: string, ageMs: number): Promise<void> => {
  const at = new Date(Date.now() - ageMs).toISOString();
  for (const entry of (await readdir(root)).filter((name) => /^[a-f0-9]{64}\.json$/u.test(name))) {
    const file = path.join(root, entry); const record = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    if (record.state === "accepted") await writeFile(file, JSON.stringify({ ...record, accepted_at: at, updated_at: at }));
  }
};
const privateRoot = async (): Promise<string> => { const root = await mkdtemp(path.join(os.tmpdir(), "daimon-capacity-")); await chmod(root, 0o700); return root; };
const candidate = (index: number, state: RetentionCandidate["state"], ageMs = 0, now = Date.parse("2026-10-05T12:00:00.000Z")): RetentionCandidate => {
  const at = new Date(now - ageMs - index).toISOString();
  return { file: `${index}.json`, state, updatedAt: at, acceptedAt: at, acceptanceId: String(index).padStart(8, "0") };
};

test("compaction makes room even when parked work keeps terminal receipts under the idempotency horizon", () => {
  const records = [
    ...Array.from({ length: 1_940 }, (_, index) => candidate(index, "completed")),
    ...Array.from({ length: 213 }, (_, index) => candidate(10_000 + index, "accepted"))
  ];
  assert.ok(records.length >= WAKE_ACCEPTANCE_COMPACTION_THRESHOLD);
  const dropped = terminalFilesToCompact(records);
  assert.ok(records.length - dropped.length < WAKE_ACCEPTANCE_COMPACTION_THRESHOLD, `${records.length - dropped.length} records remain`);
  assert.ok(dropped.every((file) => Number(file.split(".")[0]) < 1_940), "only terminal receipts are ever compacted");
});

test("queued deliveries parked past the horizon are stopped, but claimed, running and recent work is not", () => {
  const now = Date.parse("2026-10-05T12:00:00.000Z");
  const stale = { ...candidate(1, "accepted", STALE_QUEUED_DELIVERY_MS + 60_000, now), claimed: false };
  const claimed = { ...candidate(2, "accepted", STALE_QUEUED_DELIVERY_MS + 60_000, now), claimed: true };
  const running = { ...candidate(3, "running", STALE_QUEUED_DELIVERY_MS + 60_000, now), claimed: false };
  const recent = { ...candidate(4, "accepted", 60_000, now), claimed: false };
  assert.deepEqual(staleQueuedFilesToStop([stale, claimed, running, recent], now), ["1.json"]);
});

test("a store full of long-parked deliveries still accepts a new wake", async () => {
  const root = await privateRoot();
  try {
    const filling = await WakeAcceptanceStore.open(root, options);
    for (let index = 0; index < MAX_WAKE_ACCEPTANCE_RECORDS; index++) await filling.accept(request(`old-${index}`));
    await assert.rejects(filling.accept(request("today")), WakeInboxFullError, "a fresh store with only recent work is genuinely full");
    await filling.close();
    await ageQueued(root, STALE_QUEUED_DELIVERY_MS + 60_000);
    const later = await WakeAcceptanceStore.open(root, options);
    assert.equal((await later.accept(request("today"))).created, true);
    assert.deepEqual((await later.recoverable(new Set(["alpha"]))).map((record) => record.delivery_id), ["today"], "the parked deliveries left the queue and today's wake heads it");
    await later.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("opening the store prunes markers of dead hosts in its namespace and keeps live ones", async () => {
  const root = await privateRoot();
  try {
    const dead = randomUUID(), live = randomUUID();
    const marker = async (owner: string, pid: number) => { const file = path.join(root, `.host-online-${owner}.json`); await writeFile(file, JSON.stringify({ owner_id: owner, ...identity, pid })); await chmod(file, 0o600); };
    await marker(dead, 41); await marker(live, 42);
    const sibling = randomUUID(); await marker(sibling, identity.pid);
    const store = await WakeAcceptanceStore.open(root, { ...options, ownerLiveness: async (lock) => lock.pid !== 41 && lock.pid !== identity.pid });
    const markers = (await readdir(root)).filter((entry) => entry.startsWith(".host-online-"));
    assert.ok(!markers.includes(`.host-online-${dead}.json`), "a dead host's marker is removed");
    assert.ok(markers.includes(`.host-online-${live}.json`), "a live host's marker is kept");
    assert.ok(markers.includes(`.host-online-${sibling}.json`), "a marker from this same live process is never pruned, whatever liveness says");
    assert.equal(markers.length, 3, "the opening host registered itself");
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a store whose directory is over its entry bound refuses as queue-full, not as a malformed request", async () => {
  const root = await privateRoot();
  try {
    const store = await WakeAcceptanceStore.open(root, options);
    for (let index = 0; index <= MAX_WAKE_ACCEPTANCE_RECORDS + 128; index++) await writeFile(path.join(root, `.stray-${index}`), "");
    await assert.rejects(store.accept(request("today")), WakeInboxFullError);
    await store.close().catch(() => undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a long-parked delivery is no longer offered ahead of today's mail, even below the compaction threshold", async () => {
  const root = await privateRoot();
  try {
    const early = await WakeAcceptanceStore.open(root, options);
    await early.accept(request("two-weeks-old"));
    await early.close();
    await ageQueued(root, STALE_QUEUED_DELIVERY_MS + 60_000);
    const later = await WakeAcceptanceStore.open(root, options);
    await later.accept(request("today"));
    assert.deepEqual((await later.recoverable(new Set(["alpha"]))).map((record) => record.delivery_id), ["today"]);
    await later.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

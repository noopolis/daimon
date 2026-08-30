import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants, readFileSync } from "node:fs";
import { chmod, lstat, mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { publishExclusive, reconcileOfflineWakeTransition, type OfflineTransitionReconciliationRequest } from "./wakeAcceptanceReconciliation.js";
import { WakeAcceptanceStore } from "./wakeAcceptanceStore.js";
import { hostRegistrationDigest } from "./storeCoordination.js";
import { parseWakeAcceptanceRequest } from "./wakeAcceptanceTypes.js";

const agent = "alpha";
const testStoreOptions = { processIdentity: async () => ({ pid: 1, process_start: "test-start", boot_id: "test-boot", pid_namespace_dev: 1, pid_namespace_ino: 1 }), ownerLiveness: async () => true };
const testLeaseOptions = { leaseIdentity: async () => ({ owner_id: "77777777-7777-4777-8777-777777777777", pid: 1, process_start: "admin-start", boot_id: "admin-boot", pid_namespace_dev: 1, pid_namespace_ino: 1 }), leaseLiveness: async () => true, hostLiveness: async () => false };
const wake = (delivery = "offline") => ({ token: undefined, agent_id: agent, delivery_id: delivery, event: { version: "noopolis.daimon.wake.v2" as const, kind: "manual" as const, text: "private", occurred_at: "2026-08-17T00:00:00.000Z" } });

test("offline reconciliation atomically fences an attested exact stale lock and is redacted-idempotent", async () => {
  const root = await privateRoot();
  try {
    const held = await heldLock(root, "exact");
    const request = await reconciliationRequest(root, "exact");
    const result = await reconcileOfflineWakeTransition(request, { storePath: root, ...testLeaseOptions, verifyDeploymentAttestation: async (context, attestation) => { assert.equal(attestation.state, "absent"); return { request_digest: context.request_digest, nonce: context.nonce, exclusive_store: true, authorized_registration_digests: [] }; } });
    assert.equal(result.state, "reconciled");
    if (result.state !== "reconciled") throw new Error("expected reconciliation");
    const replay = await reconcileOfflineWakeTransition(request, { storePath: root, ...testLeaseOptions, verifyDeploymentAttestation: async () => { throw new Error("replay must not inspect proof"); } });
    assert.deepEqual(replay, result);
    const changedProof = await reconcileOfflineWakeTransition({ ...request, attestation: { ...request.attestation, proof: "different" } }, { storePath: root, ...testLeaseOptions, verifyDeploymentAttestation: async (context) => ({ request_digest: context.request_digest, nonce: context.nonce, exclusive_store: true, authorized_registration_digests: [] }) });
    assert.deepEqual(changedProof, { version: "noopolis.daimon.offline-transition-reconciliation.v1", state: "blocked", code: "offline_reconciliation_required" });
    const receipts = (await readFile(path.join(root, receiptName(request)), "utf8"));
    assert.equal(receipts.includes("proof"), false);
    held.resume();
    await assert.rejects(held.completing, /claim was lost/);
    await closeAbandonedStore(held.store);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("offline reconciliation blocks untrusted proof, identity mismatch, and concurrent administration", async () => {
  const root = await privateRoot();
  try {
    const held = await heldLock(root, "blocked");
    const request = await reconciliationRequest(root, "blocked");
    const denied = await reconcileOfflineWakeTransition(request, { storePath: root, ...testLeaseOptions, verifyDeploymentAttestation: async () => { throw new Error("not attested"); } });
    assert.equal(denied.state, "blocked");
    const wrongContext = await reconcileOfflineWakeTransition(request, { storePath: root, ...testLeaseOptions, verifyDeploymentAttestation: async (context) => ({ request_digest: "0".repeat(64), nonce: context.nonce, exclusive_store: true, authorized_registration_digests: [] }) });
    assert.equal(wrongContext.state, "blocked");
    const mismatch = await reconcileOfflineWakeTransition({ ...request, lock: { ...request.lock, ino: request.lock.ino + 1 } }, { storePath: root, ...testLeaseOptions, verifyDeploymentAttestation: async (context) => ({ request_digest: context.request_digest, nonce: context.nonce, exclusive_store: true, authorized_registration_digests: [] }) });
    assert.equal(mismatch.state, "blocked");
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const first = reconcileOfflineWakeTransition(request, { storePath: root, ...testLeaseOptions, verifyDeploymentAttestation: async (context) => { await paused; return { request_digest: context.request_digest, nonce: context.nonce, exclusive_store: true, authorized_registration_digests: [] }; } });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await assert.rejects(WakeAcceptanceStore.open(root, testStoreOptions), /reserved for offline reconciliation/);
    const concurrent = await reconcileOfflineWakeTransition(request, { storePath: root, ...testLeaseOptions, verifyDeploymentAttestation: async (context) => ({ request_digest: context.request_digest, nonce: context.nonce, exclusive_store: true, authorized_registration_digests: [] }) });
    assert.equal(concurrent.state, "blocked");
    release();
    assert.equal((await first).state, "reconciled");
    held.resume();
    await assert.rejects(held.completing, /claim was lost/);
    await closeAbandonedStore(held.store);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("cross-namespace registrations require exact deployment-authorized identities", async () => {
  const root = await privateRoot();
  const crossNamespace = { ...testStoreOptions, processIdentity: async () => ({ pid: 2, process_start: "old-container", boot_id: "old-boot", pid_namespace_dev: 2, pid_namespace_ino: 2 }) };
  try {
    const held = await heldLock(root, "cross", crossNamespace);
    const request = await reconciliationRequest(root, "cross");
    const unlisted = await reconcileOfflineWakeTransition(request, { storePath: root, ...testLeaseOptions, verifyDeploymentAttestation: async (context) => ({ request_digest: context.request_digest, nonce: context.nonce, exclusive_store: true, authorized_registration_digests: [] }) });
    assert.equal(unlisted.state, "blocked");
    const recovered = await reconcileOfflineWakeTransition(request, { storePath: root, ...testLeaseOptions, verifyDeploymentAttestation: async (context) => {
      assert.equal(context.stale_host_registrations.length, 1);
      return { request_digest: context.request_digest, nonce: context.nonce, exclusive_store: true, authorized_registration_digests: context.stale_host_registrations.map(hostRegistrationDigest) };
    } });
    assert.equal(recovered.state, "reconciled");
    if (recovered.state !== "reconciled") throw new Error("expected reconciliation");
    assert.equal(recovered.cleared_registration_digests.length, 1);
    held.resume();
    await assert.rejects(held.completing, /claim was lost/);
    await closeAbandonedStore(held.store);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("mutated attested registration blocks offline reconciliation", async () => {
  const root = await privateRoot();
  const crossNamespace = { ...testStoreOptions, processIdentity: async () => ({ pid: 2, process_start: "old-container", boot_id: "old-boot", pid_namespace_dev: 2, pid_namespace_ino: 2 }) };
  try {
    const held = await heldLock(root, "mutated", crossNamespace);
    const request = await reconciliationRequest(root, "mutated");
    const result = await reconcileOfflineWakeTransition(request, { storePath: root, ...testLeaseOptions, verifyDeploymentAttestation: async (context) => {
      const host = context.stale_host_registrations[0];
      if (host === undefined) throw new Error("missing host registration");
      const { dev: _dev, ino: _ino, ...record } = host;
      await writeFile(path.join(root, `.host-online-${host.owner_id}.json`), JSON.stringify({ ...record, process_start: "changed" }));
      return { request_digest: context.request_digest, nonce: context.nonce, exclusive_store: true, authorized_registration_digests: [hostRegistrationDigest(host)] };
    } });
    assert.equal(result.state, "blocked");
    held.resume();
    await held.completing;
    await closeAbandonedStore(held.store);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a prepared receipt resumes after a reconciliation crash window", async () => {
  const root = await privateRoot();
  try {
    const held = await heldLock(root, "retry");
    const request = await reconciliationRequest(root, "retry");
    const receipt = path.join(root, receiptName(request));
    await writeFile(receipt, JSON.stringify({ version: "noopolis.daimon.offline-transition-reconciliation-receipt.v1", reconciliation_id: "99999999-9999-4999-8999-999999999999", request_digest: createHash("sha256").update(JSON.stringify(request)).digest("hex"), state: "prepared", reconciled_at: "", cleared_registration_digests: [] }), { mode: 0o600 });
    await chmod(receipt, 0o600);
    const result = await reconcileOfflineWakeTransition(request, { storePath: root, ...testLeaseOptions, verifyDeploymentAttestation: async (context) => ({ request_digest: context.request_digest, nonce: context.nonce, exclusive_store: true, authorized_registration_digests: [] }) });
    assert.equal(result.state, "reconciled");
    held.resume();
    await assert.rejects(held.completing, /claim was lost/);
    await closeAbandonedStore(held.store);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an admin lease scan preserves a host registered before it", async () => {
  const root = await privateRoot();
  try {
    const host = await WakeAcceptanceStore.open(root, testStoreOptions);
    const before = await hostRegistrations(root);
    const result = await reconcileOfflineWakeTransition(await emptyReconciliationRequest(root), { storePath: root, ...testLeaseOptions, hostLiveness: async () => true, verifyDeploymentAttestation: async (context) => ({ request_digest: context.request_digest, nonce: context.nonce, exclusive_store: true, authorized_registration_digests: [] }) });
    assert.equal(result.state, "blocked");
    assert.deepEqual(await hostRegistrations(root), before);
    await host.close();
    assert.deepEqual(await hostRegistrations(root), []);
    assert.equal((await readdir(root)).includes(".offline-reconciliation.lock"), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a host aborts and cleans its registration when admin leases after its initial check", async () => {
  const root = await privateRoot();
  let initialPassed!: () => void;
  let releaseHost!: () => void;
  const initial = new Promise<void>((resolve) => { initialPassed = resolve; });
  const resumeHost = new Promise<void>((resolve) => { releaseHost = resolve; });
  let leaseCreated!: () => void;
  let releaseAdmin!: () => void;
  const leased = new Promise<void>((resolve) => { leaseCreated = resolve; });
  const resumeAdmin = new Promise<void>((resolve) => { releaseAdmin = resolve; });
  try {
    const openingOptions = { ...testStoreOptions, afterInitialLeaseCheckForTest: async () => { initialPassed(); await resumeHost; } };
    const opening = WakeAcceptanceStore.open(root, openingOptions);
    await initial;
    const admin = reconcileOfflineWakeTransition(await emptyReconciliationRequest(root), { storePath: root, ...testLeaseOptions, verifyDeploymentAttestation: async (context) => { leaseCreated(); await resumeAdmin; return { request_digest: context.request_digest, nonce: context.nonce, exclusive_store: true, authorized_registration_digests: [] }; } });
    await leased;
    releaseHost();
    await assert.rejects(opening, /reserved for offline reconciliation/);
    assert.deepEqual(await hostRegistrations(root), []);
    releaseAdmin();
    assert.equal((await admin).state, "blocked");
    assert.deepEqual(await hostRegistrations(root), []);
    assert.equal((await readdir(root)).includes(".offline-reconciliation.lock"), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function heldLock(root: string, delivery: string, ownerOptions = testStoreOptions) {
  const store = await WakeAcceptanceStore.open(root, testStoreOptions);
  const accepted = await store.accept(parseWakeAcceptanceRequest(wake(delivery)));
  const claim = await store.acquireClaim(accepted.record.acceptance_id, "66666666-6666-4666-8666-666666666666");
  if (claim.state !== "acquired") throw new Error("claim missing");
  await store.transitionClaimed(accepted.record.acceptance_id, claim.claim, "running");
  let resume!: () => void;
  const paused = new Promise<void>((resolve) => { resume = resolve; });
  let reached!: () => void;
  const locked = new Promise<void>((resolve) => { reached = resolve; });
  const owner = await WakeAcceptanceStore.open(root, { ...ownerOptions, afterFinalLockAssertion: async () => { reached(); await paused; } });
  const completing = owner.transitionClaimed(accepted.record.acceptance_id, claim.claim, "completed");
  await locked;
  await store.close();
  return { store: owner, resume, completing };
}

async function reconciliationRequest(root: string, delivery: string): Promise<OfflineTransitionReconciliationRequest> {
  const file = `${createHash("sha256").update(`${agent}\u0000${delivery}`).digest("hex")}.transition-lock`;
  const [store, lock, raw] = await Promise.all([lstat(root), lstat(path.join(root, file)), readFile(path.join(root, file), "utf8")]);
  const identity = JSON.parse(raw) as Record<string, unknown>;
  return {
    version: "noopolis.daimon.offline-transition-reconciliation.v1", agent_id: agent, delivery_id: delivery,
    store: { dev: Number(store.dev), ino: Number(store.ino) },
    lock: { dev: Number(lock.dev), ino: Number(lock.ino), owner_id: identity.owner_id as string, generation: identity.generation as string, pid: identity.pid as number, process_start: identity.process_start as string, boot_id: identity.boot_id as string, pid_namespace_dev: identity.pid_namespace_dev as number, pid_namespace_ino: identity.pid_namespace_ino as number },
    attestation: { version: "noopolis.deployment.container-quiescence.v1", authority_id: "deployment", attestation_id: "attestation", state: "absent", proof: "opaque-attestation" }
  };
}

async function emptyReconciliationRequest(root: string): Promise<OfflineTransitionReconciliationRequest> {
  const store = await lstat(root);
  return { version: "noopolis.daimon.offline-transition-reconciliation.v1", agent_id: agent, delivery_id: "empty", store: { dev: Number(store.dev), ino: Number(store.ino) }, lock: { dev: 1, ino: 1, owner_id: "88888888-8888-4888-8888-888888888888", generation: "99999999-9999-4999-8999-999999999999", pid: 1, process_start: "old", boot_id: "old", pid_namespace_dev: 1, pid_namespace_ino: 1 }, attestation: { version: "noopolis.deployment.container-quiescence.v1", authority_id: "deployment", attestation_id: "empty-attestation", state: "absent", proof: "opaque-attestation" } };
}

function receiptName(request: OfflineTransitionReconciliationRequest): string { return `.reconcile-${createHash("sha256").update(JSON.stringify({ store: request.store, lock: request.lock })).digest("hex")}.json`; }
async function hostRegistrations(root: string): Promise<string[]> { return (await readdir(root)).filter((entry) => entry.startsWith(".host-online-")).sort(); }
async function closeAbandonedStore(store: WakeAcceptanceStore): Promise<void> { await (store as unknown as { directory: { close(): Promise<void> } }).directory.close(); }
async function privateRoot(): Promise<string> { const root = await mkdtemp(path.join(os.tmpdir(), "daimon-reconcile-")); await chmod(root, 0o700); return root; }

test("the offline reconciliation lease is never published under its final name with unparseable content", async () => {
  const root = await privateRoot();
  try {
    const request = await emptyReconciliationRequest(root);
    const leasePath = path.join(root, ".offline-reconciliation.lock");
    let torn = 0;
    for (let trial = 0; trial < 25; trial += 1) {
      let done = false;
      const reconcile = reconcileOfflineWakeTransition(request, {
        storePath: root, ...testLeaseOptions,
        verifyDeploymentAttestation: async (context) => ({ request_digest: context.request_digest, nonce: context.nonce, exclusive_store: true, authorized_registration_digests: [] })
      }).catch(() => undefined).finally(() => { done = true; });
      const probe = new Promise<void>((resolve) => {
        const tick = (): void => {
          let raw: string | undefined;
          try { raw = readFileSync(leasePath, "utf8"); } catch { raw = undefined; }
          if (raw !== undefined) { try { JSON.parse(raw); } catch { torn += 1; } }
          if (done) resolve(); else setImmediate(tick);
        };
        setImmediate(tick);
      });
      await Promise.all([reconcile, probe]);
    }
    assert.equal(torn, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a lease acquisition that loses the publish race is reported as blocked and leaves no temp files", async () => {
  const root = await privateRoot();
  try {
    const request = await emptyReconciliationRequest(root);
    let reached!: () => void;
    let release!: () => void;
    const acquired = new Promise<void>((resolve) => { reached = resolve; });
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const first = reconcileOfflineWakeTransition(request, { storePath: root, ...testLeaseOptions, verifyDeploymentAttestation: async (context) => { reached(); await paused; return { request_digest: context.request_digest, nonce: context.nonce, exclusive_store: true, authorized_registration_digests: [] }; } });
    await acquired;
    const second = await reconcileOfflineWakeTransition(request, { storePath: root, ...testLeaseOptions, verifyDeploymentAttestation: async (context) => ({ request_digest: context.request_digest, nonce: context.nonce, exclusive_store: true, authorized_registration_digests: [] }) });
    assert.equal(second.state, "blocked");
    release();
    await first;
    assert.equal((await readdir(root)).some((entry) => /\.offline-reconciliation\.lock\./u.test(entry)), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("publishExclusive refuses to overwrite an existing name and leaves its content untouched", async () => {
  const root = await privateRoot();
  try {
    const directory = await open(root, constants.O_RDONLY);
    try {
      const target = path.join(root, "publish-target.json");
      const existing = JSON.stringify({ owner_id: "already-published" });
      await writeFile(target, existing, { mode: 0o600 });

      await assert.rejects(
        publishExclusive(target, { owner_id: "usurper" }, directory),
        (error: NodeJS.ErrnoException) => error.code === "EEXIST"
      );

      // rename(2) would have silently overwritten both of these assertions away.
      assert.equal(await readFile(target, "utf8"), existing);
      assert.equal((await readdir(root)).some((entry) => entry.startsWith("publish-target.json.")), false);

      // The same primitive still publishes complete content onto a free name.
      const fresh = path.join(root, "publish-fresh.json");
      await publishExclusive(fresh, { owner_id: "published" }, directory);
      assert.deepEqual(JSON.parse(await readFile(fresh, "utf8")), { owner_id: "published" });
      assert.equal((await readdir(root)).some((entry) => entry.startsWith("publish-fresh.json.")), false);
    } finally { await directory.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

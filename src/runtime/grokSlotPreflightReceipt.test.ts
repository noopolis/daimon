import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { resolveOrganizationGrokBrokerProjection } from "./grokBrokerProjection.js";
import { parseGrokSlotPreflightReceipt, verifyGrokSlotPreflightReceipt } from "./grokSlotPreflightReceipt.js";

const fresh = { expectedNonce: "5f0e2a1c9b8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f", minGeneration: 3 } as const;

const fixture = async (name: string): Promise<Record<string, unknown>> => JSON.parse(await readFile(new URL(`./fixtures/grok-slot-preflight/${name}`, import.meta.url), "utf8")) as Record<string, unknown>;
const projection = async () => { const input = await fixture("projection-input.json") as { config: unknown; agentId: string; options: Parameters<typeof resolveOrganizationGrokBrokerProjection>[2] }; return resolveOrganizationGrokBrokerProjection(input.config, input.agentId, input.options); };

test("the committed valid receipt fixture proves the committed projection input", async () => {
  const receipt = verifyGrokSlotPreflightReceipt(await fixture("receipt.valid.v2.json"), await projection(), fresh);
  assert.equal(receipt.canaries.length, (await projection()).denyPaths.length);
  assert.ok(receipt.canaries.every((canary) => canary.method === "sandboxed-read" && canary.result === "denied"));
});

test("the schema refuses a readable canary, an unknown member, duplicates and malformed digests or times", async () => {
  const valid = await fixture("receipt.valid.v2.json");
  await assert.rejects(async () => parseGrokSlotPreflightReceipt(await fixture("receipt.readable-canary.json")), /invalid Grok slot preflight receipt/u);
  await assert.rejects(async () => parseGrokSlotPreflightReceipt(await fixture("receipt.unknown-member.json")), /invalid Grok slot preflight receipt/u);
  const canaries = valid.canaries as Record<string, unknown>[];
  for (const bad of [
    { ...valid, canaries: [...canaries, canaries[0]] },
    { ...valid, canaries: [{ ...canaries[0], method: "stat" }] },
    { ...valid, canaries: [{ ...canaries[0], path: "/run/../etc" }] },
    { ...valid, canaries: [{ ...canaries[0], extra: true }] },
    { ...valid, canaries: [] },
    { ...valid, projection_sha256: "A".repeat(64) },
    { ...valid, worker_uid: 2_000 },
    { ...valid, created_at: "2026-09-17T12:00:00Z" },
    { ...valid, version: "noopolis.daimon.grok-slot-preflight.v3" }
  ]) assert.throws(() => parseGrokSlotPreflightReceipt(bad), /invalid Grok slot preflight receipt/u);
});

test("a receipt for a different projection, slot, profile or deny set is refused", async () => {
  const projected = await projection();
  const valid = await fixture("receipt.valid.v2.json");
  // Mutation guard: dropping the digest comparison accepts this fixture.
  await assert.rejects(async () => verifyGrokSlotPreflightReceipt(await fixture("receipt.projection-mismatch.json"), projected, fresh), /projection_sha256/u);
  await assert.rejects(async () => verifyGrokSlotPreflightReceipt(await fixture("receipt.missing-canary.json"), projected, fresh), /canaries/u);
  // Exact match, both halves: a canary for a path the projection does not deny is as wrong as a missing one.
  await assert.rejects(async () => verifyGrokSlotPreflightReceipt(await fixture("receipt.extra-canary.json"), projected, fresh), /canaries/u);
  assert.throws(() => verifyGrokSlotPreflightReceipt(valid, { ...projected, limits: { ...projected.limits, maxTokens: 1 } }, fresh), /projection_sha256/u);
  assert.throws(() => verifyGrokSlotPreflightReceipt({ ...valid, sandbox_profile_sha256: "1".repeat(64) }, projected, fresh), /sandbox_profile_sha256/u);
  assert.throws(() => verifyGrokSlotPreflightReceipt({ ...valid, slot: 1 }, projected, fresh), /slot/u);
  // Mutation guard: never comparing the seccomp digest accepts a receipt taken under another profile.
  assert.throws(() => verifyGrokSlotPreflightReceipt({ ...valid, seccomp_profile_sha256: "8".repeat(64) }, projected, fresh), /seccomp_profile_sha256/u);
  assert.throws(() => parseGrokSlotPreflightReceipt({ ...valid, sandbox_runtime: "none" }), /invalid Grok slot preflight receipt/u);
  assert.throws(() => parseGrokSlotPreflightReceipt((({ sandbox_runtime: _omit, ...rest }) => rest)(valid)), /invalid Grok slot preflight receipt/u);
});

test("a receipt from an earlier recycle is refused: another nonce, a lower generation, or a v1 receipt without freshness", async () => {
  const projected = await projection();
  const valid = await fixture("receipt.valid.v2.json");
  assert.equal(verifyGrokSlotPreflightReceipt(valid, projected, { ...fresh, minGeneration: 1 }).generation, 3);
  // Mutation guard: ignoring the nonce accepts a receipt written for another recycle request.
  assert.throws(() => verifyGrokSlotPreflightReceipt(valid, projected, { ...fresh, expectedNonce: "a".repeat(64) }), /stale: nonce/u);
  // Mutation guard: ignoring the generation accepts a receipt older than the last one accepted.
  assert.throws(() => verifyGrokSlotPreflightReceipt(valid, projected, { ...fresh, minGeneration: 4 }), /stale: generation/u);
  await assert.rejects(async () => verifyGrokSlotPreflightReceipt(await fixture("receipt.legacy-v1.json"), projected, fresh), /invalid Grok slot preflight receipt/u);
  for (const bad of [{ ...valid, nonce: "A".repeat(64) }, { ...valid, nonce: "ab" }, { ...valid, generation: 0 }, { ...valid, generation: 1.5 }, (({ nonce: _omit, ...rest }) => rest)(valid), (({ generation: _omit, ...rest }) => rest)(valid)]) {
    assert.throws(() => parseGrokSlotPreflightReceipt(bad), /invalid Grok slot preflight receipt/u);
  }
  for (const freshness of [{ expectedNonce: "short", minGeneration: 1 }, { expectedNonce: fresh.expectedNonce, minGeneration: 0 }, { expectedNonce: fresh.expectedNonce.toUpperCase(), minGeneration: 1 }]) {
    assert.throws(() => verifyGrokSlotPreflightReceipt(valid, projected, freshness), /invalid Grok slot preflight freshness/u);
  }
});

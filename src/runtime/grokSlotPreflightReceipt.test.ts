import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { resolveOrganizationGrokBrokerProjection } from "./grokBrokerProjection.js";
import { parseGrokSlotPreflightReceipt, verifyGrokSlotPreflightReceipt } from "./grokSlotPreflightReceipt.js";

const fixture = async (name: string): Promise<Record<string, unknown>> => JSON.parse(await readFile(new URL(`./fixtures/grok-slot-preflight/${name}`, import.meta.url), "utf8")) as Record<string, unknown>;
const projection = async () => { const input = await fixture("projection-input.json") as { config: unknown; agentId: string; options: Parameters<typeof resolveOrganizationGrokBrokerProjection>[2] }; return resolveOrganizationGrokBrokerProjection(input.config, input.agentId, input.options); };

test("the committed valid receipt fixture proves the committed projection input", async () => {
  const receipt = verifyGrokSlotPreflightReceipt(await fixture("receipt.valid.v1.json"), await projection());
  assert.equal(receipt.canaries.length, (await projection()).denyPaths.length);
  assert.ok(receipt.canaries.every((canary) => canary.method === "sandboxed-read" && canary.result === "denied"));
});

test("the schema refuses a readable canary, an unknown member, duplicates and malformed digests or times", async () => {
  const valid = await fixture("receipt.valid.v1.json");
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
    { ...valid, version: "noopolis.daimon.grok-slot-preflight.v2" }
  ]) assert.throws(() => parseGrokSlotPreflightReceipt(bad), /invalid Grok slot preflight receipt/u);
});

test("a receipt for a different projection, slot, profile or deny set is refused", async () => {
  const projected = await projection();
  const valid = await fixture("receipt.valid.v1.json");
  // Mutation guard: dropping the digest comparison accepts this fixture.
  await assert.rejects(async () => verifyGrokSlotPreflightReceipt(await fixture("receipt.projection-mismatch.json"), projected), /projection_sha256/u);
  await assert.rejects(async () => verifyGrokSlotPreflightReceipt(await fixture("receipt.missing-canary.json"), projected), /canaries/u);
  assert.throws(() => verifyGrokSlotPreflightReceipt(valid, { ...projected, limits: { ...projected.limits, maxTokens: 1 } }), /projection_sha256/u);
  assert.throws(() => verifyGrokSlotPreflightReceipt({ ...valid, sandbox_profile_sha256: "1".repeat(64) }, projected), /sandbox_profile_sha256/u);
  assert.throws(() => verifyGrokSlotPreflightReceipt({ ...valid, slot: 1 }, projected), /slot/u);
});

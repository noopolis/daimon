import path from "node:path";
import { z } from "zod";

import { GROK_ENGINE_BROKER } from "../contracts/runtimeContractManifest.js";
import { grokBrokerProjectionSha256, type OrganizationGrokBrokerProjection } from "./grokBrokerProjection.js";

export const GROK_SLOT_PREFLIGHT_VERSION = GROK_ENGINE_BROKER.slotPreflightVersion;

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const NONCE = /^[a-f0-9]{64}$/u;
const canonicalAbsolute = z.string().max(4_096).refine((value) => path.posix.isAbsolute(value) && path.posix.normalize(value) === value && value !== "/" && !value.endsWith("/") && !value.includes("\0"), "canonical absolute path");

/**
 * One denied-path canary: the root supervisor ran a real sandboxed read of
 * `path` as the slot's worker uid (a stub-model turn under the attested
 * profile) and the read was denied. Only denials are representable — a
 * supervisor that observed a readable path writes no receipt at all.
 */
export const grokSlotPreflightCanarySchema = z.strictObject({
  path: canonicalAbsolute,
  method: z.literal("sandboxed-read"),
  result: z.literal("denied")
});

/**
 * `noopolis.daimon.grok-slot-preflight.v2`: what the root slot supervisor (P5)
 * writes after provisioning or recycling one broker slot, and what an
 * evaluator (Paideia, P4) must hold before it runs a Grok subject turn in that
 * slot. It binds the slot to one exact projection by digest, so any change to
 * the model, limits, deny list, profile, worker config, or pinned executable
 * invalidates it.
 *
 * The projection digest is identical across recycles of the same slot, so v1
 * could not tell this recycle's receipt from an earlier one. v2 adds
 * freshness: `generation` is the supervisor-owned per-slot counter, strictly
 * increasing on every provision/recycle, and `nonce` echoes the 32 random
 * bytes (hex) the evaluator passed in its recycle request. A v1 receipt is
 * refused.
 */
export const grokSlotPreflightReceiptSchema = z.strictObject({
  version: z.literal(GROK_SLOT_PREFLIGHT_VERSION),
  slot: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  worker_uid: z.number().int().min(GROK_ENGINE_BROKER.identities.firstWorkerUid).max(4_294_967_294),
  /** Supervisor-owned, strictly increasing per slot across provisions and recycles; starts at 1. */
  generation: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  /** The caller's recycle nonce: 32 random bytes, lowercase hex. */
  nonce: z.string().regex(NONCE),
  projection_sha256: sha256,
  /** The bubblewrap/Landlock `daimon-strict` profile bytes' digest (the projection's `profileSha256`). */
  sandbox_profile_sha256: sha256,
  /** The container seccomp profile the worker ran under. */
  seccomp_profile_sha256: sha256,
  /** Grok 1.0.34 runs every profile inside bubblewrap; the supervisor observed it present and working. */
  sandbox_runtime: z.literal("bubblewrap"),
  grok_executable_sha256: sha256,
  canaries: z.array(grokSlotPreflightCanarySchema).min(1).max(256),
  created_at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u).refine((value) => !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value, "exact RFC3339 timestamp")
}).superRefine((receipt, context) => {
  const paths = receipt.canaries.map((canary) => canary.path);
  if (new Set(paths).size !== paths.length) context.addIssue({ code: "custom", path: ["canaries"], message: "duplicate canary path" });
});

export type GrokSlotPreflightReceipt = z.infer<typeof grokSlotPreflightReceiptSchema>;

/** Strict parse: unknown members, off-contract values, or duplicate canaries throw. */
export function parseGrokSlotPreflightReceipt(value: unknown): GrokSlotPreflightReceipt {
  const result = grokSlotPreflightReceiptSchema.safeParse(value);
  if (!result.success) throw new TypeError(`invalid Grok slot preflight receipt: ${result.error.issues.map((issue) => `${issue.path.join(".") || "receipt"}: ${issue.message}`).join("; ")}`);
  return result.data;
}

/**
 * What the evaluator knows about *this* recycle: the nonce it sent, and the
 * lowest generation it will accept — one above the last generation it
 * accepted for the slot (1 for a slot it has never seen).
 */
export type GrokSlotPreflightFreshness = Readonly<{ expectedNonce: string; minGeneration: number }>;

/**
 * Parse a receipt and require that it proves *this* projection's slot: same
 * digest, slot, worker uid, profile and executable, and a denied canary for
 * exactly every projected deny path (no more, no fewer), under the projected
 * seccomp profile and sandbox runtime — and that it is *this* recycle's
 * receipt: the caller's nonce, at or above the caller's minimum generation.
 * A receipt replayed from an earlier recycle fails on the nonce, and one
 * whose generation went backwards fails on the generation.
 */
export function verifyGrokSlotPreflightReceipt(value: unknown, projection: OrganizationGrokBrokerProjection, freshness: GrokSlotPreflightFreshness): GrokSlotPreflightReceipt {
  if (freshness === null || typeof freshness !== "object" || typeof freshness.expectedNonce !== "string" || !NONCE.test(freshness.expectedNonce) || !Number.isSafeInteger(freshness.minGeneration) || freshness.minGeneration < 1) throw new TypeError("invalid Grok slot preflight freshness");
  const receipt = parseGrokSlotPreflightReceipt(value);
  const mismatch = (member: string): never => { throw new Error(`Grok slot preflight receipt does not match the projection: ${member}`); };
  if (receipt.nonce !== freshness.expectedNonce) throw new Error("Grok slot preflight receipt is stale: nonce");
  if (receipt.generation < freshness.minGeneration) throw new Error("Grok slot preflight receipt is stale: generation");
  if (receipt.projection_sha256 !== grokBrokerProjectionSha256(projection)) mismatch("projection_sha256");
  if (receipt.slot !== projection.slot) mismatch("slot");
  if (receipt.worker_uid !== projection.workerUid) mismatch("worker_uid");
  if (receipt.sandbox_profile_sha256 !== projection.profileSha256) mismatch("sandbox_profile_sha256");
  if (receipt.grok_executable_sha256 !== projection.grokExecutableSha256) mismatch("grok_executable_sha256");
  if (receipt.seccomp_profile_sha256 !== projection.seccompProfileSha256) mismatch("seccomp_profile_sha256");
  if (receipt.sandbox_runtime !== projection.attestation.sandboxRuntime) mismatch("sandbox_runtime");
  const denied = receipt.canaries.map((canary) => canary.path).sort();
  if (denied.length !== projection.denyPaths.length || denied.some((entry, index) => entry !== projection.denyPaths[index])) mismatch("canaries");
  return receipt;
}

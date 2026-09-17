import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { GROK_ENGINE_BROKER } from "../contracts/runtimeContractManifest.js";
import type { EngineBrokerInferenceFailureCode } from "./engineBrokerInferenceProtocol.js";
import type { EngineBrokerTurnLimits, EngineBrokerTurnUsage } from "./engineBrokerTurnAccounting.js";
import { parseGrokBrokerModelPolicy, type GrokBrokerModelPolicy } from "./grokBrokerModelPolicy.js";
import { GrokBrokerTurnMeter } from "./grokBrokerTurnMeter.js";
import { GROK_INFERENCE_PURPOSES, recordInferenceUsage, type GrokInferencePurpose, type InferenceUsageEntry } from "./inferenceUsageLedger.js";

const SPEC = GROK_ENGINE_BROKER.inferenceGrants;

/** One live evaluator grant as the proxy sees it. */
export type GrokInferenceGrant = Readonly<{ grantId: string; purpose: GrokInferencePurpose; policy: GrokBrokerModelPolicy; expiresAt: number; meter: GrokBrokerTurnMeter }>;
export type GrokInferenceGrantIssued = Readonly<{ grantId: string; token: string; purpose: GrokInferencePurpose; policy: GrokBrokerModelPolicy; expiresAt: number; limits: EngineBrokerTurnLimits }>;
export type GrokInferenceGrantRequest = Readonly<{ model: unknown; reasoningEffort: unknown; purpose: unknown }>;

export class GrokInferenceGrantRefused extends Error {
  constructor(readonly code: EngineBrokerInferenceFailureCode) { super(`inference grant refused (${code})`); }
}

type Entry = { grant: GrokInferenceGrant; digest: Buffer; timer: NodeJS.Timeout };
export type GrokInferenceGrantsOptions = Readonly<{
  now?: () => number;
  /** Test seam: a fixed grant id proves grants never share a key space with turn capabilities. */
  grantId?: () => string;
  onSettled?: (entry: InferenceUsageEntry) => void;
  ttlMs?: number;
  maxLiveGrants?: number;
}>;

/**
 * Evaluator inference grants: a distinct kind beside subject turn capabilities.
 *
 * Grants live in their own map keyed by a random grant id; turn capabilities
 * (`engineBrokerCapabilities.ts`) are keyed by turn id and never consulted
 * here, and grant tokens carry `inference_` so the proxy routes a bearer to
 * exactly one of the two lookups. A grant has no worker isolation guard (it is
 * issued only to the organization uid, the trusted evaluator side), but it
 * carries the same spend gate as a subject turn: a {@link GrokBrokerTurnMeter}
 * with one request in flight, the request ceiling, the between-requests token
 * ceiling and the estimate for a response without usage. Its lifetime is the
 * meter's time limit: past `expiresAt` it is gone from the map, and a request
 * still in flight at expiry is aborted.
 *
 * At most `maxLiveGrants` grants exist at once; a caller frees a slot early
 * with {@link release}. Nothing here is durable — a broker restart drops every
 * grant, and callers request a new one.
 */
export class GrokInferenceGrants {
  private readonly grants = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxLive: number;
  constructor(private readonly options: GrokInferenceGrantsOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? SPEC.ttlMs;
    this.maxLive = options.maxLiveGrants ?? SPEC.maxLiveGrants;
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 1 || this.ttlMs > SPEC.ttlMs || !Number.isSafeInteger(this.maxLive) || this.maxLive < 1 || this.maxLive > SPEC.maxLiveGrants) throw new TypeError("invalid inference grant policy");
  }

  issue(request: GrokInferenceGrantRequest): GrokInferenceGrantIssued {
    let policy: GrokBrokerModelPolicy;
    try { policy = parseGrokBrokerModelPolicy({ model: request.model, reasoningEffort: request.reasoningEffort }); } catch { throw new GrokInferenceGrantRefused("invalid_request"); }
    // Nothing is defaulted: the model parser fills an absent member, a grant must name both.
    if (request.model !== policy.model || request.reasoningEffort !== policy.reasoningEffort || !(GROK_INFERENCE_PURPOSES as readonly unknown[]).includes(request.purpose)) throw new GrokInferenceGrantRefused("invalid_request");
    this.prune();
    if (this.grants.size >= this.maxLive) throw new GrokInferenceGrantRefused("grant_limit");
    const grantId = this.options.grantId?.() ?? randomBytes(16).toString("hex");
    if (!/^[a-f0-9]{32}$/u.test(grantId) || this.grants.has(grantId)) throw new GrokInferenceGrantRefused("grant_limit");
    const limits: EngineBrokerTurnLimits = Object.freeze({ maxRequests: SPEC.limits.maxRequests, maxTokens: SPEC.limits.maxTokens, timeoutMs: this.ttlMs });
    const token = `${SPEC.tokenPrefix}${randomBytes(32).toString("base64url")}`;
    const grant: GrokInferenceGrant = Object.freeze({ grantId, purpose: request.purpose as GrokInferencePurpose, policy, expiresAt: this.now() + this.ttlMs, meter: new GrokBrokerTurnMeter(limits, () => undefined, this.now) });
    const timer = setTimeout(() => this.release(grantId), this.ttlMs); timer.unref?.();
    this.grants.set(grantId, { grant, digest: digest(token), timer });
    return Object.freeze({ grantId, token, purpose: grant.purpose, policy, expiresAt: grant.expiresAt, limits });
  }

  /** The live, unexpired grant a bearer names, or `undefined`. Never counts a request. */
  authorize(token: string): GrokInferenceGrant | undefined {
    if (!token.startsWith(SPEC.tokenPrefix)) return undefined;
    this.prune();
    const candidate = digest(token);
    for (const entry of this.grants.values()) if (timingSafeEqual(entry.digest, candidate)) return entry.grant;
    return undefined;
  }

  /** Records one admitted request's end on the grant's meter and emits its ledger row. */
  settle(grant: GrokInferenceGrant, index: number, usage: EngineBrokerTurnUsage | undefined, requestBytes: number): void {
    const before = grant.meter.snapshot().timings[index];
    if (before === undefined || before.endedAt !== undefined) return;
    grant.meter.settle(index, usage, requestBytes);
    const timing = grant.meter.snapshot().timings[index];
    if (timing?.usage === undefined || timing.endedAt === undefined) return;
    this.options.onSettled?.({ grant: grant.grantId, purpose: grant.purpose, model: grant.policy.model, request: index, usage: timing.usage, usageSource: timing.estimated === true ? "estimated" : "upstream", startedAt: timing.startedAt, endedAt: timing.endedAt });
  }

  /** Revokes a grant and aborts its in-flight request. Returns whether it was live. */
  release(grantId: string): boolean {
    const entry = this.grants.get(grantId);
    if (entry === undefined) return false;
    clearTimeout(entry.timer); entry.grant.meter.trip("timeout"); entry.digest.fill(0); this.grants.delete(grantId);
    return true;
  }

  live(): number { this.prune(); return this.grants.size; }

  close(): void { for (const grantId of [...this.grants.keys()]) this.release(grantId); }

  private prune(): void {
    const now = this.now();
    for (const [grantId, entry] of this.grants) if (entry.grant.expiresAt <= now) this.release(grantId);
  }
}

/** The broker's grants: every settled request is appended to the evaluator inference ledger and nowhere else. */
export const createLedgeredGrokInferenceGrants = (inferenceLedgerPath: string): GrokInferenceGrants =>
  new GrokInferenceGrants({ onSettled: (entry) => { void recordInferenceUsage(inferenceLedgerPath, entry); } });

const digest = (value: string): Buffer => createHash("sha256").update(value).digest();

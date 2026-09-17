import path from "node:path";

import { DEFAULT_GROK_BROKER_TURN_LIMITS, parseEngineBrokerTurnLimits, type EngineBrokerTurnLimits } from "./engineBrokerTurnAccounting.js";
import { DEFAULT_GROK_BROKER_MODEL_POLICY, GROK_BROKER_MODELS, GROK_BROKER_REASONING_EFFORTS, type GrokBrokerModelPolicy } from "./grokBrokerModelPolicy.js";
import { grokWorkerEventsPathFor } from "./grokWorkerSandboxProfile.js";
import { TURN_USAGE_LEDGER } from "./turnUsageLedger.js";

export const ENGINE_BROKER_SERVICE_V1 = "noopolis.daimon.engine-broker-service.v1" as const;
export const ENGINE_BROKER_SERVICE_V2 = "noopolis.daimon.engine-broker-service.v2" as const;

/** One root-provisioned broker slot. Every field is fixed at provisioning time; a wake can only lower `limits`. */
export type EngineBrokerServiceRegistration = Readonly<{
  agentId: string; slot: number; workerUid: number; workspace: string; profilePath: string; eventsPath: string; profileSha256: string;
  /** Per-slot usage ledger the broker appends turn rows to; per-request rows go to `requests.jsonl` beside it. */
  usageLedgerPath: string;
  limits: EngineBrokerTurnLimits;
  model: GrokBrokerModelPolicy;
}>;
export type EngineBrokerServiceConfig = Readonly<{ credentialHome: string; turnStore: string; registrations: readonly EngineBrokerServiceRegistration[] }>;

const V1_REGISTRATION = ["agentId", "slot", "workerUid", "workspace", "profilePath", "eventsPath", "profileSha256"] as const;
const V2_REGISTRATION = [...V1_REGISTRATION, "usageLedgerPath", "limits", "model"] as const;
const invalid = (): TypeError => new TypeError("invalid engine broker service config");
const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, fields: readonly string[]): void => { if (Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field))) throw invalid(); };
const absolute = (item: unknown): item is string => typeof item === "string" && item.startsWith("/") && !item.includes("/../") && !item.endsWith("/..") && !item.includes("\0");

/** The per-request stream written beside a registration's usage ledger. */
export const engineBrokerRequestLedgerPathFor = (usageLedgerPath: string): string => path.posix.join(path.posix.dirname(usageLedgerPath), "requests.jsonl");

/**
 * Strict `service.json` parser.
 *
 * v2 requires every registration to declare its usage ledger, limits and model
 * (`model.id`/`model.reasoningEffort` from the closed lists); unknown keys at
 * any level are refused. v1 is still accepted and receives today's defaults:
 * the container ledger, {@link DEFAULT_GROK_BROKER_TURN_LIMITS}, and
 * `grok-4.6`/`low`.
 */
export function parseEngineBrokerServiceConfig(value: unknown): EngineBrokerServiceConfig {
  if (!plain(value)) throw invalid();
  const v2 = value.version === ENGINE_BROKER_SERVICE_V2;
  if (!v2 && value.version !== ENGINE_BROKER_SERVICE_V1) throw invalid();
  exact(value, ["version", "credentialHome", "turnStore", "registrations"]);
  if (!absolute(value.credentialHome) || !absolute(value.turnStore) || !Array.isArray(value.registrations) || value.registrations.length === 0) throw invalid();
  const seen = new Set<string>(), slots = new Set<number>();
  const registrations = value.registrations.map((entry: unknown): EngineBrokerServiceRegistration => {
    if (!plain(entry)) throw invalid();
    exact(entry, v2 ? V2_REGISTRATION : V1_REGISTRATION);
    const { agentId, slot, workerUid, workspace, profilePath, eventsPath, profileSha256 } = entry;
    if (typeof agentId !== "string" || !agentId.trim() || seen.has(agentId) || !Number.isSafeInteger(slot) || (slot as number) < 0 || slots.has(slot as number) || !Number.isSafeInteger(workerUid) || (workerUid as number) < 2200 || !absolute(workspace) || !absolute(profilePath) || !absolute(eventsPath) || typeof profileSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(profileSha256) || eventsPath !== grokWorkerEventsPathFor(profilePath) || !profilePath.endsWith("/sandbox.toml")) throw invalid();
    seen.add(agentId); slots.add(slot as number);
    const base = { agentId, slot: slot as number, workerUid: workerUid as number, workspace, profilePath, eventsPath, profileSha256 };
    if (!v2) return { ...base, usageLedgerPath: TURN_USAGE_LEDGER.filePath, limits: DEFAULT_GROK_BROKER_TURN_LIMITS, model: DEFAULT_GROK_BROKER_MODEL_POLICY };
    const usageLedgerPath = entry.usageLedgerPath;
    if (!absolute(usageLedgerPath) || !usageLedgerPath.endsWith(".jsonl") || usageLedgerPath === engineBrokerRequestLedgerPathFor(usageLedgerPath) || path.posix.normalize(usageLedgerPath) !== usageLedgerPath) throw invalid();
    let limits: EngineBrokerTurnLimits;
    try { limits = parseEngineBrokerTurnLimits(entry.limits); } catch { throw invalid(); }
    return { ...base, usageLedgerPath, limits, model: parseServiceModel(entry.model) };
  });
  return { credentialHome: value.credentialHome, turnStore: value.turnStore, registrations };
}

function parseServiceModel(value: unknown): GrokBrokerModelPolicy {
  if (!plain(value)) throw invalid();
  exact(value, ["id", "reasoningEffort"]);
  if (!(GROK_BROKER_MODELS as readonly unknown[]).includes(value.id) || !(GROK_BROKER_REASONING_EFFORTS as readonly unknown[]).includes(value.reasoningEffort)) throw invalid();
  return Object.freeze({ model: value.id as GrokBrokerModelPolicy["model"], reasoningEffort: value.reasoningEffort as GrokBrokerModelPolicy["reasoningEffort"] });
}

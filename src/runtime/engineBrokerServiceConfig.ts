import path from "node:path";

import { DEFAULT_GROK_BROKER_TURN_LIMITS, parseEngineBrokerTurnLimits, type EngineBrokerTurnLimits } from "./engineBrokerTurnAccounting.js";
import { DEFAULT_GROK_BROKER_MODEL_POLICY, GROK_BROKER_MODELS, GROK_BROKER_REASONING_EFFORTS, type GrokBrokerModelPolicy } from "./grokBrokerModelPolicy.js";
import { grokWorkerEventsPathFor } from "./grokWorkerSandboxProfile.js";
import { TURN_REQUEST_LEDGER } from "./turnRequestLedger.js";
import { TURN_USAGE_LEDGER } from "./turnUsageLedger.js";

export const ENGINE_BROKER_SERVICE_V1 = "noopolis.daimon.engine-broker-service.v1" as const;
export const ENGINE_BROKER_SERVICE_V2 = "noopolis.daimon.engine-broker-service.v2" as const;

/** One root-provisioned broker slot. Every field is fixed at provisioning time; a wake can only lower `limits`. */
export type EngineBrokerServiceRegistration = Readonly<{
  agentId: string; slot: number; workerUid: number; workspace: string; profilePath: string; eventsPath: string; profileSha256: string;
  /** Per-slot usage ledger the broker appends turn rows to; per-request rows go to `requests.jsonl` and per-turn seals to `turns.jsonl` beside it. */
  usageLedgerPath: string;
  limits: EngineBrokerTurnLimits;
  model: GrokBrokerModelPolicy;
}>;
/**
 * `inferenceLedgerPath` (v2, optional) is where evaluator inference grants
 * append their rows (`inferenceUsageLedger.ts`). Without it the broker refuses
 * every grant request. It can never be a subject ledger: not any
 * registration's usage ledger or its `requests.jsonl`, and not the container
 * ledger the wake fuse sums.
 */
export type EngineBrokerServiceConfig = Readonly<{ credentialHome: string; turnStore: string; registrations: readonly EngineBrokerServiceRegistration[]; inferenceLedgerPath?: string }>;

const V1_REGISTRATION = ["agentId", "slot", "workerUid", "workspace", "profilePath", "eventsPath", "profileSha256"] as const;
const V2_REGISTRATION = [...V1_REGISTRATION, "usageLedgerPath", "limits", "model"] as const;
const invalid = (): TypeError => new TypeError("invalid engine broker service config");
const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, fields: readonly string[]): void => { if (Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field))) throw invalid(); };
/**
 * Absolute and canonical: no `.`/`..`/empty components and no trailing slash.
 * The native launcher derives HOME, GROK_HOME and TMPDIR from the registered
 * home and refuses a non-canonical one, so the broker's view must match it.
 */
const absolute = (item: unknown): item is string => typeof item === "string" && item.length > 1 && item.startsWith("/") && !item.endsWith("/") && path.posix.normalize(item) === item && !item.split("/").slice(1).some((part) => part === "." || part === "..") && !item.includes("\0");

/** The per-request stream written beside a registration's usage ledger. */
export const engineBrokerRequestLedgerPathFor = (usageLedgerPath: string): string => path.posix.join(path.posix.dirname(usageLedgerPath), "requests.jsonl");

/**
 * The per-turn seal stream written beside the other two
 * (`engineBrokerSealLedger.ts`): the operator-visible half of a sealed terminal
 * response, for the turn whose response never reaches a client.
 */
export const engineBrokerSealLedgerPathFor = (usageLedgerPath: string): string => path.posix.join(path.posix.dirname(usageLedgerPath), "turns.jsonl");

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
  const top = ["version", "credentialHome", "turnStore", "registrations"];
  exact(value, v2 && Object.hasOwn(value, "inferenceLedgerPath") ? [...top, "inferenceLedgerPath"] : top);
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
    if (!ledgerPath(usageLedgerPath) || usageLedgerPath === engineBrokerRequestLedgerPathFor(usageLedgerPath) || usageLedgerPath === engineBrokerSealLedgerPathFor(usageLedgerPath)) throw invalid();
    let limits: EngineBrokerTurnLimits;
    try { limits = parseEngineBrokerTurnLimits(entry.limits); } catch { throw invalid(); }
    return { ...base, usageLedgerPath, limits, model: parseServiceModel(entry.model) };
  });
  const base = { credentialHome: value.credentialHome, turnStore: value.turnStore, registrations };
  if (!Object.hasOwn(value, "inferenceLedgerPath")) return base;
  const inferenceLedgerPath = value.inferenceLedgerPath;
  if (!ledgerPath(inferenceLedgerPath)) throw invalid();
  const subject = new Set<string>([TURN_USAGE_LEDGER.filePath, TURN_REQUEST_LEDGER.filePath, ...registrations.flatMap((entry) => [entry.usageLedgerPath, engineBrokerRequestLedgerPathFor(entry.usageLedgerPath), engineBrokerSealLedgerPathFor(entry.usageLedgerPath)])]);
  if (subject.has(inferenceLedgerPath)) throw invalid();
  return { ...base, inferenceLedgerPath };
}

const ledgerPath = (item: unknown): item is string => absolute(item) && item.endsWith(".jsonl") && path.posix.normalize(item) === item;

function parseServiceModel(value: unknown): GrokBrokerModelPolicy {
  if (!plain(value)) throw invalid();
  exact(value, ["id", "reasoningEffort"]);
  if (!(GROK_BROKER_MODELS as readonly unknown[]).includes(value.id) || !(GROK_BROKER_REASONING_EFFORTS as readonly unknown[]).includes(value.reasoningEffort)) throw invalid();
  return Object.freeze({ model: value.id as GrokBrokerModelPolicy["model"], reasoningEffort: value.reasoningEffort as GrokBrokerModelPolicy["reasoningEffort"] });
}

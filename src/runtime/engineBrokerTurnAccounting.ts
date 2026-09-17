import { GROK_BROKER_MODELS } from "../contracts/grokWorkerContract.js";
import { GROK_ENGINE_BROKER } from "../contracts/runtimeContractManifest.js";
import type { GrokBrokerModel } from "./grokBrokerModelPolicy.js";

/**
 * Numeric-only accounting the Grok engine broker seals beside every terminal
 * turn response, and the per-turn limits it enforces.
 *
 * The broker is the single writer of this data (turn registry record, control
 * response, usage ledger row). Nothing engine-controlled and non-numeric is
 * persisted: `model` is a member of the closed declared list, never the
 * provider's own string, and `limitReason` is a closed vocabulary.
 *
 * Buckets are disjoint and `total = input + cacheRead + cacheWrite + output`.
 * `reasoning` is reported only when the source separates it; it is already
 * inside `output` and never added to `total`.
 */
export type EngineBrokerTurnUsage = Readonly<{ input: number; cacheRead: number; cacheWrite: number; output: number; total: number; reasoning?: number }>;
export const ENGINE_BROKER_LIMIT_REASONS = GROK_ENGINE_BROKER.turnLimits.limitReasons;
export type EngineBrokerLimitReason = (typeof ENGINE_BROKER_LIMIT_REASONS)[number];
export type EngineBrokerTurnLimits = Readonly<{ maxRequests: number; maxTokens: number; timeoutMs: number }>;
export type EngineBrokerTurnLimitOverrides = Readonly<Partial<EngineBrokerTurnLimits>>;
export type EngineBrokerTurnAccounting = Readonly<{
  outcome: "completed" | "failed";
  usage: EngineBrokerTurnUsage | null;
  model: GrokBrokerModel;
  requests: number;
  limitReason: EngineBrokerLimitReason;
}>;

/**
 * Bounds every declared limit must sit inside, and the v1 defaults, both from
 * the runtime contract manifest. `maxRequests` stays at or below the
 * launcher's compiled `--max-turns` backstop, so the broker ceiling is the one
 * that fires first.
 */
export const ENGINE_BROKER_LIMIT_BOUNDS = GROK_ENGINE_BROKER.turnLimits.bounds;

/** What a v1 `service.json` registration gets; equal to the Codex per-wake defaults. */
export const DEFAULT_GROK_BROKER_TURN_LIMITS: EngineBrokerTurnLimits = Object.freeze({ ...GROK_ENGINE_BROKER.turnLimits.v1Defaults });

const LIMIT_KEYS = ["maxRequests", "maxTokens", "timeoutMs"] as const;
type JsonRecord = Record<string, unknown>;
const plain = (value: unknown): value is JsonRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const invalid = (label: string): TypeError => new TypeError(`invalid ${label}`);

const limitValue = (key: (typeof LIMIT_KEYS)[number], value: unknown, label: string): number => {
  const [minimum, maximum] = ENGINE_BROKER_LIMIT_BOUNDS[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw invalid(label);
  return value;
};

/** Exactly `{maxRequests, maxTokens, timeoutMs}`, each inside its bound. */
export function parseEngineBrokerTurnLimits(value: unknown, label = "engine broker turn limits"): EngineBrokerTurnLimits {
  if (!plain(value) || Object.keys(value).length !== LIMIT_KEYS.length || LIMIT_KEYS.some((key) => !Object.hasOwn(value, key))) throw invalid(label);
  return Object.freeze({ maxRequests: limitValue("maxRequests", value.maxRequests, label), maxTokens: limitValue("maxTokens", value.maxTokens, label), timeoutMs: limitValue("timeoutMs", value.timeoutMs, label) });
}

/** A non-empty subset of the limit keys, each inside its bound. */
export function parseEngineBrokerTurnLimitOverrides(value: unknown, label = "engine broker turn limits"): EngineBrokerTurnLimitOverrides {
  if (!plain(value) || Object.keys(value).length === 0 || Object.keys(value).some((key) => !(LIMIT_KEYS as readonly string[]).includes(key))) throw invalid(label);
  const result: Partial<Record<(typeof LIMIT_KEYS)[number], number>> = {};
  for (const key of LIMIT_KEYS) if (Object.hasOwn(value, key)) result[key] = limitValue(key, value[key], label);
  return Object.freeze(result);
}

/**
 * The limits one turn runs under: the registration's, lowered by the wake.
 * A wake can never raise a declared limit; asking to is refused rather than
 * clamped, so a misconfigured caller learns it instead of silently getting less.
 */
export function lowerEngineBrokerTurnLimits(declared: EngineBrokerTurnLimits, overrides: EngineBrokerTurnLimitOverrides | undefined): EngineBrokerTurnLimits {
  if (overrides === undefined) return declared;
  for (const key of LIMIT_KEYS) {
    const requested = overrides[key];
    if (requested !== undefined && requested > declared[key]) throw new RangeError(`engine broker turn limit ${key} may only be lowered`);
  }
  return Object.freeze({ maxRequests: overrides.maxRequests ?? declared.maxRequests, maxTokens: overrides.maxTokens ?? declared.maxTokens, timeoutMs: overrides.timeoutMs ?? declared.timeoutMs });
}

/** Four disjoint buckets plus an optional reasoning split; the total invariant is re-checked. */
export function parseEngineBrokerTurnUsage(value: unknown, label = "engine broker turn usage"): EngineBrokerTurnUsage {
  const required = ["input", "cacheRead", "cacheWrite", "output", "total"];
  if (!plain(value)) throw invalid(label);
  const keys = Object.keys(value);
  if (required.some((key) => !Object.hasOwn(value, key)) || keys.some((key) => !required.includes(key) && key !== "reasoning")) throw invalid(label);
  if (![value.input, value.cacheRead, value.cacheWrite, value.output, value.total].every(count)) throw invalid(label);
  const usage = value as { input: number; cacheRead: number; cacheWrite: number; output: number; total: number; reasoning?: unknown };
  if (usage.total !== usage.input + usage.cacheRead + usage.cacheWrite + usage.output) throw invalid(label);
  if (usage.reasoning !== undefined && (!count(usage.reasoning) || usage.reasoning > usage.output)) throw invalid(label);
  return Object.freeze({ input: usage.input, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, output: usage.output, total: usage.total, ...(usage.reasoning === undefined ? {} : { reasoning: usage.reasoning as number }) });
}

export const sumEngineBrokerTurnUsage = (items: readonly EngineBrokerTurnUsage[]): EngineBrokerTurnUsage | null => {
  if (items.length === 0) return null;
  const sum = (pick: (usage: EngineBrokerTurnUsage) => number): number => items.reduce((total, usage) => total + pick(usage), 0);
  const reasoning = items.every((usage) => usage.reasoning !== undefined) ? { reasoning: sum((usage) => usage.reasoning ?? 0) } : {};
  return Object.freeze({ input: sum((usage) => usage.input), cacheRead: sum((usage) => usage.cacheRead), cacheWrite: sum((usage) => usage.cacheWrite), output: sum((usage) => usage.output), total: sum((usage) => usage.total), ...reasoning });
};

/** Validates the accounting members of a v2 terminal response against its kind. */
export function parseEngineBrokerTurnAccounting(value: JsonRecord, kind: "completed" | "failed"): EngineBrokerTurnAccounting {
  if (value.outcome !== kind) throw invalid("broker frame");
  if (!(GROK_BROKER_MODELS as readonly unknown[]).includes(value.model)) throw invalid("broker frame");
  if (!count(value.requests) || value.requests > 1_024) throw invalid("broker frame");
  if (!(ENGINE_BROKER_LIMIT_REASONS as readonly unknown[]).includes(value.limitReason)) throw invalid("broker frame");
  if (kind === "completed" && value.limitReason !== "none") throw invalid("broker frame");
  let usage: EngineBrokerTurnUsage | null = null;
  if (value.usage !== null) { try { usage = parseEngineBrokerTurnUsage(value.usage); } catch { throw invalid("broker frame"); } }
  return { outcome: kind, usage, model: value.model as GrokBrokerModel, requests: value.requests, limitReason: value.limitReason as EngineBrokerLimitReason };
}

/**
 * Maps a provider-reported model key onto the declared closed-list model.
 *
 * Grok 1.0.34 reports `grok-4.6` usage under `grok-4.6-build` (P0). The exact
 * declared id and its `-build` alias are accepted; anything else is a
 * different model and yields `undefined`.
 */
export const mapGrokReportedModel = (reported: string, declared: GrokBrokerModel): GrokBrokerModel | undefined =>
  reported === declared || reported === `${declared}-build` ? declared : undefined;

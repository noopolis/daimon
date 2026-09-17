import { GROK_BROKER_MODELS, GROK_BROKER_REASONING_EFFORTS } from "../contracts/grokWorkerContract.js";
import { GROK_ENGINE_BROKER } from "../contracts/runtimeContractManifest.js";
import type { EngineBrokerTurnLimits } from "./engineBrokerTurnAccounting.js";
import type { GrokBrokerModel, GrokBrokerReasoningEffort } from "./grokBrokerModelPolicy.js";
import type { GrokInferencePurpose } from "./inferenceUsageLedger.js";

/**
 * Evaluator inference grant frames, additive kinds of control protocol v2.
 *
 * Both ends ship in this package (the organization-side client and the broker
 * service), so the kinds join v2 without a version bump; a broker that
 * predates them refuses the unknown kind and closes the connection, which the
 * client reports as `unavailable`. The native relay forwards frames opaquely
 * and admits only the organization uid on `control.sock` (`SO_PEERCRED`), so
 * that check is what limits grants to the evaluator side.
 *
 * The grant `token` is the bearer the evaluator's Grok CLI presents to the
 * provider proxy (`env_key`). It never carries the broker credential.
 */
const SPEC = GROK_ENGINE_BROKER.inferenceGrants;
export const ENGINE_BROKER_INFERENCE_FAILURE_CODES = SPEC.failureCodes;
export type EngineBrokerInferenceFailureCode = (typeof ENGINE_BROKER_INFERENCE_FAILURE_CODES)[number];
export const GROK_INFERENCE_PROXY_BASE_URL = `http://${GROK_ENGINE_BROKER.providerProxy.host}:${GROK_ENGINE_BROKER.providerProxy.port}/v1` as const;

type V = "noopolis.daimon.engine-broker.v2";
export type EngineBrokerInferenceRequest =
  | Readonly<{ version: V; kind: "request_inference_grant"; requestId: string; model: GrokBrokerModel; reasoningEffort: GrokBrokerReasoningEffort; purpose: GrokInferencePurpose }>
  | Readonly<{ version: V; kind: "release_inference_grant"; requestId: string; grantId: string }>;
export type EngineBrokerInferenceResponse =
  | Readonly<{ version: V; kind: "inference_grant"; requestId: string; grantId: string; token: string; baseUrl: typeof GROK_INFERENCE_PROXY_BASE_URL; model: GrokBrokerModel; reasoningEffort: GrokBrokerReasoningEffort; purpose: GrokInferencePurpose; expiresAt: string; limits: EngineBrokerTurnLimits }>
  | Readonly<{ version: V; kind: "inference_grant_released"; requestId: string; grantId: string; released: boolean }>
  | Readonly<{ version: V; kind: "inference_grant_refused"; requestId: string; code: EngineBrokerInferenceFailureCode }>;

type JsonRecord = Record<string, unknown>;
const invalid = (): TypeError => new TypeError("invalid broker frame");
const exact = (value: JsonRecord, fields: readonly string[]): void => { if (Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field))) throw invalid(); };
const member = <T extends string>(list: readonly T[], value: unknown): T => { if (!(list as readonly unknown[]).includes(value)) throw invalid(); return value as T; };
const grantId = (value: unknown): string => { if (typeof value !== "string" || !/^[a-f0-9]{32}$/u.test(value)) throw invalid(); return value; };
const TOKEN = new RegExp(`^${SPEC.tokenPrefix}[A-Za-z0-9_-]{43}$`, "u");

/** `input` has already passed the v2 envelope checks; `requestId` is the parsed id. */
export function parseEngineBrokerInferenceRequest(input: JsonRecord, requestId: string, version: V): EngineBrokerInferenceRequest {
  if (input.kind === "request_inference_grant") {
    exact(input, ["version", "kind", "requestId", "model", "reasoningEffort", "purpose"]);
    return { version, kind: "request_inference_grant", requestId, model: member(GROK_BROKER_MODELS, input.model), reasoningEffort: member(GROK_BROKER_REASONING_EFFORTS, input.reasoningEffort), purpose: member(SPEC.purposes, input.purpose) };
  }
  if (input.kind === "release_inference_grant") {
    exact(input, ["version", "kind", "requestId", "grantId"]);
    return { version, kind: "release_inference_grant", requestId, grantId: grantId(input.grantId) };
  }
  throw invalid();
}

export function parseEngineBrokerInferenceResponse(input: JsonRecord, requestId: string, version: V): EngineBrokerInferenceResponse {
  if (input.kind === "inference_grant") {
    exact(input, ["version", "kind", "requestId", "grantId", "token", "baseUrl", "model", "reasoningEffort", "purpose", "expiresAt", "limits"]);
    if (typeof input.token !== "string" || !TOKEN.test(input.token) || input.baseUrl !== GROK_INFERENCE_PROXY_BASE_URL || typeof input.expiresAt !== "string" || Number.isNaN(Date.parse(input.expiresAt)) || new Date(input.expiresAt).toISOString() !== input.expiresAt) throw invalid();
    const limits = input.limits as JsonRecord;
    if (limits === null || typeof limits !== "object" || Array.isArray(limits)) throw invalid();
    exact(limits, ["maxRequests", "maxTokens", "timeoutMs"]);
    if (!(Number.isSafeInteger(limits.maxRequests) && (limits.maxRequests as number) >= 1 && (limits.maxRequests as number) <= SPEC.limits.maxRequests && Number.isSafeInteger(limits.maxTokens) && (limits.maxTokens as number) >= 1 && (limits.maxTokens as number) <= SPEC.limits.maxTokens && Number.isSafeInteger(limits.timeoutMs) && (limits.timeoutMs as number) >= 1 && (limits.timeoutMs as number) <= SPEC.ttlMs)) throw invalid();
    return { version, kind: "inference_grant", requestId, grantId: grantId(input.grantId), token: input.token, baseUrl: GROK_INFERENCE_PROXY_BASE_URL, model: member(GROK_BROKER_MODELS, input.model), reasoningEffort: member(GROK_BROKER_REASONING_EFFORTS, input.reasoningEffort), purpose: member(SPEC.purposes, input.purpose), expiresAt: input.expiresAt, limits: { maxRequests: limits.maxRequests as number, maxTokens: limits.maxTokens as number, timeoutMs: limits.timeoutMs as number } };
  }
  if (input.kind === "inference_grant_released") {
    exact(input, ["version", "kind", "requestId", "grantId", "released"]);
    if (typeof input.released !== "boolean") throw invalid();
    return { version, kind: "inference_grant_released", requestId, grantId: grantId(input.grantId), released: input.released };
  }
  if (input.kind === "inference_grant_refused") {
    exact(input, ["version", "kind", "requestId", "code"]);
    return { version, kind: "inference_grant_refused", requestId, code: member(ENGINE_BROKER_INFERENCE_FAILURE_CODES, input.code) };
  }
  throw invalid();
}

export const isEngineBrokerInferenceRequestKind = (kind: unknown): boolean => kind === "request_inference_grant" || kind === "release_inference_grant";
export const isEngineBrokerInferenceResponseKind = (kind: unknown): boolean => kind === "inference_grant" || kind === "inference_grant_released" || kind === "inference_grant_refused";

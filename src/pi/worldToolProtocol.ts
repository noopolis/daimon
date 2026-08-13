import type { PiWorldTurnContext } from "./worldNudge.js";

export const WORLD_ACTION_RESULT_PAGE_REQUEST_VERSION =
  "simfile.world-action-result-page-request.v1" as const;

export type PiWorldProtocolOperation =
  | "claim" | "status" | "capabilities" | "observe"
  | "affordances" | "act" | "ledger";

export interface ParsedWorldClaim {
  readonly decisionId: string;
  readonly decisionToken: string;
  readonly issuedAtTick: number;
  readonly validThroughTick: number;
}

const text = (value: unknown, maximum = 256): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maximum
  && value === value.trim();

export const createWorldClaimRequestBody = (
  context: PiWorldTurnContext | undefined,
): Record<string, unknown> | undefined => context !== undefined
  && context.decisionToken === undefined && text(context.requestId) && text(context.wakeId)
  ? { request_id: context.requestId, wake_id: context.wakeId }
  : undefined;

export const createWorldRequestBody = (
  operation: Exclude<PiWorldProtocolOperation, "claim">,
  params: Record<string, unknown>,
  context: PiWorldTurnContext | undefined,
): Record<string, unknown> | undefined => {
  const decisionToken = context?.decisionToken;
  if (context === undefined || !text(decisionToken, 512) || params.decision_token !== undefined
    || params.request_id !== undefined) return undefined;
  if (operation === "status" || operation === "capabilities" || operation === "affordances") {
    return { decision_token: decisionToken };
  }
  if (operation === "observe") return text(params.sense)
    ? { decision_token: decisionToken, sense: params.sense }
    : undefined;
  if (operation === "act") {
    const requestId = context.requestId;
    if (!text(requestId) || !text(params.affordance) || !text(params.target)
    ) return undefined;
    return { decision_token: decisionToken, request_id: requestId,
      affordance: params.affordance, target: params.target, input: params.input };
  }
  return { decision_token: decisionToken, version: WORLD_ACTION_RESULT_PAGE_REQUEST_VERSION,
    ...(params.limit === undefined ? {} : { limit: params.limit }),
    ...(params.result_after === undefined ? {} : { result_after: params.result_after }) };
};

export const parseWorldClaimResponse = (value: unknown): ParsedWorldClaim | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
  const keys = Object.keys(value).sort();
  if (keys.length !== 4 || keys.some((key, index) => key !== [
    "decision_id", "decision_token", "issued_at_tick", "valid_through_tick",
  ][index])) return undefined;
  const record = value as Record<string, unknown>;
  if (!text(record.decision_id) || !text(record.decision_token, 512)
    || !Number.isSafeInteger(record.issued_at_tick) || (record.issued_at_tick as number) < 0
    || !Number.isSafeInteger(record.valid_through_tick)
    || (record.valid_through_tick as number) < (record.issued_at_tick as number)) return undefined;
  return Object.freeze({ decisionId: record.decision_id, decisionToken: record.decision_token,
    issuedAtTick: record.issued_at_tick as number,
    validThroughTick: record.valid_through_tick as number });
};

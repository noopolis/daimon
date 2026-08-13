import { emitCausalEvent, resolveRunId, type CausalEvent } from "./causalEvents.js";

/**
 * Control-wake causal emitters for root's two wake-acceptance surfaces
 * (`src/runtime/pi/appControlSource.ts`, root repo, out of scope here):
 * the operator-only control endpoint and the Moltnet loopback delivery
 * endpoint (`/agents/:slug/wake`). Both stamp `control.wake.accepted` —
 * enforcement point #3 in `specs/CAUSAL.md` §"Enforcement points" — but with
 * different `principal_id` authorities, per the B62 fix (Option B): the
 * operator endpoint stamps `operator:<name>` (`emitControlWakeAccepted`),
 * the delivery endpoint stamps the fixed `system:moltnet` authority
 * (`emitDeliveryWakeAccepted`), never a caller-supplied `from`/agent field.
 * `control.wake.denied` (`emitControlWakeDenied`) stays operator-only: the
 * delivery endpoint has no bearer-token deny path to stamp. Root's generated
 * app calls these directly; this file has no knowledge of HTTP, tokens, or
 * the request shape, only the causal envelope contract.
 */

export const CONTROL_WAKE_ACCEPTED_TYPE = "control.wake.accepted" as const;
export const CONTROL_WAKE_DENIED_TYPE = "control.wake.denied" as const;

/** Payload for `control.wake.accepted`. */
export interface ControlWakeAcceptedPayload extends Record<string, unknown> {
  target_agent_id: string;
  wake_kind: string;
}

/** Payload for `control.wake.denied`. */
export interface ControlWakeDeniedPayload extends Record<string, unknown> {
  reason: string;
  target_agent_id: string;
}

/**
 * Payload for a Moltnet-delivered `control.wake.accepted` (same event type
 * as the operator path — it is still an accepted wake; `principal_id` is
 * what distinguishes authority). Adds `delivered_by` so downstream readers
 * can tell a delivery-stamped event from an operator-stamped one without
 * inspecting `principal_id`.
 */
export interface DeliveryWakeAcceptedPayload extends ControlWakeAcceptedPayload {
  delivered_by: "moltnet";
}

/**
 * Principal grammar per `specs/CAUSAL.md` §3 (`^(agent|operator|system):.+`):
 * an authenticated operator identity, e.g. `operator:control`. Callers must
 * pass the identity behind the verified bearer token, never a value read
 * from the request body or model output.
 */
export const operatorPrincipalId = (operatorName: string): string => `operator:${operatorName}`;

/**
 * Fixed principal for wakes accepted through the Moltnet loopback delivery
 * endpoint (`/agents/:slug/wake`): the delivering authority itself, never an
 * identity derived from a caller-supplied `from`/agent field on the request.
 */
export const DELIVERY_PRINCIPAL_ID = "system:moltnet" as const;

/** Deterministic, non-model-derived event id for a control wake acceptance. */
export const controlWakeAcceptedEventId = (requestId: string): string =>
  `daimon:${requestId}:control.wake.accepted`;

/** Deterministic, non-model-derived event id for a control wake denial. */
export const controlWakeDeniedEventId = (requestId: string): string => `daimon:${requestId}:control.wake.denied`;

/**
 * Deterministic, non-model-derived event id for a Moltnet-delivered wake
 * acceptance. Distinct from `controlWakeAcceptedEventId` (own `.delivery.`
 * segment) so the two paths never collide even if a future caller reused a
 * `requestId` across both endpoints for the same target.
 */
export const deliveryWakeAcceptedEventId = (requestId: string): string =>
  `daimon:${requestId}:delivery.wake.accepted`;

export interface EmitControlWakeAcceptedInput {
  causeEventIds?: string[];
  operatorName: string;
  requestId: string;
  runId?: string;
  runtimeHomePath: string;
  targetAgentId: string;
  wakeKind: string;
}

/**
 * Stamps `control.wake.accepted` once root's operator-control endpoint has
 * verified the bearer token and is about to wake `targetAgentId`.
 * `principal_id` is always `operator:<operatorName>` (the authenticated
 * operator behind the verified token), never derived from the request body.
 * `run_id` defaults to `resolveRunId()` like every other daimon emitter.
 */
export const emitControlWakeAccepted = (
  input: EmitControlWakeAcceptedInput
): Promise<CausalEvent<ControlWakeAcceptedPayload>> =>
  emitCausalEvent({
    agentId: input.targetAgentId,
    causeEventIds: input.causeEventIds ?? [],
    eventId: controlWakeAcceptedEventId(input.requestId),
    payload: {
      target_agent_id: input.targetAgentId,
      wake_kind: input.wakeKind
    },
    principalId: operatorPrincipalId(input.operatorName),
    runId: input.runId ?? resolveRunId(),
    runtimeHomePath: input.runtimeHomePath,
    type: CONTROL_WAKE_ACCEPTED_TYPE
  });

export interface EmitDeliveryWakeAcceptedInput {
  causeEventIds?: string[];
  requestId: string;
  runId?: string;
  runtimeHomePath: string;
  targetAgentId: string;
  wakeKind: string;
}

/**
 * Stamps `control.wake.accepted` once root's Moltnet loopback delivery
 * endpoint (`/agents/:slug/wake`) is about to wake `targetAgentId` on behalf
 * of an inter-agent message. `principal_id` is always the fixed
 * `DELIVERY_PRINCIPAL_ID` (`system:moltnet`) — the delivering authority —
 * never derived from a caller-supplied `from`/agent field, and never
 * `operator:<name>` (that principal is reserved for the operator-only
 * control endpoint; see `emitControlWakeAccepted`). `run_id` defaults to
 * `resolveRunId()` like every other daimon emitter.
 */
export const emitDeliveryWakeAccepted = (
  input: EmitDeliveryWakeAcceptedInput
): Promise<CausalEvent<DeliveryWakeAcceptedPayload>> =>
  emitCausalEvent({
    agentId: input.targetAgentId,
    causeEventIds: input.causeEventIds ?? [],
    eventId: deliveryWakeAcceptedEventId(input.requestId),
    payload: {
      delivered_by: "moltnet",
      target_agent_id: input.targetAgentId,
      wake_kind: input.wakeKind
    },
    principalId: DELIVERY_PRINCIPAL_ID,
    runId: input.runId ?? resolveRunId(),
    runtimeHomePath: input.runtimeHomePath,
    type: CONTROL_WAKE_ACCEPTED_TYPE
  });

export interface EmitControlWakeDeniedInput {
  causeEventIds?: string[];
  operatorName: string;
  reason: string;
  requestId: string;
  runId?: string;
  runtimeHomePath: string;
  targetAgentId: string;
}

/**
 * Stamps `control.wake.denied` when root's operator-control endpoint rejects
 * a wake request over a missing or invalid bearer token. Deny paths must
 * never drop silently (see `specs/CAUSAL.md` enforcement point #3 / T5):
 * every 401 the endpoint returns should carry exactly one of these. As with
 * `emitControlWakeAccepted`, `principal_id` is always the authenticated
 * operator identity, never a value read from the request.
 */
export const emitControlWakeDenied = (
  input: EmitControlWakeDeniedInput
): Promise<CausalEvent<ControlWakeDeniedPayload>> =>
  emitCausalEvent({
    agentId: input.targetAgentId,
    causeEventIds: input.causeEventIds ?? [],
    eventId: controlWakeDeniedEventId(input.requestId),
    payload: {
      reason: input.reason,
      target_agent_id: input.targetAgentId
    },
    principalId: operatorPrincipalId(input.operatorName),
    runId: input.runId ?? resolveRunId(),
    runtimeHomePath: input.runtimeHomePath,
    type: CONTROL_WAKE_DENIED_TYPE
  });

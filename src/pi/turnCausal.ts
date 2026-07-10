import type { MemoryPrepareTurnResult } from "@noopolis/mneme";

import type { WakeEvent } from "../core/types.js";
import {
  emitTurnInputSubmitted,
  emitTurnOutputCompleted,
  resolveRunId,
  sha256Hex,
  type CausalEvent,
  type TurnInputSubmittedPayload,
  type TurnOutputCompletedPayload
} from "../observability/causalEvents.js";
import { summarizePrompt } from "./turnTrace.js";

/**
 * Principal grammar per `specs/CAUSAL.md` §3
 * (`^(agent|operator|system):.+`): the authenticated agent identity this
 * harness instance was started under, never a bare id and never model
 * output. See `stampTurnInputSubmitted`/`stampTurnOutputCompleted` below for
 * why `agentId` itself is trustworthy at this layer.
 */
export const agentPrincipalId = (agentId: string): string => `agent:${agentId}`;

export interface StampTurnInputSubmittedInput {
  agentId: string;
  event: WakeEvent;
  prepared?: MemoryPrepareTurnResult;
  promptText: string;
  runtimeHomePath: string;
}

/**
 * Stamps `turn.input.submitted` for one Pi turn, wiring piHarness's own
 * variables into `@noopolis/daimon`'s causal envelope (`../observability/
 * causalEvents.ts`).
 *
 * - `principal_id` is `agent:<agentId>` (`agentPrincipalId`, per the
 *   `specs/CAUSAL.md` §3 principal grammar). `src/pi/auth.ts` scopes LLM
 *   provider auth (Codex / Claude / API key) per harness instance rather
 *   than exposing a separate network identity token, so `agentId` — the
 *   identity this harness instance was started under (`AgentStartInput.id`,
 *   which also scopes its own `authPath`/`runtimeHomePath`) — is the
 *   truthful authenticated identity available at this layer.
 * - `cause_event_ids` chains to `event.id` (the WakeEvent id) plus any mneme
 *   recall ids from `prepared.recall.selectedEventIds`. `event.id` stands in
 *   for the upstream moltnet `message.accepted` id: `WakeEvent` does not
 *   carry a separately namespaced moltnet causal event_id, since Daimon
 *   stays detached from Moltnet wiring (see repo `AGENTS.md`) — `event.id`
 *   is the truthful value available here.
 * - `run_id` always comes from `resolveRunId()` (`NOOPOLIS_RUN_ID`), never
 *   from `event` or model output.
 */
export const stampTurnInputSubmitted = (
  input: StampTurnInputSubmittedInput
): Promise<CausalEvent<TurnInputSubmittedPayload>> =>
  emitTurnInputSubmitted({
    agentId: input.agentId,
    causeEventIds: [input.event.id, ...(input.prepared?.recall.selectedEventIds ?? [])],
    inputContentSha256: sha256Hex(input.event.text),
    inputMessageIds: [input.event.id],
    principalId: agentPrincipalId(input.agentId),
    promptSha256: summarizePrompt(input.promptText).sha256,
    runId: resolveRunId(),
    runtimeHomePath: input.runtimeHomePath,
    turnId: input.event.id
  });

export interface StampTurnOutputCompletedInput {
  agentId: string;
  causeEventId: string;
  outputText: string;
  runtimeHomePath: string;
  turnId: string;
}

/**
 * Stamps `turn.output.completed` once a Pi turn finishes successfully,
 * chained back via `cause_event_ids` to the `turn.input.submitted` id for
 * the same turn. `output_sha256` is over the harness-extracted reply text;
 * the model has no path to influence `cause_event_ids`, `run_id`, or
 * `principal_id` here.
 */
export const stampTurnOutputCompleted = (
  input: StampTurnOutputCompletedInput
): Promise<CausalEvent<TurnOutputCompletedPayload>> =>
  emitTurnOutputCompleted({
    agentId: input.agentId,
    causeEventIds: [input.causeEventId],
    outputSha256: sha256Hex(input.outputText),
    principalId: agentPrincipalId(input.agentId),
    runId: resolveRunId(),
    runtimeHomePath: input.runtimeHomePath,
    turnId: input.turnId
  });

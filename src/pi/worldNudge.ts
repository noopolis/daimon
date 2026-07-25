import { createHash } from "node:crypto";

import type { WakeEvent } from "../core/types.js";

export const WORLD_NUDGE_VERSION = "simfile.world-nudge.v1" as const;

export interface PiWorldTurnContext {
  readonly decisionToken: string;
  readonly requestId: string;
  readonly runId: string;
  readonly tick: number;
  readonly wakeId: string;
}

export interface PiWorldToolContextRef {
  current?: PiWorldTurnContext;
}

const exactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === [...expected].sort()[index]);
};

const validText = (value: unknown, maximum: number): value is string =>
  typeof value === "string"
  && value.length > 0
  && value.length <= maximum
  && value === value.trim();

/**
 * Recognizes the versioned world nudge envelope and converts transport
 * authority into a turn-local binding. The opaque token never enters the
 * model prompt or tool schema.
 */
export const worldTurnContext = (event: WakeEvent): PiWorldTurnContext | undefined => {
  if (event.kind !== "message" || event.delivery === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(event.text) as unknown;
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (!exactKeys(record, ["decision_token", "run_id", "tick", "version"])
    || record.version !== WORLD_NUDGE_VERSION
    || !validText(record.decision_token, 512)
    || !validText(record.run_id, 256)
    || !Number.isSafeInteger(record.tick)
    || (record.tick as number) < 0) return undefined;
  const requestId = `daimon-${createHash("sha256")
    .update(`${event.id}\0${record.decision_token}`)
    .digest("hex")}`;
  return Object.freeze({
    decisionToken: record.decision_token,
    requestId,
    runId: record.run_id,
    tick: record.tick as number,
    wakeId: event.id
  });
};

export const formatWorldWakePrompt = (context: PiWorldTurnContext): string => [
  "World decision wake:",
  `- run_id: ${context.runId}`,
  `- tick: ${context.tick}`,
  "",
  "The harness already bound this wake's authority to the world tools.",
  "Observe current state and perform one allowed action now."
].join("\n");

import { createHash } from "node:crypto";

import type { WakeEvent } from "../core/types.js";

export const WAKE_ACCEPTANCE_VERSION = "noopolis.wake-acceptance.v1" as const;
export const WAKE_ACCEPTANCE_FILE = "state.v1.json" as const;
export const WAKE_ACCEPTANCE_COMPLETED_TOMBSTONES = 512;
export const WAKE_ACCEPTANCE_FILE_BYTES_MAX = 1_048_576;
export const WAKE_ACCEPTANCE_FIELD_BYTES_MAX = 512;

export type WakeAcceptanceState = "accepted" | "invoking" | "completed" | "incomplete";

export type WakeAcceptanceSafeErrorCode =
  | "wake_delivery_conflict"
  | "wake_delivery_incomplete"
  | "wake_acceptance_store_corrupt"
  | "wake_delivery_invalid";

export class WakeAcceptanceError extends Error {
  constructor(readonly code: WakeAcceptanceSafeErrorCode) {
    super(code);
    this.name = "WakeAcceptanceError";
  }
}

const UTF8 = "utf8";
const IDENTITY_DOMAIN = "daimon.wake-acceptance.v1";

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): void => {
  const current = Object.keys(value);
  if (current.length !== keys.length) {
    throw new WakeAcceptanceError("wake_acceptance_store_corrupt");
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new WakeAcceptanceError("wake_acceptance_store_corrupt");
    }
  }
};

const assertInteger = (value: unknown, key: string, allowNegative = false): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || (!allowNegative && value < 0)) {
    throw new WakeAcceptanceError("wake_acceptance_store_corrupt");
  }
  return value;
};

const textMaxBytes = (value: string, maxBytes: number = WAKE_ACCEPTANCE_FIELD_BYTES_MAX): boolean =>
  Buffer.byteLength(value, UTF8) <= maxBytes;

const assertText = (
  value: unknown,
  code: WakeAcceptanceSafeErrorCode,
  allowEmpty = false
): string => {
  if (typeof value !== "string") {
    throw new WakeAcceptanceError(code);
  }
  if (!allowEmpty && value.length === 0) {
    throw new WakeAcceptanceError(code);
  }
  if (!textMaxBytes(value)) {
    throw new WakeAcceptanceError(code);
  }
  return value;
};

const assertTextUnbounded = (value: unknown, code: WakeAcceptanceSafeErrorCode): string => {
  if (typeof value !== "string") {
    throw new WakeAcceptanceError(code);
  }
  return value;
};

const assertObject = (value: unknown, code: WakeAcceptanceSafeErrorCode): Record<string, unknown> => {
  if (!isObject(value)) {
    throw new WakeAcceptanceError(code);
  }
  return value;
};

const canonical = (left: WakeAcceptanceRecord, right: WakeAcceptanceRecord): number => {
  if (left.sequence !== right.sequence) {
    return left.sequence - right.sequence;
  }
  return left.identity.localeCompare(right.identity);
};

const isHex64 = (value: string): boolean => /^[0-9a-f]{64}$/u.test(value);

export interface WakeAcceptanceAttempt {
  bodySha256: string;
  contextId: string;
  digest: string;
  eventId: string;
  identity: string;
  kind: string;
  sender: string;
  target: string;
}

export interface WakeAcceptanceRecord {
  body_sha256: string;
  context_id: string;
  digest: string;
  event_id: string;
  identity: string;
  kind: string;
  sender: string;
  state: WakeAcceptanceState;
  sequence: number;
  target: string;
}

export interface WakeAcceptanceStoreState {
  version: string;
  run_id: string;
  agent_id: string;
  next_sequence: number;
  records: WakeAcceptanceRecord[];
}

const sha256 = (value: string): string => createHash("sha256").update(value, UTF8).digest("hex");

const identityPreimage = (input: {
  runId: string;
  agentId: string;
  eventId: string;
}): string => `${IDENTITY_DOMAIN}\0${input.runId}\0${input.agentId}\0${input.eventId}`;

export const wakeAcceptanceIdentity = (input: {
  runId: string;
  agentId: string;
  eventId: string;
}): string => sha256(identityPreimage(input));

export const wakeAcceptanceDigest = (input: {
  bodySha256: string;
  contextId: string;
  eventId: string;
  kind: string;
  sender: string;
  target: string;
}): string =>
  sha256(
    JSON.stringify({
      body_sha256: input.bodySha256,
      context_id: input.contextId,
      event_id: input.eventId,
      kind: input.kind,
      sender: input.sender,
      target: input.target
    })
  );

const parseRecord = (raw: Record<string, unknown>): WakeAcceptanceRecord => {
  exactKeys(raw, [
    "body_sha256",
    "context_id",
    "digest",
    "event_id",
    "identity",
    "kind",
    "sender",
    "state",
    "sequence",
    "target"
  ]);

  const body = assertText(raw.body_sha256, "wake_acceptance_store_corrupt");
  const contextId = assertText(raw.context_id, "wake_acceptance_store_corrupt");
  const digest = assertText(raw.digest, "wake_acceptance_store_corrupt");
  const eventId = assertText(raw.event_id, "wake_acceptance_store_corrupt");
  const identity = assertText(raw.identity, "wake_acceptance_store_corrupt");
  const kind = assertText(raw.kind, "wake_acceptance_store_corrupt");
  const sender = assertText(raw.sender, "wake_acceptance_store_corrupt");
  const target = assertText(raw.target, "wake_acceptance_store_corrupt");
  const state = assertText(raw.state, "wake_acceptance_store_corrupt");
  const sequence = assertInteger(raw.sequence, "sequence");

  if (state !== "accepted" && state !== "invoking" && state !== "completed" && state !== "incomplete") {
    throw new WakeAcceptanceError("wake_acceptance_store_corrupt");
  }

  if (!isHex64(body) || !isHex64(digest) || !isHex64(identity)) {
    throw new WakeAcceptanceError("wake_acceptance_store_corrupt");
  }

  return {
    body_sha256: body,
    context_id: contextId,
    digest,
    event_id: eventId,
    identity,
    kind,
    sender,
    state,
    sequence,
    target
  };
};

export const candidateFromDelivery = (input: {
  event: WakeEvent;
  runId: string;
  trustedAgentId: string;
}): WakeAcceptanceAttempt => {
  const eventId = assertText(input.event.id, "wake_delivery_invalid");
  const kind = assertText(input.event.kind, "wake_delivery_invalid");
  if (kind !== "message") {
    throw new WakeAcceptanceError("wake_delivery_invalid");
  }

  if (input.event.delivery === undefined) {
    throw new WakeAcceptanceError("wake_delivery_invalid");
  }

  if (assertText(input.event.delivery.eventId, "wake_delivery_invalid") !== eventId) {
    throw new WakeAcceptanceError("wake_delivery_invalid");
  }

  const sender = assertText(input.event.delivery.sender, "wake_delivery_invalid");
  const target = assertText(input.event.delivery.target, "wake_delivery_invalid");
  const contextId = assertText(input.event.delivery.contextId, "wake_delivery_invalid");
  const from = assertText(input.event.from, "wake_delivery_invalid");
  if (target !== input.trustedAgentId || from !== sender) {
    throw new WakeAcceptanceError("wake_delivery_invalid");
  }

  const bodySha256 = sha256(assertTextUnbounded(input.event.text, "wake_delivery_invalid"));

  return {
    bodySha256,
    contextId,
    digest: wakeAcceptanceDigest({
      bodySha256,
      contextId,
      eventId,
      kind,
      sender,
      target
    }),
    eventId,
    identity: wakeAcceptanceIdentity({ runId: input.runId, agentId: input.trustedAgentId, eventId }),
    kind,
    sender,
    target
  };
};

export const candidateFromEvent = (input: {
  event: WakeEvent;
  runId: string;
  agentId: string;
}): WakeAcceptanceAttempt =>
  candidateFromDelivery({
    event: input.event,
    runId: input.runId,
    trustedAgentId: input.agentId
  });

const parseState = (
  raw: unknown,
  context: { runId: string; agentId: string }
): WakeAcceptanceStoreState => {
  const root = assertObject(raw, "wake_acceptance_store_corrupt");
  exactKeys(root, ["version", "run_id", "agent_id", "next_sequence", "records"]);

  const version = assertText(root.version, "wake_acceptance_store_corrupt");
  const runId = assertText(root.run_id, "wake_acceptance_store_corrupt");
  const agentId = assertText(root.agent_id, "wake_acceptance_store_corrupt");
  const nextSequence = assertInteger(root.next_sequence, "next_sequence");

  if (version !== WAKE_ACCEPTANCE_VERSION || runId !== context.runId || agentId !== context.agentId) {
    throw new WakeAcceptanceError("wake_acceptance_store_corrupt");
  }

  if (!Array.isArray(root.records)) {
    throw new WakeAcceptanceError("wake_acceptance_store_corrupt");
  }

  const records = root.records.map((entry) => {
    const parsed = parseRecord(assertObject(entry, "wake_acceptance_store_corrupt"));

    if (parsed.kind !== "message") {
      throw new WakeAcceptanceError("wake_acceptance_store_corrupt");
    }

    if (parsed.target !== context.agentId) {
      throw new WakeAcceptanceError("wake_acceptance_store_corrupt");
    }

    const expectedIdentity = wakeAcceptanceIdentity({
      runId,
      agentId,
      eventId: parsed.event_id
    });
    if (parsed.identity !== expectedIdentity) {
      throw new WakeAcceptanceError("wake_acceptance_store_corrupt");
    }

    const expectedDigest = wakeAcceptanceDigest({
      bodySha256: parsed.body_sha256,
      contextId: parsed.context_id,
      eventId: parsed.event_id,
      kind: parsed.kind,
      sender: parsed.sender,
      target: parsed.target
    });

    if (parsed.digest !== expectedDigest) {
      throw new WakeAcceptanceError("wake_acceptance_store_corrupt");
    }

    return parsed;
  });

  let completed = 0;
  let previousSequence = 0;
  const seenSequences = new Set<number>();
  const seenIdentities = new Set<string>();

  for (const record of records) {
    if (record.sequence <= 0 || seenSequences.has(record.sequence)) {
      throw new WakeAcceptanceError("wake_acceptance_store_corrupt");
    }

    if (record.sequence <= previousSequence) {
      throw new WakeAcceptanceError("wake_acceptance_store_corrupt");
    }

    if (seenIdentities.has(record.identity)) {
      throw new WakeAcceptanceError("wake_acceptance_store_corrupt");
    }

    if (record.sequence > nextSequence) {
      throw new WakeAcceptanceError("wake_acceptance_store_corrupt");
    }

    seenSequences.add(record.sequence);
    seenIdentities.add(record.identity);
    if (record.state === "completed") {
      completed += 1;
    }

    previousSequence = record.sequence;
  }

  if (records.length > 0 && previousSequence !== nextSequence) {
    throw new WakeAcceptanceError("wake_acceptance_store_corrupt");
  }

  if (records.length === 0 && nextSequence !== 0) {
    throw new WakeAcceptanceError("wake_acceptance_store_corrupt");
  }

  if (completed > WAKE_ACCEPTANCE_COMPLETED_TOMBSTONES) {
    throw new WakeAcceptanceError("wake_acceptance_store_corrupt");
  }

  return {
    version: WAKE_ACCEPTANCE_VERSION,
    run_id: runId,
    agent_id: agentId,
    next_sequence: nextSequence,
    records
  };
};

export const parseWakeAcceptanceState = parseState;

export const emptyWakeAcceptanceState = (context: { runId: string; agentId: string }): WakeAcceptanceStoreState => ({
  version: WAKE_ACCEPTANCE_VERSION,
  run_id: context.runId,
  agent_id: context.agentId,
  next_sequence: 0,
  records: []
});

export const pruneCompletedRecords = (records: WakeAcceptanceRecord[]): WakeAcceptanceRecord[] => {
  const active = [...records].filter((record) => record.state !== "completed").sort(canonical);
  const completed = [...records]
    .filter((record) => record.state === "completed")
    .sort(canonical);

  if (completed.length > WAKE_ACCEPTANCE_COMPLETED_TOMBSTONES) {
    const keep = completed.slice(completed.length - WAKE_ACCEPTANCE_COMPLETED_TOMBSTONES);
    return [...active, ...keep].sort(canonical);
  }

  return [...active, ...completed].sort(canonical);
};

export const serializeWakeAcceptanceState = (state: WakeAcceptanceStoreState): string => JSON.stringify(state);

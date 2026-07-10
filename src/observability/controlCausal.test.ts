import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CAUSAL_EVENT_VERSION } from "./causalEvents.js";
import {
  CONTROL_WAKE_ACCEPTED_TYPE,
  CONTROL_WAKE_DENIED_TYPE,
  DELIVERY_PRINCIPAL_ID,
  controlWakeAcceptedEventId,
  controlWakeDeniedEventId,
  deliveryWakeAcceptedEventId,
  emitControlWakeAccepted,
  emitControlWakeDenied,
  emitDeliveryWakeAccepted,
  operatorPrincipalId
} from "./controlCausal.js";

const tempRoots: string[] = [];

const tempDir = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "noopolis-daimon-control-causal-"));
  tempRoots.push(directory);
  return directory;
};

test.afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const readJsonl = async (runtimeHomePath: string): Promise<Record<string, unknown>[]> => {
  const raw = await readFile(path.join(runtimeHomePath, "telemetry", "causal.jsonl"), "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
};

test("operatorPrincipalId follows the specs/CAUSAL.md §3 grammar", () => {
  assert.equal(operatorPrincipalId("control"), "operator:control");
  assert.match(operatorPrincipalId("control"), /^(agent|operator|system):.+/u);
});

test("emitControlWakeAccepted stamps control.wake.accepted with an operator: principal", async () => {
  const runtimeHomePath = await tempDir();

  const event = await emitControlWakeAccepted({
    operatorName: "control",
    requestId: "req-1",
    runId: "run-1",
    runtimeHomePath,
    targetAgentId: "mapper",
    wakeKind: "message"
  });

  assert.equal(event.version, CAUSAL_EVENT_VERSION);
  assert.equal(event.type, CONTROL_WAKE_ACCEPTED_TYPE);
  assert.equal(event.event_id, controlWakeAcceptedEventId("req-1"));
  assert.equal(event.event_id, "daimon:req-1:control.wake.accepted");
  assert.equal(event.principal_id, "operator:control");
  assert.equal(event.run_id, "run-1");
  assert.deepEqual(event.emitter, { system: "daimon", stream_id: "agent:mapper", seq: 1 });
  assert.deepEqual(event.cause_event_ids, []);
  assert.equal(event.payload.target_agent_id, "mapper");
  assert.equal(event.payload.wake_kind, "message");
  assert.equal(typeof event.recorded_at, "string");
  assert.equal(Number.isNaN(Date.parse(event.recorded_at)), false);

  const lines = await readJsonl(runtimeHomePath);
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0], event as unknown as Record<string, unknown>);
});

test("emitControlWakeDenied stamps control.wake.denied with an operator: principal and a reason", async () => {
  const runtimeHomePath = await tempDir();

  const event = await emitControlWakeDenied({
    operatorName: "control",
    reason: "missing bearer token",
    requestId: "req-2",
    runId: "run-1",
    runtimeHomePath,
    targetAgentId: "mapper"
  });

  assert.equal(event.type, CONTROL_WAKE_DENIED_TYPE);
  assert.equal(event.event_id, controlWakeDeniedEventId("req-2"));
  assert.equal(event.event_id, "daimon:req-2:control.wake.denied");
  assert.equal(event.principal_id, "operator:control");
  assert.deepEqual(event.emitter, { system: "daimon", stream_id: "agent:mapper", seq: 1 });
  assert.equal(event.payload.reason, "missing bearer token");
  assert.equal(event.payload.target_agent_id, "mapper");

  const lines = await readJsonl(runtimeHomePath);
  assert.equal(lines.length, 1);
});

test("accepted and denied events for the same run/target share one contiguous stream", async () => {
  const runtimeHomePath = await tempDir();

  const denied = await emitControlWakeDenied({
    operatorName: "control",
    reason: "invalid token",
    requestId: "req-3",
    runId: "run-1",
    runtimeHomePath,
    targetAgentId: "mapper"
  });
  const accepted = await emitControlWakeAccepted({
    operatorName: "control",
    requestId: "req-4",
    runId: "run-1",
    runtimeHomePath,
    targetAgentId: "mapper",
    wakeKind: "manual"
  });

  assert.equal(denied.emitter.seq, 1);
  assert.equal(accepted.emitter.seq, 2);
  assert.deepEqual(denied.emitter, { system: "daimon", stream_id: "agent:mapper", seq: 1 });
});

test("emitDeliveryWakeAccepted stamps control.wake.accepted with the fixed system:moltnet principal", async () => {
  const runtimeHomePath = await tempDir();

  const event = await emitDeliveryWakeAccepted({
    requestId: "req-delivery-1",
    runId: "run-1",
    runtimeHomePath,
    targetAgentId: "mapper",
    wakeKind: "message"
  });

  assert.equal(event.version, CAUSAL_EVENT_VERSION);
  assert.equal(event.type, CONTROL_WAKE_ACCEPTED_TYPE);
  assert.equal(event.event_id, deliveryWakeAcceptedEventId("req-delivery-1"));
  assert.equal(event.event_id, "daimon:req-delivery-1:delivery.wake.accepted");
  assert.equal(event.principal_id, DELIVERY_PRINCIPAL_ID);
  assert.equal(event.principal_id, "system:moltnet");
  assert.match(event.principal_id, /^system:.+/u);
  assert.equal(/^operator:/u.test(event.principal_id), false);
  assert.equal(event.run_id, "run-1");
  assert.deepEqual(event.emitter, { system: "daimon", stream_id: "agent:mapper", seq: 1 });
  assert.deepEqual(event.cause_event_ids, []);
  assert.equal(event.payload.target_agent_id, "mapper");
  assert.equal(event.payload.wake_kind, "message");
  assert.equal(event.payload.delivered_by, "moltnet");
  assert.equal(typeof event.recorded_at, "string");
  assert.equal(Number.isNaN(Date.parse(event.recorded_at)), false);

  const lines = await readJsonl(runtimeHomePath);
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0], event as unknown as Record<string, unknown>);
});

test("emitDeliveryWakeAccepted never derives its principal from a caller-supplied field", async () => {
  const runtimeHomePath = await tempDir();

  // Simulate a delivery request whose body carries an impersonation
  // attempt (e.g. a forged `from` field); emitDeliveryWakeAccepted takes
  // no such field at all, so there is nothing to smuggle a different
  // principal through.
  const event = await emitDeliveryWakeAccepted({
    requestId: "req-delivery-spoof",
    runId: "run-1",
    runtimeHomePath,
    targetAgentId: "mapper",
    wakeKind: "message"
  });

  assert.equal(event.principal_id, "system:moltnet");
  assert.notEqual(event.principal_id, "operator:control");
  assert.notEqual(event.principal_id, "attacker");
});

test("no field lets the request body override principal_id, run_id, or event_id", async () => {
  const runtimeHomePath = await tempDir();

  // Simulate a request whose body/claimed identity tries to impersonate a
  // different operator; only the caller-supplied `operatorName` (the
  // identity behind the verified bearer token, per appControlSource.ts)
  // ever reaches principal_id.
  const event = await emitControlWakeDenied({
    operatorName: "control",
    reason: "invalid token",
    requestId: "req-spoof",
    runId: "run-1",
    runtimeHomePath,
    targetAgentId: "mapper"
  });

  assert.equal(event.principal_id, "operator:control");
  assert.notEqual(event.principal_id, "attacker");
});

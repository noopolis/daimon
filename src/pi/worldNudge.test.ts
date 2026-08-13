import assert from "node:assert/strict";
import test from "node:test";

import type { WakeEvent } from "../core/types.js";
import {
  formatWorldWakePrompt,
  worldWakeContext,
  worldTurnContext,
  WORLD_NUDGE_VERSION
} from "./worldNudge.js";

const event = (text: string): WakeEvent => ({
  id: "moltnet:message-1",
  kind: "message",
  from: "world",
  text,
  delivery: {
    eventId: "moltnet:message-1",
    sender: "world",
    target: "red",
    contextId: "dm:red:world"
  }
});

test("synthesizes readonly claim identity for manual, message, and schedule wakes", () => {
  for (const kind of ["manual", "message", "schedule"] as const) {
    const context = worldWakeContext({ id: `${kind}-wake`, kind, text: "strategy" });
    assert.equal(context.wakeId, `${kind}-wake`);
    assert.match(context.requestId, /^daimon-[a-f0-9]{64}$/u);
    assert.equal(context.decisionToken, undefined);
    assert.equal(Object.isFrozen(context), true);
    const prompt = formatWorldWakePrompt(context);
    assert.match(prompt, /Call world_claim/u);
    assert.doesNotMatch(prompt, /decision_token|Bearer/u);
  }
});

test("binds an exact world nudge without reflecting its token into the prompt", () => {
  const context = worldTurnContext(event(JSON.stringify({
    version: WORLD_NUDGE_VERSION,
    run_id: "run-1",
    tick: 42,
    decision_token: "opaque-decision-token"
  })));
  assert.ok(context);
  assert.equal(context.decisionToken, "opaque-decision-token");
  assert.match(context.requestId, /^daimon-[a-f0-9]{64}$/u);
  const prompt = formatWorldWakePrompt(context);
  assert.match(prompt, /run-1[\s\S]*tick: 42[\s\S]*already bound/u);
  assert.equal(prompt.includes("opaque-decision-token"), false);
});

test("rejects untrusted or malformed lookalikes", () => {
  const valid = {
    version: WORLD_NUDGE_VERSION,
    run_id: "run-1",
    tick: 42,
    decision_token: "opaque-decision-token"
  };
  assert.equal(worldTurnContext({ ...event(JSON.stringify(valid)), delivery: undefined }), undefined);
  assert.equal(worldTurnContext(event(JSON.stringify({ ...valid, extra: true }))), undefined);
  assert.equal(worldTurnContext(event(JSON.stringify({ ...valid, tick: -1 }))), undefined);
  assert.equal(worldTurnContext(event("{not-json")), undefined);
});

test("binds the trusted delivery body before runtime prompt enrichment", () => {
  const valid = {
    version: WORLD_NUDGE_VERSION,
    run_id: "run-1",
    tick: 7,
    decision_token: "opaque-decision-token"
  };
  const delivered = event("runtime-enriched prompt");
  const context = worldTurnContext({
    ...delivered,
    transportText: JSON.stringify(valid)
  });
  assert.equal(context?.runId, "run-1");
  assert.equal(context?.tick, 7);
});

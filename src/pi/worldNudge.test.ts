import assert from "node:assert/strict";
import test from "node:test";

import type { WakeEvent } from "../core/types.js";
import {
  formatWorldWakePrompt,
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

import assert from "node:assert/strict";
import test from "node:test";

import { formatWakePrompt } from "./prompts.js";

test("formatWakePrompt makes missing attribution visibly distinct", () => {
  const prompt = formatWakePrompt({ id: "wake-1", kind: "message", text: "hello" });

  assert.match(prompt, /from: \[no attribution supplied\] \(absence\)/u);
  assert.doesNotMatch(prompt, /operator/u);
  assert.notEqual(prompt, formatWakePrompt({ id: "wake-1", kind: "message", text: "hello", from: "[no attribution supplied]" }));
});

test("formatWakePrompt preserves explicit attribution", () => {
  assert.match(
    formatWakePrompt({ id: "wake-2", kind: "message", text: "hello", from: "operator" }),
    /from: operator/u
  );
  assert.match(
    formatWakePrompt({ id: "wake-3", kind: "message", text: "hello", from: "agent:mapper" }),
    /from: agent:mapper/u
  );
});

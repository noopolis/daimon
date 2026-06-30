import assert from "node:assert/strict";
import { test } from "node:test";

import { JungianTrace, parseInnerUsed, parseSpeakLine } from "./jungianTrace.js";

test("parseInnerUsed extracts normalized archetype ids", () => {
  assert.deepEqual(
    parseInnerUsed("SPEAK: yes\nSTAGE: stillness\nINNER_USED: Persona, shadow; wise-one."),
    ["persona", "shadow", "wise-one"]
  );
});

test("parseSpeakLine prefers the SPEAK stanza", () => {
  assert.equal(
    parseSpeakLine("ARCHETYPE: none\nSPEAK: I will name the wound.\nINNER_USED: shadow"),
    "I will name the wound."
  );
});

test("parseSpeakLine strips accidental wrapping quotes", () => {
  assert.equal(
    parseSpeakLine("SPEAK: \"Plug your phone in first.\"\nINNER_USED: persona"),
    "Plug your phone in first."
  );
});

test("parseSpeakLine strips accidental markdown emphasis markers", () => {
  assert.equal(
    parseSpeakLine("SPEAK: ** Okay. I'll text you by ten.\nINNER_USED: leo-soul-image"),
    "Okay. I'll text you by ten."
  );
});

test("JungianTrace renders inner counsel before the public line", () => {
  const trace = new JungianTrace({ runId: "run-test", title: "Trace Test" });
  trace.addCounsel({
    archetype: "Shadow",
    engine: "agy",
    event: "maya-turn-01-council-maya-shadow",
    output: "ARCHETYPE: Shadow\nCOUNSEL: Say the plain thing.",
    recallSelected: 0,
    self: "Maya",
    voice: "maya-shadow"
  });
  trace.addDialogue({
    engine: "codex",
    event: "maya-turn-01-speaks",
    output: "SPEAK: We need chairs.\nINNER_USED: maya-shadow",
    recallSelected: 0,
    self: "Maya",
    speaker: "Maya Self"
  });

  const markdown = trace.toMarkdown();
  assert.match(markdown, /## Interleaved Conversation/);
  assert.ok(markdown.indexOf("#### Shadow · maya-shadow") < markdown.indexOf("> We need chairs."));
});

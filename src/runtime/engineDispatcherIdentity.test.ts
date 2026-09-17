import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { identityEnvelope } from "./engineDispatcher.js";
import { DAIMON_GROK_MCP_SERVER, DAIMON_GROK_SYSTEM_PROMPT, DAIMON_GROK_TOOL_PREFIX, GROK_MCP_INVOKE_TOOL, GROK_MCP_SEARCH_TOOL, GROK_MCP_TOOL_NAME_ARGUMENT, grokDaimonToolName } from "../contracts/grokWorkerContract.js";
import type { OrganizationRuntimeAgentConfig } from "./organizationRuntime.js";

const rootConfig = (root: string, kind: OrganizationRuntimeAgentConfig["engine"]["kind"]): OrganizationRuntimeAgentConfig => ({
  id: `${kind}-agent`, name: kind, instructions: "Reply.",
  workspacePath: path.join(root, "workspace", kind), runtimeHomePath: path.join(root, "runtime", kind),
  engine: { kind }
});

/**
 * The envelope's Grok wording is the second naming rule a Grok worker reads,
 * after the pinned system prompt. It used to instruct the bare form, which
 * Grok 1.0.34 refuses outright as an invalid MCP tool name, so what is asserted
 * here is agreement: the same route, stated once, the prefixed form named as
 * the only valid one, and no third voice about `search_tool`.
 */
const mounted = ["moltnet_read", "moltnet_send", "memory_search"] as const;
const envelopeToolSentence = (kind: OrganizationRuntimeAgentConfig["engine"]["kind"]): string =>
  identityEnvelope(rootConfig("/private/org", kind), mounted).split("\n").find((line) => line.startsWith("Your mounted tools are exactly"))!;

test("the Grok envelope names the prefixed form as the only valid one, once", () => {
  const sentence = envelopeToolSentence("grok");
  // The route, asserted: one bare catalogue, one prefix rule, one example.
  assert.equal(sentence.includes(`Your mounted tools are exactly: ${mounted.join(", ")}.`), true);
  assert.match(sentence, new RegExp(`MCP tool on server ${DAIMON_GROK_MCP_SERVER}`, "u"));
  assert.match(sentence, new RegExp(`only valid tool name is ${DAIMON_GROK_TOOL_PREFIX}<name>`, "u"));
  assert.match(sentence, new RegExp(`invoke it with ${GROK_MCP_INVOKE_TOOL}, ${GROK_MCP_TOOL_NAME_ARGUMENT} = ${grokDaimonToolName(mounted[0])}`, "u"));
  // A bare name is invalid, not merely discouraged: that is the CLI's own verdict.
  assert.match(sentence, /A bare name is not a valid MCP tool name and reaches nothing\./u);
  assert.match(sentence, /No other tool reaches the newsroom\.$/u);
  // What it must never say: the bare names are callable, the agent's own
  // instructions are wrong, or a shell reaches the tools.
  assert.doesNotMatch(sentence, /Call them by these names/u);
  assert.doesNotMatch(sentence, /spell them differently/u);
  assert.doesNotMatch(sentence, /shell|terminal|CLI|run_terminal/u);
  // Fewer authoritative voices: the pinned prompt and Grok's own injected
  // notice already give two rules for `search_tool`. This adds no third.
  assert.equal(sentence.includes(GROK_MCP_SEARCH_TOOL), false);
  // One catalogue only: the prefixed names are a rule, not a second list.
  for (const tool of mounted) assert.equal(sentence.split(tool).length - 1, tool === mounted[0] ? 2 : 1, tool);
  assert.equal(sentence.split(DAIMON_GROK_TOOL_PREFIX).length - 1, 2, "prefix appears as the rule and its one example");
  // The transport prohibition is untouched and still follows the tool sentence.
  assert.match(identityEnvelope(rootConfig("/private/org", "grok"), mounted), /Do not seek transport credentials or invoke a transport CLI/u);
});

test("the Grok envelope and the pinned worker system prompt state the same route", () => {
  const sentence = envelopeToolSentence("grok");
  for (const atom of [DAIMON_GROK_MCP_SERVER, DAIMON_GROK_TOOL_PREFIX, GROK_MCP_INVOKE_TOOL, GROK_MCP_TOOL_NAME_ARGUMENT]) {
    assert.ok(DAIMON_GROK_SYSTEM_PROMPT.includes(atom), `system prompt states ${atom}`);
    assert.ok(sentence.includes(atom), `envelope states ${atom}`);
  }
});

test("only Grok gains the prefix rule: every other engine's envelope stays byte-identical", () => {
  const unchanged = `Your mounted tools are exactly: ${mounted.join(", ")}. Call them by these names; your instructions may spell them differently. No other tool reaches the newsroom.`;
  for (const kind of ["codex", "agy"] as const) assert.equal(envelopeToolSentence(kind), unchanged);
  assert.notEqual(envelopeToolSentence("grok"), unchanged);
  // An unmounted agent gets no tool sentence at all, on every engine.
  for (const kind of ["codex", "agy", "grok"] as const) assert.doesNotMatch(identityEnvelope(rootConfig("/private/org", kind)), /Your mounted tools/u);
});

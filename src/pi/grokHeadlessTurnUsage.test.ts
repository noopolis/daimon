import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { decodeGrokHeadlessResult, decodeGrokHeadlessTurn } from "./grokHeadlessResult.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (name: string): string => readFileSync(path.join(fixtures, name), "utf8");

const assistant = (text: string) => ({
  type: "assistant", parent_tool_use_id: null, session_id: "session-1",
  message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text }] }
});
const result = (usage: unknown, extra: Record<string, unknown> = {}) => ({
  type: "result", subtype: "success", is_error: false, result: "ACK", stop_reason: "end_turn", session_id: "session-1",
  num_turns: 3, total_cost_usd: 0.0035, ...(usage === undefined ? {} : { usage }), ...extra
});
const stream = (...events: readonly unknown[]): string => events.map((event) => JSON.stringify(event)).join("\n");
const turn = (usage: unknown, extra: Record<string, unknown> = {}) =>
  decodeGrokHeadlessTurn(stream(assistant("ACK"), result(usage, extra)));

const fullUsage = {
  input_tokens: 8_746, output_tokens: 29,
  cache_read_input_tokens: 5_760, cache_creation_input_tokens: 12,
  server_tool_use: { web_search_requests: 0 }
};

test("the live success fixture decodes to the measured turn, with cache in the total", () => {
  const decoded = decodeGrokHeadlessTurn(fixture("grok-streaming-messages-json-success-result.jsonl"));
  assert.equal(decoded.text, "OK");
  assert.deepEqual(decoded.usage, {
    input: 8_746, output: 29, cacheRead: 5_760, cacheWrite: 0,
    // Mutation guard: `total` must include both cache buckets. Dropping them
    // yields 8,775 and hides the dominant cost of every wake.
    total: 14_535,
    calls: 1, notionalUsd: 0.0035, complete: true
  });
});

test("the live zero-filled fixture is a lower bound, not a free turn", () => {
  // The captured frame is a real `error_during_execution` result: grok's
  // Messages-shaped stream has no incompleteness marker, so an all-zero usage
  // block reads as "unknown". The decoder still refuses the frame outright,
  // because the turn never published — but the usage rule is asserted directly
  // below so the heuristic itself is pinned.
  assert.throws(() => decodeGrokHeadlessResult(fixture("grok-streaming-messages-json-error-result.jsonl")), /no publishable terminal response/u);
  assert.equal(turn({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }).usage?.complete, false);
  assert.equal(turn({ ...fullUsage, input_tokens: 0 }).usage?.complete, true, "a partially zero-filled turn is byte-indistinguishable and is not detected");
});

test("the captured fixtures carry no capturing machine's environment", () => {
  // These frames ship in the repo. The live capture embedded the operator's
  // home/scratchpad path and their personal skill and slash-command lists in
  // the `system/init` frame; none of it is anything the decoder reads.
  for (const name of [
    "grok-streaming-messages-json-error-result.jsonl",
    "grok-streaming-messages-json-success-result.jsonl"
  ]) {
    const text = fixture(name);
    assert.doesNotMatch(text, /\/Users\/|\/home\/|\/private\/tmp\//u, `${name} leaks a host path`);
    assert.doesNotMatch(text, /claude-\d+|scratchpad/u, `${name} leaks a host scratchpad`);
  }

  // The structural shape the parser walks is unchanged: a `system`/`init`
  // frame with the same keys, still carrying non-empty string arrays.
  const init = JSON.parse(fixture("grok-streaming-messages-json-error-result.jsonl").split("\n")[0]!);
  assert.equal(init.type, "system");
  assert.equal(init.subtype, "init");
  assert.equal(init.cwd, "/workspace");
  for (const key of ["tools", "slash_commands", "skills"]) {
    assert.ok(Array.isArray(init[key]) && init[key].length > 0, `init.${key} lost its shape`);
    assert.ok(init[key].every((entry: unknown) => typeof entry === "string"), `init.${key} lost its shape`);
  }
});

test("usage sums the four disjoint buckets and carries num_turns and the notional amount", () => {
  assert.deepEqual(turn(fullUsage).usage, {
    input: 8_746, output: 29, cacheRead: 5_760, cacheWrite: 12,
    total: 8_746 + 29 + 5_760 + 12, calls: 3, notionalUsd: 0.0035, complete: true
  });
});

test("a malformed, renamed, or stringified usage field yields no usage and never throws", () => {
  const rejected: readonly unknown[] = [
    undefined,
    null,
    "usage",
    [],
    { ...fullUsage, input_tokens: "8746" },
    { ...fullUsage, output_tokens: -1 },
    { ...fullUsage, cache_read_input_tokens: 1.5 },
    { ...fullUsage, cache_creation_input_tokens: Number.NaN },
    { ...fullUsage, cache_creation_input_tokens: Number.MAX_SAFE_INTEGER + 2 },
    { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 1 },
    { inputTokens: 8_746, outputTokens: 29, cacheReadInputTokens: 5_760, cacheCreationInputTokens: 0 }
  ];
  for (const usage of rejected) {
    const decoded = turn(usage);
    assert.equal(decoded.text, "ACK");
    assert.equal(decoded.usage, undefined, `expected no usage for ${JSON.stringify(usage)}`);
  }
});

test("a malformed num_turns or total_cost_usd degrades to zero without discarding the token counts", () => {
  const decoded = turn(fullUsage, { num_turns: "3", total_cost_usd: "0.0035" });
  assert.equal(decoded.usage?.total, 8_746 + 29 + 5_760 + 12);
  assert.equal(decoded.usage?.calls, 0);
  assert.equal(decoded.usage?.notionalUsd, 0);
  assert.equal(turn(fullUsage, { total_cost_usd: -1 }).usage?.notionalUsd, 0);
});

test("an error stream carrying plausible usage still throws rather than publishing a metered turn", () => {
  assert.throws(() => decodeGrokHeadlessTurn(stream(
    assistant("ACK"),
    { type: "error", message: "engine died", usage: fullUsage, total_cost_usd: 9.99 }
  )), /no publishable terminal response/u);
});

test("no engine-controlled string from the usage block reaches the decoded record", () => {
  const canary = "usage-canary-must-not-persist";
  const decoded = turn({
    ...fullUsage, model: canary, note: canary,
    server_tool_use: { web_search_requests: 0, label: canary }
  }, { modelUsage: { [canary]: { inputTokens: 1, costUSD: 1 } } });
  assert.equal(JSON.stringify(decoded.usage).includes(canary), false);
  assert.equal(decoded.usage?.total, 8_746 + 29 + 5_760 + 12);
});

test("the text-only decoder still returns exactly the published reply", () => {
  assert.equal(decodeGrokHeadlessResult(stream(assistant("ACK"), result(fullUsage))), "ACK");
});

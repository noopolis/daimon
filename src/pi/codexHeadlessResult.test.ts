import assert from "node:assert/strict";
import test from "node:test";

import { decodeCodexHeadlessResult, decodeCodexHeadlessTurn } from "./codexHeadlessResult.js";

const frame = (value: unknown): string => JSON.stringify(value);
const usage = (overrides: Record<string, unknown> = {}) => ({
  input_tokens: 18_110, cached_input_tokens: 11_008, cache_write_input_tokens: 0,
  output_tokens: 5, reasoning_output_tokens: 0, ...overrides
});
const stream = (...values: unknown[]): string => values.map(frame).join("\n");

test("decodes the captured Codex 0.151.0 stream and reconciled subset accounting", () => {
  const output = stream(
    { type: "thread.started", thread_id: "01a053f6-4a8d-7851-93e2-7d7fb1853849" },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "ok" } },
    { type: "turn.completed", usage: usage() }
  );
  assert.deepEqual(decodeCodexHeadlessTurn(output), {
    text: "ok",
    usage: { input: 18_110, output: 5, cacheRead: 11_008, cacheWrite: 0, total: 18_115, calls: 0, notionalUsd: 0, complete: true }
  });
  assert.equal(decodeCodexHeadlessResult(output), "ok");
});

test("cacheRead is a subset of input and is never added to total", () => {
  const decoded = decodeCodexHeadlessTurn(stream(
    { type: "item.completed", item: { type: "agent_message", text: "ok" } },
    { type: "turn.completed", usage: usage() }
  ));
  assert.equal(decoded.usage?.total, 18_110 + 5);
  assert.notEqual(decoded.usage?.total, 18_110 + 11_008 + 5);

  const invalidCacheSubset = decodeCodexHeadlessTurn(stream(
    { type: "item.completed", item: { type: "agent_message", text: "ok" } },
    { type: "turn.completed", usage: usage({ cached_input_tokens: 18_111 }) }
  ));
  assert.equal(invalidCacheSubset.usage?.complete, false);

  const invalidReasoningSubset = decodeCodexHeadlessTurn(stream(
    { type: "item.completed", item: { type: "agent_message", text: "ok" } },
    { type: "turn.completed", usage: usage({ reasoning_output_tokens: 6 }) }
  ));
  assert.equal(invalidReasoningSubset.usage?.complete, false);
});

test("tool frames are counted while the last agent message is published", () => {
  const decoded = decodeCodexHeadlessTurn(stream(
    { type: "item.completed", item: { type: "agent_message", text: "draft" } },
    { type: "item.started", item: { type: "command_execution" } },
    { type: "item.completed", item: { type: "command_execution" } },
    { type: "item.completed", item: { type: "mcp_tool_call" } },
    { type: "item.completed", item: { type: "agent_message", text: "final" } },
    { type: "turn.completed", usage: usage() }
  ));
  assert.equal(decoded.text, "final");
  assert.equal(decoded.usage?.calls, 2);
});

test("unknown future envelope and item types are skipped", () => {
  assert.equal(decodeCodexHeadlessResult(stream(
    { type: "future.envelope", payload: true },
    { type: "item.completed", item: { type: "agent_message", text: "right" } },
    { type: "item.completed", item: { type: "future_item", text: "wrong" } },
    { type: "turn.completed", usage: usage() }
  )), "right");
});

test("absent or malformed usage remains advisory", () => {
  const base = [{ type: "item.completed", item: { type: "agent_message", text: "ok" } }];
  assert.equal(decodeCodexHeadlessTurn(stream(...base, { type: "turn.completed" })).usage, undefined);
  for (const field of ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "reasoning_output_tokens"]) {
    for (const replacement of ["1", -1, 1.5]) {
      assert.equal(decodeCodexHeadlessTurn(stream(...base, { type: "turn.completed", usage: usage({ [field]: replacement }) })).usage, undefined);
    }
  }
});

test("invalid subset relationships clear complete without failing publication", () => {
  const decoded = decodeCodexHeadlessTurn(stream(
    { type: "item.completed", item: { type: "agent_message", text: "ok" } },
    { type: "turn.completed", usage: usage({ reasoning_output_tokens: 6 }) }
  ));
  assert.equal(decoded.usage?.complete, false);
});

test("a frame after turn.completed preserves the reply and usage", () => {
  const decoded = decodeCodexHeadlessTurn(stream(
    { type: "item.completed", item: { type: "agent_message", text: "ok" } },
    { type: "turn.completed", usage: usage() },
    { type: "future.envelope", payload: true }
  ));
  assert.equal(decoded.text, "ok");
  assert.equal(decoded.usage?.total, 18_115);
});

test("two turn.completed frames preserve the reply without ambiguous usage", () => {
  const decoded = decodeCodexHeadlessTurn(stream(
    { type: "item.completed", item: { type: "agent_message", text: "ok" } },
    { type: "turn.completed", usage: usage() },
    { type: "turn.completed", usage: usage() }
  ));
  assert.equal(decoded.text, "ok");
  assert.equal(decoded.usage, undefined);
});

test("a reply without turn.completed is published without usage", () => {
  const decoded = decodeCodexHeadlessTurn(stream(
    { type: "item.completed", item: { type: "agent_message", text: "ok" } }
  ));
  assert.deepEqual(decoded, { text: "ok" });
});

test("the last non-blank agent message wins", () => {
  const decoded = decodeCodexHeadlessTurn(stream(
    { type: "item.completed", item: { type: "agent_message", text: "ok" } },
    { type: "item.completed", item: { type: "agent_message", text: "   " } },
    { type: "turn.completed", usage: usage() }
  ));
  assert.equal(decoded.text, "ok");
  assert.equal(decoded.usage?.total, 18_115);
});

test("only a blank agent message rejects", () => {
  assert.throws(() => decodeCodexHeadlessTurn(stream(
    { type: "item.completed", item: { type: "agent_message", text: "   " } }
  )), /empty response/u);
});

test("turn.failed after a reply publishes text without usage", () => {
  assert.deepEqual(decodeCodexHeadlessTurn(stream(
    { type: "item.completed", item: { type: "agent_message", text: "ok" } },
    { type: "turn.failed", error: "no" }
  )), { text: "ok" });
});

test("turn.failed without a reply rejects", () => {
  assert.throws(() => decodeCodexHeadlessTurn(stream({ type: "turn.failed", error: "no" })), /failed turn/u);
});

test("empty streams reject", () => {
  assert.throws(() => decodeCodexHeadlessTurn(""), /empty stream/u);
});

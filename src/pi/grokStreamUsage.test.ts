import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { decodeGrokHeadlessTurn } from "./grokHeadlessResult.js";
import { decodeGrokStreamUsage } from "./grokStreamUsage.js";

const fixture = (): Promise<string> => readFile(fileURLToPath(new URL("./fixtures/grok-1.0.34-streaming-two-requests.jsonl", import.meta.url)), "utf8");

test("a real 1.0.34 two-request stream yields one row per request, summing exactly to the terminal result", async () => {
  const output = await fixture();
  const stream = decodeGrokStreamUsage(output);
  assert.deepEqual(stream.requests, [
    { index: 0, input: 2_568, cacheRead: 128, cacheWrite: 0, output: 79, total: 2_775 },
    { index: 1, input: 109, cacheRead: 2_688, cacheWrite: 0, output: 13, total: 2_810 }
  ]);
  assert.equal(stream.sessionId, "01a0ad21-a90f-7f71-8054-93fdb4334d6a");
  assert.deepEqual(stream.reportedModels, ["grok-4.6-build"]);
  const terminal = decodeGrokHeadlessTurn(output).usage!;
  assert.equal(stream.requests.reduce((sum, request) => sum + request.total, 0), terminal.total);
});

test("a malformed per-request usage block discards every request instead of reporting part of the turn", async () => {
  const lines = (await fixture()).split("\n");
  const index = lines.findIndex((line) => line.includes('"msg_1"'));
  lines[index] = lines[index]!.replace('"input_tokens":109', '"input_tokens":"109"');
  assert.deepEqual(decodeGrokStreamUsage(lines.join("\n")).requests, []);
});

test("frames repeating one message id are one request, and a torn line is skipped", async () => {
  const lines = (await fixture()).split("\n").filter((line) => line.length > 0);
  const repeated = lines.find((line) => line.includes('"msg_0"'))!;
  const stream = decodeGrokStreamUsage([...lines.slice(0, 2), repeated, ...lines.slice(2), '{"type":"assist'].join("\n"));
  assert.equal(stream.requests.length, 2);
});

test("the captured fixture carries no capturing machine's environment", async () => {
  assert.doesNotMatch(await fixture(), /\/Users\/|\/private\/|scratchpad|\/home\//u);
});

test("a per-request stream block beyond the context-window bound is invalid, not counted", async () => {
  const lines = (await fixture()).split("\n");
  const index = lines.findIndex((line) => line.includes('"msg_1"'));
  lines[index] = lines[index]!.replace('"input_tokens":109', '"input_tokens":900000000');
  assert.deepEqual(decodeGrokStreamUsage(lines.join("\n")).requests, []);
});

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { recordCodexTurnRequests } from "../runtime/turnRequestLedger.js";
import { createCliSessionFactory } from "./cliSession.js";

/**
 * The wake-to-rollout join, exercised against a real child process.
 *
 * The per-wake usage ledger cannot say whether a wake's fresh input is one cold
 * miss on a replayed prefix or a context that grows per request. The answer is
 * in the rollout Codex writes for the wake's own thread, and the only thing
 * that identifies *which* rollout is the thread id Codex announces on its first
 * frame. These tests fix that join: the id comes off the stream, never from
 * whichever file on disk happens to be newest.
 */

const FIXTURE_THREAD = "01a06f31-0000-7000-8000-000000000001";
const fixturePath = fileURLToPath(new URL("./fixtures/codex-rollout-token-usage.jsonl", import.meta.url));

const frame = (value: unknown): string => `process.stdout.write(${JSON.stringify(`${JSON.stringify(value)}\n`)});`;
const threadStarted = (threadId: string): string => frame({ type: "thread.started", thread_id: threadId });
const reply = (text: string): string => frame({ type: "item.completed", item: { type: "agent_message", text } });
const completed = (input: number, output: number): string =>
  frame({ type: "turn.completed", usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0 } });
const failed = frame({ type: "turn.failed", error: { message: "engine said no" } });

const plantRollout = async (home: string, threadId: string): Promise<void> => {
  const directory = path.join(home, "sessions", "2026", "09", "05");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `rollout-2026-09-05T03-31-52-${threadId}.jsonl`), await readFile(fixturePath, "utf8"), "utf8");
};

const runCodexWake = async (
  name: string,
  stub: readonly string[],
  onCodexTurnRequests?: (threadId: string) => Promise<void>
): Promise<{ threads: string[]; replies: string[]; failure: unknown; root: string; cleanup: () => Promise<void> }> => {
  const root = await mkdtemp(path.join(os.tmpdir(), `daimon-requests-${name}-`));
  const engine = path.join(root, "codex-stub.mjs");
  await writeFile(engine, stub.join("\n"));
  const threads: string[] = [];
  const replies: string[] = [];
  const cleanup = async (): Promise<void> => { await rm(root, { recursive: true, force: true }); };
  try {
    const { session } = await createCliSessionFactory({
      command: process.execPath,
      commandArgs: [engine],
      engine: "codex",
      timeoutMs: 10_000,
      onCodexTurnRequests: async (threadId) => {
        threads.push(threadId);
        await onCodexTurnRequests?.(threadId);
      }
    })({ cwd: root });
    session.subscribe((event) => {
      if (event.type !== "turn_end") return;
      const content = (event.message as { content?: readonly { type: string; text?: string }[] }).content ?? [];
      for (const part of content) if (part.type === "text" && typeof part.text === "string") replies.push(part.text);
    });
    const failure = await session.prompt("wake").then(() => undefined, (error: unknown) => error ?? new Error("rejected with no reason"));
    return { threads, replies, failure, root, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
};

test("the thread id is carried off the stream, exactly once, on a published wake", async () => {
  const run = await runCodexWake("published", [threadStarted(FIXTURE_THREAD), reply("done"), completed(8_000, 120)]);
  try {
    assert.equal(run.failure, undefined);
    assert.deepEqual(run.threads, [FIXTURE_THREAD]);
  } finally { await run.cleanup(); }
});

test("a failed wake is instrumented too, because it made and paid for model requests", async () => {
  const run = await runCodexWake("failed", [threadStarted(FIXTURE_THREAD), failed]);
  try {
    assert.ok(run.failure instanceof Error);
    assert.deepEqual(run.threads, [FIXTURE_THREAD]);
  } finally { await run.cleanup(); }
});

test("a stream that never announces a thread instruments nothing rather than guessing one", async () => {
  const run = await runCodexWake("no-thread", [reply("done"), completed(8_000, 120)]);
  try {
    assert.equal(run.failure, undefined);
    assert.deepEqual(run.threads, []);
  } finally { await run.cleanup(); }
});

test("the thread frame is not published as the wake's reply", async () => {
  const run = await runCodexWake("not-a-reply", [threadStarted(FIXTURE_THREAD), reply("the actual reply"), completed(8_000, 120)]);
  try {
    assert.equal(run.failure, undefined);
    assert.deepEqual(run.replies, ["the actual reply"], "reading the thread frame must not widen what the decoder publishes");
  } finally { await run.cleanup(); }
});

test("an instrumentation error never fails the wake it describes", async () => {
  const run = await runCodexWake("throwing-sink", [threadStarted(FIXTURE_THREAD), reply("done"), completed(8_000, 120)], async () => {
    throw new Error("the ledger volume is gone");
  });
  try {
    assert.equal(run.failure, undefined, "a wake that published must not be failed by its own instrumentation");
    assert.deepEqual(run.threads, [FIXTURE_THREAD]);
  } finally { await run.cleanup(); }
});

test("end to end: a wake's rollout becomes per-request rows in the side stream", async () => {
  const run = await runCodexWake("end-to-end", [threadStarted(FIXTURE_THREAD), reply("done"), completed(50_004, 288)]);
  try {
    const home = path.join(run.root, "codex-home");
    const file = path.join(run.root, "requests.jsonl");
    await plantRollout(home, FIXTURE_THREAD);
    assert.deepEqual(run.threads, [FIXTURE_THREAD]);
    await recordCodexTurnRequests({ agent: "agent-one", wake: "wake-1", codexHome: home, threadId: run.threads[0]!, file });
    const rows = (await readFile(file, "utf8")).split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line));
    assert.equal(rows.length, 4, "four model requests behind one aggregate ledger row");
    assert.deepEqual(rows.map((row) => row.fresh_input), [15_742, 248, 4_276, 10_068]);
    assert.equal(rows.every((row) => row.thread === FIXTURE_THREAD), true);
  } finally { await run.cleanup(); }
});

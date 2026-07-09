import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAgentSession } from "@earendil-works/pi-coding-agent";

import { PiHarnessAdapter, type PiSessionFactory } from "./piHarness.js";

type PiSessionEvent = {
  message?: { content?: string };
  status?: string;
  tool?: { name: string };
  type: string;
};
type PiSessionListener = (event: PiSessionEvent) => void;
type SessionResult = Awaited<ReturnType<typeof createAgentSession>>;
type FakeTool = {
  execute: (...args: unknown[]) => Promise<unknown>;
  name: string;
};

const tempRoots: string[] = [];

const tempDir = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "noopolis-daimon-turn-trace-"));
  tempRoots.push(directory);
  return directory;
};

test.afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const makeAdapter = (root: string, factory: PiSessionFactory): PiHarnessAdapter =>
  new PiHarnessAdapter({
    authPath: path.join(root, "auth.json"),
    model: {
      auth: { method: "none" },
      endpoint: { baseUrl: "http://127.0.0.1:11434/v1", compatibility: "openai" },
      name: "llama3.2",
      provider: "local"
    },
    sessionFactory: factory,
    memory: { tokenBudget: 1200 }
  });

const readTrace = async (runtimeHomePath: string, eventId: string): Promise<Record<string, any>> =>
  JSON.parse(await readFile(path.join(runtimeHomePath, "telemetry", "turns", `${eventId}.json`), "utf8")) as Record<string, any>;

test("Pi harness writes a safe per-turn trace with wake, memory, tool, and model metadata", async () => {
  const root = await tempDir();
  const runtimeHomePath = path.join(root, "runtime");
  const workspacePath = path.join(root, "workspace");
  const listeners = new Set<PiSessionListener>();

  const factory: PiSessionFactory = async (input) => ({
    session: {
      async prompt() {
        const tools = (input?.customTools ?? []) as FakeTool[];
        const search = tools.find((tool) => tool.name === "memory_search");
        assert.ok(search);
        await search.execute("trace-memory-search", { scope: "global", query: "trace", limit: 1 });
        for (const listener of listeners) {
          listener({ status: "completed", tool: { name: "bash" }, type: "tool_result" });
          listener({ type: "turn_end", message: { content: "trace reply" } });
        }
      },
      subscribe(listener: PiSessionListener) {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
      dispose() {
        listeners.clear();
      }
    }
  } as unknown as SessionResult);

  const handle = await makeAdapter(root, factory).startAgent({
    id: "mapper",
    name: "Mapper",
    instructions: "Trace every useful turn.",
    runtimeHomePath,
    workspacePath
  });

  await handle.wake({
    id: "wake-trace",
    kind: "message",
    from: "moltnet",
    text: "Use memory if useful.",
    context: { networkId: "noopolis", roomId: "agora", teamId: "ops" }
  });

  const trace = await readTrace(runtimeHomePath, "wake-trace");
  const ndjson = await readFile(path.join(runtimeHomePath, "telemetry", "turns.ndjson"), "utf8");
  assert.equal(JSON.parse(ndjson.trim()).turn_id, "wake-trace");
  assert.equal(trace.schema, "daimon.turn_trace.v1");
  assert.equal(trace.wake.event_id, "wake-trace");
  assert.equal(trace.wake.context.roomId, "agora");
  assert.deepEqual(trace.engine, {
    auth_method: "none",
    kind: "pi",
    model: "llama3.2",
    provider: "local-openai-llama3-2-a9fdcd05"
  });
  assert.equal(trace.memory.enabled, true);
  assert.equal(trace.memory.prepare.status, "completed");
  assert.equal(typeof trace.prompt.sha256, "string");
  assert.equal(trace.prompt.has_memory_context, true);
  assert.equal(trace.reply.reply_given, true);
  assert.equal(trace.tools.some((tool: Record<string, unknown>) => tool.name === "memory_search"), true);
  assert.equal(trace.tools.some((tool: Record<string, unknown>) => tool.name === "bash"), true);

  await handle.stop();
});

test("Pi harness writes failed turn traces with redacted errors", async () => {
  const root = await tempDir();
  const runtimeHomePath = path.join(root, "runtime");
  const workspacePath = path.join(root, "workspace");
  const factory: PiSessionFactory = async () => ({
    session: {
      async prompt() {
        throw new Error("failed sk-proj-abcdefghijklmnopqrstuvwxyz /Users/apresmoi/.codex/auth.json");
      },
      subscribe() {
        return () => {};
      },
      dispose() {}
    }
  } as unknown as SessionResult);

  const handle = await makeAdapter(root, factory).startAgent({
    id: "mapper",
    name: "Mapper",
    instructions: "Trace failures.",
    runtimeHomePath,
    workspacePath
  });

  await assert.rejects(handle.wake({
    id: "wake-failed",
    kind: "manual",
    text: "This will fail."
  }), /failed/u);

  const trace = await readTrace(runtimeHomePath, "wake-failed");
  assert.equal(trace.status, "failed");
  assert.equal(trace.error.stage, "engine_prompt");
  assert.match(trace.error.message, /\[path\]/u);
  assert.equal(trace.error.message.includes("sk-proj-abcdefghijklmnopqrstuvwxyz"), false);

  await handle.stop();
});

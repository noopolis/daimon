import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAgentSession } from "@earendil-works/pi-coding-agent";

import { memoryScopeId } from "@noopolis/mneme";
import { JsonlMemoryStore } from "@noopolis/mneme";
import { PiHarnessAdapter, type PiSessionFactory } from "./piHarness.js";

type PiSessionEvent = { type: string; message?: { content?: string | ReadonlyArray<unknown> } };
type PiSessionListener = (event: PiSessionEvent) => void;
type SessionResult = Awaited<ReturnType<typeof createAgentSession>>;

const tempRoots: string[] = [];

const tempDir = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "noopolis-daimon-pi-memory-tools-"));
  tempRoots.push(directory);
  return directory;
};

test.afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const seedRoomMemory = async (runtimeHomePath: string): Promise<void> => {
  const principal = { agentId: "mapper", scope: "room" as const, qualifier: "noopolis:agora" };
  await new JsonlMemoryStore(runtimeHomePath).append({
    type: "memory.observed",
    principal,
    scope: memoryScopeId(principal),
    visibility: "room",
    source: "pi-memory-tool-test",
    content: { kind: "text", text: "PI_CUSTOM_TOOL_MARKER is visible in this room." },
    tags: ["tool"],
    entities: ["tool"],
    sensitivity: "normal",
    parentEventIds: []
  });
};

test("Pi sessions receive provider-safe memory custom tools with active wake context", async () => {
  const root = await tempDir();
  const runtimeHomePath = path.join(root, "runtime");
  const workspacePath = path.join(root, "workspace");
  await seedRoomMemory(runtimeHomePath);

  const listeners = new Set<PiSessionListener>();
  const calls: Array<Parameters<PiSessionFactory>[0]> = [];
  let toolResultText = "";

  const factory: PiSessionFactory = async (input) => {
    calls.push(input);
    return {
      session: {
        async prompt() {
          const customTools = (calls[0]?.customTools ?? []) as Array<{
            name: string;
            execute: (...args: unknown[]) => Promise<{ content: Array<{ type: string; text: string }> }>;
          }>;
          const search = customTools.find((tool) => tool.name === "memory_search");
          assert.ok(search);
          const result = await search.execute(
            "tool-call-1",
            { scope: "current", query: "PI_CUSTOM_TOOL_MARKER", limit: 3 },
            undefined,
            undefined,
            {}
          );
          toolResultText = result.content[0]?.text ?? "";
          for (const listener of listeners) {
            listener({ type: "turn_end", message: { content: "ack" } });
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
    } as unknown as SessionResult;
  };

  const adapter = new PiHarnessAdapter({
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
  const handle = await adapter.startAgent({
    id: "mapper",
    name: "Mapper",
    instructions: "Use memory tools when necessary.",
    runtimeHomePath,
    workspacePath
  });

  const toolNames = calls[0]?.tools ?? [];
  assert.ok(toolNames.includes("memory_search"));
  assert.ok(toolNames.includes("memory_register"));

  await handle.wake({
    id: "wake-tool-search",
    kind: "manual",
    text: "Use memory_search for room context.",
    context: { networkId: "noopolis", roomId: "agora", teamId: "ops" }
  });

  assert.ok(toolResultText.includes("memory.search"));
  assert.ok(toolResultText.includes("PI_CUSTOM_TOOL_MARKER"));

  await handle.stop();
});

test("dream wakes use fresh dream sessions without replacing the awake session", async () => {
  const root = await tempDir();
  const runtimeHomePath = path.join(root, "runtime");
  const workspacePath = path.join(root, "workspace");
  const calls: Array<Parameters<PiSessionFactory>[0]> = [];
  const prompts: string[][] = [];
  const disposed: boolean[] = [];

  const factory: PiSessionFactory = async (input) => {
    const index = calls.length;
    const listeners = new Set<PiSessionListener>();
    calls.push(input);
    prompts.push([]);
    disposed.push(false);

    return {
      session: {
        async prompt(text: string) {
          prompts[index]?.push(text);
          for (const listener of listeners) {
            listener({ type: "turn_end", message: { content: `reply-${index}` } });
          }
        },
        subscribe(listener: PiSessionListener) {
          listeners.add(listener);
          return () => void listeners.delete(listener);
        },
        dispose() {
          disposed[index] = true;
          listeners.clear();
        }
      }
    } as unknown as SessionResult;
  };

  const adapter = new PiHarnessAdapter({
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
  const handle = await adapter.startAgent({
    id: "dreamer",
    name: "Dreamer",
    instructions: "Use Mneme memory deliberately.",
    runtimeHomePath,
    workspacePath
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0]?.resourceLoader?.getSystemPrompt?.() ?? "", /# Mneme Memory/u);

  await handle.wake({
    id: "dream-check",
    kind: "dream",
    text: "Consolidate memory now."
  });
  await handle.wake({
    id: "dream-check",
    kind: "dream",
    text: "Consolidate memory again."
  });
  await handle.wake({
    id: "manual-check",
    kind: "manual",
    text: "Return to normal work."
  });

  assert.equal(calls.length, 3);
  assert.match(calls[1]?.resourceLoader?.getSystemPrompt?.() ?? "", /# Mneme Dream/u);
  assert.match(calls[2]?.resourceLoader?.getSystemPrompt?.() ?? "", /# Mneme Dream/u);
  assert.match(prompts[1]?.[0] ?? "", /## Dream Mode/u);
  assert.match(prompts[1]?.[0] ?? "", /dream_thread: dream:dream-check-[a-f0-9]{8}/u);
  assert.match(prompts[2]?.[0] ?? "", /dream_thread: dream:dream-check-[a-f0-9]{8}/u);
  assert.notEqual(
    /dream_thread: (dream:[^\n]+)/u.exec(prompts[1]?.[0] ?? "")?.[1],
    /dream_thread: (dream:[^\n]+)/u.exec(prompts[2]?.[0] ?? "")?.[1]
  );
  assert.equal(prompts[0]?.some((prompt) => prompt.includes("Return to normal work.")), true);
  assert.deepEqual(disposed, [false, true, true]);

  await handle.stop();
  assert.equal(disposed[0], true);
});

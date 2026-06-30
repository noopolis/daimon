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


import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { JsonlMemoryStore } from "@noopolis/mneme";
import { PiHarnessAdapter } from "./piHarness.js";
import { createAgentSession } from "@earendil-works/pi-coding-agent";

type PiSessionEvent = { type: "turn_end"; message: { content?: string | ReadonlyArray<unknown> } };
type PiSessionListener = (event: PiSessionEvent) => void;
interface FakePiSessionConfig {
  prompts: string[];
  session: {
    prompt: (text: string, options?: Record<string, unknown>) => Promise<void>;
    dispose: () => void;
    subscribe: (listener: PiSessionListener) => () => void;
  };
}

const makeFakePiSessionFactory = (scripts: string[][]) => {
  const sessions: FakePiSessionConfig[] = [];
  type SessionResult = Awaited<ReturnType<typeof createAgentSession>>;
  let sessionIndex = 0;

  const factory = (input: Parameters<typeof createAgentSession>[0]) => {
    const responses = scripts[sessionIndex] ?? ["ack"];
    const currentSessionIndex = sessionIndex;
    sessionIndex += 1;
    const prompts: string[] = [];
    const listeners = new Set<PiSessionListener>();
    let responseCursor = 0;
    const session = {
      async prompt(text: string) {
        prompts.push(text);
        const customTools = (input?.customTools ?? []) as Array<{
          execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string; type: string }> }>;
          name: string;
        }>;
        const output = responses[responseCursor] ?? "ack";
        responseCursor += 1;
        let finalOutput = output;

        if (currentSessionIndex === 0) {
          const register = customTools.find((tool) => tool.name === "memory_register");
          assert.ok(register);
          await register.execute("register-1", {
            scope: "global",
            kind: "episodic",
            content: { kind: "text", text: "BANK_SHARED_SCOPE_ALPHA" },
            visibility: "global",
            sensitivity: "normal",
            evidence_event_ids: ["wake-mapper"],
            source_type: "test",
            confidence: 1
          });
        }

        if (currentSessionIndex === 1) {
          const search = customTools.find((tool) => tool.name === "memory_search");
          assert.ok(search);
          const result = await search.execute("search-1", {
            scope: "global",
            query: "BANK_SHARED_SCOPE_ALPHA",
            limit: 5
          });
          finalOutput = JSON.stringify(result).includes("BANK_SHARED_SCOPE_ALPHA")
            ? "found BANK_SHARED_SCOPE_ALPHA"
            : "missing";
        }

        for (const listener of listeners) {
          listener({ type: "turn_end", message: { content: finalOutput } });
        }
      },
      subscribe(listener: PiSessionListener) {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
      dispose() {
        listeners.clear();
      }
    };

    sessions.push({ prompts, session });
    return Promise.resolve({ session } as SessionResult);
  };

  return { sessions, factory };
};

const tempRoots: string[] = [];

const tempDir = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "noopolis-daimon-pi-harness-share-"));
  tempRoots.push(directory);
  return directory;
};

test.afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("shares one Mneme bank across agents with separate Pi runtimes", async () => {
  const root = await tempDir();
  const factory = makeFakePiSessionFactory([["ack-a"], ["ack-b"]]);
  const mapperRuntimeHome = path.join(root, "agent-a", "runtime");
  const listenerRuntimeHome = path.join(root, "agent-b", "runtime");
  const mapperWorkspace = path.join(root, "agent-a", "workspace");
  const listenerWorkspace = path.join(root, "agent-b", "workspace");
  const adapter = new PiHarnessAdapter({
    authPath: path.join(root, "auth.json"),
    model: {
      auth: { method: "none" },
      endpoint: {
        baseUrl: "http://127.0.0.1:11434/v1",
        compatibility: "openai"
      },
      name: "llama3.2",
      provider: "local"
    },
    sessionFactory: factory.factory,
    memory: {
      runtimeHomePath: path.join(root, "memory-bank"),
      tokenBudget: 1200
    }
  });

  const mapper = await adapter.startAgent({
    id: "mapper",
    name: "Mapper",
    instructions: "Record and reuse durable memory.",
    runtimeHomePath: mapperRuntimeHome,
    workspacePath: mapperWorkspace
  });

  await mapper.wake({
    id: "wake-mapper",
    kind: "manual",
    text: "Store durable global marker: BANK_SHARED_SCOPE_ALPHA"
  });
  await mapper.stop();

  const listener = await adapter.startAgent({
    id: "listener",
    name: "Listener",
    instructions: "Use recalled memory when relevant.",
    runtimeHomePath: listenerRuntimeHome,
    workspacePath: listenerWorkspace
  });

  assert.notEqual(mapperRuntimeHome, listenerRuntimeHome);
  assert.notEqual(mapperWorkspace, listenerWorkspace);

  await listener.wake({
    id: "wake-listener",
    kind: "manual",
    text: "What did we agree earlier?"
  });

  const sharedBank = new JsonlMemoryStore(path.join(root, "memory-bank"));
  const sharedEvents = await sharedBank.read({});
  const agentIds = new Set(sharedEvents.map((event) => event.principal?.agentId));
  assert.ok(agentIds.has("mapper"));
  assert.equal(agentIds.has("listener"), false);
  assert.ok(JSON.stringify(sharedEvents).includes("BANK_SHARED_SCOPE_ALPHA"));

  await listener.stop();
});

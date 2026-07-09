import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { memoryScopeId } from "@noopolis/mneme";
import { JsonlMemoryStore } from "@noopolis/mneme";
import { createMemoryRuntime } from "@noopolis/mneme";
import { PiHarnessAdapter, type PiSessionFactory } from "./piHarness.js";

type PiSessionEvent = { type: string; message?: { content?: string | ReadonlyArray<unknown> } };
type PiSessionListener = (event: PiSessionEvent) => void;

interface FakePiSession {
  prompts: string[];
  session: {
    prompt: (text: string) => Promise<void>;
    dispose: () => void;
    subscribe: (listener: PiSessionListener) => () => void;
  };
}

type FakePiAdapterSetup = { adapter: PiHarnessAdapter; runtimeHomePath: string; sessions: FakePiSession[] };

type FakeMemoryTool = {
  execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string; type: string }> }>;
  name: string;
};

type OnPrompt = (input: {
  customTools: FakeMemoryTool[];
  text: string;
  sessionIndex: number;
  emit: (event: PiSessionEvent) => void;
}) => void | Promise<void>;

const makeFakePiSessionFactory = (
  responses: string[][],
  options?: {
    onPrompt?: OnPrompt;
  }
) => {
  const sessions: FakePiSession[] = [];
  const listeners = new Set<PiSessionListener>();
  let index = 0;

  const factory: PiSessionFactory = (input) => {
    const output = responses[index] ?? ["ok"];
    const sessionIndex = index;
    index += 1;

    const prompts: string[] = [];
    let cursor = 0;
    const customTools = (input?.customTools ?? []) as FakeMemoryTool[];

    const session = {
      async prompt(text: string) {
        prompts.push(text);
        await options?.onPrompt?.({
          customTools,
          text,
          sessionIndex,
          emit(event) {
            for (const listener of listeners) {
              listener(event);
            }
          }
        });

        const next = output[cursor] ?? "ok";
        cursor += 1;
        for (const listener of listeners) {
          listener({ type: "turn_end", message: { content: next } });
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
    return Promise.resolve({
      session,
      extensionsResult: {
        extensions: [],
        errors: [],
        runtime: {}
      }
    } as unknown as Awaited<ReturnType<PiSessionFactory>>);
  };

  return { sessions, factory };
};

const tempRoots: string[] = [];

const tempDir = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "noopolis-daimon-pi-harness-"));
  tempRoots.push(directory);
  return directory;
};

const seedPairAndRoomMemory = async (runtimeHomePath: string): Promise<void> => {
  const store = new JsonlMemoryStore(runtimeHomePath);
  await store.append({
    type: "memory.observed",
    principal: { agentId: "mapper", scope: "room", qualifier: "noopolis:agora" },
    scope: memoryScopeId({ agentId: "mapper", scope: "room", qualifier: "noopolis:agora" }),
    visibility: "room",
    source: "pi-harness-contract",
    content: {
      kind: "text",
      text: "PUBLIC_ROOM_MARKER room context asks for alignment."
    },
    tags: ["public", "agora"],
    entities: ["mapper", "room"],
    sensitivity: "normal",
    parentEventIds: []
  });
  await store.append({
    type: "memory.observed",
    principal: { agentId: "mapper", scope: "pair", qualifier: "inner-shadow" },
    scope: memoryScopeId({ agentId: "mapper", scope: "pair", qualifier: "inner-shadow" }),
    visibility: "private",
    source: "pi-harness-contract",
    content: {
      kind: "text",
      text: "PRIVATE_PAIR_MARKER shadow keeps credentials in private channel."
    },
    tags: ["pair", "shadow"],
    entities: ["inner-shadow", "mapper"],
    sensitivity: "normal",
    parentEventIds: []
  });
};

const makeHarness = async (input: {
  root: string;
  responses: string[][];
  onPrompt?: OnPrompt;
}) => {
  const factory = makeFakePiSessionFactory(input.responses, { onPrompt: input.onPrompt });
  const adapter = new PiHarnessAdapter({
    authPath: path.join(input.root, "auth.json"),
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
    memory: { tokenBudget: 1200 }
  });

  await seedPairAndRoomMemory(path.join(input.root, "runtime"));
  return {
    adapter,
    runtimeHomePath: path.join(input.root, "runtime"),
    sessions: factory.sessions
  } satisfies FakePiAdapterSetup;
};

test.afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("prompt excludes forbidden private pair context for room wakes", async () => {
  const root = await tempDir();
  const setup = await makeHarness({
    root,
    responses: [["ack"]]
  });
  const handle = await setup.adapter.startAgent({
    id: "mapper",
    name: "Mapper",
    instructions: "Use memory to reason in public room.",
    runtimeHomePath: setup.runtimeHomePath,
    workspacePath: path.join(root, "workspace")
  });

  await handle.wake({
    id: "wake-room",
    kind: "manual",
    text: "How should we handle alignment in public?",
    context: {
      networkId: "noopolis",
      roomId: "agora",
      teamId: "ops"
    }
  });

  const promptText = setup.sessions[0]?.prompts[0] ?? "";
  assert.ok(promptText.includes("PUBLIC_ROOM_MARKER"));
  assert.equal(promptText.includes("PRIVATE_PAIR_MARKER"), false);

  await handle.stop();
});

test("fake sessions can recall prior turn memory without live provider calls", async () => {
  const root = await tempDir();
  const setup = await makeHarness({
    root,
    responses: [["first-turn"], ["second-turn"]],
    onPrompt: async ({ customTools, text }) => {
      if (!text.includes("SESSION_TOOL_MARKER") || !text.includes("id: wake-1")) {
        return;
      }
      const register = customTools.find((tool) => tool.name === "memory_register");
      assert.ok(register);
      await register.execute("register-session-marker", {
        scope: "current",
        kind: "episodic",
        content: {
          kind: "text",
          text: "SESSION_TOOL_MARKER relay route set to amber."
        },
        visibility: "room",
        sensitivity: "normal",
        evidence_event_ids: ["wake-1"],
        source_type: "test",
        confidence: 1
      });
    }
  });

  const handle = await setup.adapter.startAgent({
    id: "mapper",
    name: "Mapper",
    instructions: "Maintain continuity from prior turns.",
    runtimeHomePath: setup.runtimeHomePath,
    workspacePath: path.join(root, "workspace")
  });

  await handle.wake({
    id: "wake-1",
    kind: "message",
    from: "operator",
    text: "Register this marker: SESSION_TOOL_MARKER relay route set to amber.",
    context: {
      networkId: "noopolis",
      roomId: "agora",
      teamId: "ops"
    }
  });

  await handle.wake({
    id: "wake-2",
    kind: "message",
    from: "operator",
    text: "What was the relay marker?",
    context: {
      networkId: "noopolis",
      roomId: "agora",
      teamId: "ops"
    }
  });

  const secondPrompt = setup.sessions[0]?.prompts[1] ?? "";
  assert.ok(secondPrompt.includes("SESSION_TOOL_MARKER"));

  await handle.stop();
});

test("fake Moltnet-style pair and room wakes show scoped behavior", async () => {
  const root = await tempDir();
  const setup = await makeHarness({
    root,
    responses: [["ok"], ["ok"]]
  });

  const handle = await setup.adapter.startAgent({
    id: "mapper",
    name: "Mapper",
    instructions: "Respect room and pair scopes during recall.",
    runtimeHomePath: setup.runtimeHomePath,
    workspacePath: path.join(root, "workspace")
  });

  await handle.wake({
    id: "wake-pair",
    kind: "message",
    from: "inner-shadow",
    text: "Who handled shadow memory last?",
    context: {
      pairPeers: ["inner-shadow"]
    }
  });

  await handle.wake({
    id: "wake-room",
    kind: "manual",
    text: "Summarize public room context only.",
    context: {
      networkId: "noopolis",
      roomId: "agora",
      teamId: "ops"
    }
  });

  assert.ok((setup.sessions[0]?.prompts[0] ?? "").includes("PRIVATE_PAIR_MARKER"));
  assert.equal((setup.sessions[0]?.prompts[1] ?? "").includes("PRIVATE_PAIR_MARKER"), false);

  await handle.stop();
});

test("memory activity can be reloaded through Pi adapter across turns", async () => {
  const root = await tempDir();
  const setup = await makeHarness({
    root,
    responses: [["ok-1"], ["ok-2"]]
  });
  const runtime = createMemoryRuntime({
    agentId: "mapper",
    runtimeHomePath: setup.runtimeHomePath
  });

  await runtime.recordTurn({
    principal: { agentId: "mapper", scope: "room", qualifier: "noopolis:agora" },
    prompt: {
      principal: { agentId: "mapper", scope: "room", qualifier: "noopolis:agora" },
      sections: [{ heading: "Preseed", text: "Legacy activity context." }],
      rawHint: "seeded"
    },
    request: {
      eventId: "seed-legacy",
      kind: "manual",
      text: "seed legacy event for continuity",
      context: {}
    },
    result: "completed",
    outputText: "seeded legacy output"
  });

  const handle = await setup.adapter.startAgent({
    id: "mapper",
    name: "Mapper",
    instructions: "Pick up prior runtime activity.",
    runtimeHomePath: setup.runtimeHomePath,
    workspacePath: path.join(root, "workspace")
  });

  await handle.wake({
    id: "wake-continuation",
    kind: "manual",
    text: "Continue from seeded activity.",
    context: {
      networkId: "noopolis",
      roomId: "agora",
      teamId: "ops"
    }
  });

  const secondPrompt = setup.sessions[0]?.prompts[0] ?? "";
  assert.ok(secondPrompt.includes("Legacy activity context.") || secondPrompt.includes("seed legacy event for continuity"));

  const events = await runtime.prepareTurn({
    eventId: "noop-wake",
    kind: "manual",
    text: "continuation check",
    context: {
      networkId: "noopolis",
      roomId: "agora"
    }
  });
  assert.equal(events.principal.scope, "room");
  assert.ok(Array.isArray(events.packet.sections));
  await handle.stop();
});

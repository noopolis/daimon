import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
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

  const factory = () => {
    const responses = scripts[sessionIndex] ?? ["ack"];
    sessionIndex += 1;

    const prompts: string[] = [];
    const listeners = new Set<PiSessionListener>();
    let responseCursor = 0;

    const session = {
      async prompt(text: string) {
        prompts.push(text);
        const output = responses[responseCursor] ?? "ack";
        responseCursor += 1;
        for (const listener of listeners) {
          listener({ type: "turn_end", message: { content: output } });
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

const makeHarness = async (input: {
  root: string;
  sessionScripts: string[][];
}) => {
  const sessionFactory = makeFakePiSessionFactory(input.sessionScripts);
  const authPath = path.join(input.root, "auth.json");
  const runtimeHomePath = path.join(input.root, "runtime");
  const workspacePath = path.join(input.root, "workspace");

  const adapter = new PiHarnessAdapter({
    authPath,
    model: {
      auth: { method: "none" },
      endpoint: {
        baseUrl: "http://127.0.0.1:11434/v1",
        compatibility: "openai"
      },
      name: "llama3.2",
      provider: "local"
    },
    sessionFactory: sessionFactory.factory,
    memory: { tokenBudget: 1200 }
  });

  return { adapter, runtimeHomePath, workspacePath, sessionFactory };
};

const nextTick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const waitFor = async (predicate: () => boolean): Promise<void> => {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 1000) {
      throw new Error("timed out waiting for condition");
    }
    await nextTick();
  }
};

const tempRoots: string[] = [];

const tempDir = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "noopolis-daimon-pi-"));
  tempRoots.push(directory);
  return directory;
};

test.afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("starts a local endpoint model without an explicit modelsPath", async () => {
  const root = await tempDir();
  const { adapter, workspacePath } = await makeHarness({
    root,
    sessionScripts: [["done"]]
  });

  const handle = await adapter.startAgent({
    id: "localist",
    instructions: "Use the local model when asked to work.",
    name: "Localist",
    runtimeHomePath: path.join(root, "runtime"),
    workspacePath
  });

  assert.equal(handle.status().state, "idle");
  assert.ok((await stat(workspacePath)).isDirectory());
  await handle.stop();
});

test("persists and recalls memory across adapter restarts", async () => {
  const root = await tempDir();
  const base = await makeHarness({
    root,
    sessionScripts: [["boot-1"], ["boot-2"], ["boot-3"]]
  });

  const firstHandle = await base.adapter.startAgent({
    id: "mapper",
    name: "Mapper",
    instructions: "Recall prior turns before answering.",
    runtimeHomePath: base.runtimeHomePath,
    workspacePath: base.workspacePath
  });

  await firstHandle.wake({
    id: "wake-1",
    kind: "message",
    from: "orchestrator",
    text: "Seed memory: we built the phoenix relay and tagged it in memory.",
    context: {
      networkId: "noopolis",
      roomId: "agora",
      teamId: "ops"
    }
  });

  await firstHandle.stop();

  const secondAdapterSetup = await makeHarness({
    root,
    sessionScripts: [["boot-2-restart"]]
  });

  const secondHandle = await secondAdapterSetup.adapter.startAgent({
    id: "mapper",
    name: "Mapper",
    instructions: "Recall prior turns before answering.",
    runtimeHomePath: base.runtimeHomePath,
    workspacePath: base.workspacePath
  });

  await secondHandle.wake({
    id: "wake-2",
    kind: "message",
    from: "orchestrator",
    text: "Can you continue the phoenix relay work?",
    context: {
      networkId: "noopolis",
      roomId: "agora",
      teamId: "ops"
    }
  });

  const secondPrompt = secondAdapterSetup.sessionFactory.sessions[0]?.prompts[0] ?? "";
  assert.ok(secondPrompt.includes("Wake event"));
  const store = new JsonlMemoryStore(base.runtimeHomePath);
  const events = await store.read({ principalAgentId: "mapper" });
  const hasRecalled = events.some((event) => {
    return event.type === "memory.recalled" && `${event.content.kind === "text" ? event.content.text : ""}`.includes("phoenix");
  });
  assert.ok(hasRecalled);
  await secondHandle.stop();
});

test("isolates memory between different agents with shared runtime home", async () => {
  const root = await tempDir();
  const mapperHarness = await makeHarness({
    root,
    sessionScripts: [["mapped"]]
  });

  const mapper = await mapperHarness.adapter.startAgent({
    id: "mapper",
    name: "Mapper",
    instructions: "Use only workspace memory when you need context.",
    runtimeHomePath: mapperHarness.runtimeHomePath,
    workspacePath: mapperHarness.workspacePath
  });

  await mapper.wake({
    id: "wake-a",
    kind: "manual",
    text: "Mapper's private note: the phoenix signal is for internal routing only.",
    context: {
      networkId: "noopolis",
      roomId: "agora"
    }
  });
  await mapper.stop();

  const listenerHarness = await makeHarness({
    root,
    sessionScripts: [["heard"]]
  });

  const listener = await listenerHarness.adapter.startAgent({
    id: "listener",
    name: "Listener",
    instructions: "Use only workspace memory when you need context.",
    runtimeHomePath: mapperHarness.runtimeHomePath,
    workspacePath: mapperHarness.workspacePath
  });

  await listener.wake({
    id: "wake-b",
    kind: "manual",
    text: "Can you summarize the current status?",
    context: {
      networkId: "noopolis",
      roomId: "agora"
    }
  });

  const listenerPrompt = listenerHarness.sessionFactory.sessions[0]?.prompts[0] ?? "";
  assert.equal(listenerPrompt.includes("phoenix"), false);

  const listenerEvents = await new JsonlMemoryStore(mapperHarness.runtimeHomePath).read({ principalAgentId: "listener" });
  assert.equal(listenerEvents.some((event) => event.type === "memory.recalled"), false);

  await listener.stop();
});

test("serializes concurrent wakes through one Pi session", async () => {
  const root = await tempDir();
  const prompts: string[] = [];
  const completions: Array<() => void> = [];
  const listeners = new Set<PiSessionListener>();

  type SessionResult = Awaited<ReturnType<typeof createAgentSession>>;
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
    sessionFactory: () => Promise.resolve({
      session: {
        async prompt(text: string) {
          const index = prompts.length;
          prompts.push(text);
          await new Promise<void>((resolve) => {
            completions.push(() => {
              for (const listener of listeners) {
                listener({ type: "turn_end", message: { content: `reply-${index + 1}` } });
              }
              resolve();
            });
          });
        },
        subscribe(listener: PiSessionListener) {
          listeners.add(listener);
          return () => void listeners.delete(listener);
        },
        dispose() {
          listeners.clear();
        }
      }
    } as SessionResult)
  });

  const handle = await adapter.startAgent({
    id: "queue-agent",
    name: "Queue Agent",
    instructions: "Process wakes in order.",
    runtimeHomePath: path.join(root, "runtime"),
    workspacePath: path.join(root, "workspace")
  });

  const first = handle.wake({
    id: "wake-1",
    kind: "message",
    text: "first message"
  });
  const second = handle.wake({
    id: "wake-2",
    kind: "message",
    text: "second message"
  });

  await waitFor(() => prompts.length === 1);
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0].includes("first message"));

  completions[0]();
  assert.equal((await first).text, "reply-1");

  await waitFor(() => prompts.length === 2);
  assert.equal(prompts.length, 2);
  assert.ok(prompts[1].includes("second message"));

  completions[1]();
  assert.equal((await second).text, "reply-2");

  await handle.stop();
});

test("continues queued wakes after a failed wake", async () => {
  const root = await tempDir();
  const prompts: string[] = [];
  const listeners = new Set<PiSessionListener>();
  let promptCount = 0;

  type SessionResult = Awaited<ReturnType<typeof createAgentSession>>;
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
    sessionFactory: () => Promise.resolve({
      session: {
        async prompt(text: string) {
          promptCount += 1;
          prompts.push(text);
          if (promptCount === 1) {
            throw new Error("first wake failed");
          }
          for (const listener of listeners) {
            listener({ type: "turn_end", message: { content: "second ok" } });
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
    } as SessionResult)
  });

  const handle = await adapter.startAgent({
    id: "queue-agent",
    name: "Queue Agent",
    instructions: "Process wakes in order.",
    runtimeHomePath: path.join(root, "runtime"),
    workspacePath: path.join(root, "workspace")
  });

  const first = handle.wake({
    id: "wake-fail",
    kind: "message",
    text: "fail first"
  });
  const second = handle.wake({
    id: "wake-after",
    kind: "message",
    text: "run after failure"
  });

  await assert.rejects(first, /first wake failed/u);
  assert.equal((await second).text, "second ok");
  assert.equal(prompts.length, 2);
  assert.ok(prompts[1].includes("run after failure"));

  await handle.stop();
});

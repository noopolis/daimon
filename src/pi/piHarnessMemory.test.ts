import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAgentSession } from "@earendil-works/pi-coding-agent";

import { memoryScopeId } from "@noopolis/mneme";
import { JsonlMemoryStore } from "@noopolis/mneme";
import { PiHarnessAdapter } from "./piHarness.js";

const tempRoots: string[] = [];

const tempDir = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "noopolis-daimon-pi-memory-"));
  tempRoots.push(directory);
  return directory;
};

test.afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("non-memory Pi tool events are not implicitly written to memory", async () => {
  const root = await tempDir();
  const runtimeHomePath = path.join(root, "runtime");
  const workspacePath = path.join(root, "workspace");
  const listeners = new Set<(event: { type: string; message?: { content?: string } }) => void>();
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
    sessionFactory: () => Promise.resolve(({
      session: {
        async prompt() {
          for (const listener of listeners) {
            listener({
              type: "tool_event",
              message: { content: "PUBLIC_TOOL_PAYLOAD_MARKER should not be persisted" }
            });
            listener({ type: "turn_end", message: { content: "ok" } });
          }
        },
        subscribe(listener: (event: { type: string; message?: { content?: string } }) => void) {
          listeners.add(listener);
          return () => void listeners.delete(listener);
        },
        dispose() {
          listeners.clear();
        }
      }
    } as unknown) as SessionResult)
  });

  const handle = await adapter.startAgent({
    id: "mapper",
    name: "Mapper",
    instructions: "Use memory tools only when explicitly useful.",
    runtimeHomePath,
    workspacePath
  });

  await handle.wake({
    id: "wake-tool",
    kind: "manual",
    text: "Check tool boundary test.",
    context: {
      networkId: "noopolis",
      roomId: "agora",
      teamId: "ops"
    }
  });

  const events = await new JsonlMemoryStore(runtimeHomePath).read({ principalAgentId: "mapper" });
  assert.equal(JSON.stringify(events).includes("PUBLIC_TOOL_PAYLOAD_MARKER"), false);

  await handle.stop();
});

test("failed wakes do not implicitly record recalled memory provenance", async () => {
  const root = await tempDir();
  const runtimeHomePath = path.join(root, "runtime");
  const workspacePath = path.join(root, "workspace");
  const principal = {
    agentId: "mapper",
    scope: "global" as const
  };

  await new JsonlMemoryStore(runtimeHomePath).append({
    type: "memory.observed",
    principal,
    scope: memoryScopeId(principal),
    visibility: "global",
    source: "test",
    content: {
      kind: "text",
      text: "PHOENIX_FAIL_MARKER should be recalled before failure."
    },
    tags: ["phoenix"],
    entities: ["phoenix"],
    sensitivity: "normal",
    parentEventIds: []
  });

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
    sessionFactory: () => Promise.resolve(({
      session: {
        async prompt() {
          throw new Error("prompt failed after recall");
        },
        subscribe() {
          return () => {};
        },
        dispose() {}
      }
    } as unknown) as SessionResult)
  });

  const handle = await adapter.startAgent({
    id: "mapper",
    name: "Mapper",
    instructions: "Recall before answering.",
    runtimeHomePath,
    workspacePath
  });

  await assert.rejects(handle.wake({
    id: "wake-fail-after-recall",
    kind: "manual",
    text: "Use the phoenix memory before failing."
  }), /prompt failed after recall/u);

  const recalled = await new JsonlMemoryStore(runtimeHomePath).read({
    principalAgentId: "mapper",
    types: ["memory.recalled"]
  });
  assert.equal(recalled.some((event) =>
    event.content.kind === "text" &&
    event.content.text.includes("PHOENIX_FAIL_MARKER")
  ), false);

  await handle.stop();
});

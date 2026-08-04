import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PiHarnessAdapter, type PiSessionFactory } from "./piHarness.js";
import type { PiSessionLike } from "./piAgentHandle.js";

test.beforeEach(() => {
  process.env.NOOPOLIS_RUN_ID = "run-test-pi-harness-cli";
});
test.afterEach(() => {
  delete process.env.NOOPOLIS_RUN_ID;
});

const readEvents = async (runtimeHomePath: string): Promise<Array<{ type: string; payload: { turn_id: string } }>> => {
  const raw = await readFile(path.join(runtimeHomePath, "telemetry", "causal.jsonl"), "utf8");
  return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type: string; payload: { turn_id: string } });
};

test("a non-Pi PiSessionLike preserves the causal turn envelope and wake id", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "noopolis-daimon-cli-causal-"));
  try {
    const listeners = new Set<(event: { type: "turn_end"; message: { content: string } }) => void>();
    const session: PiSessionLike = {
      subscribe(listener) {
        listeners.add(listener as (event: { type: "turn_end"; message: { content: string } }) => void);
        return () => listeners.delete(listener as (event: { type: "turn_end"; message: { content: string } }) => void);
      },
      async prompt() {
        for (const listener of listeners) listener({ type: "turn_end", message: { content: "cli reply" } });
      },
      dispose() { listeners.clear(); }
    };
    const sessionFactory: PiSessionFactory = async () => ({ session });
    const runtimeHomePath = path.join(root, "runtime");
    const handle = await new PiHarnessAdapter({
      authPath: path.join(root, "auth.json"),
      model: {
        auth: { method: "none" },
        endpoint: { baseUrl: "http://127.0.0.1:11434/v1", compatibility: "openai" },
        name: "llama3.2",
        provider: "local"
      },
      sessionFactory
    }).startAgent({
      id: "cli-agent",
      name: "CLI agent",
      instructions: "Reply.",
      runtimeHomePath,
      workspacePath: path.join(root, "workspace")
    });

    await handle.wake({ id: "wake-cli-1", kind: "message", from: "test", text: "hello" });
    const events = await readEvents(runtimeHomePath);
    assert.deepEqual(events.map((event) => event.type), ["turn.input.submitted", "turn.output.completed"]);
    assert.deepEqual(events.map((event) => event.payload.turn_id), ["wake-cli-1", "wake-cli-1"]);
    await handle.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

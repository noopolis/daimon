import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAgentSession } from "@earendil-works/pi-coding-agent";

import { PiHarnessAdapter, type PiSessionFactory } from "./piHarness.js";
import { PI_WORLD_TOOL_NAMES } from "./worldTools.js";

type SessionInput = Parameters<PiSessionFactory>[0];
type SessionResult = Awaited<ReturnType<typeof createAgentSession>>;
type CapturedTool = {
  execute: (...args: unknown[]) => Promise<{ details: unknown }>;
  name: string;
  parameters: unknown;
};

const BASE_TOOLS = Object.freeze(["read", "write", "edit", "bash", "grep", "find", "ls"]);
const MEMORY_TOOLS = Object.freeze([
  "memory_search",
  "memory_locate",
  "memory_register",
  "memory_summarize",
  "memory_forget"
]);
const tempRoots: string[] = [];

const tempDir = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "noopolis-daimon-pi-world-tools-"));
  tempRoots.push(directory);
  return directory;
};

test.afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const capturingFactory = (): {
  calls: SessionInput[];
  factory: PiSessionFactory;
  prompts: string[];
} => {
  const calls: SessionInput[] = [];
  const prompts: string[] = [];
  const factory: PiSessionFactory = async (input) => {
    calls.push(input);
    return {
      session: {
        async prompt(prompt: string) { prompts.push(prompt); },
        subscribe() { return () => {}; },
        dispose() {}
      }
    } as unknown as SessionResult;
  };
  return { calls, factory, prompts };
};

const localModel = Object.freeze({
  auth: { method: "none" as const },
  endpoint: { baseUrl: "http://127.0.0.1:11434/v1", compatibility: "openai" as const },
  name: "llama3.2",
  provider: "local"
});

test("an absent world binding preserves the prior Pi tool set and custom-tool ordering", async () => {
  const root = await tempDir();
  const captured = capturingFactory();
  const adapter = new PiHarnessAdapter({
    authPath: path.join(root, "auth.json"),
    model: localModel,
    sessionFactory: captured.factory,
    memory: { tokenBudget: 1_200 }
  });
  const handle = await adapter.startAgent({
    id: "unbound",
    name: "Unbound",
    instructions: "Work without a world binding.",
    runtimeHomePath: path.join(root, "runtime"),
    workspacePath: path.join(root, "workspace")
  });

  const input = captured.calls[0];
  assert.ok(input);
  assert.deepEqual(input.tools, [...BASE_TOOLS, ...MEMORY_TOOLS]);
  assert.deepEqual((input.customTools as CapturedTool[]).map((tool) => tool.name), MEMORY_TOOLS);
  assert.equal(input.tools.some((name) => name.startsWith("world_")), false);
  await handle.stop();
});

test("a world-only agent omits unrelated memory and coding tools", async () => {
  const root = await tempDir();
  const captured = capturingFactory();
  const adapter = new PiHarnessAdapter({
    authPath: path.join(root, "auth.json"),
    model: localModel,
    sessionFactory: captured.factory,
    world: {
      url: "http://simfile-world:19972/v1/world",
      tokenEnv: "WORLD_ONLY_TOKEN"
    }
  });
  const handle = await adapter.startAgent({
    id: "player",
    name: "Player",
    instructions: "Observe and act once.",
    runtimeHomePath: path.join(root, "runtime"),
    tools: [],
    workspacePath: path.join(root, "workspace")
  });

  const input = captured.calls[0];
  assert.ok(input);
  assert.deepEqual(input.tools, PI_WORLD_TOOL_NAMES);
  assert.deepEqual(
    (input.customTools as CapturedTool[]).map((tool) => tool.name),
    PI_WORLD_TOOL_NAMES
  );
  const systemPrompt = input.resourceLoader?.getSystemPrompt?.() ?? "";
  assert.match(systemPrompt, /authenticated world tools/u);
  assert.doesNotMatch(systemPrompt, /Mneme Memory|coding tools|files you created/u);
  await handle.wake({
    id: "moltnet:world-nudge-1",
    kind: "message",
    from: "world",
    text: JSON.stringify({
      version: "simfile.world-nudge.v1",
      run_id: "run-world",
      tick: 4,
      decision_token: "secret-world-decision"
    }),
    delivery: {
      eventId: "moltnet:world-nudge-1",
      sender: "world",
      target: "player",
      contextId: "dm:player:world"
    }
  });
  assert.equal(captured.prompts.length, 1);
  assert.match(captured.prompts[0]!, /run-world[\s\S]*already bound/u);
  assert.equal(captured.prompts[0]!.includes("secret-world-decision"), false);
  const trajectory = await readFile(
    path.join(
      root,
      "runtime",
      "telemetry",
      "world-trajectories",
      "moltnet_world-nudge-1.json"
    ),
    "utf8"
  );
  assert.equal(JSON.parse(trajectory).schema, "daimon.world_trajectory.v1");
  assert.equal(trajectory.includes("secret-world-decision"), false);
  await handle.stop();
});

test("a world binding appends exact Pi tools and reads only its named bearer when called", async () => {
  const root = await tempDir();
  const captured = capturingFactory();
  const tokenEnv = "B29_PI_WORLD_TOKEN";
  const priorToken = process.env[tokenEnv];
  const priorFetch = globalThis.fetch;
  const requests: Array<{ authorization: string; body: string; url: string }> = [];
  delete process.env[tokenEnv];
  globalThis.fetch = async (url, init) => {
    requests.push({
      authorization: new Headers(init?.headers).get("authorization") ?? "",
      body: String(init?.body),
      url: String(url)
    });
    return new Response('{"ready":true}', { headers: { "content-type": "application/json; charset=utf-8" } });
  };
  let handle: Awaited<ReturnType<PiHarnessAdapter["startAgent"]>> | undefined;
  try {
    const world = { url: "http://simfile-world:19972/v1/world", tokenEnv };
    const adapter = new PiHarnessAdapter({
      authPath: path.join(root, "auth.json"),
      model: localModel,
      sessionFactory: captured.factory,
      memory: { tokenBudget: 1_200 },
      world
    });
    handle = await adapter.startAgent({
      id: "red",
      name: "Red",
      instructions: "Use only the bound world authority.",
      runtimeHomePath: path.join(root, "runtime"),
      workspacePath: path.join(root, "workspace")
    });

    const input = captured.calls[0];
    assert.ok(input);
    assert.deepEqual(input.tools, [...BASE_TOOLS, ...MEMORY_TOOLS, ...PI_WORLD_TOOL_NAMES]);
    const customTools = input.customTools as CapturedTool[];
    assert.deepEqual(customTools.map((tool) => tool.name), [...MEMORY_TOOLS, ...PI_WORLD_TOOL_NAMES]);
    assert.deepEqual(world, { url: "http://simfile-world:19972/v1/world", tokenEnv });
    assert.equal(requests.length, 0);

    process.env[tokenEnv] = "late-red-bearer";
    const status = customTools.find((tool) => tool.name === "world_status");
    assert.ok(status);
    const output = await status.execute(
      "world-call",
      { decision_token: "decision-red" },
      undefined,
      undefined,
      {}
    );
    assert.deepEqual(output.details, { ready: true });
    assert.deepEqual(requests, [{
      authorization: "Bearer late-red-bearer",
      body: '{"decision_token":"decision-red"}',
      url: "http://simfile-world:19972/v1/world/status"
    }]);
  } finally {
    if (handle !== undefined) await handle.stop();
    globalThis.fetch = priorFetch;
    if (priorToken === undefined) delete process.env[tokenEnv];
    else process.env[tokenEnv] = priorToken;
  }
});

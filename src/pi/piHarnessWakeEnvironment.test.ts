import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import { PiHarnessAdapter, type PiSessionFactory } from "./piHarness.js";

test("binds the current wake id to protected bash children and clears it after the turn", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-wake-env-"));
  const protectedName = "DAIMON_WAKE_ENV_CONTROL_CANARY";
  const priorRun = process.env.NOOPOLIS_RUN_ID;
  process.env.NOOPOLIS_RUN_ID = "wake-environment-test";
  process.env[protectedName] = "secret";
  let bash: NonNullable<Parameters<PiSessionFactory>[0]["customTools"]>[number] | undefined;
  let during = "";
  const factory: PiSessionFactory = async (input) => {
    bash = input.customTools?.find((tool) => tool.name === "bash");
    return { session: {
      async prompt() {
        during = JSON.stringify(await bash!.execute("wake-env", { command: "printf %s \"$DAIMON_WAKE_ID\"" }, undefined, undefined, {} as never));
      },
      subscribe() { return () => undefined; },
      dispose() { return undefined; }
    } };
  };
  try {
    const adapter = new PiHarnessAdapter({
      authPath: path.join(root, "auth.json"),
      model: { auth: { method: "none" }, endpoint: { baseUrl: "http://127.0.0.1", compatibility: "openai" }, name: "stub", provider: "stub" },
      protectedEnvironmentNames: [protectedName],
      sessionFactory: factory
    });
    const handle = await adapter.startAgent({ id: "agent", name: "Agent", instructions: "test", workspacePath: root, runtimeHomePath: path.join(root, "home") });
    await handle.wake({ id: "moltnet:msg_1", kind: "message", text: "hello" });
    assert.match(during, /moltnet:msg_1/u);
    const after = JSON.stringify(await bash!.execute("wake-env-after", { command: "printf %s \"${DAIMON_WAKE_ID-unset}\"" }, undefined, undefined, {} as never));
    assert.match(after, /unset/u);
    assert.doesNotMatch(after, /moltnet:msg_1/u);
    await handle.stop();
  } finally {
    delete process.env[protectedName];
    if (priorRun === undefined) delete process.env.NOOPOLIS_RUN_ID;
    else process.env.NOOPOLIS_RUN_ID = priorRun;
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * Defect 3 end-to-end through the real construction seam: `hasSendCapability`
 * must come from whether `productionTools` actually mounts `moltnet_send`,
 * not from whether the turn happened to call it. A turn that narrates a
 * failure back as its own terminal text — never touching `moltnet_send` —
 * still completes structurally and must never leak into the room once a
 * send tool is mounted for this agent.
 */
test("an agent with a moltnet_send production tool never returns terminal text, whether it spoke or narrated a failure", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-wake-env-send-"));
  const priorRun = process.env.NOOPOLIS_RUN_ID;
  process.env.NOOPOLIS_RUN_ID = "wake-environment-send-test";
  const moltnetSendTool: ToolDefinition = {
    name: "moltnet_send", label: "send", description: "send",
    parameters: { type: "object", additionalProperties: false, properties: {} },
    async execute() { return { content: [{ type: "text", text: "{}" }] }; }
  } as ToolDefinition;
  let reply = "Blocked: Moltnet auth is not mounted, cannot send";
  const factory: PiSessionFactory = async () => ({ session: {
    async prompt() { for (const listener of [...listeners]) listener({ type: "turn_end", message: { content: reply } }); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    dispose() { listeners.clear(); }
  } });
  const listeners = new Set<(event: { type: string; message?: { content?: string } }) => void>();
  try {
    const adapter = new PiHarnessAdapter({
      authPath: path.join(root, "auth.json"),
      model: { auth: { method: "none" }, endpoint: { baseUrl: "http://127.0.0.1", compatibility: "openai" }, name: "stub", provider: "stub" },
      productionTools: [moltnetSendTool],
      sessionFactory: factory
    });
    const handle = await adapter.startAgent({ id: "agent", name: "Agent", instructions: "test", workspacePath: root, runtimeHomePath: path.join(root, "home") });

    const narrated = await handle.wake({ id: "moltnet:narrated-1", kind: "message", text: "hello" });
    assert.equal(narrated.text, "", "a narrated failure that never called moltnet_send must still be blanked");

    reply = "spoken reply";
    const spoken = await handle.wake({ id: "moltnet:spoken-1", kind: "message", text: "hello again" });
    assert.equal(spoken.text, "", "an ordinary completed reply must also be blanked while a send tool is mounted");

    await handle.stop();
  } finally {
    if (priorRun === undefined) delete process.env.NOOPOLIS_RUN_ID;
    else process.env.NOOPOLIS_RUN_ID = priorRun;
    await rm(root, { recursive: true, force: true });
  }
});

test("an agent with no production tools keeps the terminal-text fallback", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-wake-env-nosend-"));
  const priorRun = process.env.NOOPOLIS_RUN_ID;
  process.env.NOOPOLIS_RUN_ID = "wake-environment-nosend-test";
  const listeners = new Set<(event: { type: string; message?: { content?: string } }) => void>();
  const factory: PiSessionFactory = async () => ({ session: {
    async prompt() { for (const listener of [...listeners]) listener({ type: "turn_end", message: { content: "fallback reply" } }); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    dispose() { listeners.clear(); }
  } });
  try {
    const adapter = new PiHarnessAdapter({
      authPath: path.join(root, "auth.json"),
      model: { auth: { method: "none" }, endpoint: { baseUrl: "http://127.0.0.1", compatibility: "openai" }, name: "stub", provider: "stub" },
      sessionFactory: factory
    });
    const handle = await adapter.startAgent({ id: "agent", name: "Agent", instructions: "test", workspacePath: root, runtimeHomePath: path.join(root, "home") });
    const result = await handle.wake({ id: "moltnet:no-send-1", kind: "message", text: "hello" });
    assert.equal(result.text, "fallback reply");
    await handle.stop();
  } finally {
    if (priorRun === undefined) delete process.env.NOOPOLIS_RUN_ID;
    else process.env.NOOPOLIS_RUN_ID = priorRun;
    await rm(root, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

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

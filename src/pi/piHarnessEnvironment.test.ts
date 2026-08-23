import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PiHarnessAdapter, type PiSessionFactory } from "./piHarness.js";

test("Pi bash children use each agent's isolated HOME/XDG paths and strip protected values", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-pi-protected-bash-"));
  const tokenEnv = "DAIMON_PI_CONTROL_TOKEN_CANARY";
  const worldTokenEnv = "DAIMON_PI_WORLD_TOKEN_CANARY";
  const previousRunId = process.env.NOOPOLIS_RUN_ID;
  process.env[tokenEnv] = "never-in-bash";
  process.env[worldTokenEnv] = "world-token-never-in-bash";
  process.env.NOOPOLIS_RUN_ID = "pi-environment-test";
  const captured: Parameters<PiSessionFactory>[0][] = [];
  const factory: PiSessionFactory = async (input) => ({
    session: {
      async prompt() { return undefined; },
      subscribe() { return () => undefined; },
      dispose() { return undefined; }
    }
  });
  try {
    const adapter = new PiHarnessAdapter({
      authPath: path.join(root, "auth.json"),
      model: {
        auth: { method: "none" },
        endpoint: { baseUrl: "http://127.0.0.1:11434/v1", compatibility: "openai" },
        name: "stub",
        provider: "stub"
      },
      protectedEnvironmentNames: [tokenEnv],
      world: { url: "http://world.invalid/v1/world", tokenEnv: worldTokenEnv },
      sessionFactory: async (input) => {
        captured.push(input);
        return factory(input);
      }
    });
    const homes = [path.join(root, "alpha-home"), path.join(root, "beta-home")];
    const handles = await Promise.all(homes.map((runtimeHomePath, index) => adapter.startAgent({
      id: `agent-${index}`, name: `Agent ${index}`, instructions: "test", workspacePath: root, runtimeHomePath
    })));
    const command = `printf '%s|%s|%s|%s|%s|%s|%s|%s' "$HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME" "$XDG_CACHE_HOME" "$TMPDIR" "$${tokenEnv}" "$${worldTokenEnv}"`;
    for (const input of captured) {
      const index = homes.indexOf(input.runtimeHomePath!);
      assert.notEqual(index, -1);
      const bash = input.customTools?.find((tool) => tool.name === "bash");
      assert.ok(bash);
      const result = JSON.stringify(await bash.execute("bash", { command }, undefined, undefined, {} as never));
      assert.match(result, new RegExp(homes[index]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.equal(result.includes("never-in-bash"), false);
      assert.equal(result.includes("world-token-never-in-bash"), false);
      assert.equal(result.includes(homes[1 - index]!), false);
    }
    await Promise.all(handles.map((handle) => handle.stop()));
  } finally {
    delete process.env[tokenEnv];
    delete process.env[worldTokenEnv];
    if (previousRunId === undefined) delete process.env.NOOPOLIS_RUN_ID;
    else process.env.NOOPOLIS_RUN_ID = previousRunId;
    await rm(root, { recursive: true, force: true });
  }
});

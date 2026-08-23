import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runEngine, runEngineDetailed } from "./cliEngineRun.js";

test("one-shot CLI helpers pass the assigned runtime home to every child", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-engine-home-"));
  const priorPath = process.env.PATH;
  const home = path.join(root, "isolated-home");
  const command = path.join(root, "agy");
  await writeFile(command, [
    "#!/usr/bin/env node",
    "process.stdout.write(JSON.stringify({ home: process.env.HOME, config: process.env.XDG_CONFIG_HOME, data: process.env.XDG_DATA_HOME, state: process.env.XDG_STATE_HOME, cache: process.env.XDG_CACHE_HOME, tmp: process.env.TMPDIR }));"
  ].join("\n"));
  await chmod(command, 0o700);
  try {
    process.env.PATH = `${root}${path.delimiter}${priorPath ?? ""}`;
    const paths = { workspacePath: root, runtimeHomePath: home };
    const result = await runEngineDetailed("agy", "probe", paths);
    assert.deepEqual(JSON.parse(result.text), {
      home,
      config: `${home}/.config`,
      data: `${home}/.local/share`,
      state: `${home}/.local/state`,
      cache: `${home}/.cache`,
      tmp: `${home}/.tmp`
    });
    await Promise.all([`${home}/.cache`, `${home}/.tmp`].map(async (directory) => assert.equal((await stat(directory)).isDirectory(), true)));
    assert.equal(await runEngine("agy", "probe", paths), result.text);
  } finally {
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
    await rm(root, { recursive: true, force: true });
  }
});

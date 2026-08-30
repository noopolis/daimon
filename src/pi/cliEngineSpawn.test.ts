import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readChild } from "./cliSession.js";
import { GROK_STRICT_SANDBOX_PROFILE, renderGrokSandboxArgs, spawnEngine } from "./cliEngineSpawn.js";

test("autonomous Codex and Grok launches omit wall-clock and turn caps", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-unbounded-cli-"));
  const command = path.join(root, "engine");
  await writeFile(command, "#!/usr/bin/env node\nconst a=process.argv.slice(2);if(a[0]==='mcp')process.stdout.write('ok');else{for await(const c of process.stdin){}process.stdout.write(JSON.stringify(a));}\n");
  await chmod(command, 0o700);
  try {
    for (const engine of ["codex", "grok"] as const) {
      const options = engine === "grok"
        ? { engine, command, commandArgs: ["--deny", "Bash(rm *)"], maxToolTurns: 1 }
        : { engine, command };
      const child = spawnEngine(options, "probe", { cwd: root }, "http://127.0.0.1:1234/mcp");
      const args = JSON.parse(await readChild(child, 10_000, [])) as string[];
      assert.equal(args.includes("--max-turns"), false);
      assert.equal(args.includes("--print-timeout"), false);
      if (engine === "grok") {
        assert.ok(args.includes("--always-approve"));
        assert.deepEqual(args.slice(0, 2), ["--deny", "Bash(rm *)"]);
        assert.deepEqual(args.slice(args.indexOf("--sandbox"), args.indexOf("--sandbox") + 2), ["--sandbox", GROK_STRICT_SANDBOX_PROFILE]);
        assert.ok(args.includes("--no-subagents"));
        assert.deepEqual(args.slice(args.indexOf("--output-format"), args.indexOf("--output-format") + 2), ["--output-format", "streaming-messages-json"]);
        assert.equal(args.includes("--json-schema"), false);
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Grok's kernel sandbox authority cannot be weakened by injected CLI arguments", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-grok-boundary-"));
  try {
    for (const commandArgs of [["--sandbox", "off"], ["--sandbox=workspace"], ["--permission-mode", "bypassPermissions"]]) {
      assert.throws(() => spawnEngine({ engine: "grok", command: process.execPath, commandArgs }, "probe", { cwd: root }, undefined), /Daimon-owned/u);
    }
    assert.deepEqual(renderGrokSandboxArgs(undefined, "daimon-strict"), ["--sandbox", "daimon-strict"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

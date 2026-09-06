import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readChild } from "./cliSession.js";
import { GROK_STRICT_SANDBOX_PROFILE, renderCodexArgs, renderGrokSandboxArgs, spawnEngine } from "./cliEngineSpawn.js";

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

test("Codex output, sandbox, config, and cwd boundaries reject caller overrides", () => {
  for (const injected of [
    "--json", "--sandbox", "--sandbox=read-only", "--dangerously-bypass-approvals-and-sandbox",
    "--output-last-message", "-c", "--config", "--skip-git-repo-check", "--color", "-C", "--cd"
  ]) {
    assert.throws(() => renderCodexArgs({ commandArgs: [injected] }, "/workspace", undefined), /Daimon-owned/u);
  }
  const args = renderCodexArgs({ commandArgs: ["--effort", "high"] }, "/workspace", undefined);
  assert.deepEqual(args.slice(0, 2), ["--effort", "high"]);
  assert.equal(args.includes("--json"), true);
});

test("codex argv is byte-identical to before model selection existed when model/reasoningEffort are absent", () => {
  const before = ["exec", "--sandbox", "danger-full-access", "--skip-git-repo-check", "--color", "never", "--json", "-C", "/workspace",
    "-c", "mcp_servers.daimon.url=http://127.0.0.1:1/mcp", "-"];
  const after = renderCodexArgs({ commandArgs: [] }, "/workspace", "http://127.0.0.1:1/mcp");
  assert.deepEqual(after, before);
});

test("codex argv renders -m for a pinned model and leaves everything else untouched", () => {
  const args = renderCodexArgs({ commandArgs: [], model: "gpt-5-codex" }, "/workspace", "http://127.0.0.1:1/mcp");
  assert.deepEqual(args, ["exec", "--sandbox", "danger-full-access", "--skip-git-repo-check", "--model=gpt-5-codex", "--color", "never", "--json", "-C", "/workspace",
    "-c", "mcp_servers.daimon.url=http://127.0.0.1:1/mcp", "-"]);
});

test("codex argv renders both model and reasoningEffort together in stable order", () => {
  const args = renderCodexArgs({ commandArgs: [], model: "gpt-5-codex", reasoningEffort: "xhigh" }, "/workspace", "http://127.0.0.1:1/mcp");
  assert.deepEqual(args, ["exec", "--sandbox", "danger-full-access", "--skip-git-repo-check", "--model=gpt-5-codex", "-c", "model_reasoning_effort=xhigh", "--color", "never", "--json", "-C", "/workspace",
    "-c", "mcp_servers.daimon.url=http://127.0.0.1:1/mcp", "-"]);
});

test("codex argv renders reasoningEffort alone without a model flag", () => {
  const args = renderCodexArgs({ commandArgs: [], reasoningEffort: "low" }, "/workspace", "http://127.0.0.1:1/mcp");
  assert.equal(args.includes("--model=gpt-5-codex"), false);
  assert.deepEqual(args.slice(args.indexOf("-c"), args.indexOf("-c") + 2), ["-c", "model_reasoning_effort=low"]);
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

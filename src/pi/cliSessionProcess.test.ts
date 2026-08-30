import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createCliSessionFactory, readChild, spawnEngine, terminateChild } from "./cliSession.js";

const grokStream = (text: string): string => [
  { type: "assistant", parent_tool_use_id: null, session_id: "fake", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text }] } },
  { type: "result", subtype: "success", is_error: false, result: text, stop_reason: "end_turn", session_id: "fake" }
].map((event) => JSON.stringify(event)).join("\n");

test("terminates a process group after its leader has exited", async (context) => {
  if (!requirePosixProcessGroups(context)) return;
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-cli-group-"));
  const descendant = path.join(root, "descendant-pid");
  const leader = path.join(root, "leader.mjs");
  await writeFile(leader, `import { spawn } from "node:child_process"; import { writeFileSync } from "node:fs"; const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => undefined); setInterval(() => undefined, 1000)"], { stdio: "ignore" }); child.unref(); writeFileSync(${JSON.stringify(descendant)}, String(child.pid));`);
  try {
    const child = spawnEngine({ engine: "agy", command: process.execPath, commandArgs: [leader], maxToolTurns: 1, timeoutMs: 10_000 }, "exit", { cwd: root }, undefined);
    await readChild(child, 10_000, []);
    await waitForFile(descendant);
    const pid = Number(await readFile(descendant, "utf8"));
    await terminateChild(child);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Grok setup reaps a stubborn descendant after its successful leader exits", async (context) => {
  if (!requirePosixProcessGroups(context)) return;
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-grok-setup-group-"));
  const descendant = path.join(root, "setup-descendant-pid");
  const grok = path.join(root, "grok.mjs");
  await writeFile(grok, `import { spawn } from "node:child_process"; import { writeFileSync } from "node:fs";
    const args = process.argv.slice(2);
    if (args.includes("add")) {
      const child = spawn(process.execPath, ["-e", "import { writeFileSync } from 'node:fs'; process.on('SIGTERM', () => undefined); writeFileSync('ready', 'ready'); process.stdout.write('ready'); setInterval(() => undefined, 1000)"], { stdio: ["ignore", "pipe", "ignore"] });
      child.stdout.once("data", () => { writeFileSync(${JSON.stringify(descendant)}, String(child.pid)); process.exit(0); });
    }
    if (args.includes("remove")) process.exit(0);
    process.stdout.write(${JSON.stringify(grokStream("engine complete"))});`);
  try {
    const { session } = await createCliSessionFactory({
      command: process.execPath, commandArgs: [grok], engine: "grok", maxToolTurns: 1, timeoutMs: 10_000
    })({ cwd: root });
    await session.prompt("research");
    const pid = Number(await readFile(descendant, "utf8"));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    await session.disposeAsync?.();
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Grok removal reaps a stubborn descendant after its successful leader exits", async (context) => {
  if (!requirePosixProcessGroups(context)) return;
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-grok-remove-group-"));
  const descendant = path.join(root, "remove-descendant-pid");
  const grok = path.join(root, "grok.mjs");
  await writeFile(grok, `import { spawn } from "node:child_process"; import { writeFileSync } from "node:fs";
    const args = process.argv.slice(2);
    if (args.includes("remove")) {
      const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => undefined); process.stdout.write('ready'); setInterval(() => undefined, 1000)"], { stdio: ["ignore", "pipe", "ignore"] });
      child.stdout.once("data", () => { writeFileSync(${JSON.stringify(descendant)}, String(child.pid)); process.exit(0); });
    } else if (args.includes("add")) process.exit(0); else process.stdout.write(${JSON.stringify(grokStream("engine complete"))});`);
  try {
    const { session } = await createCliSessionFactory({
      command: process.execPath, commandArgs: [grok], engine: "grok", maxToolTurns: 1, timeoutMs: 10_000
    })({ cwd: root });
    await session.prompt("research");
    const pid = Number(await readFile(descendant, "utf8"));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    await session.disposeAsync?.();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function waitForFile(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { await access(filePath); return; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
  throw new Error("child did not become ready");
}

function requirePosixProcessGroups(context: { skip(message?: string): void }): boolean {
  if (process.platform !== "win32") return true;
  context.skip("detached process groups are not available on Windows");
  return false;
}

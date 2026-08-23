import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createCliSessionFactory } from "./cliSession.js";

test("Grok removal failure rejects without emitting a successful turn", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-grok-remove-failure-"));
  const grok = path.join(root, "grok.mjs");
  await writeFile(grok, `const args = process.argv.slice(2); if (args.includes("remove")) process.exit(23); else if (args.includes("add")) process.exit(0); else process.stdout.write("engine complete");`);
  try {
    const { session } = await createCliSessionFactory({ command: process.execPath, commandArgs: [grok], engine: "grok", maxToolTurns: 1, timeoutMs: 10_000 })({ cwd: root });
    let turns = 0;
    session.subscribe((event) => { if (event.type === "turn_end") turns += 1; });
    await assert.rejects(session.prompt("research"), /CLI engine exited 23/);
    assert.ok(session.disposeAsync);
    await assert.rejects(session.disposeAsync(), /CLI engine exited 23/);
    assert.equal(turns, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

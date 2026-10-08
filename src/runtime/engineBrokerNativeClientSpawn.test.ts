import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runNativeBrokerTurn } from "./engineBrokerNativeClient.js";

// The native client refuses to run unless its parent is the broker it names:
// a client whose broker died before it started would otherwise hold its
// handler's socket open, and the handler would supervise a turn nobody reads.
test("the native client is told which broker spawned it", { skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "daimon-native-client-"));
  try {
    const record = path.join(directory, "broker-pid");
    const executable = path.join(directory, "client");
    await writeFile(executable, `#!/bin/sh\ncat >/dev/null\nprintf '%s %s' "$DAIMON_BROKER_PID" "$PPID" > '${record}'\nexit 111\n`);
    await chmod(executable, 0o755);
    await assert.rejects(runNativeBrokerTurn(executable, { slot: 0, prompt: "prompt", providerCapability: "provider.Token-1", mcpCapability: "mcp.Token-2", requestId: "request-1", turnId: "turn-1", agentId: "agent-1", wakeId: "wake-1" }));
    const [named, parent] = (await readFile(record, "utf8")).split(" ");
    assert.equal(named, String(process.pid));
    assert.equal(parent, String(process.pid), "the named broker is the client's own parent");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

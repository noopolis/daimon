import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { CliProcessCleanupError, terminateChild } from "./cliProcess.js";

test("process-group permission failures are typed cleanup errors", async (context) => {
  if (process.platform === "win32") {
    context.skip("detached process groups are not available on Windows");
    return;
  }
  const child = Object.assign(new EventEmitter(), { exitCode: null, pid: 41_337, signalCode: null }) as never;
  const originalKill = process.kill;
  Object.defineProperty(process, "kill", {
    configurable: true,
    value: (() => {
      const error = Object.assign(new Error("permission denied"), { code: "EPERM" });
      throw error;
    }) as typeof process.kill
  });
  try {
    await assert.rejects(terminateChild(child), CliProcessCleanupError);
  } finally {
    Object.defineProperty(process, "kill", { configurable: true, value: originalKill });
  }
});

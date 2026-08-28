import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { refreshGrokBrokerCredential } from "./grokBrokerRefresh.js";

test("refresh uses only pinned models command and a positive broker environment", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-grok-refresh-")); const command = path.join(root, "grok"); const receipt = path.join(root, "receipt.json");
  await writeFile(command, `#!/bin/sh\n[ "$1" = models ] || exit 9\nnode -e 'require("fs").writeFileSync(process.argv[1],JSON.stringify({argv:process.argv.slice(2),expired:process.env.GROK_AUTH_EXPIRED,secret:process.env.SHOULD_NOT_LEAK}))' '${receipt}'\n`); await chmod(command, 0o700);
  process.env.SHOULD_NOT_LEAK = "secret";
  try { await refreshGrokBrokerCredential(command, root); const value = JSON.parse(await readFile(receipt, "utf8")); assert.deepEqual(value, { argv: [] }); }
  finally { delete process.env.SHOULD_NOT_LEAK; await rm(root, { recursive: true, force: true }); }
});

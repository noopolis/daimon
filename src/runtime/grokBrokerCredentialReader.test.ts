import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readGrokBrokerCredential } from "./grokBrokerCredentialReader.js";
test("broker reads only a private refreshable credential without exposing refresh", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-broker-auth-")); const file = path.join(root, "auth.json"); const token = "a".repeat(64); await writeFile(file, JSON.stringify({ realm: { key: token, refresh_token: "r".repeat(32) } }), { mode: 0o600 });
  try { const result = await readGrokBrokerCredential(file); assert.equal(result.accessToken, token); assert.match(result.digest, /^[a-f0-9]{64}$/u); assert.equal("refreshToken" in result, false); await chmod(file, 0o644); await assert.rejects(readGrokBrokerCredential(file), /unavailable/); await symlink(file, `${file}.link`); await assert.rejects(readGrokBrokerCredential(`${file}.link`), /unavailable/); }
  finally { await rm(root, { recursive: true, force: true }); }
});

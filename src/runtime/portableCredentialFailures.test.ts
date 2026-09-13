import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";

import { materializePortableCredential } from "./portableCredentialMaterial.js";
import type { OrganizationRuntimeAgentConfig } from "./organizationRuntime.js";

test("keeps directory and existing-credential protections and refuses undeclared engines", async () => {
  for (const mode of ["engine", "directory-mode", "directory-link", "destination-mode", "destination-directory", "repair-destination"] as const) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "daimon-credential-guards-"));
    const config: OrganizationRuntimeAgentConfig = { id: "agent:codex", name: "Codex", instructions: "Unused", workspacePath: `${root}/workspace`, runtimeHomePath: root, engine: { kind: mode === "engine" ? "grok" : "codex" } };
    try {
      await fs.mkdir(`${root}/.daimon-inbound`, { mode: 0o700 });
      await fs.writeFile(`${root}/.daimon-inbound/codex-auth`, "dummy", { mode: 0o600 });
      if (mode === "directory-mode") await fs.chmod(`${root}/.daimon-inbound`, 0o755);
      if (mode === "directory-link") { await fs.rename(`${root}/.daimon-inbound`, `${root}/source`); await fs.symlink(`${root}/source`, `${root}/.daimon-inbound`); }
      if (mode.startsWith("destination") || mode === "repair-destination") await fs.mkdir(`${root}/.codex`, { mode: mode === "repair-destination" ? 0o755 : 0o700 });
      if (mode === "destination-mode") await fs.writeFile(`${root}/.codex/auth.json`, "existing", { mode: 0o644 });
      if (mode === "destination-directory") await fs.mkdir(`${root}/.codex/auth.json`, { mode: 0o600 });
      if (mode === "repair-destination") {
        assert.equal(await materializePortableCredential(config, root), "created");
        assert.equal((await fs.stat(`${root}/.codex`)).mode & 0o777, 0o700);
      } else await assert.rejects(materializePortableCredential(config, root), /credential material/u);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  }
});

for (const failure of ["mkdir", "rename", "source-lstat", "existing-lstat", "temporary-close"] as const) test(`does not install credentials after ${failure} failure`, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "daimon-credential-failure-"));
  const config: OrganizationRuntimeAgentConfig = { id: "agent:codex", name: "Codex", instructions: "Unused", workspacePath: `${root}/workspace`, runtimeHomePath: root, engine: { kind: "codex" } };
  const source = `${root}/.daimon-inbound/codex-auth`, destination = `${root}/.codex/auth.json`;
  const fail = (): never => { throw Object.assign(new Error("private-path-and-contents-must-not-leak"), { code: "EIO" }); };
  try {
    await fs.mkdir(path.dirname(source), { mode: 0o700 }); await fs.writeFile(source, "dummy", { mode: 0o600 });
    if (failure === "mkdir") mock.method(fs, "mkdir", fail);
    if (failure === "rename") mock.method(fs, "rename", fail);
    if (failure.endsWith("lstat")) {
      const original = fs.lstat;
      mock.method(fs, "lstat", (...args: Parameters<typeof fs.lstat>) => args[0] === (failure === "source-lstat" ? source : destination) ? fail() : original(...args));
    }
    if (failure === "temporary-close") {
      const original = fs.open;
      mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
        const handle = await original(...args);
        if (String(args[0]).endsWith(".tmp")) { const close = handle.close.bind(handle); mock.method(handle, "close", async () => { await close(); fail(); }); }
        return handle;
      });
    }
    syncBuiltinESMExports();
    await assert.rejects(materializePortableCredential(config, root), (error: Error) => error.message === "agent agent:codex codex credential materialization failed");
    await assert.rejects(fs.readFile(destination), { code: "ENOENT" });
    const files = await fs.readdir(`${root}/.codex`).catch(() => []);
    assert.equal(files.some(file => file.endsWith(".tmp")), false);
  } finally { mock.restoreAll(); syncBuiltinESMExports(); await fs.rm(root, { recursive: true, force: true }); }
});

import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { materializePortableCredential } from "./portableCredentialMaterial.js";
import type { OrganizationRuntimeAgentConfig } from "./organizationRuntime.js";

const agent = (root: string, kind: "codex"): OrganizationRuntimeAgentConfig & {
  engine: { kind: "codex" };
} => ({
  id: `agent:${kind}`,
  name: kind,
  instructions: "Work.",
  workspacePath: path.join(root, "workspace"),
  runtimeHomePath: path.join(root, "runtime"),
  engine: { kind }
});

test("materializes an opaque portable credential with private runtime-owned modes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-portable-credential-"));
  const config = agent(root, "codex");
  const inbound = path.join(config.runtimeHomePath, ".daimon-inbound");
  const source = path.join(inbound, "codex-auth");
  const destination = path.join(config.runtimeHomePath, ".codex", "auth.json");
  try {
    await mkdir(inbound, { recursive: true, mode: 0o700 });
    await writeFile(source, "opaque-codex-credential", { mode: 0o600 });
    await chmod(source, 0o600);

    assert.equal(await materializePortableCredential(config, config.runtimeHomePath), "created");
    assert.equal(await readFile(destination, "utf8"), "opaque-codex-credential");
    assert.equal((await lstat(path.dirname(destination))).mode & 0o777, 0o700);
    assert.equal((await lstat(destination)).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves a newer runtime refresh and imports a later ingress refresh", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-portable-refresh-"));
  const config = agent(root, "codex");
  const inbound = path.join(config.runtimeHomePath, ".daimon-inbound");
  const source = path.join(inbound, "codex-auth");
  const destination = path.join(config.runtimeHomePath, ".codex", "auth.json");
  try {
    await mkdir(inbound, { recursive: true, mode: 0o700 });
    await writeFile(source, "initial-ingress", { mode: 0o600 });
    await chmod(source, 0o600);
    assert.equal(await materializePortableCredential(config, config.runtimeHomePath), "created");

    await writeFile(destination, "runtime-refreshed", { mode: 0o600 });
    await chmod(destination, 0o600);
    await utimes(source, new Date(2_000), new Date(2_000));
    await utimes(destination, new Date(3_000), new Date(3_000));
    assert.equal(await materializePortableCredential(config, config.runtimeHomePath), "preserved");
    assert.equal(await readFile(destination, "utf8"), "runtime-refreshed");

    await writeFile(source, "operator-refreshed", { mode: 0o600 });
    await chmod(source, 0o600);
    await utimes(source, new Date(4_000), new Date(4_000));
    assert.equal(await materializePortableCredential(config, config.runtimeHomePath), "refreshed");
    assert.equal(await readFile(destination, "utf8"), "operator-refreshed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects unsafe ingress without disclosing its path or contents", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-portable-unsafe-"));
  const config = agent(root, "codex");
  const inbound = path.join(config.runtimeHomePath, ".daimon-inbound");
  const source = path.join(inbound, "codex-auth");
  const outside = path.join(root, "outside-auth");
  try {
    await mkdir(inbound, { recursive: true, mode: 0o700 });
    await writeFile(outside, "must-not-leak", { mode: 0o600 });
    await symlink(outside, source);
    await assert.rejects(
      materializePortableCredential(config, config.runtimeHomePath),
      (error: Error) => {
        assert.match(error.message, /agent:codex codex credential materialization failed/);
        assert.doesNotMatch(error.message, /outside-auth|must-not-leak/);
        return true;
      }
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

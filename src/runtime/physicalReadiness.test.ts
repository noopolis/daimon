import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { prepareOrganizationRuntimePaths } from "./physicalReadiness.js";
import type { OrganizationRuntimeAgentConfig } from "./organizationRuntime.js";

const agent = (workspacePath: string, runtimeHomePath: string): OrganizationRuntimeAgentConfig => ({
  id: "agent", name: "Agent", instructions: "Work.", workspacePath, runtimeHomePath, engine: { kind: "codex" }
});

test("preflight rejects missing or linked caller roots without creating anything", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-physical-"));
  const real = path.join(root, "real");
  const linked = path.join(root, "linked");
  const missing = path.join(root, "missing");
  const home = path.join(root, "home");
  try {
    await mkdir(real, { mode: 0o700 });
    await mkdir(home, { mode: 0o700 });
    await symlink(real, linked);
    await assert.rejects(prepareOrganizationRuntimePaths([agent(linked, home)]), /symlink/);
    await assert.rejects(prepareOrganizationRuntimePaths([agent(missing, home)]), /ENOENT/);
    await assert.rejects(lstat(missing), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("preflight requires safe workspace and private runtime roots, and proves physical isolation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-physical-"));
  const workspace = path.join(root, "workspace");
  const home = path.join(root, "home");
  try {
    await mkdir(workspace, { mode: 0o700 });
    await mkdir(home, { mode: 0o700 });
    const authority = await prepareOrganizationRuntimePaths([agent(workspace, home)]);
    await authority.forAgent(agent(workspace, home)).verify();
    await authority.close();
    await chmod(home, 0o755);
    await assert.rejects(prepareOrganizationRuntimePaths([agent(workspace, home)]), /mode 0700/);
    await chmod(home, 0o700);
    await chmod(workspace, 0o777);
    await assert.rejects(prepareOrganizationRuntimePaths([agent(workspace, home)]), /write access/);
    await chmod(workspace, 0o700);
    await assert.rejects(prepareOrganizationRuntimePaths([agent(workspace, workspace)]), /overlap/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

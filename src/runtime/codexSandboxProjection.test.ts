import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveOrganizationCodexSandboxProjection } from "./codexSandboxProjection.js";
import { renderCodexArgs } from "../pi/cliEngineSpawn.js";
import { codexSandboxProtectedPaths, codexSandboxReadablePaths } from "./engineDispatcher.js";

test("public projection uses actual canonical policy and never reads auth or runs cognition", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "daimon-projection-")));
  const priorPath = process.env.PATH;
  const agent = { id: "agent:writer", name: "Writer", instructions: "Unused", workspacePath: path.join(root, "workspace"),
    runtimeHomePath: path.join(root, "home"), schedule: { kind: "disabled" }, engine: { kind: "codex", codexSandbox: { mode: "workspace-write", networkAccess: false, webSearch: "disabled" } } } as const;
  const config = { version: "noopolis.daimon.organization-runtime.v2", host: { bindHost: "127.0.0.1", port: 19700, controlTokenEnv: "UNIT_CONTROL_TOKEN" }, agents: [agent] };
  try {
    for (const directory of [agent.workspacePath, agent.runtimeHomePath]) await mkdir(directory, { mode: 0o700 });
    const executable = path.join(root, "codex"), log = path.join(root, "calls.jsonl");
    await writeFile(executable, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2))+'\\n');if(process.argv[2]!=='--version')process.exit(9);process.stdout.write('unit-codex-version');`, { mode: 0o700 });
    process.env.PATH = `${root}${path.delimiter}${priorPath ?? ""}`;
    const projection = await resolveOrganizationCodexSandboxProjection(config, agent.id, { acceptanceStorePath: "/run/paideia/control" });
    const expected = renderCodexArgs({ codexSandbox: agent.engine.codexSandbox,
      codexSandboxProtectedPaths: codexSandboxProtectedPaths(agent.id, agent, path.join(agent.runtimeHomePath, ".codex"), [agent], ["/run/paideia/control"]),
      codexSandboxReadablePaths: codexSandboxReadablePaths(agent) }, agent.workspacePath, undefined).find(arg => arg.startsWith("permissions="));
    assert.equal(projection.permissionConfig, expected);
    assert.equal(projection.executablePath, executable);
    assert.equal(projection.engineHomePath, path.join(agent.runtimeHomePath, ".codex"));
    assert.deepEqual(projection.sandboxArgs, ["sandbox", "-P", "daimon-strict", "-C", agent.workspacePath, "-c", expected]);
    assert.ok(!projection.permissionConfig.includes('"/run/paideia/control"="deny"'));
    assert.deepEqual((await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line)), [["--version"], ["--version"]]);
    await assert.rejects(readFile(path.join(agent.runtimeHomePath, ".codex", "auth.json")), /ENOENT/);
    await assert.rejects(resolveOrganizationCodexSandboxProjection(config, "missing", { acceptanceStorePath: "/run/control" }), /known strict/);
    await assert.rejects(resolveOrganizationCodexSandboxProjection({ ...config, agents: [{ ...agent, engine: { kind: "grok" } }] }, agent.id, { acceptanceStorePath: "/run/control" }), /known strict/);
    await assert.rejects(resolveOrganizationCodexSandboxProjection({ ...config, agents: [{ ...agent, engine: { kind: "codex" } }] }, agent.id, { acceptanceStorePath: "/run/control" }), /known strict/);
    await assert.rejects(resolveOrganizationCodexSandboxProjection(config, agent.id, { acceptanceStorePath: "relative" }), /absolute/);
    await chmod(executable, 0o600);
    process.env.PATH = root;
    await assert.rejects(resolveOrganizationCodexSandboxProjection(config, agent.id, { acceptanceStorePath: "/run/control" }), /unavailable/);
  } finally { if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath; await rm(root, { recursive: true, force: true }); }
});

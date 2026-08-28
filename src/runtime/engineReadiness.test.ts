import assert from "node:assert/strict";
import { chmod, link, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ENGINE_CREDENTIAL_MATERIAL, GROK_SUBSCRIPTION_REALM } from "./contractManifest.js";
import { engineAuthFile, engineHomeName, prepareEngineReadiness } from "./engineReadiness.js";
import type { OrganizationRuntimeAgentConfig } from "./organizationRuntime.js";

const agent = (root: string, kind: "codex" | "grok" | "agy"): OrganizationRuntimeAgentConfig => ({
  id: "safe-agent", name: "Safe", instructions: "Work.", workspacePath: path.join(root, "workspace"), runtimeHomePath: path.join(root, "home"), engine: { kind }
});

test("pins an executable and accepts only a private refreshable local auth artifact", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-engine-ready-"));
  const previousPath = process.env.PATH;
  try {
    const config = agent(root, "codex");
    const executable = path.join(root, "codex");
    await mkdir(config.workspacePath, { recursive: true, mode: 0o700 });
    await mkdir(path.join(config.runtimeHomePath, ".codex"), { recursive: true, mode: 0o700 });
    await writeFile(executable, "#!/usr/bin/env node\nif (process.argv.includes('--version')) process.stdout.write('test');", { mode: 0o700 });
    await chmod(executable, 0o700);
    await writeFile(path.join(config.runtimeHomePath, ".codex", "auth.json"), JSON.stringify({ tokens: { access_token: "not-logged", refresh_token: "not-logged" } }), { mode: 0o600 });
    await chmod(path.join(config.runtimeHomePath, ".codex", "auth.json"), 0o600);
    process.env.PATH = `${root}${path.delimiter}${previousPath ?? ""}`;
    const readiness = await prepareEngineReadiness(config, config.runtimeHomePath);
    await readiness.verify();
    await rename(executable, `${executable}.replaced`);
    await assert.rejects(readiness.verify(), /safe-agent codex is unavailable/);
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("accepts refreshable native Grok subscription auth across access expiry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-engine-grok-ready-"));
  const previousPath = process.env.PATH;
  try {
    const config = agent(root, "grok");
    const executable = path.join(root, "grok");
    const authPath = path.join(config.runtimeHomePath, ".grok", "auth.json");
    await mkdir(config.workspacePath, { recursive: true, mode: 0o700 });
    await mkdir(path.dirname(authPath), { recursive: true, mode: 0o700 });
    await writeFile(executable, "#!/usr/bin/env node\nif (process.argv.includes('--version')) process.stdout.write('test');", { mode: 0o700 });
    await chmod(executable, 0o700);
    const credential = (expiresAt: string, access = "not-logged", refresh = "not-logged") => ({
      "https://auth.x.ai::account": { key: access, refresh_token: refresh, expires_at: expiresAt }
    });
    await writeFile(authPath, JSON.stringify(credential("2099-01-01T00:00:00.000Z")), { mode: 0o600 });
    await chmod(authPath, 0o600);
    process.env.PATH = `${root}${path.delimiter}${previousPath ?? ""}`;
    await (await prepareEngineReadiness(config, config.runtimeHomePath)).verify();

    await writeFile(authPath, JSON.stringify(credential("2020-01-01T00:00:00.000Z")), { mode: 0o600 });
    await chmod(authPath, 0o600);
    await (await prepareEngineReadiness(config, config.runtimeHomePath)).verify();

    for (const unsupported of [
      { "https://auth.x.ai::account": { key: "not-logged", refresh_token: "not-logged" } },
      credential("not-a-date"),
      { "https://auth.x.ai::account": { refresh_token: "not-logged", expires_at: "2099-01-01T00:00:00.000Z" } },
      { "https://auth.x.ai::account": { key: "not-logged", expires_at: "2099-01-01T00:00:00.000Z" } },
      credential("2099-01-01T00:00:00.000Z", "", "not-logged"),
      credential("2099-01-01T00:00:00.000Z", "not-logged", ""),
      credential("2020-01-01T00:00:00.000Z", "not-logged", "   "),
      { unexpected: true }
    ]) {
      await writeFile(authPath, JSON.stringify(unsupported), { mode: 0o600 });
      await chmod(authPath, 0o600);
      await assert.rejects(prepareEngineReadiness(config, config.runtimeHomePath), /subscription authentication is not ready/);
    }

    await writeFile(authPath, "{", { mode: 0o600 });
    await chmod(authPath, 0o600);
    await assert.rejects(prepareEngineReadiness(config, config.runtimeHomePath), /subscription authentication is not ready/);

    await writeFile(authPath, JSON.stringify(credential("2099-01-01T00:00:00.000Z")), { mode: 0o600 });
    await chmod(authPath, 0o644);
    await assert.rejects(prepareEngineReadiness(config, config.runtimeHomePath), /subscription authentication is not ready/);

    await chmod(authPath, 0o600);
    await link(authPath, path.join(root, "linked-auth"));
    await assert.rejects(prepareEngineReadiness(config, config.runtimeHomePath), /subscription authentication is not ready/);
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("fails closed for missing or unsafe credentials without reflecting their path or contents", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-engine-auth-"));
  const previousPath = process.env.PATH;
  try {
    const config = agent(root, "agy");
    await mkdir(config.workspacePath, { recursive: true, mode: 0o700 });
    await mkdir(path.join(config.runtimeHomePath, ".antigravity-cli"), { recursive: true, mode: 0o700 });
    await writeFile(path.join(root, "agy"), "#!/usr/bin/env node\nif (process.argv.includes('--version')) process.stdout.write('test'); else process.exitCode = 1;", { mode: 0o700 });
    await chmod(path.join(root, "agy"), 0o700);
    process.env.PATH = `${root}${path.delimiter}${previousPath ?? ""}`;
    await assert.rejects(prepareEngineReadiness(config, config.runtimeHomePath, "unix:path=/private/realm/bus"), (error: Error) => {
      assert.match(error.message, /safe-agent agy is unavailable/);
      assert.match(error.message, /subscription enrollment is required/);
      assert.doesNotMatch(error.message, /antigravity-oauth-token|daimon-engine-auth/);
      return true;
    });
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});
test("verifies AGY through its noninteractive native secure-storage probe without a portable token file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-engine-agy-native-"));
  const previousPath = process.env.PATH;
  try {
    const config = agent(root, "agy");
    const probeLog = path.join(root, "probe-log");
    await Promise.all([
      mkdir(config.workspacePath, { recursive: true, mode: 0o700 }),
      mkdir(config.runtimeHomePath, { recursive: true, mode: 0o700 })
    ]);
    await writeFile(path.join(root, "agy"), [
      "#!/usr/bin/env node",
      `import { appendFileSync } from "node:fs";`,
      `if (process.argv.includes("--version")) process.stdout.write("1.1.19");`,
      `else if (process.argv.includes("models")) appendFileSync(${JSON.stringify(probeLog)}, process.env.HOME + "|" + process.env.DBUS_SESSION_BUS_ADDRESS + "\\n");`,
      `else process.exitCode = 2;`
    ].join("\n"), { mode: 0o700 });
    await chmod(path.join(root, "agy"), 0o700);
    process.env.PATH = `${root}${path.delimiter}${previousPath ?? ""}`;

    const readiness = await prepareEngineReadiness(config, config.runtimeHomePath, "unix:path=/private/realm/bus");
    await readiness.verify();

    assert.equal(readiness.engineHomePath, config.runtimeHomePath);
    assert.equal(await readFile(probeLog, "utf8"), `${config.runtimeHomePath}|unix:path=/private/realm/bus\n${config.runtimeHomePath}|unix:path=/private/realm/bus\n`);
    assert.equal((ENGINE_CREDENTIAL_MATERIAL as Partial<Record<string, unknown>>).agy, undefined);
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("readiness derives every engine home, credential file, and required mode from the manifest", () => {
  const root = "/runtime-home";
  for (const kind of ["codex"] as const) {
    const rule = ENGINE_CREDENTIAL_MATERIAL[kind];
    const engineHome = path.join(root, engineHomeName(kind));
    assert.equal(engineHome, path.join(root, path.dirname(rule.destinationRelativePath)));
    assert.equal(engineAuthFile(kind, engineHome), path.join(root, rule.destinationRelativePath));
    assert.equal(rule.directoryMode, 0o700);
    assert.equal(rule.fileMode, 0o600);
  }
  assert.equal(engineHomeName("grok"), ".grok");
  assert.equal(engineAuthFile("grok", path.join(root, ".grok")), path.join(root, GROK_SUBSCRIPTION_REALM.agentCredentialRelativePath));
});

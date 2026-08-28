import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ORGANIZATION_RUNTIME_VERSION } from "./organizationRuntime.js";
import { parseOrganizationRuntimeCliArguments, runOrganizationRuntimeCli } from "./cli.js";

test("CLI parses only normal run and the bounded interactive AGY bootstrap", () => {
  assert.deepEqual(parseOrganizationRuntimeCliArguments(["run", "--config", "/config"]), { configPath: "/config", kind: "run" });
  assert.deepEqual(parseOrganizationRuntimeCliArguments(["auth", "agy", "login", "--config", "/config"]), { configPath: "/config", kind: "agy-login" });
  assert.throws(() => parseOrganizationRuntimeCliArguments(["auth", "codex", "login", "--config", "/config"]), /usage/);
  assert.throws(() => parseOrganizationRuntimeCliArguments(["auth", "agy", "export", "--config", "/config"]), /usage/);
});

test("CLI rejects an oversized config before JSON parsing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-runtime-config-cap-"));
  const configPath = path.join(root, "runtime.json");
  try {
    await writeFile(configPath, " ".repeat(1_048_577));
    await assert.rejects(runOrganizationRuntimeCli(["run", "--config", configPath]), /too large/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI strictly authenticates and routes a production Daimon engine", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-runtime-cli-"));
  const port = await availablePort();
  const tokenEnv = "DAIMON_RUNTIME_CLI_TEST_TOKEN";
  const token = "cli-control-token";
  const workspace = path.join(root, "workspace");
  const runtimeHome = path.join(root, "runtime");
  const acceptanceStore = path.join(root, "acceptance-store");
  const supportsC0 = process.platform === "linux";
  const program = path.join(root, "codex");
  const configPath = path.join(root, "runtime.json");
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  await mkdir(runtimeHome, { recursive: true, mode: 0o700 });
  await mkdir(acceptanceStore, { recursive: true, mode: 0o700 });
  await mkdir(path.join(runtimeHome, ".daimon-inbound"), { recursive: true, mode: 0o700 });
  const inboundAuth = path.join(runtimeHome, ".daimon-inbound", "codex-auth");
  const runtimeAuth = path.join(runtimeHome, ".codex", "auth.json");
  const readinessReceipt = path.join(root, "state", "runtime-readiness.json");
  await writeFile(inboundAuth, JSON.stringify({ tokens: { access_token: "test-access", refresh_token: "test-refresh" } }), { mode: 0o600 });
  await chmod(inboundAuth, 0o600);
  await writeFile(program, `#!/usr/bin/env node\nif (process.argv.includes('--version')) process.stdout.write('test'); else { process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(process.env.${tokenEnv} ?? 'absent')); }`);
  await chmod(program, 0o700);
  await writeFile(configPath, JSON.stringify({
    version: ORGANIZATION_RUNTIME_VERSION,
    host: { bindHost: "0.0.0.0", port, controlTokenEnv: tokenEnv },
    agents: [{
      id: "agent", name: "Agent", instructions: "Respond.", workspacePath: workspace, runtimeHomePath: runtimeHome,
      engine: { kind: "codex" }
    }]
  }));
  const child = spawn(process.execPath, ["--import", "tsx", "src/runtime/cli.ts", "run", "--config", configPath], {
    cwd: process.cwd(), env: { ...process.env, PATH: `${root}${path.delimiter}${process.env.PATH ?? ""}`, [tokenEnv]: token, DAIMON_RUNTIME_READINESS_RECEIPT: readinessReceipt, ...(supportsC0 ? { DAIMON_RUNTIME_ACCEPTANCE_STORE: acceptanceStore } : {}), NOOPOLIS_RUN_ID: "runtime-cli-test" }, stdio: ["ignore", "pipe", "pipe"]
  });
  const output: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => output.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => output.push(chunk));
  try {
    await waitForHealth(port, token, child, output);
    assert.deepEqual(JSON.parse(await readFile(readinessReceipt, "utf8")), { version: "noopolis.daimon.readiness-receipt.v1", agents: [{ agent_id: "agent", engine: "codex" }] });
    assert.equal(await readFile(runtimeAuth, "utf8"), await readFile(inboundAuth, "utf8"));
    assert.equal((await lstat(path.dirname(runtimeAuth))).mode & 0o777, 0o700);
    assert.equal((await lstat(runtimeAuth)).mode & 0o777, 0o600);
    const readiness = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(readiness.status, 200);
    assert.deepEqual(await readiness.json(), { status: "ok" });
    const unauthorized = await fetch(`http://127.0.0.1:${port}/v1/health`);
    assert.equal(unauthorized.status, 401);
    const malformed = await fetch(`http://127.0.0.1:${port}/v1/wake`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ agentId: "agent" })
    });
    assert.equal(malformed.status, 400);
    const wrongContentType = await fetch(`http://127.0.0.1:${port}/v1/wake`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "text/plain" }, body: "{}"
    });
    assert.equal(wrongContentType.status, 400);
    const looseTimestamp = await fetch(`http://127.0.0.1:${port}/v1/wake`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ agentId: "agent", event: {
        version: "noopolis.daimon.wake.v1", id: "loose", kind: "manual", text: "wake", occurredAt: "2026-08-17T00:00:00Z"
      } })
    });
    assert.equal(looseTimestamp.status, 400);
    const unknown = await requestWake(port, token, "unknown", "unknown-wake");
    assert.equal(unknown.status, 409);
    assert.equal((await unknown.json() as { code: string }).code, "unknown_agent");
    const response = await requestWake(port, token, "agent", "valid-wake");
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { text: string }).text, "absent");
    const accepted = await fetch(`http://127.0.0.1:${port}/v2/wakes`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ agent_id: "agent", delivery_id: "delivery-1", event: {
        version: "noopolis.daimon.wake.v2", kind: "manual", text: "wake", occurred_at: "2026-08-17T00:00:00.000Z"
      } })
    });
    if (!supportsC0) { assert.equal(accepted.status, 404); return; }
    assert.equal(accepted.status, 202);
    const acceptance = await accepted.json() as { acceptance_id: string; state: string; text?: string };
    assert.equal(acceptance.state, "accepted");
    assert.equal(acceptance.text, undefined);
    const activityV2 = await fetch(`http://127.0.0.1:${port}/v2/activity`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(activityV2.status, 200);
    const activityBody = await activityV2.json() as { version: string; items: Array<{ delivery_id: string }> };
    assert.equal(activityBody.version, "noopolis.daimon.organization-runtime-activity.v2");
    assert.equal(activityBody.items.some((item) => item.delivery_id === "delivery-1"), true);
    await waitForReceipt(port, token, acceptance.acceptance_id);
    const conflict = await fetch(`http://127.0.0.1:${port}/v2/wakes`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ agent_id: "agent", delivery_id: "delivery-1", event: {
        version: "noopolis.daimon.wake.v2", kind: "manual", text: "different", occurred_at: "2026-08-17T00:00:00.000Z"
      } })
    });
    assert.equal(conflict.status, 409);
  } finally {
    child.kill("SIGTERM");
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
    await rm(root, { recursive: true, force: true });
  }
});

async function requestWake(port: number, token: string, agentId: string, id: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/wake`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ agentId, event: {
      version: "noopolis.daimon.wake.v1", id, kind: "manual", text: "wake", occurredAt: "2026-08-17T00:00:00.000Z"
    } })
  });
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no test port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function waitForHealth(port: number, token: string, child: ReturnType<typeof spawn>, output: Buffer[]): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/health`, { headers: { authorization: `Bearer ${token}` } });
      if (response.status === 200) return;
    } catch { /* process has not bound yet */ }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`runtime CLI did not become healthy: ${Buffer.concat(output).toString("utf8")}; exit=${child.exitCode ?? child.signalCode ?? "running"}`);
}

async function waitForReceipt(port: number, token: string, acceptanceId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(`http://127.0.0.1:${port}/v2/wake-receipts/${acceptanceId}`, { headers: { authorization: `Bearer ${token}` } });
    if (response.status === 200 && (await response.json() as { state: string }).state === "completed") return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("v2 acceptance did not reach a terminal result");
}

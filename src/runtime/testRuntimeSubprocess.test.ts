import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";

const entrypoint = path.resolve("src/runtime/testRuntimeSubprocess.ts");
const config = {
  version: "noopolis.daimon.organization-runtime.v2",
  host: { bindHost: "127.0.0.1", port: 4318, controlTokenEnv: "IGNORED_TEST_TOKEN" },
  agents: [{ id: "alpha", name: "Alpha", instructions: "work", workspacePath: "/workspace/alpha", runtimeHomePath: "/runtime/alpha", engine: { kind: "codex" }, schedule: { kind: "every", interval_ms: 1_000, prompt: "scheduled work" } }]
};

test("explicit subprocess drives real durable schedule acceptance and restart without duplication", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-test-runtime-")); await chmod(root, 0o700);
  try {
    const first = runtime();
    const started = await first.command({ type: "start", acceptance_store_path: root, config, control_token: "test-control", now_ms: 0 }) as { base_url: string };
    assert.match(started.base_url, /^http:\/\/127\.0\.0\.1:\d+$/u);
    const advanced = await first.command({ type: "advance", now_ms: 1_000 }) as { wakes: Array<{ wake_id: string }> };
    assert.equal(advanced.wakes.length, 1);
    const wakeId = advanced.wakes[0]!.wake_id;
    const stopped = await first.command({ type: "stop" }) as { wakes: Array<{ wake_id: string }> };
    assert.deepEqual(stopped.wakes.map((wake) => wake.wake_id), [wakeId]);
    await first.close();

    const replacement = runtime();
    await replacement.command({ type: "start", acceptance_store_path: root, config, control_token: "test-control", now_ms: 1_000 });
    const replay = await replacement.command({ type: "snapshot" }) as { wakes: unknown[] };
    assert.equal(replay.wakes.length, 0);
    const next = await replacement.command({ type: "advance", now_ms: 2_000 }) as { wakes: Array<{ wake_id: string }> };
    assert.equal(next.wakes.length, 1);
    assert.notEqual(next.wakes[0]!.wake_id, wakeId);
    await replacement.command({ type: "stop" }); await replacement.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("loopback v2 bridge durably accepts, authenticates, and deduplicates across restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-test-runtime-http-")); await chmod(root, 0o700);
  const body = { agent_id: "alpha", delivery_id: "bridge-delivery", event: { version: "noopolis.daimon.wake.v2", kind: "external", text: "sensor value", occurred_at: "1970-01-01T00:00:00.000Z" } };
  try {
    const first = runtime();
    const started = await first.command({ type: "start", acceptance_store_path: root, config, control_token: "bridge-token", now_ms: 0 }) as { base_url: string };
    assert.equal((await post(started.base_url, body, "wrong")).status, 401);
    const accepted = await post(started.base_url, body, "bridge-token");
    assert.equal(accepted.status, 202);
    await settles(first, 1);
    await first.command({ type: "stop" }); await first.close();

    const replacement = runtime();
    const restarted = await replacement.command({ type: "start", acceptance_store_path: root, config, control_token: "bridge-token", now_ms: 0 }) as { base_url: string };
    const replay = await post(restarted.base_url, body, "bridge-token");
    assert.equal(replay.status, 202);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const snapshot = await replacement.command({ type: "snapshot" }) as { wakes: unknown[] };
    assert.equal(snapshot.wakes.length, 0);
    await replacement.command({ type: "stop" }); await replacement.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("explicit test runtime supports a bounded container HTTP bind", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-test-runtime-bind-")); await chmod(root, 0o700);
  try {
    const child = runtime();
    const started = await child.command({ type: "start", acceptance_store_path: root, config, control_token: "bind-token", now_ms: 0, http_host: "0.0.0.0", http_port: 0 }) as { base_url: string; http_host: string; http_port: number };
    assert.equal(started.http_host, "0.0.0.0"); assert.ok(started.http_port > 0); assert.equal(started.base_url, `http://0.0.0.0:${started.http_port}`);
    assert.equal((await post(`http://127.0.0.1:${started.http_port}`, { agent_id: "alpha", delivery_id: "container-bind", event: { version: "noopolis.daimon.wake.v2", kind: "external", text: "reachable", occurred_at: "1970-01-01T00:00:00.000Z" } }, "bind-token")).status, 202);
    await child.command({ type: "stop" }); await child.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("scripted cognition uses the real Moltnet CLI path to address a declared outbound wake", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "daimon-test-runtime-action-"));
  const senderRoot = path.join(directory, "sender"); const recipientRoot = path.join(directory, "recipient");
  await Promise.all([chmod(directory, 0o700), mkdtemp(`${senderRoot}-`), mkdtemp(`${recipientRoot}-`)]);
  const actualSenderRoot = (await import("node:fs/promises")).readdir(directory).then((names) => path.join(directory, names.find((name) => name.startsWith("sender-"))!));
  const actualRecipientRoot = (await import("node:fs/promises")).readdir(directory).then((names) => path.join(directory, names.find((name) => name.startsWith("recipient-"))!));
  const sender = runtime(); const recipient = runtime();
  try {
    const recipientStart = await recipient.command({ type: "start", acceptance_store_path: await actualRecipientRoot, config, control_token: "recipient-token", now_ms: 0 }) as { base_url: string };
    const bridge = createServer(async (request, response) => {
      if (request.method !== "POST" || request.url !== "/v1/messages") { response.writeHead(404).end(); return; }
      const body = await new Promise<string>((resolve) => { let value = ""; request.on("data", (chunk) => { value += chunk; }); request.on("end", () => resolve(value)); });
      const sent = JSON.parse(body) as { parts: Array<{ text: string }> };
      await post(recipientStart.base_url, { agent_id: "alpha", delivery_id: "moltnet:outgoing_1", event: { version: "noopolis.daimon.wake.v2", kind: "message", text: sent.parts[0]!.text, occurred_at: "1970-01-01T00:00:00.000Z" } }, "recipient-token");
      response.writeHead(202, { "content-type": "application/json" }).end(JSON.stringify({ accepted: true, event_id: "moltnet:outgoing_1", message_id: "outgoing_1" }));
    });
    await new Promise<void>((resolve) => bridge.listen(0, "127.0.0.1", resolve));
    const address = bridge.address(); assert.ok(address && typeof address !== "string");
    const clientConfig = path.join(directory, "config.json");
    await writeFile(clientConfig, JSON.stringify({ version: "moltnet.client.v1", agent: { name: "Alpha", runtime: "daimon" }, attachments: [{ agent_name: "Alpha", auth: { mode: "none" }, base_url: `http://127.0.0.1:${address.port}`, member_id: "alpha", network_id: "test-network", runtime: "daimon", rooms: [{ id: "dispatch" }] }] }), { mode: 0o600 });
    const senderStart = await sender.command({ type: "start", acceptance_store_path: await actualSenderRoot, config, control_token: "sender-token", now_ms: 0,
      cognition_actions: [{ delivery_id: "moltnet:incoming_1", network_id: "test-network", target: "room:dispatch", text: "addressed result" }],
      moltnet_cli_path: path.resolve("../moltnet/bin/moltnet"), moltnet_client_config_path: clientConfig }) as { base_url: string };
    assert.equal((await post(senderStart.base_url, { agent_id: "alpha", delivery_id: "moltnet:incoming_1", event: { version: "noopolis.daimon.wake.v2", kind: "message", text: "inbound", occurred_at: "1970-01-01T00:00:00.000Z" } }, "sender-token")).status, 202);
    await settles(sender, 1); await settles(recipient, 1);
    const senderEvidence = await sender.command({ type: "snapshot" }) as { action_receipts: Array<{ target: string }> };
    assert.deepEqual(senderEvidence.action_receipts.map((item) => item.target), ["room:dispatch"]);
    await sender.command({ type: "stop" }); await recipient.command({ type: "stop" });
    await Promise.all([sender.close(), recipient.close(), new Promise<void>((resolve, reject) => bridge.close((error) => error ? reject(error) : resolve()))]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("scripted cognition calls only an attested compiled MCP server and tool", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-test-runtime-mcp-")); await chmod(root, 0o700);
  try {
    const artifact = { version: "spawnfile.explicit-test-mcp.v1", compile_fingerprint: "sf1:0123456789ab", servers: [{ id: "fixture", agent_id: "alpha", command: process.execPath, args: [path.resolve("src/runtime/fixtures/testMcpServer.mjs")], tools: ["checkpoint"], env_names: [] }] };
    const artifactBytes = Buffer.from(`${JSON.stringify(artifact)}\n`); const configPath = path.join(root, "mcp.json"), receiptPath = path.join(root, "receipt.json");
    await writeFile(configPath, artifactBytes, { mode: 0o600 }); await writeFile(receiptPath, JSON.stringify({ version: "spawnfile.explicit-test-mcp-receipt.v1", artifact_sha256: `sha256:${(await import("node:crypto")).createHash("sha256").update(artifactBytes).digest("hex")}` }), { mode: 0o600 });
    const child = runtime(); const started = await child.command({ type: "start", acceptance_store_path: root, config, control_token: "mcp-token", now_ms: 0, mcp_config_path: configPath, mcp_receipt_path: receiptPath, cognition_actions: [{ type: "mcp_call", trigger: { agent_id: "alpha", wake_kind: "schedule", text_sha256: (await import("node:crypto")).createHash("sha256").update("scheduled work").digest("hex") }, server_id: "fixture", tool: "checkpoint", arguments: { phase: "drafting" } }] }) as { base_url: string };
    const advanced = await child.command({ type: "advance", now_ms: 1_000 }) as { action_receipts: Array<{ type: string; tool: string; is_error: boolean }> };
    assert.deepEqual(advanced.action_receipts.map(({ type, tool, is_error }) => ({ type, tool, is_error })), [{ type: "mcp_call", tool: "checkpoint", is_error: false }]);
    await child.command({ type: "stop" }); await child.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("subprocess entrypoint is unavailable without explicit test mode", async () => {
  const child = spawn(process.execPath, ["--import", "tsx", entrypoint], { env: { ...process.env, DAIMON_EXPLICIT_TEST_RUNTIME: "" }, stdio: ["ignore", "ignore", "pipe"] });
  let error = ""; child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk: string) => { error += chunk; });
  const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  assert.notEqual(code, 0); assert.match(error, /requires DAIMON_EXPLICIT_TEST_RUNTIME=1/);
});

function runtime(): { command(value: unknown): Promise<unknown>; close(): Promise<void> } {
  const child = spawn(process.execPath, ["--import", "tsx", entrypoint], { env: { ...process.env, DAIMON_EXPLICIT_TEST_RUNTIME: "1" }, stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout });
  const replies: Array<(value: unknown) => void> = [];
  lines.on("line", (line) => replies.shift()?.(JSON.parse(line)));
  return {
    command: async (value) => await new Promise((resolve, reject) => {
      replies.push(resolve);
      child.stdin.write(`${JSON.stringify(value)}\n`, (error) => { if (error) reject(error); });
    }),
    close: async () => {
      child.stdin.end();
      const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
      if (code !== 0) throw new Error(`test runtime exited ${code}`);
    }
  };
}

async function post(baseUrl: string, body: unknown, token: string): Promise<Response> {
  return await fetch(`${baseUrl}/v2/wakes`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
}
async function settles(child: ReturnType<typeof runtime>, expected: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const value = await child.command({ type: "snapshot" }) as { wakes: unknown[] };
    if (value.wakes.length === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("HTTP wake did not settle");
}

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, Server } from "node:http";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { PiHarnessAdapter, type PiSessionFactory } from "./piHarness.js";
import { CLI_ENGINE_MAX_OUTPUT_BYTES, createCliSessionFactory, readChild, renderCodexArgs, spawnEngine } from "./cliSession.js";
import { formatWorldWakePrompt } from "./worldNudge.js";

const require = createRequire(import.meta.url);
const mcpClientEntry = pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/index.js")).href;
const mcpTransportEntry = pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js")).href;

const model = {
  auth: { method: "none" as const },
  endpoint: { baseUrl: "http://127.0.0.1:11434/v1", compatibility: "openai" as const },
  name: "stub",
  provider: "stub"
};

test("CLI adapter mounts the harness tool objects and preserves the causal wake envelope", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-cli-mcp-proof-"));
  const bearer = "proof-bearer-never-engine-visible";
  const decisionToken = "proof-decision-never-engine-visible";
  const calls: Array<{ authorization: string | undefined; body: string }> = [];
  const world = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      calls.push({ authorization: request.headers.authorization, body });
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true, operation: JSON.parse(body).request_id ?? "observe" }));
    });
  });
  const listenError = await new Promise<Error | undefined>((resolve) => {
    world.once("error", resolve);
    world.listen(0, "127.0.0.1", () => resolve(undefined));
  });
  if (listenError !== undefined) {
    await rm(root, { recursive: true, force: true });
    context.skip(`stub proof requires loopback sockets: ${listenError.message}`);
    return;
  }
  const address = world.address();
  if (address === null || typeof address === "string") throw new Error("world did not bind");
  const tokenEnv = "DAIMON_CLI_PROOF_BEARER";
  process.env.NOOPOLIS_RUN_ID = "proof-run";
  process.env[tokenEnv] = bearer;
  const stub = path.join(root, "stub-engine.mjs");
  await writeFile(stub, [
    "const promptChunks = [];",
    "for await (const chunk of process.stdin) promptChunks.push(chunk);",
    "const prompt = Buffer.concat(promptChunks).toString('utf8');",
    `import { Client } from ${JSON.stringify(mcpClientEntry)};`,
    `import { StreamableHTTPClientTransport } from ${JSON.stringify(mcpTransportEntry)};`,
    "const config = process.argv[process.argv.indexOf('-c') + 1];",
    "const endpoint = config.slice(config.indexOf('=') + 1);",
    "const client = new Client({ name: 'proof-stub', version: '1' });",
    "await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));",
    "const listed = await client.listTools();",
    "const observe = await client.callTool({ name: 'world_observe', arguments: { sense: 'world://proof/sense' } });",
    "const act = await client.callTool({ name: 'world_act', arguments: { affordance: 'world://proof/act', target: 'world://proof/target', input: { ok: true } } });",
    "const refused = await client.callTool({ name: 'world_status', arguments: {} });",
    "const codex = (value) => [{ type: 'item.completed', item: { type: 'agent_message', text: value } }, { type: 'turn.completed' }].map(JSON.stringify).join('\\n');",
    `process.stdout.write(codex(JSON.stringify({ listed: listed.tools.map((tool) => tool.name), observe, act, refused, bearer: process.env.${tokenEnv} ?? null, argv: process.argv.join('\\n'), prompt })));`,
    "await client.close();"
  ].join("\n"));
  const captured: Parameters<PiSessionFactory>[0][] = [];
  const mounted: Array<readonly object[]> = [];
  const realFactory = createCliSessionFactory({
    command: process.execPath,
    commandArgs: [stub],
    engine: "codex",
    maxToolTurns: 2,
    onToolsMounted: (tools) => mounted.push(tools),
    redactedEnvironmentNames: [tokenEnv],
    timeoutMs: 10_000
  });
  const sessionFactory: PiSessionFactory = async (input) => {
    captured.push(input);
    return realFactory(input);
  };
  try {
    const handle = await new PiHarnessAdapter({
      authPath: path.join(root, "auth.json"),
      model,
      sessionFactory,
      world: { url: `http://127.0.0.1:${address.port}/v1/world`, tokenEnv }
    }).startAgent({
      id: "proof-agent",
      name: "Proof agent",
      instructions: "Use the world tools.",
      runtimeHomePath: path.join(root, "runtime"),
      workspacePath: path.join(root, "workspace")
    });
    const result = await handle.wake({
      id: "proof-wake",
      kind: "message",
      from: "proof",
      text: JSON.stringify({ decision_token: decisionToken, run_id: "proof-run", tick: 1, version: "simfile.world-nudge.v1" }),
      delivery: { eventId: "proof-wake", sender: "proof", target: "proof-agent", contextId: "proof" }
    });
    assert.match(result.text, /world_observe/);
    assert.match(result.text, /world_act/);
    assert.match(result.text, /"isError":true/);
    assert.equal((JSON.parse(result.text) as { prompt: string }).prompt, formatWorldWakePrompt({
      decisionToken,
      requestId: "unused-in-test",
      runId: "proof-run",
      tick: 1,
      wakeId: "proof-wake"
    }));
    assert.equal(JSON.stringify(result).includes(decisionToken), false);
    assert.equal(JSON.stringify(result).includes(bearer), false);
    assert.deepEqual(captured[0]?.customTools?.map((tool) => tool.name).filter((name) => name.startsWith("world_")), [
      "world_claim", "world_status", "world_capabilities", "world_observe", "world_affordances", "world_act", "world_ledger"
    ]);
    assert.strictEqual(mounted[0], captured[0]?.customTools);
    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => call.authorization === `Bearer ${bearer}`));
    assert.ok(calls.every((call) => call.body.includes(decisionToken)));
    assert.equal(result.text.includes(bearer), false);
    assert.equal(result.text.includes(`"bearer":"${bearer}"`), false);
    assert.equal(result.text.includes(bearer), false);
    const events = (await readFile(path.join(root, "runtime", "telemetry", "causal.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as {
        cause_event_ids: string[];
        event_id: string;
        payload: { turn_id: string };
        run_id: string;
        type: string;
      });
    assert.deepEqual(events.map((event) => event.type), ["turn.input.submitted", "turn.output.completed"]);
    assert.deepEqual(events.map((event) => event.payload.turn_id), ["proof-wake", "proof-wake"]);
    assert.equal(events[0]?.run_id, "proof-run");
    assert.deepEqual(events[1]?.cause_event_ids, [events[0]?.event_id]);
    await handle.stop();
  } finally {
    delete process.env[tokenEnv];
    delete process.env.NOOPOLIS_RUN_ID;
    await new Promise<void>((resolve) => world.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("codex argv includes the configurable sandbox setting", () => {
  const previous = process.env.DAIMON_CODEX_SANDBOX;
  try {
    delete process.env.DAIMON_CODEX_SANDBOX;
    const defaultArgs = renderCodexArgs({ commandArgs: [] }, "/workspace", "http://127.0.0.1:1234/mcp");
    assert.deepEqual(defaultArgs.slice(defaultArgs.indexOf("-c"), defaultArgs.indexOf("-c") + 2), ["-c", "mcp_servers.daimon.url=http://127.0.0.1:1234/mcp"]);
    assert.deepEqual(defaultArgs.slice(defaultArgs.indexOf("--sandbox"), defaultArgs.indexOf("--sandbox") + 2), ["--sandbox", "danger-full-access"]);
    process.env.DAIMON_CODEX_SANDBOX = "workspace-write";
    const overrideArgs = renderCodexArgs({ commandArgs: [] }, "/workspace", "http://127.0.0.1:1234/mcp");
    assert.deepEqual(overrideArgs.slice(overrideArgs.indexOf("--sandbox"), overrideArgs.indexOf("--sandbox") + 2), ["--sandbox", "workspace-write"]);
  } finally {
    if (previous === undefined) delete process.env.DAIMON_CODEX_SANDBOX;
    else process.env.DAIMON_CODEX_SANDBOX = previous;
  }
});

test("CLI engine failures include bounded redacted diagnostics", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-cli-diagnostic-"));
  const tokenEnv = "DAIMON_CLI_DIAGNOSTIC_BEARER";
  const bearer = "diagnostic-bearer-must-not-leak";
  process.env[tokenEnv] = bearer;
  const stub = path.join(root, "failing-engine.mjs");
  await writeFile(stub, `process.stderr.write(${JSON.stringify(`${bearer} ${"x".repeat(1500)}`)}); process.exit(1);`);
  try {
    const { session } = await createCliSessionFactory({
      command: process.execPath,
      commandArgs: [stub],
      engine: "agy",
      maxToolTurns: 1,
      timeoutMs: 10_000,
      redactedEnvironmentNames: [tokenEnv]
    })({ cwd: root });
    await assert.rejects(session.prompt("fail"), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /CLI engine exited 1: /);
      assert.equal(error.message.includes(bearer), false);
      assert.ok(error.message.length < 1_200);
      return true;
    });
  } finally {
    delete process.env[tokenEnv];
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI stdout cap counts multibyte replies and quiesces descendants", async (context) => {
  if (!requirePosixProcessGroups(context)) return;
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-cli-output-cap-"));
  const pidFile = path.join(root, "descendant.pid");
  const engine = path.join(root, "overflow.mjs");
  await writeFile(engine, [
    "import { spawn } from 'node:child_process';",
    "import { writeFileSync } from 'node:fs';",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify("process.on('SIGTERM', () => undefined); setInterval(() => undefined, 1000)")}], { stdio: 'ignore' });`,
    `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
    "process.on('SIGTERM', () => undefined);",
    "const output = '🐙'.repeat(2 * 1024 * 1024);",
    "process.stdout.write(output); process.stderr.write(output);",
    "setInterval(() => undefined, 1000);"
  ].join("\n"));
  try {
    const child = spawnEngine({
      command: process.execPath, commandArgs: [engine], engine: "agy", maxToolTurns: 1, timeoutMs: 10_000
    }, "overflow", { cwd: root }, undefined);
    await assert.rejects(readChild(child, 10_000, []), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, `CLI engine output exceeded ${CLI_ENGINE_MAX_OUTPUT_BYTES} bytes`);
      assert.ok(error.message.length < 120);
      return true;
    });
    const descendantPid = Number(await readFile(pidFile, "utf8"));
    assert.throws(() => process.kill(descendantPid, 0), { code: "ESRCH" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("codex NDJSON retention survives a large tool result and keeps reply plus terminal usage", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-codex-stream-retention-"));
  const stub = path.join(root, "codex.mjs");
  const secret = "stream-secret-must-be-redacted";
  await writeFile(stub, [
    `process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "command_execution", output: ${JSON.stringify("x".repeat(2 * CLI_ENGINE_MAX_OUTPUT_BYTES))} } }) + "\\n");`,
    `process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: ${JSON.stringify(`answer ${secret}`)} } }) + "\\n");`,
    `process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 11, cached_input_tokens: 3, output_tokens: 2, reasoning_output_tokens: 1 } }) + "\\n");`
  ].join("\n"));
  try {
    const child = spawn(process.execPath, [stub], { stdio: ["ignore", "pipe", "pipe"] });
    const output = await readChild(child, 10_000, [secret], { retainNdjson: "codex" });
    assert.match(output, /answer \[REDACTED\]/u);
    assert.equal(output.includes(secret), false);
    assert.match(output, /turn\.completed/u);
    assert.match(output, /command_execution/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("codex child stdin EPIPE does not replace the engine exit diagnostic", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-cli-epipe-"));
  const stub = path.join(root, "early-exit-engine.mjs");
  await writeFile(stub, "process.exit(1);");
  try {
    const child = spawnEngine({
      command: process.execPath,
      commandArgs: [stub],
      engine: "codex",
      maxToolTurns: 1,
      timeoutMs: 10_000
    }, "fail", { cwd: root }, undefined);
    await assert.rejects(readChild(child, 10_000, []), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /CLI engine exited 1/);
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("protected host control variables never reach Codex, Grok, or AGY children", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-cli-control-token-"));
  const controlEnv = "DAIMON_HOST_CONTROL_TOKEN_CANARY";
  const controlToken = "must-never-reach-engine";
  const unrelatedEnv = "DAIMON_UNRELATED_HOST_CANARY";
  const modelEnv = "OPENAI_API_KEY";
  process.env[controlEnv] = controlToken;
  process.env[unrelatedEnv] = "must-never-reach-engine";
  process.env[modelEnv] = "must-never-reach-engine";
  const probe = path.join(root, "probe.mjs");
  await writeFile(probe, `#!/usr/bin/env node\nconst text = [process.env.${controlEnv} ?? "absent", process.env.${unrelatedEnv} ?? "absent", process.env.${modelEnv} ?? "absent", process.env.CODEX_HOME ?? process.env.GROK_HOME ?? process.env.ANTIGRAVITY_CLI_HOME ?? "missing", process.env.DAIMON_WAKE_ID ?? "absent"].join("|"); const stream = (value) => [{ type: "assistant", parent_tool_use_id: null, session_id: "fake", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: value }] } }, { type: "result", subtype: "success", is_error: false, result: value, stop_reason: "end_turn", session_id: "fake" }].map(JSON.stringify).join("\\n"); const codex = (value) => [{ type: "item.completed", item: { type: "agent_message", text: value } }, { type: "turn.completed" }].map(JSON.stringify).join("\\n"); const agy = (value) => JSON.stringify({ event: "result", result: { conversation_id: "fake", status: "SUCCESS", response: value, num_turns: 1, usage: { input_tokens: 11, output_tokens: 2, thinking_tokens: 1, cache_read_tokens: 0, total_tokens: 13 } } }); process.stdout.write(process.argv.includes("--single") ? stream(text) : process.argv.includes("--output-format") ? agy(text) : process.argv.includes("--json") ? codex(text) : text);`);
  await chmod(probe, 0o700);
  try {
    for (const engine of ["codex", "grok", "agy"] as const) {
      const engineHomePath = path.join(root, engine, engine === "codex" ? ".codex" : engine === "grok" ? ".grok" : ".antigravity-cli");
      const options = engine === "agy"
        ? { engine, command: probe, commandArgs: [], maxToolTurns: 1, timeoutMs: 10_000 as const, redactedEnvironmentNames: [controlEnv], engineHomePath }
        : { engine, command: probe, commandArgs: [], maxToolTurns: 1, timeoutMs: 10_000, redactedEnvironmentNames: [controlEnv], engineHomePath };
      const { session } = await createCliSessionFactory(options)({ cwd: root, runtimeHomePath: path.join(root, engine) });
      session.bindWake?.({ id: "moltnet:msg_1", kind: "message", text: "probe" });
      let output = "";
      session.subscribe((event) => {
        if (event.type === "turn_end" && "content" in event.message && Array.isArray(event.message.content)) {
          output = event.message.content.filter((item) => item.type === "text").map((item) => item.text).join("");
        }
      });
      await session.prompt("probe");
      assert.equal(output, `absent|absent|absent|${engineHomePath}|moltnet:msg_1`);
      await session.disposeAsync?.();
    }
  } finally {
    delete process.env[controlEnv];
    delete process.env[unrelatedEnv];
    delete process.env[modelEnv];
    await rm(root, { recursive: true, force: true });
  }
  void context;
});

test("disposing a CLI session kills a stubborn process group before returning", async (context) => {
  if (!requirePosixProcessGroups(context)) return;
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-cli-stop-"));
  const stubborn = path.join(root, "stubborn.mjs");
  const ready = path.join(root, "ready");
  await writeFile(stubborn, `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs'; process.on('SIGTERM', () => undefined); writeFileSync(${JSON.stringify(ready)}, 'ready'); setInterval(() => undefined, 1000);`);
  await chmod(stubborn, 0o700);
  try {
    const { session } = await createCliSessionFactory({
      engine: "agy", command: stubborn, commandArgs: [], maxToolTurns: 1, timeoutMs: 10_000
    })({ cwd: root });
    const running = session.prompt("hold");
    void running.catch(() => undefined);
    await waitForFile(ready);
    const started = Date.now();
    await session.disposeAsync?.();
    assert.ok(Date.now() - started >= 900);
    await assert.rejects(running);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("disposing during MCP setup prevents an engine process from spawning", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-cli-mcp-cancel-"));
  const marker = path.join(root, "engine-started");
  const engine = path.join(root, "engine.mjs");
  await writeFile(engine, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "started");`);
  try {
    let session: Awaited<ReturnType<ReturnType<typeof createCliSessionFactory>>>["session"] | undefined;
    const factory = createCliSessionFactory({
      command: process.execPath, commandArgs: [engine], engine: "codex", maxToolTurns: 1, timeoutMs: 10_000,
      onToolsMounted: () => session?.dispose()
    });
    ({ session } = await factory({ cwd: root }));
    await assert.rejects(session.prompt("cancel"), /cancelled|disposed/);
    await session.disposeAsync?.();
    await assert.rejects(access(marker));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("disposing from a Server.prototype.listen interleaving never leaves an MCP listener", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-cli-mcp-listen-race-"));
  const prototype = Server.prototype as unknown as {
    listen: (this: Server, ...args: unknown[]) => Server;
  };
  const originalListen = prototype.listen;
  let activeSession: Awaited<ReturnType<ReturnType<typeof createCliSessionFactory>>>["session"] | undefined;
  let intercepted: Server | undefined;
  prototype.listen = function (this: Server, ...args: unknown[]): Server {
    intercepted = this;
    activeSession?.dispose();
    return originalListen.apply(this, args);
  };
  try {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const { session } = await createCliSessionFactory({
        command: process.execPath, commandArgs: ["-e", "process.exit(0)"], engine: "codex", maxToolTurns: 1, timeoutMs: 10_000
      })({ cwd: root });
      activeSession = session;
      intercepted = undefined;
      await assert.rejects(session.prompt(`cancel-${attempt}`), /cancelled|disposed/);
      await session.disposeAsync?.();
      const mounted = intercepted as Server | undefined;
      assert.ok(mounted, "MCP listener was not intercepted");
      assert.equal(mounted.listening, false);
      assert.equal(mounted.address(), null);
    }
  } finally {
    prototype.listen = originalListen;
    await rm(root, { recursive: true, force: true });
  }
});

test("disposing during Grok registration terminates setup before the engine starts", async (context) => {
  if (!requirePosixProcessGroups(context)) return;
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-cli-grok-cancel-"));
  const ready = path.join(root, "add-ready");
  const marker = path.join(root, "engine-started");
  const grok = path.join(root, "grok.mjs");
  await writeFile(grok, `import { writeFileSync } from "node:fs"; const args = process.argv.slice(2); if (args.includes("add")) { writeFileSync(${JSON.stringify(ready)}, "ready"); process.on("SIGTERM", () => undefined); setInterval(() => undefined, 1000); } else if (args.includes("remove")) process.exit(0); else writeFileSync(${JSON.stringify(marker)}, "started");`);
  try {
    const { session } = await createCliSessionFactory({
      command: process.execPath, commandArgs: [grok], engine: "grok", maxToolTurns: 1, timeoutMs: 10_000
    })({ cwd: root });
    const pending = session.prompt("cancel");
    void pending.catch(() => undefined);
    await waitForFile(ready);
    await session.disposeAsync?.();
    await assert.rejects(pending);
    await assert.rejects(access(marker));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function waitForFile(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { await access(filePath); return; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
  throw new Error("child did not become ready");
}

function requirePosixProcessGroups(context: { skip(message?: string): void }): boolean {
  if (process.platform !== "win32") return true;
  context.skip("detached process groups are not available on Windows");
  return false;
}

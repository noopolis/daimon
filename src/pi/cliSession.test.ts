import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { PiHarnessAdapter, type PiSessionFactory } from "./piHarness.js";
import { createCliSessionFactory, readChild, renderCodexArgs, spawnEngine } from "./cliSession.js";
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
    `process.stdout.write(JSON.stringify({ listed: listed.tools.map((tool) => tool.name), observe, act, refused, bearer: process.env.${tokenEnv} ?? null, argv: process.argv.join('\\n'), prompt }));`,
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
      toolAccess: "none",
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

import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { grokSandboxProtectedPaths, startOrganizationRuntimeEngine } from "./engineDispatcher.js";
import { AGY_SUBSCRIPTION_REALM, GROK_SUBSCRIPTION_REALM } from "./contractManifest.js";
import type { EngineBrokerTurnClient } from "./engineBrokerControlClient.js";
import { ORGANIZATION_RUNTIME_VERSION, type OrganizationRuntimeAgentConfig } from "./organizationRuntime.js";

const rootConfig = (root: string, kind: OrganizationRuntimeAgentConfig["engine"]["kind"]): OrganizationRuntimeAgentConfig => ({
  id: `${kind}-agent`, name: kind, instructions: "Reply.",
  workspacePath: path.join(root, "workspace", kind), runtimeHomePath: path.join(root, "runtime", kind),
  engine: { kind }
});

test("Grok sandbox protects the shared realm and every peer agent root", () => {
  const current = rootConfig("/private/org", "grok");
  const peer: OrganizationRuntimeAgentConfig = {
    ...rootConfig("/private/org", "codex"),
    id: "peer-agent"
  };
  const agy: OrganizationRuntimeAgentConfig = {
    ...rootConfig("/private/org", "agy"),
    id: "secure-agent"
  };
  const acceptanceStore = "/private/org/shared/wake-acceptance";
  assert.deepEqual(grokSandboxProtectedPaths(current.id, [current, peer, agy], [acceptanceStore]), [
    GROK_SUBSCRIPTION_REALM.bootstrapMountPath,
    GROK_SUBSCRIPTION_REALM.durableMountPath,
    AGY_SUBSCRIPTION_REALM.unlockMountPath,
    AGY_SUBSCRIPTION_REALM.durableMountPath,
    acceptanceStore,
    peer.runtimeHomePath,
    peer.workspacePath,
    agy.runtimeHomePath,
    agy.workspacePath
  ]);
});

test("production dispatcher starts each closed engine intent through Daimon", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-dispatcher-"));
  const priorPath = process.env.PATH;
  const priorRun = process.env.NOOPOLIS_RUN_ID;
  const priorLedger = process.env.DAIMON_TURN_USAGE_LEDGER_PATH;
  const ledger = path.join(root, "usage.jsonl");
  const stub = `#!/usr/bin/env node\nconst args = process.argv.slice(2); const text = process.env.DAIMON_DISPATCH_CONTROL ?? "absent"; const stream = (value) => [{ type: "assistant", parent_tool_use_id: null, session_id: "fake", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: value }] } }, { type: "result", subtype: "success", is_error: false, result: value, stop_reason: "end_turn", session_id: "fake" }].map(JSON.stringify).join("\\n"); const codex = (value) => [{ type: "item.completed", item: { type: "agent_message", text: value } }, { type: "turn.completed", usage: { input_tokens: 11, cached_input_tokens: 3, cache_write_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 1 } }].map(JSON.stringify).join("\\n"); const agy = (value) => JSON.stringify({ event: "result", result: { conversation_id: "fake", status: "SUCCESS", response: value, num_turns: 1, usage: { input_tokens: 11, output_tokens: 2, thinking_tokens: 1, cache_read_tokens: 0, total_tokens: 13 } } }); if (args.includes("mcp")) process.stdout.write("ok"); else process.stdout.write(args.includes("--single") ? stream(text) : args.includes("--output-format") ? agy(text) : args.includes("--json") ? codex(text) : text);`;
  try {
    for (const name of ["codex", "grok", "agy"]) {
      const file = path.join(root, name);
      await writeFile(file, stub);
      await chmod(file, 0o700);
      await seedAuth(root, name as "codex" | "grok" | "agy");
    }
    process.env.PATH = `${root}${path.delimiter}${priorPath ?? ""}`;
    process.env.NOOPOLIS_RUN_ID = "dispatcher-test";
    process.env.DAIMON_TURN_USAGE_LEDGER_PATH = ledger;
    process.env.DAIMON_DISPATCH_CONTROL = "host-only";
    for (const kind of ["codex", "grok", "agy"] as const) {
      const handle = await startOrganizationRuntimeEngine(rootConfig(root, kind), "DAIMON_DISPATCH_CONTROL", undefined, kind === "agy" ? "unix:path=/private/realm/bus" : undefined);
      const result = await handle.wake({ id: `${kind}-wake`, kind: "manual", text: "probe" });
      assert.equal(result.text, "absent");
      await handle.stop();
    }
    const metered = (await readFile(ledger, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(metered.map(({ engine, wake, total }) => ({ engine, wake, total })), [
      { engine: "codex", wake: "codex-wake", total: 13 },
      { engine: "agy", wake: "agy-wake", total: 13 }
    ], "Codex and AGY carry advisory session meters while unbrokered Grok remains unchanged");
  } finally {
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
    if (priorRun === undefined) delete process.env.NOOPOLIS_RUN_ID;
    else process.env.NOOPOLIS_RUN_ID = priorRun;
    if (priorLedger === undefined) delete process.env.DAIMON_TURN_USAGE_LEDGER_PATH;
    else process.env.DAIMON_TURN_USAGE_LEDGER_PATH = priorLedger;
    delete process.env.DAIMON_DISPATCH_CONTROL;
    await rm(root, { recursive: true, force: true });
  }
});

test("engine dispatcher threads a declared memory bank into the Pi harness", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-dispatcher-memory-"));
  const priorPath = process.env.PATH;
  const priorRun = process.env.NOOPOLIS_RUN_ID;
  const stub = `#!/usr/bin/env node\nconst args = process.argv.slice(2); const text = process.env.DAIMON_DISPATCH_CONTROL ?? "absent"; const stream = (value) => [{ type: "assistant", parent_tool_use_id: null, session_id: "fake", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: value }] } }, { type: "result", subtype: "success", is_error: false, result: value, stop_reason: "end_turn", session_id: "fake" }].map(JSON.stringify).join("\\n"); const codex = (value) => [{ type: "item.completed", item: { type: "agent_message", text: value } }, { type: "turn.completed", usage: { input_tokens: 11, cached_input_tokens: 3, cache_write_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 1 } }].map(JSON.stringify).join("\\n"); const agy = (value) => JSON.stringify({ event: "result", result: { conversation_id: "fake", status: "SUCCESS", response: value, num_turns: 1, usage: { input_tokens: 11, output_tokens: 2, thinking_tokens: 1, cache_read_tokens: 0, total_tokens: 13 } } }); if (args.includes("mcp")) process.stdout.write("ok"); else process.stdout.write(args.includes("--single") ? stream(text) : args.includes("--output-format") ? agy(text) : args.includes("--json") ? codex(text) : text);`;
  try {
    const file = path.join(root, "codex");
    await writeFile(file, stub);
    await chmod(file, 0o700);
    await seedAuth(root, "codex");
    process.env.PATH = `${root}${path.delimiter}${priorPath ?? ""}`;
    process.env.NOOPOLIS_RUN_ID = "dispatcher-memory-test";
    process.env.DAIMON_DISPATCH_CONTROL = "host-only";
    const memoryRuntimeHomePath = path.join(root, "memory-bank");
    const config: OrganizationRuntimeAgentConfig = { ...rootConfig(root, "codex"), memory: { runtimeHomePath: memoryRuntimeHomePath, tokenBudget: 500 } };
    const handle = await startOrganizationRuntimeEngine(config, "DAIMON_DISPATCH_CONTROL");
    await handle.wake({ id: "memory-wake", kind: "manual", text: "probe" });
    await handle.stop();
    // createMemoryRuntime (in-process, via PiHarnessAdapter) provisions this
    // SQLite index synchronously at the *configured* memory.runtimeHomePath,
    // not the agent's own runtimeHomePath — the observable proof the option
    // actually reached the harness rather than being silently dropped.
    await access(path.join(memoryRuntimeHomePath, "memory", "index.sqlite"));
  } finally {
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
    if (priorRun === undefined) delete process.env.NOOPOLIS_RUN_ID;
    else process.env.NOOPOLIS_RUN_ID = priorRun;
    delete process.env.DAIMON_DISPATCH_CONTROL;
    await rm(root, { recursive: true, force: true });
  }
});

test("production dispatcher waits for active engine quiescence during shutdown", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-dispatcher-stop-"));
  const priorPath = process.env.PATH;
  const priorRun = process.env.NOOPOLIS_RUN_ID;
  const ready = path.join(root, "ready");
  const agy = path.join(root, "agy");
  await writeFile(agy, `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs"; if (process.argv.some((value) => value.includes("hold"))) { writeFileSync(${JSON.stringify(ready)}, "ready"); process.on("SIGTERM", () => undefined); setInterval(() => undefined, 1000); }`);
  await chmod(agy, 0o700);
  await seedAuth(root, "agy");
  try {
    process.env.PATH = `${root}${path.delimiter}${priorPath ?? ""}`;
    process.env.NOOPOLIS_RUN_ID = "dispatcher-stop-test";
    const handle = await startOrganizationRuntimeEngine(rootConfig(root, "agy"), "DAIMON_DISPATCH_CONTROL", undefined, "unix:path=/private/realm/bus");
    const pending = handle.wake({ id: "hold", kind: "manual", text: "hold" });
    void pending.catch(() => undefined);
    await waitForFile(ready);
    const started = Date.now();
    await handle.stop();
    assert.ok(Date.now() - started >= 900);
    await assert.rejects(pending);
  } finally {
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
    if (priorRun === undefined) delete process.env.NOOPOLIS_RUN_ID;
    else process.env.NOOPOLIS_RUN_ID = priorRun;
    await rm(root, { recursive: true, force: true });
  }
});

test("production Grok dispatcher routes every wake through the broker without agent credentials", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-dispatcher-grok-realm-"));
  const priorPath = process.env.PATH;
  const priorRun = process.env.NOOPOLIS_RUN_ID;
  const executable = path.join(root, "grok");
  const config = rootConfig(root, "grok") as OrganizationRuntimeAgentConfig & { engine: { kind: "grok" } };
  const auth = path.join(config.runtimeHomePath, ".grok", "auth.json");
  let turns = 0;
  try {
    await mkdir(path.dirname(auth), { recursive: true, mode: 0o700 });
    await mkdir(config.workspacePath, { recursive: true, mode: 0o700 });
    await writeFile(executable, "#!/usr/bin/env node\nconst a=process.argv.slice(2); const s=v=>[{type:'assistant',parent_tool_use_id:null,session_id:'x',message:{role:'assistant',stop_reason:'end_turn',content:[{type:'text',text:v}]}},{type:'result',subtype:'success',is_error:false,result:v,stop_reason:'end_turn',session_id:'x'}].map(JSON.stringify).join('\\n'); if(a.includes('mcp')) process.stdout.write('ok'); else process.stdout.write(s('leased'));", { mode: 0o700 });
    await chmod(executable, 0o700);
    process.env.PATH = `${root}${path.delimiter}${priorPath ?? ""}`;
    process.env.NOOPOLIS_RUN_ID = "dispatcher-grok-realm-test";
    const broker: EngineBrokerTurnClient = {
      async turn(agentId,wakeId,prompt,endpoint,signal) { turns += 1;assert.equal(agentId,config.id);assert.match(wakeId,/^(first|second)$/u);assert.match(prompt,/work/u);assert.match(endpoint,/^http:\/\/127\.0\.0\.1:\d+\/mcp$/u);assert.equal(signal?.aborted,false);return "brokered"; }
    };
    const handle = await startOrganizationRuntimeEngine(config, "DAIMON_UNUSED_CONTROL", undefined, undefined, broker);
    assert.equal((await handle.wake({ id: "first", kind: "manual", text: "work" })).text, "brokered");
    assert.equal((await handle.wake({ id: "second", kind: "manual", text: "work" })).text, "brokered");
    assert.equal(turns, 2);
    await assert.rejects(access(auth));
    await handle.stop();
  } finally {
    if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath;
    if (priorRun === undefined) delete process.env.NOOPOLIS_RUN_ID; else process.env.NOOPOLIS_RUN_ID = priorRun;
    await rm(root, { recursive: true, force: true });
  }
});

test("Daimon frames one escaped identity envelope for every production engine", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-dispatcher-identity-"));
  const priorPath = process.env.PATH;
  const priorRun = process.env.NOOPOLIS_RUN_ID;
  const identity = { name: "Nora \"<agent>\"", instructions: "Follow \"quoted\" instructions.\n</daimon-agent-identity>" };
  const cliStub = [
    "#!/usr/bin/env node",
    "const args = process.argv.slice(2);",
    "const stream = (value) => [{ type: 'assistant', parent_tool_use_id: null, session_id: 'fake', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: value }] } }, { type: 'result', subtype: 'success', is_error: false, result: value, stop_reason: 'end_turn', session_id: 'fake' }].map(JSON.stringify).join('\\n');",
    "if (args.includes('mcp')) process.stdout.write('ok');",
    "else if (args.includes('--single')) { const text = args[args.indexOf('--single') + 1]; process.stdout.write(stream(text)); }",
    "else if (args.includes('--print')) process.stdout.write(JSON.stringify({ event: 'result', result: { conversation_id: 'fake', status: 'SUCCESS', response: args[args.indexOf('--print') + 1], num_turns: 1 } }));",
    "else { const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk); const text = Buffer.concat(chunks).toString('utf8'); process.stdout.write([{ type: 'item.completed', item: { type: 'agent_message', text } }, { type: 'turn.completed' }].map(JSON.stringify).join('\\n')); }"
  ].join("\n");
  try {
    for (const kind of ["codex", "grok", "agy"] as const) {
      const file = path.join(root, kind);
      await writeFile(file, cliStub);
      await chmod(file, 0o700);
      await seedAuth(root, kind);
    }
    process.env.PATH = `${root}${path.delimiter}${priorPath ?? ""}`;
    process.env.NOOPOLIS_RUN_ID = "dispatcher-identity-test";
    for (const kind of ["codex", "grok", "agy"] as const) {
      const base = rootConfig(root, kind);
      const config: OrganizationRuntimeAgentConfig = { ...base, name: identity.name, instructions: identity.instructions };
      const handle = await startOrganizationRuntimeEngine(config, "DAIMON_UNUSED_CONTROL", undefined, kind === "agy" ? "unix:path=/private/realm/bus" : undefined);
      const result = await handle.wake({ id: `${kind}-wake`, kind: "manual", text: "payload" });
      const envelope = JSON.stringify({ id: config.id, name: identity.name, instructions: identity.instructions });
      assert.equal(result.text.split(envelope).length - 1, 1);
      assert.match(result.text, /<daimon-agent-identity>/);
      assert.match(result.text, /Colleagues only hear you when you call moltnet_send/u);
      assert.match(result.text, /Do not seek transport credentials or invoke a transport CLI/u);
      assert.match(result.text, /payload/);
      await handle.stop();
    }
  } finally {
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
    if (priorRun === undefined) delete process.env.NOOPOLIS_RUN_ID;
    else process.env.NOOPOLIS_RUN_ID = priorRun;
    await rm(root, { recursive: true, force: true });
  }
});

test("a Codex wake whose reported usage crosses the configured per-wake token ceiling fails the wake with a named bound", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-dispatcher-codex-ceiling-"));
  const priorCeiling = process.env.DAIMON_CODEX_WAKE_TOKEN_CEILING;
  const priorPath = process.env.PATH;
  const priorRun = process.env.NOOPOLIS_RUN_ID;
  const config = rootConfig(root, "codex");
  const stub = path.join(root, "codex");
  await writeFile(stub, [
    "#!/usr/bin/env node",
    "if (!process.argv.includes('exec')) { process.stdout.write('codex-cli 0.0.0-test\\n'); process.exit(0); }",
    `process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "over budget" } }) + "\\n");`,
    `process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 4000, cached_input_tokens: 0, output_tokens: 1000, reasoning_output_tokens: 0 } }) + "\\n");`
  ].join("\n"));
  await chmod(stub, 0o700);
  await seedAuth(root, "codex");
  try {
    process.env.PATH = `${root}${path.delimiter}${priorPath ?? ""}`;
    process.env.NOOPOLIS_RUN_ID = "dispatcher-codex-ceiling-test";
    process.env.DAIMON_CODEX_WAKE_TOKEN_CEILING = "1000";
    const handle = await startOrganizationRuntimeEngine({ ...config, engine: { kind: "codex" } }, "DAIMON_UNUSED_CONTROL");
    await assert.rejects(handle.wake({ id: "codex-over-budget-wake", kind: "manual", text: "probe" }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /1000-token per-wake ceiling/u);
      assert.match(error.message, /5000 tokens/u);
      return true;
    });
    await handle.stop();
  } finally {
    if (priorCeiling === undefined) delete process.env.DAIMON_CODEX_WAKE_TOKEN_CEILING;
    else process.env.DAIMON_CODEX_WAKE_TOKEN_CEILING = priorCeiling;
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
    if (priorRun === undefined) delete process.env.NOOPOLIS_RUN_ID;
    else process.env.NOOPOLIS_RUN_ID = priorRun;
    await rm(root, { recursive: true, force: true });
  }
});

test("a Codex wake that runs past the configured wall-clock bound fails the wake naming that bound", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-dispatcher-codex-timeout-"));
  const priorTimeout = process.env.DAIMON_CODEX_WAKE_TIMEOUT_MS;
  const priorPath = process.env.PATH;
  const priorRun = process.env.NOOPOLIS_RUN_ID;
  const config = rootConfig(root, "codex");
  const stub = path.join(root, "codex");
  // Never emits turn.completed: the wall-clock bound is what has to interrupt it.
  await writeFile(stub, [
    "#!/usr/bin/env node",
    "if (!process.argv.includes('exec')) { process.stdout.write('codex-cli 0.0.0-test\\n'); process.exit(0); }",
    "setInterval(() => undefined, 1000);"
  ].join("\n"));
  await chmod(stub, 0o700);
  await seedAuth(root, "codex");
  try {
    process.env.PATH = `${root}${path.delimiter}${priorPath ?? ""}`;
    process.env.NOOPOLIS_RUN_ID = "dispatcher-codex-timeout-test";
    process.env.DAIMON_CODEX_WAKE_TIMEOUT_MS = "100";
    const handle = await startOrganizationRuntimeEngine({ ...config, engine: { kind: "codex" } }, "DAIMON_UNUSED_CONTROL");
    await assert.rejects(handle.wake({ id: "codex-hang-wake", kind: "manual", text: "probe" }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /100ms per-wake wall-clock bound/u);
      return true;
    });
    await handle.stop();
  } finally {
    if (priorTimeout === undefined) delete process.env.DAIMON_CODEX_WAKE_TIMEOUT_MS;
    else process.env.DAIMON_CODEX_WAKE_TIMEOUT_MS = priorTimeout;
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
    if (priorRun === undefined) delete process.env.NOOPOLIS_RUN_ID;
    else process.env.NOOPOLIS_RUN_ID = priorRun;
    await rm(root, { recursive: true, force: true });
  }
});

async function waitForFile(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { await access(filePath); return; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
  throw new Error("engine did not become active");
}

async function seedAuth(root: string, kind: "codex" | "grok" | "agy"): Promise<void> {
  const directory = path.join(root, "runtime", kind, kind === "codex" ? ".codex" : kind === "grok" ? ".grok" : ".antigravity-cli");
  await mkdir(path.join(root, "workspace", kind), { recursive: true, mode: 0o700 });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, kind === "agy" ? "antigravity-oauth-token" : "auth.json");
  const credential = kind === "grok"
    ? { "https://auth.x.ai::test": { key: "test-access", refresh_token: "test-refresh", expires_at: "2099-01-01T00:00:00.000Z" } }
    : { tokens: { access_token: "test-access", refresh_token: "test-refresh" } };
  await writeFile(file, JSON.stringify(credential), { mode: 0o600 });
  await chmod(file, 0o600);
}

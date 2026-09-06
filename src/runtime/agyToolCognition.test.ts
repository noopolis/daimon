import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

import { startOrganizationRuntimeEngine } from "./engineDispatcher.js";
import { TURN_USAGE_LEDGER_PATH_ENV, TURN_USAGE_LEDGER_VERSION } from "./turnUsageLedger.js";
import type { OrganizationRuntimeAgentConfig } from "./organizationRuntime.js";

const require_ = createRequire(import.meta.url);
const sdkClient = require_.resolve("@modelcontextprotocol/sdk/client/index.js");
const sdkHttp = require_.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js");

/**
 * A stand-in for the AGY CLI that behaves the way the live binary was measured
 * to behave: it records every invocation, answers `mcp add`/`mcp remove`/
 * `models`/`--version` locally, and on a `--print` turn it actually *connects*
 * to the endpoint it was registered against and lists the tools there. Nothing
 * here fakes the interesting step: the endpoint under test is the real
 * per-wake `StreamableHTTPServerTransport` the session started, reached over
 * loopback by the child process the dispatcher spawned.
 */
const agyStub = (logPath: string, toolsPath: string): string => `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");
if (args[0] !== "--print") process.exit(0);
const lines = readFileSync(${JSON.stringify(logPath)}, "utf8").split("\\n").filter(Boolean).map(JSON.parse);
const added = lines.filter((entry) => entry[0] === "mcp" && entry[1] === "add").at(-1);
if (added === undefined) { process.stderr.write("agy was never registered against an endpoint"); process.exit(3); }
const { Client } = await import(${JSON.stringify(sdkClient)});
const { StreamableHTTPClientTransport } = await import(${JSON.stringify(sdkHttp)});
const client = new Client({ name: "agy-stub", version: "0.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(added.at(-1))));
const listed = await client.listTools();
await client.close();
// This agent has a mounted moltnet_send tool, so its terminal reply is
// always blanked by Defect 3 (piAgentHandle.ts). Prove tool visibility
// through a side channel independent of that blanked terminal text.
writeFileSync(${JSON.stringify(toolsPath)}, listed.tools.map((tool) => tool.name).sort().join(","));
process.stdout.write(JSON.stringify({
  event: "result",
  result: {
    conversation_id: "stub", status: "SUCCESS",
    response: listed.tools.map((tool) => tool.name).sort().join(","),
    num_turns: 1,
    usage: { input_tokens: 44937, output_tokens: 444, thinking_tokens: 305, cache_read_tokens: 0, total_tokens: 45381 }
  }
}));
`;

const seedAgyAuth = async (root: string): Promise<void> => {
  const directory = path.join(root, "runtime", "agy", ".antigravity-cli");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(path.dirname(directory), 0o700);
  const handle = await open(path.join(directory, "antigravity-oauth-token"), "w", 0o600);
  try { await handle.writeFile("stub"); } finally { await handle.close(); }
};

const agyAgent = (root: string): OrganizationRuntimeAgentConfig => ({
  id: "agy-agent",
  name: "agy",
  instructions: "Reply.",
  workspacePath: path.join(root, "workspace", "agy"),
  runtimeHomePath: path.join(root, "runtime", "agy"),
  engine: { kind: "agy" },
  moltnet: {
    cliPath: "/usr/local/bin/moltnet",
    configPath: path.join(root, "workspace", "agy", ".moltnet", "config.json"),
    networks: [{ id: "news", rooms: ["lobby"], dms: false }]
  }
} as OrganizationRuntimeAgentConfig);

test("an AGY agent reaches Daimon's declared cognition tools over its own MCP endpoint, and the turn is metered", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-agy-tools-"));
  const priorPath = process.env.PATH;
  const priorRun = process.env.NOOPOLIS_RUN_ID;
  const priorLedger = process.env[TURN_USAGE_LEDGER_PATH_ENV];
  const log = path.join(root, "agy-invocations.jsonl");
  const ledger = path.join(root, "usage.jsonl");
  const toolsFile = path.join(root, "tools-seen.txt");
  try {
    const command = path.join(root, "agy");
    await writeFile(command, agyStub(log, toolsFile));
    await chmod(command, 0o700);
    await seedAgyAuth(root);
    process.env.PATH = `${root}${path.delimiter}${priorPath ?? ""}`;
    process.env.NOOPOLIS_RUN_ID = "agy-tools-test";
    process.env[TURN_USAGE_LEDGER_PATH_ENV] = ledger;

    const handle = await startOrganizationRuntimeEngine(agyAgent(root), "DAIMON_AGY_TOOLS_CONTROL", undefined, "unix:path=/private/realm/bus");
    const result = await handle.wake({ id: "wake-1", kind: "manual", text: "probe" });
    await handle.stop();

    // A: the AGY agent can see the Moltnet surface Spawnfile declared for it.
    // Before this change AGY was pinned to `toolAccess: "none"` and this list
    // could not exist at all. This agent has a mounted moltnet_send tool, so
    // its terminal text is unconditionally blanked (Defect 3) — verify tool
    // visibility through the stub's side channel instead of `result.text`.
    const toolsSeen = (await readFile(toolsFile, "utf8")).split(",");
    assert.ok(toolsSeen.includes("moltnet_send"), toolsSeen.join(","));
    assert.equal(result.text, "", "a send-capable agent's terminal text must never be published");

    const invocations: string[][] = (await readFile(log, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
    // B: the endpoint reached AGY through `agy mcp add --type http`, and was
    // withdrawn again once the wake ended.
    const added = invocations.find((entry) => entry[0] === "mcp" && entry[1] === "add");
    assert.deepEqual(added?.slice(0, 5), ["mcp", "add", "--type", "http", "daimon"]);
    assert.match(added?.at(-1) ?? "", /^http:\/\/127\.0\.0\.1:\d+\/mcp$/u);
    assert.ok(invocations.some((entry) => entry[0] === "mcp" && entry[1] === "remove" && entry[2] === "daimon"), JSON.stringify(invocations));

    const turn = invocations.find((entry) => entry[0] === "--print");
    assert.ok(turn?.includes("--dangerously-skip-permissions"), JSON.stringify(turn));
    assert.deepEqual(turn?.slice(2, 4), ["--output-format", "stream-json"]);

    // C: the turn is on the same ledger `spawnfile usage` reads, labelled agy.
    const recorded = JSON.parse((await readFile(ledger, "utf8")).trim());
    assert.deepEqual(recorded, {
      v: TURN_USAGE_LEDGER_VERSION,
      agent: "agy-agent",
      wake: "wake-1",
      engine: "agy",
      at: recorded.at,
      input: 44_937, output: 444, cache_read: 0, cache_write: 0,
      total: 45_381, calls: 1, notional_usd: 0, complete: true,
      outcome: "completed"
    });
  } finally {
    if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath;
    if (priorRun === undefined) delete process.env.NOOPOLIS_RUN_ID; else process.env.NOOPOLIS_RUN_ID = priorRun;
    if (priorLedger === undefined) delete process.env[TURN_USAGE_LEDGER_PATH_ENV];
    else process.env[TURN_USAGE_LEDGER_PATH_ENV] = priorLedger;
    await rm(root, { recursive: true, force: true });
  }
});

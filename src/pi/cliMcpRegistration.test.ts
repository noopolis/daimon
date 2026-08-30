import assert from "node:assert/strict";
import test from "node:test";

import { renderAgyArgs } from "./cliEngineSpawn.js";
import {
  DAIMON_MCP_SERVER_NAME,
  renderAgyMcpAddArgs,
  renderAgyMcpRemoveArgs,
  renderGrokMcpAddArgs,
  renderGrokMcpRemoveArgs
} from "./cliMcpRegistration.js";

test("Grok's registration arguments are unchanged by the AGY generalization", () => {
  assert.deepEqual(renderGrokMcpAddArgs([], "strict", "http://127.0.0.1:1/mcp"),
    ["--sandbox", "strict", "mcp", "add", "--transport", "http", "--scope", "project", "daimon", "http://127.0.0.1:1/mcp"]);
  assert.deepEqual(renderGrokMcpRemoveArgs([], "strict"),
    ["--sandbox", "strict", "mcp", "remove", "--scope", "project", "daimon"]);
});

test("AGY registers the per-wake endpoint as an http server, flags before the name", () => {
  const args = renderAgyMcpAddArgs([], "http://127.0.0.1:54321/mcp");
  assert.deepEqual(args, ["mcp", "add", "--type", "http", DAIMON_MCP_SERVER_NAME, "http://127.0.0.1:54321/mcp"]);
  // `agy mcp add` rejects a flag placed after <name>; the endpoint is last.
  assert.equal(args.indexOf(DAIMON_MCP_SERVER_NAME) > args.indexOf("--type"), true);
  assert.deepEqual(renderAgyMcpRemoveArgs([]), ["mcp", "remove", DAIMON_MCP_SERVER_NAME]);
});

test("AGY always runs headless in the metered stream format with tool approval", () => {
  assert.deepEqual(renderAgyArgs({ timeoutMs: 180_000 }, "PROMPT", false), [
    "--print", "PROMPT",
    "--output-format", "stream-json",
    "--dangerously-skip-permissions",
    "--print-timeout", "180000ms"
  ]);
  assert.deepEqual(renderAgyArgs({}, "PROMPT", true).includes("--sandbox"), true);
  assert.deepEqual(renderAgyArgs({}, "PROMPT", false).includes("--sandbox"), false);
});

test("AGY's permission, output-format and continuity flags are Daimon-owned", () => {
  for (const injected of [
    "--dangerously-skip-permissions",
    "--sandbox",
    "--output-format=text",
    "--print",
    "--continue",
    "-c",
    "--conversation",
    "--mode"
  ]) {
    assert.throws(
      () => renderAgyArgs({ commandArgs: [injected] }, "PROMPT", false),
      /AGY security-boundary arguments are Daimon-owned/u,
      injected
    );
  }
  assert.deepEqual(renderAgyArgs({ commandArgs: ["--effort", "high"] }, "P", false).slice(0, 2), ["--effort", "high"]);
});

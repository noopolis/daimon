import assert from "node:assert/strict";
import test from "node:test";
import { renderGrokBrokerWorkerArgs, renderGrokBrokerWorkerConfig } from "./grokBrokerWorkerConfig.js";
test("worker config uses only named in-memory auth and fixed loopback proxy", () => {
  const config = renderGrokBrokerWorkerConfig("/opt/daimon/bin/grok-broker-auth", 43123);
  assert.match(config, /auth_provider\.daimon/u); assert.match(config, /args = \["--auth-provider"\]/u);assert.match(config, /127\.0\.0\.1:43123/u);assert.match(config,/127\.0\.0\.1:43124\/mcp/u);assert.match(config,/DAIMON_MCP_CAPABILITY/u); assert.doesNotMatch(config, /access_token|refresh_token|auth\.json/u);
  const args = renderGrokBrokerWorkerArgs("/run/worker/prompt", "/workspace"); assert.equal(args.includes("--prompt-file"), true); assert.equal(args.includes("--single"), false);
});

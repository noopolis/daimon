import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { GROK_ENGINE_BROKER } from "../contracts/runtimeContractManifest.js";
import { GROK_BROKER_MODELS, GROK_BROKER_REASONING_EFFORTS } from "./grokBrokerModelPolicy.js";
import { GROK_1_0_34_BUNDLED_SKILLS, grokBrokerWorkerConfigSha256, renderGrokBrokerWorkerArgs, renderGrokBrokerWorkerConfig, renderGrokBrokerWorkerConfigWith } from "./grokBrokerWorkerConfig.js";

const section = (config: string, header: string): string => {
  const start = config.indexOf(`${header}\n`);
  assert.notEqual(start, -1, `missing ${header}`);
  const end = config.indexOf("\n[", start + header.length);
  return config.slice(start, end === -1 ? undefined : end);
};

test("worker config uses only the launcher-set turn capability, the fixed loopback proxy, and the capability-scoped MCP facade", () => {
  const config = renderGrokBrokerWorkerConfig();
  assert.match(section(config, "[model.daimon-broker-grok]"), /base_url = "http:\/\/127\.0\.0\.1:43123\/v1"\nenv_key = "DAIMON_PROVIDER_CAPABILITY"\n/u);
  // Grok 1.0.34 ignores [auth_provider.*] for custom models; a helper table would silently send no bearer.
  assert.doesNotMatch(config, /auth_provider/u);
  assert.equal(section(config, "[mcp_servers.daimon]"), '[mcp_servers.daimon]\nurl = "http://127.0.0.1:43124/mcp"\nbearer_token_env_var = "DAIMON_MCP_CAPABILITY"\n');
  assert.doesNotMatch(config, /access_token|refresh_token|auth\.json/u);
});

test("worker config disables every bundled 1.0.34 skill, workflows, and the per-turn session title request", () => {
  const config = renderGrokBrokerWorkerConfig();
  assert.equal(GROK_1_0_34_BUNDLED_SKILLS.length, 25);
  assert.equal(section(config, "[skills]"), `[skills]\ndisabled = [${GROK_1_0_34_BUNDLED_SKILLS.map((name) => JSON.stringify(name)).join(", ")}]\n`);
  assert.equal(section(config, "[workflows]"), "[workflows]\nenabled = false\n");
  assert.match(section(config, "[models]"), /\nsession_summary = "daimon-session-title-disabled"\n/u);
  assert.equal(section(config, "[model.daimon-session-title-disabled]"), '[model.daimon-session-title-disabled]\nmodel = "disabled"\nbase_url = "http://127.0.0.1:43123/v1"\napi_key = "session-title-disabled"\nmax_retries = 0\nhidden = true\n');
  // The sink carries a static placeholder key only: no env_key, so it can never pick up the turn capability.
  assert.doesNotMatch(section(config, "[model.daimon-session-title-disabled]"), /env_key|DAIMON_/u);
  for (const toggle of ["title_refresh", "telemetry", "session_recap", "turn_summary", "backend_tools", "ask_user_question"]) assert.match(section(config, "[features]"), new RegExp(`\\n${toggle} = false\\n`, "u"));
  assert.match(section(config, "[cli]"), /auto_update = false\nuse_leader = false/u);
});

test("the declared model and effort reach the worker's only model as its sole allowed effort", () => {
  const config = renderGrokBrokerWorkerConfig({ model: "grok-build", reasoningEffort: "medium" });
  assert.match(section(config, "[model.daimon-broker-grok]"), /\nmodel = "grok-build"\n/u);
  assert.match(section(config, "[models]"), /\ndefault = "daimon-broker-grok"\ndefault_reasoning_effort = "medium"\n/u);
  assert.equal(section(config, "[[model.daimon-broker-grok.reasoning_efforts]]"), '[[model.daimon-broker-grok.reasoning_efforts]]\nvalue = "medium"\nlabel = "Medium"\ndefault = true\n');
  assert.equal(config.match(/reasoning_efforts\]\]/gu)?.length, 1);
  assert.match(renderGrokBrokerWorkerConfig(), /\nmodel = "grok-4\.6"\n[\s\S]*value = "low"/u);
  for (const invalid of [{ model: "grok-3" }, { reasoningEffort: "xhigh" }, { model: "grok-4.6", reasoningEffort: "low", extra: true }]) {
    assert.throws(() => renderGrokBrokerWorkerConfig(invalid as never), /model policy/u);
  }
});

test("the manifest pins the sha256 of every renderable worker config", () => {
  for (const model of GROK_BROKER_MODELS) {
    for (const reasoningEffort of GROK_BROKER_REASONING_EFFORTS) {
      const digest = createHash("sha256").update(renderGrokBrokerWorkerConfig({ model, reasoningEffort })).digest("hex");
      assert.equal(grokBrokerWorkerConfigSha256({ model, reasoningEffort }), digest);
      assert.equal(GROK_ENGINE_BROKER.worker.configSha256[model][reasoningEffort], digest, `${model}/${reasoningEffort}`);
    }
  }
});

test("the probe-only renderer refuses non-loopback or injected endpoints", () => {
  const policy = { model: "grok-4.6", reasoningEffort: "low" } as const;
  assert.throws(() => renderGrokBrokerWorkerConfigWith(policy, { proxyPort: 0, mcpUrl: "http://127.0.0.1:1/mcp" }), /invalid/u);
  assert.throws(() => renderGrokBrokerWorkerConfigWith(policy, { proxyPort: 1, mcpUrl: "http://example.com/mcp" }), /invalid/u);
  assert.throws(() => renderGrokBrokerWorkerConfigWith(policy, { proxyPort: 1, mcpUrl: "http://127.0.0.1:1/mcp\"\n[evil]" }), /invalid/u);
  const args = renderGrokBrokerWorkerArgs("/run/worker/prompt", "/workspace");
  assert.equal(args.includes("--prompt-file"), true); assert.equal(args.includes("--single"), false);
});

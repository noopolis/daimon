import assert from "node:assert/strict";
import test from "node:test";

import { GROK_ENGINE_BROKER } from "../contracts/runtimeContractManifest.js";
import { GROK_BROKER_MODELS, GROK_BROKER_REASONING_EFFORTS } from "./grokBrokerModelPolicy.js";
import { GROK_1_0_34_BUNDLED_SKILLS, GROK_SESSION_TITLE_SINK_KEY } from "./grokBrokerWorkerConfig.js";
import { GROK_INFERENCE_CLIENT_MODEL_ID, GROK_INFERENCE_GRANT_ENV, grokInferenceClientConfigSha256, renderGrokInferenceClientConfig, renderProductionGrokInferenceClientConfig } from "./grokInferenceClientConfig.js";

const production = { baseUrl: "http://127.0.0.1:43123/v1", model: "grok-4.6", reasoningEffort: "low", envKey: "DAIMON_INFERENCE_GRANT" } as const;

test("the evaluator client config reaches only the grant proxy through env_key, with no MCP and no credential", () => {
  const config = renderGrokInferenceClientConfig(production);
  assert.match(config, /\[models\]\ndefault = "daimon-inference-grok"\ndefault_reasoning_effort = "low"\nsession_summary = "daimon-session-title-disabled"\n/u);
  assert.match(config, /\[model\.daimon-inference-grok\]\nmodel = "grok-4\.6"\nbase_url = "http:\/\/127\.0\.0\.1:43123\/v1"\nenv_key = "DAIMON_INFERENCE_GRANT"\napi_backend = "chat_completions"\n/u);
  assert.match(config, /\[\[model\.daimon-inference-grok\.reasoning_efforts\]\]\nvalue = "low"\nlabel = "Low"\ndefault = true\n/u);
  assert.equal(config.match(/reasoning_efforts\]\]/gu)?.length, 1);
  assert.doesNotMatch(config, /mcp_servers|auth_provider|access_token|refresh_token/u);
  assert.equal(GROK_INFERENCE_CLIENT_MODEL_ID, "daimon-inference-grok"); assert.equal(GROK_INFERENCE_GRANT_ENV, "DAIMON_INFERENCE_GRANT");
});

test("the evaluator client config mirrors the worker's lean settings and refuses the session title locally", () => {
  const config = renderGrokInferenceClientConfig(production);
  for (const skill of GROK_1_0_34_BUNDLED_SKILLS) assert.ok(config.includes(JSON.stringify(skill)), skill);
  assert.match(config, /\[workflows\]\nenabled = false\n/u); assert.match(config, /\[managed_mcps\]\nenabled = false\n/u); assert.match(config, /auto_update = false/u);
  assert.match(config, new RegExp(`\\[model\\.daimon-session-title-disabled\\]\\nmodel = "disabled"\\nbase_url = "http://127\\.0\\.0\\.1:43123/v1"\\napi_key = "${GROK_SESSION_TITLE_SINK_KEY}"\\nmax_retries = 0\\nhidden = true\\n`, "u"));
  assert.ok(GROK_SESSION_TITLE_SINK_KEY.length < 40, "the placeholder can never pass the proxy bearer shape");
});

test("the manifest pins the sha256 of every production evaluator client config", () => {
  for (const model of GROK_BROKER_MODELS) for (const reasoningEffort of GROK_BROKER_REASONING_EFFORTS) {
    const digest = grokInferenceClientConfigSha256({ ...production, model, reasoningEffort });
    assert.equal(GROK_ENGINE_BROKER.inferenceGrants.client.configSha256[model][reasoningEffort], digest, `${model}/${reasoningEffort}`);
    assert.equal(renderProductionGrokInferenceClientConfig({ model, reasoningEffort }), renderGrokInferenceClientConfig({ ...production, model, reasoningEffort }));
  }
});

test("the evaluator client config refuses non-loopback endpoints, injected keys and undeclared models", () => {
  for (const bad of [
    { ...production, baseUrl: "https://cli-chat-proxy.grok.com/v1" }, { ...production, baseUrl: "http://127.0.0.1:43123/v1\"\nx = 1" }, { ...production, baseUrl: "http://127.0.0.1:99999/v1" },
    { ...production, envKey: "X\"\n[mcp_servers.evil]" }, { ...production, envKey: "lower" },
    { ...production, model: "grok-3" }, { ...production, reasoningEffort: "xhigh" }
  ]) assert.throws(() => renderGrokInferenceClientConfig(bad as typeof production), /invalid Grok inference client configuration/u);
});

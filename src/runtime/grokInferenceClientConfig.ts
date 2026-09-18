import { createHash } from "node:crypto";

import { GROK_ENGINE_BROKER } from "../contracts/runtimeContractManifest.js";
import { GROK_INFERENCE_PROXY_BASE_URL } from "./engineBrokerInferenceProtocol.js";
import { parseGrokBrokerModelPolicy, type GrokBrokerModelPolicy } from "./grokBrokerModelPolicy.js";
import { GROK_SESSION_TITLE_SINK_KEY, GROK_SESSION_TITLE_SINK_MODEL_ID, renderGrokLeanBaseConfig } from "./grokBrokerWorkerConfig.js";

const SPEC = GROK_ENGINE_BROKER.inferenceGrants.client;
/** The evaluator CLI's only model id: Paideia passes `--model daimon-inference-grok`, never a catalog id. */
export const GROK_INFERENCE_CLIENT_MODEL_ID = SPEC.modelId;
/** The environment variable the evaluator CLI reads its grant token from. */
export const GROK_INFERENCE_GRANT_ENV = SPEC.envKey;

export type GrokInferenceClientConfigInput = Readonly<{ baseUrl: string; model: GrokBrokerModelPolicy["model"]; reasoningEffort: GrokBrokerModelPolicy["reasoningEffort"]; envKey: string }>;

/**
 * `config.toml` bytes for an evaluator Grok CLI (Paideia judge or optimizer,
 * uid 2000) that reaches the broker proxy through an inference grant.
 *
 * Paideia writes it into a private `GROK_HOME` (`0700`, uid 2000) and sets the
 * grant token in `envKey`; the CLI never holds the broker credential. Grok
 * 1.0.34 ignores `[auth_provider.*]` helpers for a custom model, so the token
 * travels through `env_key` exactly as the worker's turn capability does.
 *
 * It mirrors the worker renderer's lean settings: every bundled skill
 * disabled, workflows off, the per-call `session_title` request pointed at a
 * hidden model with a placeholder key the proxy refuses before any credential
 * read or upstream call, and the declared effort as the model's single
 * effort. There is no MCP server. `max_retries = 0`: with the default, a
 * refused request (HTTP 503) is retried with backoff past a 45 s bound
 * (live stub capture), so a gate refusal would hang the judge until its own
 * timeout; with it the CLI fails in ~0.35 s and the caller's routed retry
 * policy decides. HTTP 401 is never retried either way. `baseUrl` is the `baseUrl` of the grant (the
 * loopback provider proxy); the manifest pins the sha256 for the production
 * proxy URL and {@link GROK_INFERENCE_GRANT_ENV}.
 *
 * Paideia must also accept the init frame this produces: `apiKeySource` is
 * `"user"` (not `"oauth"`), with `tools: []` and `mcp_servers: []` (live
 * stub capture with the Paideia judge argv).
 */
export function renderGrokInferenceClientConfig(input: GrokInferenceClientConfigInput): string {
  let declared: GrokBrokerModelPolicy;
  try { declared = parseGrokBrokerModelPolicy({ model: input.model, reasoningEffort: input.reasoningEffort }); } catch { throw new TypeError("invalid Grok inference client configuration"); }
  if (declared.model !== input.model || declared.reasoningEffort !== input.reasoningEffort) throw new TypeError("invalid Grok inference client configuration");
  if (typeof input.baseUrl !== "string" || !/^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/v1$/u.test(input.baseUrl) || Number(input.baseUrl.slice(17, -3)) > 65_535) throw new TypeError("invalid Grok inference client configuration");
  if (typeof input.envKey !== "string" || !/^[A-Z][A-Z0-9_]{2,63}$/u.test(input.envKey)) throw new TypeError("invalid Grok inference client configuration");
  const label = `${declared.reasoningEffort[0]!.toUpperCase()}${declared.reasoningEffort.slice(1)}`;
  return [
    renderGrokLeanBaseConfig(),
    "[models]", `default = "${GROK_INFERENCE_CLIENT_MODEL_ID}"`, `default_reasoning_effort = "${declared.reasoningEffort}"`, `session_summary = "${GROK_SESSION_TITLE_SINK_MODEL_ID}"`, "",
    `[model.${GROK_SESSION_TITLE_SINK_MODEL_ID}]`, 'model = "disabled"', `base_url = "${input.baseUrl}"`, `api_key = "${GROK_SESSION_TITLE_SINK_KEY}"`, "max_retries = 0", "hidden = true", "",
    `[model.${GROK_INFERENCE_CLIENT_MODEL_ID}]`, `model = "${declared.model}"`, `base_url = "${input.baseUrl}"`, `env_key = "${input.envKey}"`,
    'api_backend = "chat_completions"', "context_window = 131072", "supports_backend_search = false", "max_retries = 0", "",
    `[[model.${GROK_INFERENCE_CLIENT_MODEL_ID}.reasoning_efforts]]`, `value = "${declared.reasoningEffort}"`, `label = "${label}"`, "default = true", ""
  ].join("\n");
}

export const grokInferenceClientConfigSha256 = (input: GrokInferenceClientConfigInput): string =>
  createHash("sha256").update(renderGrokInferenceClientConfig(input)).digest("hex");

/** The production bytes for a declared model/effort: the grant's proxy URL and the canonical env key. */
export const renderProductionGrokInferenceClientConfig = (policy: GrokBrokerModelPolicy): string =>
  renderGrokInferenceClientConfig({ baseUrl: GROK_INFERENCE_PROXY_BASE_URL, model: policy.model, reasoningEffort: policy.reasoningEffort, envKey: GROK_INFERENCE_GRANT_ENV });

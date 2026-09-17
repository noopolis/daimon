import { createHash } from "node:crypto";
import path from "node:path";

import { GROK_ENGINE_BROKER } from "../contracts/runtimeContractManifest.js";
import { DAIMON_GROK_SYSTEM_PROMPT, GROK_WORKER_MAX_TURNS, GROK_WORKER_TOOL_IDS } from "../contracts/grokWorkerContract.js";
import { parseGrokBrokerModelPolicy, type GrokBrokerModelPolicy } from "./grokBrokerModelPolicy.js";

export { DAIMON_GROK_SYSTEM_PROMPT, GROK_WORKER_MAX_TURNS, GROK_WORKER_TOOL_IDS, GROK_WORKER_VISIBLE_TOOLS } from "../contracts/grokWorkerContract.js";

/**
 * Bundled skills shipped by Grok CLI 1.0.34. Names are version-specific:
 * `[skills] disabled` removed all ~2.1k skill tokens in the P0 matrix, and a
 * CLI bump must re-derive this list rather than inherit it.
 */
export const GROK_1_0_34_BUNDLED_SKILLS = Object.freeze([
  "build-with-ai", "code-review", "create-skill", "create-workflow", "design", "docx", "execute-plan",
  "game-animation-frames", "game-asset-core", "game-character-consistency", "game-tilesets", "game-ui-icons",
  "imagine", "implement", "learn", "long-running-background-tasks", "pdf", "pptx", "pr-babysit",
  "resume-claude", "resume-codex", "resume-cursor", "review", "skill-design-principles", "statusline"
] as const);

/** The worker's only model id; the argv selects it and the proxy never sees another. */
export const GROK_BROKER_WORKER_MODEL_ID = "daimon-broker-grok" as const;

/**
 * Grok 1.0.34 sends a `session_title` model request before every headless
 * turn, and no config key or environment variable disables it
 * (`features.title_refresh` governs only the later refresh; verified against a
 * loopback stub). `[models] session_summary` does select the model it uses, so
 * the title goes to a hidden model whose endpoint is the broker's own provider
 * proxy with a placeholder key that can never be a turn capability (shorter
 * than the 40-character capability alphabet). The proxy refuses it before any
 * capability lookup, isolation guard, credential read, or upstream call, and
 * Grok falls back to the truncated prompt as the title. The endpoint is always
 * listening while a worker runs, so the refusal is bounded by one loopback
 * round trip rather than by a connect timeout, and a prompt-derived title is
 * never delivered anywhere but Daimon's own proxy.
 */
export const GROK_SESSION_TITLE_SINK_MODEL_ID = "daimon-session-title-disabled" as const;
export const GROK_SESSION_TITLE_SINK_KEY = "session-title-disabled" as const;
const renderSessionTitleSink = (proxyPort: number): readonly string[] => [
  `[model.${GROK_SESSION_TITLE_SINK_MODEL_ID}]`, 'model = "disabled"', `base_url = "http://127.0.0.1:${proxyPort}/v1"`, `api_key = "${GROK_SESSION_TITLE_SINK_KEY}"`,
  "max_retries = 0", "hidden = true", ""
];

/**
 * The turn-scoped proxy capability reaches the worker's only model through
 * `env_key`, set by the native launcher. Grok 1.0.34 accepts
 * `[auth_provider.<name>]` tables but never runs the helper for a custom model
 * (verified against a loopback stub: no helper invocation and no Authorization
 * header, with and without `args`, `api_backend`, `model_providers`, or a
 * passwd-home config), while `env_key` attaches the bearer on every request.
 * The capability is exactly as exposed as `DAIMON_MCP_CAPABILITY`: visible to
 * the worker's own tool children, which run network-restricted, and revoked
 * when the turn ends.
 */
export const GROK_BROKER_PROVIDER_CAPABILITY_ENV = "DAIMON_PROVIDER_CAPABILITY" as const;

type WorkerEndpoints = Readonly<{ proxyPort: number; mcpUrl: string }>;
const PRODUCTION_ENDPOINTS: WorkerEndpoints = Object.freeze({
  proxyPort: GROK_ENGINE_BROKER.providerProxy.port,
  mcpUrl: `http://${GROK_ENGINE_BROKER.mcpFacade.host}:${GROK_ENGINE_BROKER.mcpFacade.port}${GROK_ENGINE_BROKER.mcpFacade.path}`
});

/**
 * Sections shared by every Grok worker Daimon configures, broker or direct.
 *
 * Each toggle is either measured (skills −2.1k tokens, workflows −314, the
 * per-turn `session_title` model request) or behavioural hardening that P0
 * showed to be token-neutral and warning-free on 1.0.34.
 */
export const renderGrokLeanBaseConfig = (): string => [
  "[cli]", "auto_update = false", "use_leader = false", "show_tips = false", "",
  "[features]", "telemetry = false", "title_refresh = false", "session_recap = false", "turn_summary = false",
  "repo_status_in_system_prompt = false", "codebase_indexing = false", "backend_tools = false", "ask_user_question = false",
  "image_gen = false", "video_gen = false", "web_fetch = false", "campaigns = false", "managed_config = false", "",
  "[managed_mcps]", "enabled = false", "",
  "[skills]", `disabled = [${GROK_1_0_34_BUNDLED_SKILLS.map((name) => JSON.stringify(name)).join(", ")}]`, "",
  "[workflows]", "enabled = false", ""
].join("\n");

/**
 * The only source of broker worker `config.toml` bytes.
 *
 * Effort is declared here, not on the compiled launcher argv: the argv is one
 * constant for every registration while effort is declared per deployment, and
 * Grok 1.0.34 drops both `--reasoning-effort` and `[models]
 * default_reasoning_effort` unless the model advertises effort support. A
 * one-entry `reasoning_efforts` table makes the declared effort the model's
 * default *and* its closed enum, so it reaches the request body and nothing
 * else can be selected; the proxy then re-verifies it on every body.
 */
export function renderGrokBrokerWorkerConfig(policy: Partial<GrokBrokerModelPolicy> = {}): string {
  return renderGrokBrokerWorkerConfigWith(parseGrokBrokerModelPolicy(policy), PRODUCTION_ENDPOINTS);
}

/** Explicit-endpoint variant for the local live probe; production bytes come only from the function above. */
export function renderGrokBrokerWorkerConfigWith(policy: GrokBrokerModelPolicy, endpoints: WorkerEndpoints): string {
  const declared = parseGrokBrokerModelPolicy(policy);
  const { proxyPort, mcpUrl } = endpoints;
  if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65_535 || !/^http:\/\/127\.0\.0\.1:\d{1,5}\/mcp$/u.test(mcpUrl)) {
    throw new TypeError("invalid Grok broker worker configuration");
  }
  const label = `${declared.reasoningEffort[0]!.toUpperCase()}${declared.reasoningEffort.slice(1)}`;
  return [
    renderGrokLeanBaseConfig(),
    "[models]", `default = "${GROK_BROKER_WORKER_MODEL_ID}"`, `default_reasoning_effort = "${declared.reasoningEffort}"`, `session_summary = "${GROK_SESSION_TITLE_SINK_MODEL_ID}"`, "",
    ...renderSessionTitleSink(proxyPort),
    `[model.${GROK_BROKER_WORKER_MODEL_ID}]`, `model = "${declared.model}"`, `base_url = "http://127.0.0.1:${proxyPort}/v1"`, `env_key = "${GROK_BROKER_PROVIDER_CAPABILITY_ENV}"`,
    'api_backend = "chat_completions"', "context_window = 131072", "supports_backend_search = false", "",
    `[[model.${GROK_BROKER_WORKER_MODEL_ID}.reasoning_efforts]]`, `value = "${declared.reasoningEffort}"`, `label = "${label}"`, "default = true", "",
    "[mcp_servers.daimon]", `url = "${mcpUrl}"`, 'bearer_token_env_var = "DAIMON_MCP_CAPABILITY"', ""
  ].join("\n");
}

export const grokBrokerWorkerConfigSha256 = (policy: Partial<GrokBrokerModelPolicy> = {}): string =>
  createHash("sha256").update(renderGrokBrokerWorkerConfig(policy)).digest("hex");

/**
 * TypeScript mirror of the argv compiled into `native/engineBrokerLauncherCore.inc`.
 * `native/launcherArgv.test.ts` parses the C source and fails on any divergence.
 */
export const renderGrokBrokerWorkerArgs = (promptFile: string, cwd: string): readonly string[] => {
  if (!path.posix.isAbsolute(promptFile) || !path.posix.isAbsolute(cwd)) throw new TypeError("invalid Grok broker worker path");
  return [
    "--sandbox", "daimon-strict", "--always-approve", "--no-subagents", "--prompt-file", promptFile,
    "--no-memory", "--disable-web-search", "--no-plan", "--verbatim",
    "--system-prompt-override", DAIMON_GROK_SYSTEM_PROMPT,
    "--tools", GROK_WORKER_TOOL_IDS.join(","),
    "--max-turns", String(GROK_WORKER_MAX_TURNS),
    "--cwd", cwd, "--output-format", "streaming-messages-json", "--model", GROK_BROKER_WORKER_MODEL_ID
  ];
};

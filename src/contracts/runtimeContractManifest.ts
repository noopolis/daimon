import { WORK_AVAILABILITY_SCHEMA, WORK_BLOCKED_SCHEMA } from "./attentionContract.js";
import { GROK_BROKER_MODELS, GROK_BROKER_REASONING_EFFORTS, GROK_WORKER_MAX_TURNS, GROK_WORKER_TOOL_IDS, GROK_WORKER_VISIBLE_TOOLS } from "./grokWorkerContract.js";
import {
  ORGANIZATION_RUNTIME_CONFIG_SCHEMA,
  ORGANIZATION_RUNTIME_CONFIG_V2_SCHEMA,
  ORGANIZATION_RUNTIME_MAX_AGENTS,
  ORGANIZATION_RUNTIME_MAX_STRING_CODEPOINTS
} from "./organizationRuntimeContract.js";

export const RUNTIME_CONTRACT_MANIFEST_VERSION = "noopolis.daimon.runtime-contract-manifest.v3" as const;
export const ORGANIZATION_RUNTIME_ACTIVITY_V2_VERSION = "noopolis.daimon.organization-runtime-activity.v2" as const;
export const ENGINE_CREDENTIAL_MATERIAL = {
  codex: { sourceSlot: "codex-auth", sourceRelativePath: ".daimon-inbound/codex-auth", destinationRelativePath: ".codex/auth.json", directoryMode: 0o700, fileMode: 0o600 }
} as const;
export const GROK_SUBSCRIPTION_REALM = {
  agentCredentialRelativePath: ".grok/auth.json",
  bootstrapMountPath: "/var/lib/spawnfile/daimon/grok-bootstrap-auth",
  bootstrapSourceSlot: "grok-auth",
  directoryMode: 0o700,
  durableMountPath: "/var/lib/spawnfile/daimon/grok-subscription-realm",
  fileMode: 0o600,
  maxCredentialBytes: 64 * 1024
} as const;
export const GROK_ENGINE_BROKER = {
  nativeAbiVersion: 2,
  nativeExecutablePath: "/opt/daimon/bin/daimon-engine-broker",
  grokExecutablePath: "/usr/local/bin/grok",
  registrationPath: "/etc/daimon-engine-broker/registrations.bin",
  credentialHomePath: "/var/lib/spawnfile/daimon/grok-subscription-realm",
  turnStorePath: "/var/lib/spawnfile/daimon/grok-subscription-realm/turns",
  controlSocketPath: "/run/daimon-engine-broker/control.sock",
  backendSocketPath: "/run/daimon-engine-broker/backend.sock",
  launcherSocketPath: "/run/daimon-engine-broker/launcher.sock",
  serviceConfigPath: "/etc/daimon-engine-broker/service.json",
  providerProxy: { host: "127.0.0.1", port: 43_123 },
  mcpFacade: { host: "127.0.0.1", port: 43_124, path: "/mcp" },
  identities: { organizationUid: 2_000, brokerUid: 2_100, firstWorkerUid: 2_200 },
  grokCliVersion: "1.0.34",
  grokCliBuild: "3736acbc8658",
  grokCliArtifacts: {
    arm64: { url: "https://storage.googleapis.com/grok-build-public-artifacts/cli/grok-1.0.34-linux-aarch64", sha256: "39ab87666877d64ef3a40aa60fbe0c3b6a6acd7001b78fe60e2c76bb6cfc4a94", bytes: 136_090_504 },
    x64: { url: "https://storage.googleapis.com/grok-build-public-artifacts/cli/grok-1.0.34-linux-x86_64", sha256: "be5905e107d2b8b5f3c142d21ecfe4c8fd32a913d2fd551b788707930c4dc80d", bytes: 163_035_648 }
  },
  worker: {
    modelId: "daimon-broker-grok",
    models: GROK_BROKER_MODELS,
    reasoningEfforts: GROK_BROKER_REASONING_EFFORTS,
    defaultModel: "grok-4.6",
    defaultReasoningEffort: "low",
    toolIds: GROK_WORKER_TOOL_IDS,
    visibleTools: GROK_WORKER_VISIBLE_TOOLS,
    maxTurns: GROK_WORKER_MAX_TURNS,
    systemPromptSha256: "2c31c0085a54a4efbf9c0cf0b8124c56e47f38691b7f0c7fa233a74abaa8ddf8",
    // sha256 of `renderGrokBrokerWorkerConfig({ model, reasoningEffort })`, the only accepted config.toml bytes.
    configSha256: {
      "grok-4.6": { low: "eed6a451150a72b2cb528b30c23b3d51c7d3bc38c67a8985d4dcdf956ff214d3", medium: "8850502dbebf8918c5161c63efcc4ccf18719488300f4cec1deceb2c112b451f", high: "3ce44ace503362326b47149b528b942ce638fe146313d62502f248acf9c7333d" },
      "grok-4.5": { low: "7aa13e90b9bc08d1a018f48b7a84de1dab41db586627ee2d5a25f69011ba7e25", medium: "218ba37e57a6f02fa36b265b4e154e68e30bd2d4794feb130cc226fdda7732a9", high: "0bb4ad8bfa5062169b28422d1d534b45420d4e46b1e546bda1c578eb34303646" },
      "grok-build": { low: "83ac7202442286a65c359cc596b0b8db7bc4529ee70e98224f6cd6f66deb6878", medium: "0146313f28739888eb4e861f1bfb285f7ee4e0a9164669256ebdf6492a2790ce", high: "bbe72aaf70c417dc7007823a7e9e1a7d1fa8d57e50bde6f24036083b32bcc859" }
    },
    // Worker `GROK_HOME` layout the broker attests before every turn. The home and
    // its `sessions/` directory are root-owned, worker-group writable and sticky so
    // Grok can create its own state but never replace a root-owned file.
    home: {
      directory: { uid: 0, group: "worker", mode: 0o1771 },
      sessionsDirectory: { relativePath: "sessions", uid: 0, group: "worker", mode: 0o1771 },
      readOnlyFiles: { names: ["config.toml", "managed_config.toml", "requirements.toml", "sandbox.toml", "trusted_folders.toml"], uid: 0, gid: 0, mode: 0o444 },
      sandboxEvents: { relativePath: "sessions/sandbox-events.jsonl", owner: "worker", group: "broker", mode: 0o640 }
    }
  },
  bounds: { promptBytes: 65_536, capabilityBytes: 4_096, capabilityBundleBytes: 8_196, outputBytes: 65_536 },
  // Accounting and limits (P2). The broker is the single sealed usage writer.
  controlProtocolVersion: "noopolis.daimon.engine-broker.v2",
  turnRecordVersions: ["noopolis.daimon.engine-broker-turn.v1", "noopolis.daimon.engine-broker-turn.v2"],
  serviceConfigVersions: ["noopolis.daimon.engine-broker-service.v1", "noopolis.daimon.engine-broker-service.v2"],
  turnLimits: {
    keys: ["maxRequests", "maxTokens", "timeoutMs"],
    v1Defaults: { maxRequests: 32, maxTokens: 300_000, timeoutMs: 240_000 },
    bounds: { maxRequests: [1, GROK_WORKER_MAX_TURNS], maxTokens: [1, 10_000_000], timeoutMs: [1_000, 3_600_000] },
    limitReasons: ["tokens", "requests", "timeout", "none"],
    wakeMayOnlyLower: true,
    tokenCeilingOvershoot: "at-most-one-request",
    maxInFlightRequests: 1,
    // A per-request usage block above this is implausible (beyond the model
    // context window) and treated as invalid rather than added to any total.
    requestUsageMaxTokens: 500_000,
    // A request whose response carries no valid usage is charged this estimate.
    missingUsageEstimate: { inputBytesPerToken: 2, outputTokens: 4_096 }
  },
  wakeLimitEnvironment: { timeoutMs: "DAIMON_ENGINE_WAKE_TIMEOUT_MS", maxTokens: "DAIMON_ENGINE_WAKE_TOKEN_CEILING" },
  // Evaluator inference grants (P2c). Judges and the optimizer (organization uid
  // only, over the control socket) borrow the broker's Grok credential through
  // the provider proxy; they never hold it, and their spend never reaches the
  // subject usage ledger or wake fuse.
  inferenceGrants: {
    requestKinds: ["request_inference_grant", "release_inference_grant"],
    purposes: ["judge", "optimizer"],
    tokenPrefix: "inference_",
    ttlMs: 600_000,
    limits: { maxRequests: 64, maxTokens: 2_000_000 },
    maxLiveGrants: 8,
    maxInFlightRequestsPerGrant: 1,
    // Top-level request members Grok 1.0.34 sends for a Paideia judge/optimizer call
    // (live stub capture); `tools` and `tool_choice` are refused outright.
    bodyMembers: ["messages", "model", "reasoning_effort", "response_format", "stream", "stream_options"],
    messageRoles: ["system", "user", "assistant"],
    failureCodes: ["auth_stale", "grant_limit", "invalid_request", "unavailable"],
    ledgerVersion: "noopolis.daimon.inference-usage.v1",
    ledgerDedupeKey: ["grant", "request"],
    client: {
      modelId: "daimon-inference-grok",
      envKey: "DAIMON_INFERENCE_GRANT",
      // sha256 of `renderGrokInferenceClientConfig` for the production proxy base URL and this env key.
      configSha256: {
        "grok-4.6": { low: "f52819340ec27180e75e0744f1cff9608bd8155a7e03881e24f2add77aaab311", medium: "c7fceb6d10d3c9848a282f80b0cf617172f598489092d5b98cbca098b7335605", high: "d612e5f6595ff76a15c2e33b03a7597086ea3556d760eacbb8eefb234d089fd9" },
        "grok-4.5": { low: "93f3c55b45843862782891cf9fd4e477532e43a4da9e9a09a003f49dc67bb9b3", medium: "b8213c439be60dc0268f5a62242cccd12922ab6e8e8d9212f8325848be76b1f2", high: "5ad93821eac55816afabfd1240b8b78508a707299ff903072c6984f24e2ee334" },
        "grok-build": { low: "1a26f5482aad0b872b6442c2fa026eb47c2113bbc3fdc1c580d5b2671695e3c6", medium: "fcb6f8b673e4179b086aa6cc009b43fda418e353927dd225a5f63facd8b4479a", high: "4bc5c6118612ecb32d8f79ad871ddc69e1b33d63ee3abef6b1b0618709d0cf21" }
      }
    }
  },
  projectionVersion: "noopolis.daimon.grok-broker-projection.v1",
  slotPreflightVersion: "noopolis.daimon.grok-slot-preflight.v1",
  artifacts: {
    sourceSha256: "36f60689f0a8af0e3108f5f53d78ed52b7d4b6f934c75b6184606dfa82bc741e",
    x64Sha256: "36dc76b134eb59cf5a6720b6f94228eb279108e20ea3343fa6efd9ffcb60a4d3",
    arm64Sha256: "c93216cc6fa4ca50dc404fe41e68da9150a869b14f46eb42484ae77c3aa400a9"
  }
} as const;
export const AGY_SUBSCRIPTION_REALM = {
  durableMountPath: "/var/lib/spawnfile/daimon/agy-subscription-realm",
  unlockMountPath: "/var/lib/spawnfile/daimon/agy-unlock-secret",
  unlockSourceSlot: "agy-unlock-secret",
  directoryMode: 0o700,
  fileMode: 0o600,
  maxUnlockBytes: 4_096
} as const;

const text = { type: "string", minLength: 1, maxLength: ORGANIZATION_RUNTIME_MAX_STRING_CODEPOINTS, pattern: "\\S" } as const;
const boundedText = { type: "string", maxLength: ORGANIZATION_RUNTIME_MAX_STRING_CODEPOINTS } as const;
const timestamp = { type: "string", format: "date-time", pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" } as const;
const wakeEvent = { type: "object", additionalProperties: false, required: ["version", "id", "kind", "text", "occurredAt"], properties: { version: { const: "noopolis.daimon.wake.v1" }, id: text, kind: { enum: ["manual", "message", "schedule", "external"] }, text: boundedText, occurredAt: timestamp } } as const;
const wakeResultBase = { version: { const: "noopolis.daimon.wake-result.v1" }, agentId: text, wakeId: text } as const;
const activityItem = { type: "object", additionalProperties: false, required: ["id", "agentId", "kind", "occurredAt"], properties: { id: { type: "string", format: "uuid", pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" }, agentId: text, wakeId: text, kind: { enum: ["wake_started", "wake_completed", "wake_rejected", "wake_aborted", "agent_stopped"] }, occurredAt: timestamp } } as const;

export const RUNTIME_CONTRACT_MANIFEST = {
  version: RUNTIME_CONTRACT_MANIFEST_VERSION,
  consumedConfigFields: ["version", "host.bindHost", "host.port", "host.controlTokenEnv", "agents[].id", "agents[].name", "agents[].instructions", "agents[].workspacePath", "agents[].runtimeHomePath", "agents[].engine.kind", "agents[].engine.model", "agents[].engine.reasoningEffort", "agents[].engine.codexSandbox", "agents[].schedule.kind", "agents[].schedule.interval_ms", "agents[].schedule.cron", "agents[].schedule.timezone", "agents[].schedule.prompt", "agents[].schedule.jitter_seconds", "agents[].mcp", "agents[].moltnet", "agents[].memory", "agents[].attention"],
  organizationRuntimeConfigSchema: ORGANIZATION_RUNTIME_CONFIG_SCHEMA,
  organizationRuntimeConfigV2Schema: ORGANIZATION_RUNTIME_CONFIG_V2_SCHEMA,
  wakeAcceptanceTypes: ["manual", "message", "schedule", "external"],
  deliverySemantics: {
    activeDeliveryIdempotency: "unbounded-until-terminal",
    terminalReceiptHorizon: 2_048,
    recovery: "at-least-once-with-stable-wake-id",
    concurrentSameAgentTurns: false,
    externalEffectsExactlyOnce: false
  },
  attention: { enabledBy: "agents[].attention", defaultMaxBatchMessages: 8, defaultMaxBatchBytes: 12000, idleDispatch: "immediate", busyDispatch: "bounded-pending-message-batch", completion: "explicit-per-delivery", unhandled: "deferred-until-new-input", accounting: "execution-start-reservations" },
  workAvailabilityResponseSchema: WORK_AVAILABILITY_SCHEMA,
  workBlockedSchema: WORK_BLOCKED_SCHEMA,
  supportedEngineKinds: ["agy", "codex", "grok"],
  engineCredentialMaterial: ENGINE_CREDENTIAL_MATERIAL,
  grokSubscriptionRealm: GROK_SUBSCRIPTION_REALM,
  grokEngineBroker: GROK_ENGINE_BROKER,
  agySubscriptionRealm: AGY_SUBSCRIPTION_REALM,
  wakeRequestSchema: { type: "object", additionalProperties: false, required: ["agentId", "event"], properties: { agentId: text, event: wakeEvent } },
  wakeResultSchema: { oneOf: [
    { type: "object", additionalProperties: false, required: ["version", "status", "agentId", "wakeId", "text", "durationMs"], properties: { ...wakeResultBase, status: { const: "completed" }, text: boundedText, durationMs: { type: "integer", minimum: 0 } } },
    { type: "object", additionalProperties: false, required: ["version", "status", "agentId", "wakeId", "code"], properties: { ...wakeResultBase, status: { const: "rejected" }, code: { enum: ["unauthorized", "unknown_agent", "queue_full", "durable_inbox_required"] } } },
    { type: "object", additionalProperties: false, required: ["version", "status", "agentId", "wakeId", "code"], properties: { version: { const: "noopolis.daimon.wake-result.v1" }, status: { const: "rejected" }, agentId: { type: "string", maxLength: ORGANIZATION_RUNTIME_MAX_STRING_CODEPOINTS }, wakeId: { type: "string", maxLength: ORGANIZATION_RUNTIME_MAX_STRING_CODEPOINTS }, code: { const: "invalid_request" } } },
    { type: "object", additionalProperties: false, required: ["version", "status", "agentId", "wakeId", "code"], properties: { ...wakeResultBase, status: { const: "stopped" }, code: { enum: ["host_stopping", "host_stopped", "queued_wake_stopped", "active_wake_aborted"] } } },
    { type: "object", additionalProperties: false, required: ["version", "status", "agentId", "wakeId", "code"], properties: { ...wakeResultBase, status: { const: "failed" }, code: { const: "engine_failed" } } }
  ] },
  healthResponseSchema: { type: "object", additionalProperties: false, required: ["version", "state", "agents"], properties: { version: { const: "noopolis.daimon.organization-runtime-health.v1" }, state: { enum: ["starting", "running", "stopping", "stopped"] }, agents: { type: "array", maxItems: ORGANIZATION_RUNTIME_MAX_AGENTS, items: { type: "object", additionalProperties: false, required: ["agentId", "state"], properties: { agentId: text, state: { enum: ["starting", "running", "stopping", "stopped", "idle", "failed"] } } } } } },
  activityResponseSchema: { type: "object", additionalProperties: false, required: ["version", "items"], properties: { version: { const: "noopolis.daimon.organization-runtime-activity.v1" }, items: { type: "array", maxItems: 100, items: activityItem }, nextCursor: { type: "string", minLength: 1, maxLength: 16, pattern: "^(0|[1-9][0-9]{0,15})$" } } },
  activityV2ResponseSchema: { type: "object", additionalProperties: false, required: ["version", "items"], properties: { version: { const: ORGANIZATION_RUNTIME_ACTIVITY_V2_VERSION }, executions: { type: "array", maxItems: ORGANIZATION_RUNTIME_MAX_AGENTS, items: { type: "object", additionalProperties: false, required: ["agent_id", "execution_id", "state", "delivery_ids"], properties: { agent_id: text, execution_id: { type: "string" }, state: { const: "running" }, delivery_ids: { type: "array", maxItems: 32, items: text } } } }, items: { type: "array", maxItems: 2_112, items: { type: "object", additionalProperties: false, required: ["version", "acceptance_id", "agent_id", "delivery_id", "request_digest", "state", "accepted_at", "updated_at", "active"], properties: { version: { const: "noopolis.daimon.wake-receipt-status.v2" }, acceptance_id: { type: "string" }, agent_id: text, delivery_id: text, request_digest: { type: "string" }, state: { enum: ["accepted", "running", "completed", "failed", "stopped"] }, accepted_at: timestamp, updated_at: timestamp, active: { type: "boolean" }, execution_id: { type: "string" }, deferred: { type: "boolean" }, text: { type: "string", maxLength: 16384 }, queue_position: { type: "integer", minimum: 1 }, code: { enum: ["engine_failed", "host_stopped", "host_stopping", "queue_full", "unknown_agent"] } } } } } }
} as const;

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
      "grok-4.6": { low: "cddeac5f845fa44890679934ad840ca728f5ddcdb0ffdb34a60ed232ef0eda3f", medium: "5a986b87f3888e8b2ec1fe5f7e5361a96494b67bd66a8b9f39836c26f2d602da", high: "e023b566aa28074c544c2f44dad634eca5511a329a2030c2584574e7f419a75a" },
      "grok-4.5": { low: "e22e543e72ea409cfbb3c229ed3bd605252374d28922f6ab05c29f6d590108de", medium: "706a74cb8401b045604078f526b7afcaf292dbe85c8c26f20b533e828f8a3acc", high: "3357ca76540480f4f3f7dc7e4e05ac92df770104a7ecf6d0aa3cb29eb9b6d0b6" },
      "grok-build": { low: "905efbe13bda08f3aa3907cb0215a56c07553965f8d81242687f7c993652b294", medium: "56aab068913b69aac68862ab729462b943a31b9efb7ddadd1d1deebc0ff72714", high: "52d66731dcad01ca001243424e324b8c4921a17ab31fe6b7b869dc8473d2c3b6" }
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
  artifacts: {
    sourceSha256: "5eadf15faeccd5fec14f03e701c1b7001d7f4058941987070bf5e512e9984e5e",
    x64Sha256: "51dc67387cd0c9dbbbc36b577b5c98ea296ecaf3f2f015be52eb4df98affcbbc",
    arm64Sha256: "5821e547aa6e7c5682eaae1a3f6106138ccd5b5666909c6e135862a61b35cc47"
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

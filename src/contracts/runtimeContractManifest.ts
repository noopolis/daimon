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
  bounds: { promptBytes: 65_536, capabilityBytes: 4_096, capabilityBundleBytes: 8_196, outputBytes: 65_536 },
  artifacts: {
    sourceSha256: "bdcab1e12dcc531ed8e56f890263ca23a9ee7bac468191dd598e143df4ff8c58",
    x64Sha256: "e3fe2738fc8a979861085b4003bf2d5d7c284874897cb6ec2e2e2383211768bd",
    arm64Sha256: "ad44e02c38e6a3207ac4a3d5fd98b6d2e55341ce42dfd2f07204bbe54a7a653d"
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
  consumedConfigFields: ["version", "host.bindHost", "host.port", "host.controlTokenEnv", "agents[].id", "agents[].name", "agents[].instructions", "agents[].workspacePath", "agents[].runtimeHomePath", "agents[].engine.kind", "agents[].schedule.kind", "agents[].schedule.interval_ms", "agents[].schedule.cron", "agents[].schedule.timezone", "agents[].schedule.prompt", "agents[].schedule.jitter_seconds", "agents[].mcp", "agents[].moltnet", "agents[].memory"],
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
  supportedEngineKinds: ["agy", "codex", "grok"],
  engineCredentialMaterial: ENGINE_CREDENTIAL_MATERIAL,
  grokSubscriptionRealm: GROK_SUBSCRIPTION_REALM,
  grokEngineBroker: GROK_ENGINE_BROKER,
  agySubscriptionRealm: AGY_SUBSCRIPTION_REALM,
  wakeRequestSchema: { type: "object", additionalProperties: false, required: ["agentId", "event"], properties: { agentId: text, event: wakeEvent } },
  wakeResultSchema: { oneOf: [
    { type: "object", additionalProperties: false, required: ["version", "status", "agentId", "wakeId", "text", "durationMs"], properties: { ...wakeResultBase, status: { const: "completed" }, text: boundedText, durationMs: { type: "integer", minimum: 0 } } },
    { type: "object", additionalProperties: false, required: ["version", "status", "agentId", "wakeId", "code"], properties: { ...wakeResultBase, status: { const: "rejected" }, code: { enum: ["unauthorized", "unknown_agent", "queue_full"] } } },
    { type: "object", additionalProperties: false, required: ["version", "status", "agentId", "wakeId", "code"], properties: { version: { const: "noopolis.daimon.wake-result.v1" }, status: { const: "rejected" }, agentId: { type: "string", maxLength: ORGANIZATION_RUNTIME_MAX_STRING_CODEPOINTS }, wakeId: { type: "string", maxLength: ORGANIZATION_RUNTIME_MAX_STRING_CODEPOINTS }, code: { const: "invalid_request" } } },
    { type: "object", additionalProperties: false, required: ["version", "status", "agentId", "wakeId", "code"], properties: { ...wakeResultBase, status: { const: "stopped" }, code: { enum: ["host_stopping", "host_stopped", "queued_wake_stopped", "active_wake_aborted"] } } },
    { type: "object", additionalProperties: false, required: ["version", "status", "agentId", "wakeId", "code"], properties: { ...wakeResultBase, status: { const: "failed" }, code: { const: "engine_failed" } } }
  ] },
  healthResponseSchema: { type: "object", additionalProperties: false, required: ["version", "state", "agents"], properties: { version: { const: "noopolis.daimon.organization-runtime-health.v1" }, state: { enum: ["starting", "running", "stopping", "stopped"] }, agents: { type: "array", maxItems: ORGANIZATION_RUNTIME_MAX_AGENTS, items: { type: "object", additionalProperties: false, required: ["agentId", "state"], properties: { agentId: text, state: { enum: ["starting", "running", "stopping", "stopped", "idle", "failed"] } } } } } },
  activityResponseSchema: { type: "object", additionalProperties: false, required: ["version", "items"], properties: { version: { const: "noopolis.daimon.organization-runtime-activity.v1" }, items: { type: "array", maxItems: 100, items: activityItem }, nextCursor: { type: "string", minLength: 1, maxLength: 16, pattern: "^(0|[1-9][0-9]{0,15})$" } } },
  activityV2ResponseSchema: { type: "object", additionalProperties: false, required: ["version", "items"], properties: { version: { const: ORGANIZATION_RUNTIME_ACTIVITY_V2_VERSION }, items: { type: "array", maxItems: 2_112, items: { type: "object", additionalProperties: false, required: ["version", "acceptance_id", "agent_id", "delivery_id", "request_digest", "state", "accepted_at", "updated_at", "active"], properties: { version: { const: "noopolis.daimon.wake-receipt-status.v2" }, acceptance_id: { type: "string" }, agent_id: text, delivery_id: text, request_digest: { type: "string" }, state: { enum: ["accepted", "running", "completed", "failed", "stopped"] }, accepted_at: timestamp, updated_at: timestamp, active: { type: "boolean" }, queue_position: { type: "integer", minimum: 1 }, code: { enum: ["engine_failed", "host_stopped", "host_stopping", "queue_full", "unknown_agent"] } } } } } }
} as const;

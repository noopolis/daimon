/** The only configuration version accepted by the v1 runtime contract. */
export const ORGANIZATION_RUNTIME_VERSION = "noopolis.daimon.organization-runtime.v1" as const;
export const ORGANIZATION_RUNTIME_MAX_AGENTS = 32;
export const ORGANIZATION_RUNTIME_MAX_CONFIG_BYTES = 1_048_576;
export const ORGANIZATION_RUNTIME_MAX_STRING_BYTES = 16_384;
export const ORGANIZATION_RUNTIME_MAX_STRING_CODEPOINTS = 4_096;
export const ORGANIZATION_RUNTIME_MAX_WAKE_TEXT_BYTES = 16_384;

/** Machine-readable companion schema for config producers and validators. */
export const ORGANIZATION_RUNTIME_CONFIG_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema", $id: ORGANIZATION_RUNTIME_VERSION, type: "object", additionalProperties: false,
  required: ["version", "host", "agents"],
  properties: {
    version: { const: ORGANIZATION_RUNTIME_VERSION },
    host: { type: "object", additionalProperties: false, required: ["bindHost", "port", "controlTokenEnv"], properties: {
      bindHost: { type: "string", minLength: 1, maxLength: ORGANIZATION_RUNTIME_MAX_STRING_CODEPOINTS, pattern: "\\S" },
      port: { type: "integer", minimum: 1, maximum: 65_535 },
      controlTokenEnv: { type: "string", maxLength: ORGANIZATION_RUNTIME_MAX_STRING_CODEPOINTS, pattern: "^[A-Za-z_][A-Za-z0-9_]*$" }
    } },
    agents: { type: "array", minItems: 1, maxItems: ORGANIZATION_RUNTIME_MAX_AGENTS, items: {
      type: "object", additionalProperties: false, required: ["id", "name", "instructions", "workspacePath", "runtimeHomePath", "engine"], properties: {
        id: { type: "string", minLength: 1, maxLength: ORGANIZATION_RUNTIME_MAX_STRING_CODEPOINTS, pattern: "\\S" },
        name: { type: "string", minLength: 1, maxLength: ORGANIZATION_RUNTIME_MAX_STRING_CODEPOINTS, pattern: "\\S" },
        instructions: { type: "string", minLength: 1, maxLength: ORGANIZATION_RUNTIME_MAX_STRING_CODEPOINTS, pattern: "\\S" },
        workspacePath: { type: "string", maxLength: ORGANIZATION_RUNTIME_MAX_STRING_CODEPOINTS, pattern: "^/" },
        runtimeHomePath: { type: "string", maxLength: ORGANIZATION_RUNTIME_MAX_STRING_CODEPOINTS, pattern: "^/" },
        engine: { type: "object", additionalProperties: false, required: ["kind"], properties: {
          kind: { enum: ["codex", "grok", "agy"] }
        } }
      }
    } }
  }
} as const;

export type OrganizationRuntimeEngineKind = "codex" | "grok" | "agy";
export type OrganizationRuntimeEngineIntent = Readonly<{ kind: OrganizationRuntimeEngineKind }>;
export type OrganizationRuntimeAgentConfig = Readonly<{ id: string; name: string; instructions: string; workspacePath: string; runtimeHomePath: string; engine: OrganizationRuntimeEngineIntent }>;
export type OrganizationRuntimeHostConfig = Readonly<{ bindHost: string; port: number; /** Variable name only; never secret configuration data. */ controlTokenEnv: string }>;
export type OrganizationRuntimeConfig = Readonly<{ version: typeof ORGANIZATION_RUNTIME_VERSION; host: OrganizationRuntimeHostConfig; agents: readonly OrganizationRuntimeAgentConfig[] }>;
export type OrganizationRuntimeLifecycleState = "starting" | "running" | "stopping" | "stopped";
export type OrganizationRuntimeWakeEvent = Readonly<{ version: "noopolis.daimon.wake.v1"; id: string; kind: "manual" | "message" | "external"; text: string; occurredAt: string }>;
export type OrganizationRuntimeWakeRequest = Readonly<{ token: string | undefined; agentId: string; event: OrganizationRuntimeWakeEvent }>;
export type OrganizationRuntimeWakeResult =
  | Readonly<{ version: "noopolis.daimon.wake-result.v1"; status: "completed"; agentId: string; wakeId: string; text: string; durationMs: number }>
  | Readonly<{ version: "noopolis.daimon.wake-result.v1"; status: "rejected"; agentId: string; wakeId: string; code: "invalid_request" | "unauthorized" | "unknown_agent" | "queue_full" }>
  | Readonly<{ version: "noopolis.daimon.wake-result.v1"; status: "stopped"; agentId: string; wakeId: string; code: "host_stopping" | "host_stopped" | "queued_wake_stopped" | "active_wake_aborted" }>
  | Readonly<{ version: "noopolis.daimon.wake-result.v1"; status: "failed"; agentId: string; wakeId: string; code: "engine_failed" }>;
export type OrganizationRuntimeAgentHealth = Readonly<{ agentId: string; state: OrganizationRuntimeLifecycleState | "idle" | "running" | "failed" }>;
export type OrganizationRuntimeHealth = Readonly<{ version: "noopolis.daimon.organization-runtime-health.v1"; state: OrganizationRuntimeLifecycleState; agents: readonly OrganizationRuntimeAgentHealth[] }>;
export type OrganizationRuntimeActivityRequest = Readonly<{ agentId?: string; cursor?: string; limit: number }>;
export type OrganizationRuntimeActivity = Readonly<{ id: string; agentId: string; wakeId?: string; kind: "wake_started" | "wake_completed" | "wake_rejected" | "wake_aborted" | "agent_stopped"; occurredAt: string }>;
export type OrganizationRuntimeActivityPage = Readonly<{ version: "noopolis.daimon.organization-runtime-activity.v1"; items: readonly OrganizationRuntimeActivity[]; nextCursor?: string }>;
export type OrganizationRuntimeShutdownCompletion = Readonly<{ version: "noopolis.daimon.organization-runtime-stop.v1"; state: "stopped" }>;

/** One host runs isolated agents; it never coordinates their work. */
export interface OrganizationRuntimeHost {
  start(): Promise<void>;
  wake(request: OrganizationRuntimeWakeRequest): Promise<OrganizationRuntimeWakeResult>;
  health(agentId?: string): Promise<OrganizationRuntimeHealth>;
  activity(request: OrganizationRuntimeActivityRequest): Promise<OrganizationRuntimeActivityPage>;
  stop(): Promise<OrganizationRuntimeShutdownCompletion>;
}

export {
  isOrganizationRuntimeConfig,
  parseOrganizationRuntimeConfig,
  parseOrganizationRuntimeWakeRequest,
  validateOrganizationRuntimeConfig
} from "./organizationRuntimeParsing.js";

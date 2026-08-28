/** The data-only organization-runtime constants shared by product code and artifacts. */
export const ORGANIZATION_RUNTIME_VERSION = "noopolis.daimon.organization-runtime.v1" as const;
export const ORGANIZATION_RUNTIME_V2_VERSION = "noopolis.daimon.organization-runtime.v2" as const;
export const ORGANIZATION_RUNTIME_MAX_AGENTS = 32;
export const ORGANIZATION_RUNTIME_MAX_CONFIG_BYTES = 1_048_576;
export const ORGANIZATION_RUNTIME_MAX_STRING_BYTES = 16_384;
export const ORGANIZATION_RUNTIME_MAX_STRING_CODEPOINTS = 4_096;
export const ORGANIZATION_RUNTIME_MAX_WAKE_TEXT_BYTES = 16_384;
export const ORGANIZATION_RUNTIME_MAX_SCHEDULE_INTERVAL_MS = 31_536_000_000;

const PRODUCTION_TOOL_PROPERTIES = {
  mcp: { type: "array", maxItems: 8, items: { type: "object", additionalProperties: false, required: ["name", "transport", "args", "env", "tools"], properties: {
    name: { type: "string", minLength: 1, maxLength: ORGANIZATION_RUNTIME_MAX_STRING_CODEPOINTS }, transport: { enum: ["stdio", "sse", "streamable_http"] },
    command: { type: "string", pattern: "^/" }, url: { type: "string" }, authSecretEnv: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]*$" },
    args: { type: "array", maxItems: 32, items: { type: "string", maxLength: ORGANIZATION_RUNTIME_MAX_STRING_CODEPOINTS } }, env: { type: "object", additionalProperties: { type: "string" } },
    tools: { type: "array", minItems: 1, maxItems: 32, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: ORGANIZATION_RUNTIME_MAX_STRING_CODEPOINTS } }
  } } },
  moltnet: { type: "object", additionalProperties: false, required: ["cliPath", "configPath", "networks"], properties: {
    cliPath: { type: "string", pattern: "^/" }, configPath: { type: "string", pattern: "^/" }, networks: { type: "array", maxItems: 16, items: { type: "object", additionalProperties: false, required: ["id", "rooms", "dms"], properties: { id: { type: "string", minLength: 1 }, rooms: { type: "array", uniqueItems: true, items: { type: "string", minLength: 1 } }, dms: { type: "boolean" } } } }
  } }
} as const;

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
        } },
        ...PRODUCTION_TOOL_PROPERTIES
      }
    } }
  }
} as const;

export const ORGANIZATION_RUNTIME_SCHEDULE_SCHEMA = {
  oneOf: [
    { type: "object", additionalProperties: false, required: ["kind"], properties: { kind: { const: "disabled" } } },
    { type: "object", additionalProperties: false, required: ["kind", "interval_ms", "prompt"], properties: {
      kind: { const: "every" }, interval_ms: { type: "integer", minimum: 1, maximum: ORGANIZATION_RUNTIME_MAX_SCHEDULE_INTERVAL_MS },
      prompt: { type: "string", minLength: 1, maxLength: ORGANIZATION_RUNTIME_MAX_STRING_CODEPOINTS, pattern: "\\S" }
    } },
    { type: "object", additionalProperties: false, required: ["kind", "cron", "timezone", "prompt"], properties: {
      kind: { const: "cron" }, cron: { type: "string", minLength: 1, maxLength: ORGANIZATION_RUNTIME_MAX_STRING_CODEPOINTS, pattern: "\\S" },
      timezone: { type: "string", minLength: 1, maxLength: ORGANIZATION_RUNTIME_MAX_STRING_CODEPOINTS, pattern: "\\S" },
      prompt: { type: "string", minLength: 1, maxLength: ORGANIZATION_RUNTIME_MAX_STRING_CODEPOINTS, pattern: "\\S" }
    } }
  ]
} as const;

/** v2 adds exactly one normalized schedule to every agent; v1 stays unchanged. */
export const ORGANIZATION_RUNTIME_CONFIG_V2_SCHEMA = {
  ...ORGANIZATION_RUNTIME_CONFIG_SCHEMA,
  $id: ORGANIZATION_RUNTIME_V2_VERSION,
  properties: {
    ...ORGANIZATION_RUNTIME_CONFIG_SCHEMA.properties,
    version: { const: ORGANIZATION_RUNTIME_V2_VERSION },
    agents: {
      ...ORGANIZATION_RUNTIME_CONFIG_SCHEMA.properties.agents,
      items: {
        ...ORGANIZATION_RUNTIME_CONFIG_SCHEMA.properties.agents.items,
        required: [...ORGANIZATION_RUNTIME_CONFIG_SCHEMA.properties.agents.items.required, "schedule"],
        properties: {
          ...ORGANIZATION_RUNTIME_CONFIG_SCHEMA.properties.agents.items.properties,
          schedule: ORGANIZATION_RUNTIME_SCHEDULE_SCHEMA
        }
      }
    }
  }
} as const;

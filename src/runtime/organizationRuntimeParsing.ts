import {
  ORGANIZATION_RUNTIME_MAX_AGENTS,
  ORGANIZATION_RUNTIME_MAX_CONFIG_BYTES,
  ORGANIZATION_RUNTIME_MAX_STRING_BYTES,
  ORGANIZATION_RUNTIME_MAX_STRING_CODEPOINTS,
  ORGANIZATION_RUNTIME_MAX_WAKE_TEXT_BYTES,
  ORGANIZATION_RUNTIME_VERSION,
  type OrganizationRuntimeAgentConfig,
  type OrganizationRuntimeConfig,
  type OrganizationRuntimeEngineIntent,
  type OrganizationRuntimeEngineKind,
  type OrganizationRuntimeHostConfig,
  type OrganizationRuntimeWakeRequest
} from "./organizationRuntime.js";

type RecordValue = Record<string, unknown>;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENGINE_KINDS = new Set(["codex", "grok", "agy"]);

export function parseOrganizationRuntimeConfig(value: unknown): OrganizationRuntimeConfig {
  const root = object(snapshot(value, "config"), "config");
  size(root);
  exact(root, ["version", "host", "agents"], "config");
  if (string(root.version, "config.version") !== ORGANIZATION_RUNTIME_VERSION) throw new TypeError(`config.version must equal ${ORGANIZATION_RUNTIME_VERSION}`);
  const hostValue = object(root.host, "config.host");
  exact(hostValue, ["bindHost", "port", "controlTokenEnv"], "config.host");
  const host: OrganizationRuntimeHostConfig = {
    bindHost: nonEmpty(hostValue.bindHost, "config.host.bindHost"), port: port(hostValue.port, "config.host.port"), controlTokenEnv: envName(hostValue.controlTokenEnv, "config.host.controlTokenEnv")
  };
  const rawAgents = array(root.agents, "config.agents");
  if (rawAgents.length === 0 || rawAgents.length > ORGANIZATION_RUNTIME_MAX_AGENTS) throw new TypeError(`config.agents must contain between 1 and ${ORGANIZATION_RUNTIME_MAX_AGENTS} agents`);
  const ids = new Set<string>();
  const agents = rawAgents.map((item, index) => {
    const agent = parseAgent(item, `config.agents[${index}]`);
    if (ids.has(agent.id)) throw new TypeError(`config.agents has duplicate id ${agent.id}`);
    ids.add(agent.id);
    return agent;
  });
  isolated(agents);
  return { version: ORGANIZATION_RUNTIME_VERSION, host, agents };
}

export function parseOrganizationRuntimeWakeRequest(value: unknown): OrganizationRuntimeWakeRequest {
  const request = object(snapshot(value, "wake request"), "wake request");
  exact(request, ["token", "agentId", "event"], "wake request");
  const event = object(request.event, "wake request.event");
  exact(event, ["version", "id", "kind", "text", "occurredAt"], "wake request.event");
  if (string(event.version, "wake request.event.version") !== "noopolis.daimon.wake.v1") throw new TypeError("wake request.event.version is not supported");
  const kind = string(event.kind, "wake request.event.kind");
  if (kind !== "manual" && kind !== "message" && kind !== "external") throw new TypeError("wake request.event.kind is not supported");
  const text = string(event.text, "wake request.event.text");
  if (Buffer.byteLength(text, "utf8") > ORGANIZATION_RUNTIME_MAX_WAKE_TEXT_BYTES) throw new TypeError("wake request.event.text exceeds the wake text limit");
  return { token: request.token === undefined ? undefined : string(request.token, "wake request.token"), agentId: nonEmpty(request.agentId, "wake request.agentId"), event: { version: "noopolis.daimon.wake.v1", id: nonEmpty(event.id, "wake request.event.id"), kind, text, occurredAt: rfc3339(event.occurredAt) } };
}

export function validateOrganizationRuntimeConfig(value: unknown): value is OrganizationRuntimeConfig {
  try { parseOrganizationRuntimeConfig(value); return true; } catch { return false; }
}

export const isOrganizationRuntimeConfig = validateOrganizationRuntimeConfig;

function parseAgent(value: unknown, label: string): OrganizationRuntimeAgentConfig {
  const agent = object(value, label);
  exact(agent, ["id", "name", "instructions", "workspacePath", "runtimeHomePath", "engine"], label);
  return { id: nonEmpty(agent.id, `${label}.id`), name: nonEmpty(agent.name, `${label}.name`), instructions: nonEmpty(agent.instructions, `${label}.instructions`), workspacePath: absolute(agent.workspacePath, `${label}.workspacePath`), runtimeHomePath: absolute(agent.runtimeHomePath, `${label}.runtimeHomePath`), engine: engine(agent.engine, `${label}.engine`) };
}

function engine(value: unknown, label: string): OrganizationRuntimeEngineIntent {
  const input = object(value, label); const kind = string(input.kind, `${label}.kind`);
  if (!ENGINE_KINDS.has(kind)) throw new TypeError(`${label}.kind is not a supported engine`);
  exact(input, ["kind"], label);
  return { kind: kind as OrganizationRuntimeEngineKind };
}

function snapshot(value: unknown, label: string): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") { if (!Number.isFinite(value)) throw new TypeError(`${label} must be JSON data`); return value; }
  if (typeof value !== "object") throw new TypeError(`${label} must be JSON data`);
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (const key of Reflect.ownKeys(value)) {
      if (key === "length") continue;
      if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key)) throw new TypeError(`${label} must contain only indexed data properties`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) throw new TypeError(`${label}[${String(key)}] must be an enumerable data property`);
    }
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor)) throw new TypeError(`${label}[${index}] must be a present record`);
      result.push(snapshot(descriptor.value, `${label}[${index}]`));
    }
    return result;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError(`${label} must be a plain own-properties object`);
  const result: RecordValue = Object.create(null) as RecordValue;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new TypeError(`${label} must not contain symbol properties`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) throw new TypeError(`${label}.${key} must be an enumerable data property`);
    result[key] = snapshot(descriptor.value, `${label}.${key}`);
  }
  return result;
}

function object(value: unknown, label: string): RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError(`${label} must be a plain own-properties object`);
  return value as RecordValue;
}
function array(value: unknown, label: string): readonly unknown[] { if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`); return value; }
function exact(value: RecordValue, expected: readonly string[], label: string): void { const extras = Object.keys(value).filter((key) => !expected.includes(key)); const missing = expected.filter((key) => !Object.hasOwn(value, key)); if (extras.length || missing.length) throw new TypeError(`${label} must contain exactly ${expected.join(", ")}`); }
function isolated(agents: readonly OrganizationRuntimeAgentConfig[]): void { const paths = agents.flatMap((agent) => [{ agentId: agent.id, kind: "workspacePath", value: agent.workspacePath }, { agentId: agent.id, kind: "runtimeHomePath", value: agent.runtimeHomePath }]); for (let left = 0; left < paths.length; left += 1) for (let right = left + 1; right < paths.length; right += 1) { const first = paths[left]!; const second = paths[right]!; if (first.value === second.value || first.value.startsWith(`${second.value}/`) || second.value.startsWith(`${first.value}/`)) throw new TypeError(`agents ${first.agentId}.${first.kind} and ${second.agentId}.${second.kind} must not overlap`); } }
function string(value: unknown, label: string): string { if (typeof value !== "string") throw new TypeError(`${label} must be a string`); if (Buffer.byteLength(value, "utf8") > ORGANIZATION_RUNTIME_MAX_STRING_BYTES || Array.from(value).length > ORGANIZATION_RUNTIME_MAX_STRING_CODEPOINTS) throw new TypeError(`${label} exceeds the runtime string limit`); return value; }
function nonEmpty(value: unknown, label: string): string { const result = string(value, label); if (!result.trim()) throw new TypeError(`${label} must not be empty`); return result; }
function absolute(value: unknown, label: string): string { const result = nonEmpty(value, label); if (!path.posix.isAbsolute(result)) throw new TypeError(`${label} must be an absolute POSIX path`); const normalized = path.posix.normalize(result); if (normalized === "/") throw new TypeError(`${label} must not overlap filesystem root`); return normalized.replace(/\/+$/, ""); }
function envName(value: unknown, label: string): string { const result = nonEmpty(value, label); if (!ENV_NAME.test(result)) throw new TypeError(`${label} must be a safe environment variable name`); return result; }
function port(value: unknown, label: string): number { if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65_535) throw new TypeError(`${label} must be an integer between 1 and 65535`); return value; }
function size(value: unknown): void { const serialized = JSON.stringify(value); if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > ORGANIZATION_RUNTIME_MAX_CONFIG_BYTES) throw new TypeError("config exceeds the runtime byte limit"); }
function rfc3339(value: unknown): string { const result = nonEmpty(value, "wake request.event.occurredAt"); if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result) || Number.isNaN(Date.parse(result)) || new Date(result).toISOString() !== result) throw new TypeError("wake request.event.occurredAt must be an exact RFC3339 timestamp"); return result; }
import path from "node:path";

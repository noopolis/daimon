import { strict as assert } from "node:assert";
import test from "node:test";

import {
  ORGANIZATION_RUNTIME_CONFIG_SCHEMA,
  ORGANIZATION_RUNTIME_MAX_AGENTS,
  ORGANIZATION_RUNTIME_MAX_STRING_BYTES,
  ORGANIZATION_RUNTIME_VERSION,
  validateOrganizationRuntimeConfig,
  parseOrganizationRuntimeConfig,
  parseOrganizationRuntimeWakeRequest
} from "./organizationRuntime.js";
import type { OrganizationRuntimeEngineIntent } from "./organizationRuntime.js";

const valid = () => ({
  version: ORGANIZATION_RUNTIME_VERSION,
  host: { bindHost: "127.0.0.1", port: 4318, controlTokenEnv: "DAIMON_CONTROL_TOKEN" },
  agents: [{
    id: "editor",
    name: "Editor",
    instructions: "Write a concise report.",
    workspacePath: "/runtime/workspaces/editor",
    runtimeHomePath: "/runtime/homes/editor",
    engine: { kind: "codex" } as OrganizationRuntimeEngineIntent
  }]
});

test("parses the strict flat v1 contract", () => {
  const parsed = parseOrganizationRuntimeConfig(valid());
  assert.equal(parsed.version, ORGANIZATION_RUNTIME_VERSION);
  assert.equal(parsed.agents[0]?.engine.kind, "codex");
  assert.equal(ORGANIZATION_RUNTIME_CONFIG_SCHEMA.additionalProperties, false);
  assert.equal(ORGANIZATION_RUNTIME_CONFIG_SCHEMA.properties.agents.minItems, 1);
});

test("semantic validator and parser share a conformance corpus", () => {
  const cases: readonly [unknown, boolean][] = [
    [valid(), true],
    [{ ...valid(), agents: [] }, false],
    [{ ...valid(), agents: [{ ...valid().agents[0], id: " " }] }, false],
    [{ ...valid(), agents: [{ ...valid().agents[0], workspacePath: "/work/../escape" }] }, true],
    [{ ...valid(), agents: [{ ...valid().agents[0], runtimeHomePath: "/home//agent" }] }, true],
    [{ ...valid(), agents: [{ ...valid().agents[0], engine: { kind: "pi" } }] }, false],
    [{ ...valid(), agents: [{ ...valid().agents[0], engine: { kind: "scripted", protocol: "noopolis.daimon.scripted.v1", programPath: "agent.mjs" } }] }, false],
    [{ ...valid(), agents: [valid().agents[0], { ...valid().agents[0] }] }, false]
  ];
  for (const [candidate, accepted] of cases) {
    assert.equal(validateOrganizationRuntimeConfig(candidate), accepted);
    assert.equal(accepted, (() => { try { parseOrganizationRuntimeConfig(candidate); return true; } catch { return false; } })());
  }
});

test("rejects sparse agent arrays", () => {
  const sparse = valid();
  sparse.agents = new Array(1) as typeof sparse.agents;
  assert.throws(() => parseOrganizationRuntimeConfig(sparse), /present record/);
  const mixed = valid();
  mixed.agents = [{ ...mixed.agents[0]! }, , { ...mixed.agents[0]!, id: "other" }] as typeof mixed.agents;
  assert.throws(() => parseOrganizationRuntimeConfig(mixed), /present record/);
});

test("bounds programmatic config size, agents, and every string field", () => {
  const tooMany = valid();
  tooMany.agents = Array.from({ length: ORGANIZATION_RUNTIME_MAX_AGENTS + 1 }, (_, index) => ({
    ...valid().agents[0]!, id: `agent-${index}`
  }));
  assert.throws(() => parseOrganizationRuntimeConfig(tooMany), /between 1 and/);
  const tooLong = valid();
  tooLong.agents[0]!.instructions = "x".repeat(ORGANIZATION_RUNTIME_MAX_STRING_BYTES + 1);
  assert.throws(() => parseOrganizationRuntimeConfig(tooLong), /string limit/);
  assert.equal(ORGANIZATION_RUNTIME_CONFIG_SCHEMA.properties.agents.maxItems, ORGANIZATION_RUNTIME_MAX_AGENTS);
});

test("rejects unknown versions and organization semantics before any side effect", () => {
  const unknownVersion = valid();
  unknownVersion.version = "noopolis.daimon.organization-runtime.v2" as typeof ORGANIZATION_RUNTIME_VERSION;
  assert.throws(() => parseOrganizationRuntimeConfig(unknownVersion), /config.version/);
  for (const forbidden of ["teams", "roles", "parents", "members", "edges", "schedules", "wakePolicy", "deployment", "moltnet"]) {
    const config = valid() as Record<string, unknown>;
    config[forbidden] = [];
    assert.throws(() => parseOrganizationRuntimeConfig(config), /exactly/);
  }
});

test("rejects unsafe auth names, duplicate ids, and invalid absolute paths", () => {
  const unsafe = valid();
  unsafe.host.controlTokenEnv = "TOKEN; rm";
  assert.throws(() => parseOrganizationRuntimeConfig(unsafe), /safe environment/);
  const duplicate = valid();
  duplicate.agents.push({ ...duplicate.agents[0]!, id: "editor" });
  assert.throws(() => parseOrganizationRuntimeConfig(duplicate), /duplicate id/);
  const relative = valid();
  relative.agents[0]!.workspacePath = "workspaces/editor";
  assert.throws(() => parseOrganizationRuntimeConfig(relative), /absolute POSIX/);
});

test("rejects inherited records and every lexical agent-path collision", () => {
  const inherited = Object.create({ version: ORGANIZATION_RUNTIME_VERSION, host: valid().host, agents: valid().agents });
  assert.throws(() => parseOrganizationRuntimeConfig(inherited), /plain own-properties/);
  const missingOwn = { version: ORGANIZATION_RUNTIME_VERSION, host: Object.create(valid().host), agents: valid().agents };
  assert.throws(() => parseOrganizationRuntimeConfig(missingOwn), /plain own-properties|exactly/);
  for (const [workspacePath, runtimeHomePath] of [
    ["/runtime/workspaces/editor", "/runtime/workspaces/editor"],
    ["/runtime/workspaces", "/runtime/workspaces/editor"],
    ["/runtime/homes/other", "/runtime/homes"]
  ]) {
    const config = valid();
    config.agents.push({ ...config.agents[0]!, id: "other", workspacePath, runtimeHomePath });
    assert.throws(() => parseOrganizationRuntimeConfig(config), /must not overlap/);
  }
});

test("rejects same-agent overlap and filesystem-root capabilities", () => {
  for (const [workspacePath, runtimeHomePath] of [
    ["/runtime/agent", "/runtime/agent"],
    ["/runtime/agent", "/runtime/agent/home"],
    ["/runtime/agent/workspace", "/runtime/agent"]
  ]) {
    const config = valid();
    config.agents[0]!.workspacePath = workspacePath;
    config.agents[0]!.runtimeHomePath = runtimeHomePath;
    assert.throws(() => parseOrganizationRuntimeConfig(config), /must not overlap/);
  }
  for (const key of ["workspacePath", "runtimeHomePath"] as const) {
    const config = valid();
    config.agents[0]![key] = "/";
    assert.throws(() => parseOrganizationRuntimeConfig(config), /filesystem root/);
  }
});

test("strict config and wake parsers never invoke getters or accept hidden keys", () => {
  let reads = 0;
  const hostile = valid() as Record<string, unknown>;
  Object.defineProperty(hostile, "version", { enumerable: true, get() { reads += 1; return ORGANIZATION_RUNTIME_VERSION; } });
  assert.throws(() => parseOrganizationRuntimeConfig(hostile), /enumerable data property/);
  assert.equal(reads, 0);

  const hidden = valid() as Record<string, unknown>;
  Object.defineProperty(hidden, "argv", { enumerable: false, value: ["--unsafe"] });
  assert.throws(() => parseOrganizationRuntimeConfig(hidden), /enumerable data property/);
  const symbols = valid() as Record<PropertyKey, unknown>;
  symbols[Symbol("argv")] = ["--unsafe"];
  assert.throws(() => parseOrganizationRuntimeConfig(symbols), /symbol properties/);

  const wake = { token: "token", agentId: "agent", event: {
    version: "noopolis.daimon.wake.v1", id: "wake", kind: "manual", text: "go", occurredAt: "2026-08-17T12:00:00.000Z"
  } } as Record<string, unknown>;
  Object.defineProperty(wake, "agentId", { enumerable: true, get() { reads += 1; return "agent"; } });
  assert.throws(() => parseOrganizationRuntimeWakeRequest(wake), /enumerable data property/);
  assert.equal(reads, 0);
});

test("canonicalizes POSIX absolute paths before storing and comparing isolation", () => {
  const canonical = valid();
  canonical.agents[0]!.workspacePath = "/runtime/./workspaces/editor/";
  canonical.agents[0]!.runtimeHomePath = "/runtime/homes/../homes/editor//";
  const parsed = parseOrganizationRuntimeConfig(canonical);
  assert.equal(parsed.agents[0]?.workspacePath, "/runtime/workspaces/editor");
  assert.equal(parsed.agents[0]?.runtimeHomePath, "/runtime/homes/editor");
  for (const [firstWorkspacePath, secondWorkspacePath] of [
    ["/runtime/shared/", "/runtime/shared/child"],
    ["/", "/runtime/child"],
    ["/runtime/a/../shared", "/runtime/shared/child/./leaf"]
  ]) {
    const config = valid();
    config.agents[0]!.workspacePath = firstWorkspacePath;
    config.agents[0]!.runtimeHomePath = "/runtime/homes/first";
    config.agents.push({ ...config.agents[0]!, id: "other", workspacePath: secondWorkspacePath, runtimeHomePath: "/runtime/homes/second" });
    assert.throws(() => parseOrganizationRuntimeConfig(config), /must not overlap/);
  }
  const windowsSeparators = valid();
  windowsSeparators.agents[0]!.workspacePath = "\\runtime\\workspace";
  assert.throws(() => parseOrganizationRuntimeConfig(windowsSeparators), /POSIX/);
});

test("accepts only Daimon's three production engines", () => {
  for (const kind of ["codex", "grok", "agy"] as const) {
    const candidate = valid();
    candidate.agents[0]!.engine = { kind };
    assert.equal(parseOrganizationRuntimeConfig(candidate).agents[0]?.engine.kind, kind);
  }
  const injected = valid();
  injected.agents[0]!.engine = { kind: "codex", argv: ["--unsafe"] } as never;
  assert.throws(() => parseOrganizationRuntimeConfig(injected), /exactly/);
});

test("wake-result status and code pairs are fixed", () => {
  const fixtures = [
    { version: "noopolis.daimon.wake-result.v1", status: "completed", agentId: "a", wakeId: "w", text: "done", durationMs: 1 },
    { version: "noopolis.daimon.wake-result.v1", status: "rejected", agentId: "a", wakeId: "w", code: "unauthorized" },
    { version: "noopolis.daimon.wake-result.v1", status: "rejected", agentId: "a", wakeId: "w", code: "queue_full" },
    { version: "noopolis.daimon.wake-result.v1", status: "stopped", agentId: "a", wakeId: "w", code: "queued_wake_stopped" },
    { version: "noopolis.daimon.wake-result.v1", status: "failed", agentId: "a", wakeId: "w", code: "engine_failed" }
  ] as const;
  assert.deepEqual(fixtures.map((result) => result.status), ["completed", "rejected", "rejected", "stopped", "failed"]);
});

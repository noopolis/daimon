import { strict as assert } from "node:assert";
import test from "node:test";

import { startOrganizationRuntimeEngine } from "./engineDispatcher.js";
import {
  ORGANIZATION_RUNTIME_CONFIG_SCHEMA,
  ORGANIZATION_RUNTIME_VERSION,
  validateOrganizationRuntimeConfig,
  parseOrganizationRuntimeConfig,
  type OrganizationRuntimeAgentConfig,
  type OrganizationRuntimeEngineIntent
} from "./organizationRuntime.js";

const valid = () => ({
  version: ORGANIZATION_RUNTIME_VERSION,
  host: { bindHost: "127.0.0.1", port: 4318, controlTokenEnv: "DAIMON_CONTROL_TOKEN" },
  agents: [{ id: "editor", name: "Editor", instructions: "Write a concise report.", workspacePath: "/runtime/workspaces/editor", runtimeHomePath: "/runtime/homes/editor", engine: { kind: "codex" } as OrganizationRuntimeEngineIntent }]
});

test("grok declares model and reasoning effort together from the closed broker lists, never half-inherited", () => {
  const declared = valid();
  declared.agents[0]!.engine = { kind: "grok", model: "grok-4.6", reasoningEffort: "low" } as never;
  assert.deepEqual(parseOrganizationRuntimeConfig(declared).agents[0]!.engine, { kind: "grok", model: "grok-4.6", reasoningEffort: "low" });
  const bare = valid();
  bare.agents[0]!.engine = { kind: "grok" } as never;
  assert.deepEqual(parseOrganizationRuntimeConfig(bare).agents[0]!.engine, { kind: "grok" });
  for (const engine of [
    { kind: "grok", model: "grok-4.6" },
    { kind: "grok", reasoningEffort: "low" },
    { kind: "grok", model: "grok-4.6-build", reasoningEffort: "low" },
    { kind: "grok", model: "gpt-5-codex", reasoningEffort: "low" },
    { kind: "grok", model: "grok-4.6", reasoningEffort: "xhigh" },
    { kind: "grok", model: "grok-4.6", reasoningEffort: "low", provider: "xai" }
  ]) {
    const invalid = valid();
    invalid.agents[0]!.engine = engine as never;
    assert.throws(() => parseOrganizationRuntimeConfig(invalid), TypeError, JSON.stringify(engine));
  }
});

test("the engine JSON Schema and the parser agree on grok and agy model declarations", async () => {
  const { Ajv2020 } = await import("ajv/dist/2020.js") as unknown as { Ajv2020: new (options: Record<string, unknown>) => { compile(schema: unknown): (value: unknown) => boolean } };
  const validate = new Ajv2020({ strict: false }).compile(ORGANIZATION_RUNTIME_CONFIG_SCHEMA);
  for (const engine of [
    { kind: "grok" }, { kind: "grok", model: "grok-4.6", reasoningEffort: "low" }, { kind: "grok", model: "grok-4.6" },
    { kind: "grok", model: "grok-4.6-build", reasoningEffort: "low" }, { kind: "grok", model: "grok-4.5", reasoningEffort: "xhigh" },
    { kind: "agy" }, { kind: "agy", model: "x" }, { kind: "codex", model: "gpt-5-codex", reasoningEffort: "xhigh" }
  ]) {
    const config = valid();
    config.agents[0]!.engine = engine as never;
    assert.equal(validate(config), validateOrganizationRuntimeConfig(config), JSON.stringify(engine));
  }
});

test("a declared Grok model is refused on the direct path that cannot enforce it", async () => {
  const config = { ...valid().agents[0]!, engine: { kind: "grok", model: "grok-4.6", reasoningEffort: "low" } } as OrganizationRuntimeAgentConfig;
  await assert.rejects(startOrganizationRuntimeEngine(config, "DAIMON_UNUSED_CONTROL"), /requires the engine broker/u);
});

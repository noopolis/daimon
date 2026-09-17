import assert from "node:assert/strict";
import test from "node:test";

import { GROK_ENGINE_BROKER, GROK_SUBSCRIPTION_REALM } from "../contracts/runtimeContractManifest.js";
import { parseEngineBrokerServiceConfig } from "./engineBrokerServiceConfig.js";
import { grokBrokerProjectionSha256, grokBrokerServiceRegistrationFor, resolveOrganizationGrokBrokerProjection, verifyGrokBrokerRegistrationMatchesProjection } from "./grokBrokerProjection.js";
import { grokBrokerWorkerConfigSha256 } from "./grokBrokerWorkerConfig.js";
import { grokWorkerSandboxProfileSha256 } from "./grokWorkerSandboxProfile.js";

const agent = (id: string, engine: Record<string, unknown>) => ({ id, name: id, instructions: "Unused", workspacePath: `/var/lib/spawnfile/instance/workspace/agents/${id}`, runtimeHomePath: `/var/lib/spawnfile/instance/homes/${id}`, schedule: { kind: "disabled" }, engine });
const config = { version: "noopolis.daimon.organization-runtime.v2", host: { bindHost: "127.0.0.1", port: 19700, controlTokenEnv: "UNIT_CONTROL_TOKEN" },
  agents: [agent("foreman", { kind: "grok", model: "grok-4.6", reasoningEffort: "low" }), agent("peer", { kind: "codex" })] };
const options = { slot: 0, workerUid: 2_200, workerHomePath: "/var/lib/daimon-workers/2200", architecture: "arm64", usageLedgerPath: "/run/slots/0/usage/usage.jsonl",
  limits: { maxRequests: 24, maxTokens: 400_000, timeoutMs: 480_000 }, acceptanceStorePath: "/run/paideia/control", denyPaths: ["/run/paideia", "/run/training/inputs"], seccompProfileSha256: "7".repeat(64) } as const;

test("the projection is Daimon's own renderers and collectors, fully declared and deterministic", () => {
  const projection = resolveOrganizationGrokBrokerProjection(config, "foreman", options);
  const denyPaths = [GROK_SUBSCRIPTION_REALM.bootstrapMountPath, GROK_SUBSCRIPTION_REALM.durableMountPath, "/run/paideia/control", "/var/lib/spawnfile/instance/homes/peer", "/var/lib/spawnfile/instance/workspace/agents/peer", "/run/paideia", "/run/training/inputs"].sort();
  assert.deepEqual(projection, {
    version: "noopolis.daimon.grok-broker-projection.v1", agentId: "foreman",
    workspacePath: "/var/lib/spawnfile/instance/workspace/agents/foreman", runtimeHomePath: "/var/lib/spawnfile/instance/homes/foreman",
    workerUid: 2_200, slot: 0, profilePath: "/var/lib/daimon-workers/2200/.grok/sandbox.toml", profileSha256: grokWorkerSandboxProfileSha256(denyPaths), denyPaths,
    workerConfigSha256: grokBrokerWorkerConfigSha256({ model: "grok-4.6", reasoningEffort: "low" }), systemPromptSha256: GROK_ENGINE_BROKER.worker.systemPromptSha256,
    grokCliVersion: "1.0.34", grokExecutableSha256: GROK_ENGINE_BROKER.grokCliArtifacts.arm64.sha256, nativeAbiVersion: GROK_ENGINE_BROKER.nativeAbiVersion,
    model: "grok-4.6", reasoningEffort: "low", limits: options.limits, usageLedgerPath: options.usageLedgerPath,
    seccompProfileSha256: "7".repeat(64),
    attestation: { platform: "linux/landlock", enforced: true, restrictNetwork: true, profileName: "daimon-strict", sandboxRuntime: "bubblewrap", eventsPath: "/var/lib/daimon-workers/2200/.grok/sessions/sandbox-events.jsonl" }
  });
  assert.equal(grokBrokerProjectionSha256(resolveOrganizationGrokBrokerProjection(config, "foreman", { ...options, denyPaths: [...options.denyPaths].reverse() })), grokBrokerProjectionSha256(projection));
  assert.match(grokBrokerProjectionSha256(projection), /^[a-f0-9]{64}$/u);
});

test("the projection refuses undeclared models, non-Grok agents, and a profile digest it did not render", () => {
  assert.throws(() => resolveOrganizationGrokBrokerProjection({ ...config, agents: [agent("foreman", { kind: "grok" })] }, "foreman", options), /declared model/u);
  assert.throws(() => resolveOrganizationGrokBrokerProjection(config, "peer", options), /known Grok agent/u);
  assert.throws(() => resolveOrganizationGrokBrokerProjection(config, "foreman", { ...options, seccompProfileSha256: "not-a-digest" }), /seccomp profile sha256/u);
  assert.throws(() => resolveOrganizationGrokBrokerProjection(config, "missing", options), /known Grok agent/u);
  // Mutation guard: skipping the digest comparison accepts a weaker profile's digest.
  assert.throws(() => resolveOrganizationGrokBrokerProjection(config, "foreman", { ...options, profileSha256: grokWorkerSandboxProfileSha256([]) }), /profile digest mismatch/u);
  assert.throws(() => resolveOrganizationGrokBrokerProjection(config, "foreman", { ...options, denyPaths: ["relative"] }), /deny path/u);
  assert.throws(() => resolveOrganizationGrokBrokerProjection(config, "foreman", { ...options, limits: { ...options.limits, maxRequests: 49 } }), /invalid/u);
  assert.throws(() => resolveOrganizationGrokBrokerProjection(config, "foreman", { ...options, usageLedgerPath: "/run/slots/0/usage/requests.jsonl" }), /invalid engine broker service config/u);
  assert.equal(resolveOrganizationGrokBrokerProjection(config, "foreman", { ...options, profileSha256: resolveOrganizationGrokBrokerProjection(config, "foreman", options).profileSha256 }).agentId, "foreman");
});

test("a provisioned registration must describe its projection exactly", () => {
  const projection = resolveOrganizationGrokBrokerProjection(config, "foreman", options);
  const parse = (registration: Record<string, unknown>) => parseEngineBrokerServiceConfig({ version: "noopolis.daimon.engine-broker-service.v2", credentialHome: "/c", turnStore: "/t", registrations: [registration] }).registrations[0]!;
  const registration = grokBrokerServiceRegistrationFor(projection);
  verifyGrokBrokerRegistrationMatchesProjection(parse(registration), projection);
  for (const drift of [{ profileSha256: grokWorkerSandboxProfileSha256([]) }, { model: { id: "grok-4.5", reasoningEffort: "low" } }, { limits: { ...options.limits, maxTokens: 400_001 } }, { usageLedgerPath: "/run/slots/1/usage/usage.jsonl" }]) {
    assert.throws(() => verifyGrokBrokerRegistrationMatchesProjection(parse({ ...registration, ...drift }), projection), /does not match/u, JSON.stringify(drift));
  }
});

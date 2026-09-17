import assert from "node:assert/strict";
import test from "node:test";
import { parseEngineBrokerServiceConfig } from "./engineBrokerServiceCli.js";
import { engineBrokerRequestLedgerPathFor } from "./engineBrokerServiceConfig.js";

const paths = { credentialHome: "/var/lib/daimon-engine-broker/credential", turnStore: "/var/lib/daimon-engine-broker/turns" };
const reg = (agentId: string, slot: number) => ({ agentId, slot, workerUid: 2200 + slot, workspace: `/workspace/${slot}`, profilePath: `/workers/${slot}/.grok/sandbox.toml`, eventsPath: `/workers/${slot}/.grok/sessions/sandbox-events.jsonl`, profileSha256: "a".repeat(64) });
const v2 = (agentId: string, slot: number) => ({ ...reg(agentId, slot), usageLedgerPath: `/run/slots/${slot}/usage/usage.jsonl`, limits: { maxRequests: 12, maxTokens: 400_000, timeoutMs: 480_000 }, model: { id: "grok-4.6", reasoningEffort: "low" } });
const config = (version: string, registrations: readonly unknown[]) => ({ version: `noopolis.daimon.engine-broker-service.${version}`, ...paths, registrations });

test("v1 service config is still accepted and receives today's defaults", () => {
  assert.deepEqual(parseEngineBrokerServiceConfig(config("v1", [reg("agent-a", 0)])), { ...paths, registrations: [{
    ...reg("agent-a", 0), usageLedgerPath: "/var/lib/spawnfile/daimon/usage/usage.jsonl",
    limits: { maxRequests: 32, maxTokens: 300_000, timeoutMs: 240_000 }, model: { model: "grok-4.6", reasoningEffort: "low" }
  }] });
});

test("v2 declares a per-slot ledger, limits and a closed-list model per registration", () => {
  const parsed = parseEngineBrokerServiceConfig(config("v2", [v2("agent-a", 0), v2("agent-b", 1)]));
  assert.deepEqual(parsed.registrations[1], { ...reg("agent-b", 1), usageLedgerPath: "/run/slots/1/usage/usage.jsonl", limits: { maxRequests: 12, maxTokens: 400_000, timeoutMs: 480_000 }, model: { model: "grok-4.6", reasoningEffort: "low" } });
  assert.equal(engineBrokerRequestLedgerPathFor(parsed.registrations[0]!.usageLedgerPath), "/run/slots/0/usage/requests.jsonl");
});

test("v2 rejects unknown keys at every level, off-list models, missing fields and out-of-bound limits", () => {
  const base = v2("agent-a", 0);
  // Mutation guard: loosening any exact-member check accepts one of these.
  for (const registration of [
    { ...base, extra: true },
    { ...base, limits: { ...base.limits, maxWakes: 1 } },
    { ...base, model: { ...base.model, provider: "xai" } },
    { ...base, model: { id: "grok-4.6-build", reasoningEffort: "low" } },
    { ...base, model: { id: "grok-4.6", reasoningEffort: "xhigh" } },
    { ...base, limits: { ...base.limits, maxRequests: 49 } },
    { ...base, limits: { ...base.limits, maxTokens: 0 } },
    { ...base, usageLedgerPath: "relative/usage.jsonl" },
    { ...base, usageLedgerPath: "/run/slots/0/requests.jsonl" },
    { ...base, usageLedgerPath: "/run/slots/0/usage" },
    (({ model: _omit, ...rest }) => rest)(base),
    reg("agent-a", 0)
  ]) assert.throws(() => parseEngineBrokerServiceConfig(config("v2", [registration])), /invalid engine broker service config/u);
  assert.throws(() => parseEngineBrokerServiceConfig({ ...config("v2", [base]), grokCommand: "evil" }), /invalid engine broker service config/u);
  assert.throws(() => parseEngineBrokerServiceConfig(config("v1", [base])), /invalid engine broker service config/u, "v2 members are not accepted under v1");
  assert.throws(() => parseEngineBrokerServiceConfig(config("v3", [base])), /invalid engine broker service config/u);
});

test("rejects caller-selected commands, duplicate identities, and traversal", () => {
  const base = config("v1", [reg("agent-a", 0)]);
  assert.throws(() => parseEngineBrokerServiceConfig({ ...base, grokCommand: "evil" }));
  assert.throws(() => parseEngineBrokerServiceConfig({ ...base, turnStore: "/var/lib/../secret" }));
  assert.throws(() => parseEngineBrokerServiceConfig({ ...base, registrations: [reg("agent-a", 0), reg("agent-a", 1)] }));
  assert.throws(() => parseEngineBrokerServiceConfig({ ...base, registrations: [reg("agent-a", 0), reg("agent-b", 0)] }), /invalid/u, "one slot is one worker");
  // Grok 1.0.34 logs sandbox events under $GROK_HOME/sessions/; the 1.0.13 root path stays empty and must not be attested.
  assert.throws(() => parseEngineBrokerServiceConfig({ ...base, registrations: [{ ...reg("agent-a", 0), eventsPath: "/workers/0/.grok/sandbox-events.jsonl" }] }));
  assert.throws(() => parseEngineBrokerServiceConfig({ ...base, registrations: [{ ...reg("agent-a", 0), eventsPath: "/workers/1/.grok/sessions/sandbox-events.jsonl" }] }));
});

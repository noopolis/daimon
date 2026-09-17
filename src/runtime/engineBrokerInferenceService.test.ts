import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { EngineBrokerControlClient, EngineBrokerInferenceGrantRefused } from "./engineBrokerControlClient.js";
import { GROK_INFERENCE_PROXY_BASE_URL } from "./engineBrokerInferenceProtocol.js";
import { parseEngineBrokerRequest, parseEngineBrokerResponse } from "./engineBrokerProtocol.js";
import { startEngineBrokerServiceWithIdentity, type EngineBrokerServiceEngine } from "./engineBrokerService.js";
import { GrokInferenceGrantRefused, GrokInferenceGrants } from "./grokInferenceGrants.js";

const V = "noopolis.daimon.engine-broker.v2";
const baseEngine = (): EngineBrokerServiceEngine => ({ turn: async () => { throw new Error("no turns"); }, readiness: () => ({ providerProxyPort: 43123, mcpFacadePort: 43124, registrations: 1, credentialStale: false, realmLease: true, workerIsolation: true }), close: async () => undefined });

async function withService(engine: EngineBrokerServiceEngine, run: (client: EngineBrokerControlClient) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "daimon-broker-grants-")), socketPath = path.join(directory, "broker.sock");
  const service = await startEngineBrokerServiceWithIdentity(engine, socketPath, process.getuid!());
  try { await run(new EngineBrokerControlClient(socketPath)); } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
}
const refusedWith = (code: string) => (error: unknown) => error instanceof EngineBrokerInferenceGrantRefused && error.code === code;

test("the control socket issues, refuses and releases inference grants", async () => {
  const grants = new GrokInferenceGrants({ maxLiveGrants: 1 });
  let stale = false;
  const engine: EngineBrokerServiceEngine = { ...baseEngine(), requestInferenceGrant: (request) => { if (stale) throw new GrokInferenceGrantRefused("auth_stale"); return grants.issue(request); }, releaseInferenceGrant: (grantId) => grants.release(grantId) };
  try {
    await withService(engine, async (client) => {
      const grant = await client.requestInferenceGrant({ model: "grok-4.6", reasoningEffort: "low", purpose: "judge" });
      assert.equal(grant.baseUrl, GROK_INFERENCE_PROXY_BASE_URL); assert.equal(grant.baseUrl, "http://127.0.0.1:43123/v1");
      assert.match(grant.token, /^inference_/u); assert.deepEqual(grant.limits, { maxRequests: 64, maxTokens: 2_000_000, timeoutMs: 600_000 });
      assert.ok(Date.parse(grant.expiresAt) - Date.now() <= 600_000);
      assert.ok(grants.authorize(grant.token));
      await assert.rejects(client.requestInferenceGrant({ model: "grok-4.6", reasoningEffort: "low", purpose: "optimizer" }), refusedWith("grant_limit"));
      assert.equal(await client.releaseInferenceGrant(grant.grantId), true);
      assert.equal(await client.releaseInferenceGrant(grant.grantId), false);
      assert.equal(grants.authorize(grant.token), undefined);
      stale = true;
      await assert.rejects(client.requestInferenceGrant({ model: "grok-4.6", reasoningEffort: "low", purpose: "judge" }), refusedWith("auth_stale"));
    });
  } finally { grants.close(); }
});

test("an engine without grants refuses them as unavailable, and an off-list model never reaches the engine", async () => {
  await withService(baseEngine(), async (client) => {
    await assert.rejects(client.requestInferenceGrant({ model: "grok-4.6", reasoningEffort: "low", purpose: "judge" }), refusedWith("unavailable"));
  });
  let called = false;
  await withService({ ...baseEngine(), requestInferenceGrant: () => { called = true; throw new Error("unreachable"); } }, async (client) => {
    await assert.rejects(client.requestInferenceGrant({ model: "grok-3" as "grok-4.6", reasoningEffort: "low", purpose: "judge" }), /unavailable/u);
    await assert.rejects(client.requestInferenceGrant({ model: "grok-4.6", reasoningEffort: "xhigh" as "low", purpose: "judge" }), /unavailable/u);
    await assert.rejects(client.requestInferenceGrant({ model: "grok-4.6", reasoningEffort: "low", purpose: "subject" as "judge" }), /unavailable/u);
  });
  assert.equal(called, false);
});

test("grant frames are closed and never carry tools or undeclared members", () => {
  const request = { version: V, kind: "request_inference_grant", requestId: "r1", model: "grok-4.6", reasoningEffort: "low", purpose: "judge" };
  assert.deepEqual(parseEngineBrokerRequest(request), request);
  for (const bad of [{ ...request, tools: [] }, { ...request, purpose: "subject" }, { ...request, model: "grok-3" }, { ...request, limits: { maxRequests: 1 } }, { ...request, version: "noopolis.daimon.engine-broker.v1" }]) assert.throws(() => parseEngineBrokerRequest(bad), /invalid broker frame/u);
  assert.throws(() => parseEngineBrokerRequest({ version: V, kind: "release_inference_grant", requestId: "r1", grantId: "not-hex" }), /invalid broker frame/u);
  const grant = { version: V, kind: "inference_grant", requestId: "r1", grantId: "a".repeat(32), token: `inference_${"A".repeat(43)}`, baseUrl: GROK_INFERENCE_PROXY_BASE_URL, model: "grok-4.6", reasoningEffort: "low", purpose: "judge", expiresAt: "2026-09-17T05:00:00.000Z", limits: { maxRequests: 64, maxTokens: 2_000_000, timeoutMs: 600_000 } };
  assert.deepEqual(parseEngineBrokerResponse(grant), grant);
  for (const bad of [{ ...grant, baseUrl: "http://evil:43123/v1" }, { ...grant, token: "A".repeat(53) }, { ...grant, limits: { ...grant.limits, timeoutMs: 600_001 } }, { ...grant, limits: { ...grant.limits, maxRequests: 65 } }, { ...grant, credential: "x" }]) assert.throws(() => parseEngineBrokerResponse(bad), /invalid broker frame/u);
  assert.throws(() => parseEngineBrokerResponse({ version: V, kind: "inference_grant_refused", requestId: "r1", code: "because" }), /invalid broker frame/u);
});

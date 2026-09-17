import assert from "node:assert/strict";
import test from "node:test";

import { GROK_ENGINE_BROKER } from "../contracts/runtimeContractManifest.js";
import { EngineBrokerCapabilities } from "./engineBrokerCapabilities.js";
import { GrokInferenceGrantRefused, GrokInferenceGrants } from "./grokInferenceGrants.js";
import type { InferenceUsageEntry } from "./inferenceUsageLedger.js";

const judge = { model: "grok-4.6", reasoningEffort: "low", purpose: "judge" } as const;
const refusedWith = (code: string) => (error: unknown) => error instanceof GrokInferenceGrantRefused && error.code === code;

test("a grant is scoped to its declared model, effort and purpose and carries the manifest limits", () => {
  const grants = new GrokInferenceGrants();
  try {
    const issued = grants.issue({ model: "grok-4.5", reasoningEffort: "medium", purpose: "optimizer" });
    assert.match(issued.token, /^inference_[A-Za-z0-9_-]{43}$/u); assert.match(issued.grantId, /^[a-f0-9]{32}$/u);
    assert.deepEqual(issued.limits, { maxRequests: 64, maxTokens: 2_000_000, timeoutMs: 600_000 });
    const grant = grants.authorize(issued.token);
    assert.deepEqual(grant?.policy, { model: "grok-4.5", reasoningEffort: "medium" }); assert.equal(grant?.purpose, "optimizer");
    assert.equal(grants.authorize(issued.token.replace(/.$/u, (last) => last === "A" ? "B" : "A")), undefined);
  } finally { grants.close(); }
});

test("a grant request naming an undeclared model, effort or purpose, or omitting one, is refused", () => {
  const grants = new GrokInferenceGrants();
  for (const request of [{ ...judge, model: "grok-3" }, { ...judge, reasoningEffort: "xhigh" }, { ...judge, purpose: "subject" }, { ...judge, model: undefined }, { ...judge, reasoningEffort: undefined }]) {
    assert.throws(() => grants.issue(request), refusedWith("invalid_request"));
  }
  assert.equal(grants.live(), 0);
});

test("the grant TTL can never exceed ten minutes", () => {
  assert.equal(GROK_ENGINE_BROKER.inferenceGrants.ttlMs <= 600_000, true);
  assert.throws(() => new GrokInferenceGrants({ ttlMs: 600_001 }), /invalid inference grant policy/u);
});

test("an expired grant is refused and frees its slot", () => {
  let now = 1_000_000;
  const grants = new GrokInferenceGrants({ now: () => now, maxLiveGrants: 1 });
  try {
    const issued = grants.issue(judge);
    now += 599_999; assert.ok(grants.authorize(issued.token));
    now += 1; assert.equal(grants.authorize(issued.token), undefined);
    assert.equal(grants.live(), 0); assert.ok(grants.issue(judge));
  } finally { grants.close(); }
});

test("live grants are capped and a release frees a slot", () => {
  const grants = new GrokInferenceGrants();
  try {
    const issued = Array.from({ length: GROK_ENGINE_BROKER.inferenceGrants.maxLiveGrants }, () => grants.issue(judge));
    assert.throws(() => grants.issue(judge), refusedWith("grant_limit"));
    assert.equal(grants.release(issued[3]!.grantId), true); assert.equal(grants.authorize(issued[3]!.token), undefined);
    assert.ok(grants.issue(judge)); assert.throws(() => grants.issue(judge), refusedWith("grant_limit"));
  } finally { grants.close(); }
});

test("grants never share a key space with turn capabilities", () => {
  const turnId = "0123456789abcdef0123456789abcdef";
  const capabilities = new EngineBrokerCapabilities(); const turnToken = capabilities.issue("agent-a", turnId);
  const grants = new GrokInferenceGrants({ grantId: () => turnId });
  try {
    const issued = grants.issue(judge);
    assert.equal(issued.grantId, turnId);
    assert.deepEqual(capabilities.inspectToken(turnToken), { agentId: "agent-a", turnId });
    assert.equal(capabilities.inspectToken(issued.token), undefined);
    assert.equal(grants.authorize(turnToken), undefined);
    capabilities.revoke(turnId); assert.ok(grants.authorize(issued.token));
    grants.release(turnId); assert.equal(capabilities.inspectToken(turnToken), undefined);
  } finally { grants.close(); }
});

test("a grant meters one request at a time and emits one row per settled request, estimated when usage is missing", () => {
  const rows: InferenceUsageEntry[] = [];
  const grants = new GrokInferenceGrants({ onSettled: (row) => rows.push(row) });
  try {
    const grant = grants.authorize(grants.issue(judge).token)!;
    const first = grant.meter.admit(); assert.ok("index" in first);
    assert.deepEqual(grant.meter.admit(), { busy: true });
    grants.settle(grant, first.index, { input: 90, cacheRead: 10, cacheWrite: 0, output: 5, total: 105 }, 400);
    grants.settle(grant, first.index, { input: 1, cacheRead: 0, cacheWrite: 0, output: 1, total: 2 }, 400);
    const second = grant.meter.admit(); assert.ok("index" in second);
    grants.settle(grant, second.index, undefined, 1_000);
    assert.deepEqual(rows.map((row) => [row.request, row.usage.total, row.usageSource, row.purpose, row.model]), [[0, 105, "upstream", "judge", "grok-4.6"], [1, 4_596, "estimated", "judge", "grok-4.6"]]);
  } finally { grants.close(); }
});

test("releasing a grant aborts its in-flight upstream request", () => {
  const grants = new GrokInferenceGrants();
  const issued = grants.issue(judge); const grant = grants.authorize(issued.token)!;
  const admission = grant.meter.admit(); assert.ok("signal" in admission);
  grants.release(issued.grantId);
  assert.equal(admission.signal.aborted, true);
});

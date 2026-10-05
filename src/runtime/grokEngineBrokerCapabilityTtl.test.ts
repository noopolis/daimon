import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { EngineBrokerCapabilities } from "./engineBrokerCapabilities.js";
import type { EngineBrokerServiceRegistration } from "./engineBrokerServiceConfig.js";
import { EngineBrokerTurnRegistry } from "./engineBrokerTurnRegistry.js";
import { runGrokEngineBrokerTurn, type GrokEngineBrokerTurnDependencies } from "./grokEngineBrokerTurn.js";

// 2026-10-05: production declared a 30-minute turn, but both the provider and
// the MCP capability were issued for a fixed 15 minutes. Every turn that ran
// past 15 minutes lost its tools mid-write (MCP 403, mcp_refused=expired) and
// then timed out without filing. A capability must outlive the turn it serves.
const runWith = async (timeoutMs: number, overrides?: Parameters<typeof runGrokEngineBrokerTurn>[6]) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-capability-ttl-"));
  const issued: { provider?: number; mcp?: number } = {};
  try {
    const registration: EngineBrokerServiceRegistration = { agentId: "cogsworth", slot: 0, workerUid: 2_200, workspace: "/workspace", profilePath: "/workers/0/.grok/sandbox.toml", eventsPath: "/workers/0/.grok/sessions/sandbox-events.jsonl", profileSha256: "a".repeat(64), usageLedgerPath: path.join(root, "usage.jsonl"), limits: { maxRequests: 32, maxTokens: 300_000, timeoutMs }, model: { model: "grok-4.6", reasoningEffort: "low" } };
    const deps: GrokEngineBrokerTurnDependencies = {
      turns: new EngineBrokerTurnRegistry(path.join(root, "turns")),
      proxy: {
        capabilities: { issue: (_agent, _turn, ttlMs) => { issued.provider = ttlMs; return "provider-capability"; }, revoke: () => undefined },
        registerIsolationGuard: () => undefined, revokeIsolationGuard: () => undefined, registerTurn: () => undefined, revokeTurn: () => undefined
      },
      mcp: { register: (_agent, _turn, _endpoint, ttlMs) => { issued.mcp = ttlMs; return "mcp-capability-0123456789abcdef"; }, revoke: () => undefined },
      credentialStale: () => false,
      prepareIsolation: async () => async () => undefined,
      runNative: async () => { throw new Error("worker not needed: the capabilities were already issued"); }
    };
    await runGrokEngineBrokerTurn(deps, registration, "wake-ttl", "prompt", "http://127.0.0.1:43124/mcp", undefined, overrides).catch(() => undefined);
    return issued;
  } finally { await rm(root, { recursive: true, force: true }); }
};

test("both capabilities outlive a 30-minute turn instead of expiring at 15 minutes", async () => {
  const issued = await runWith(1_800_000);
  assert.ok(issued.provider !== undefined && issued.provider > 1_800_000, `provider capability ttl ${issued.provider} must exceed the 30-minute turn`);
  assert.ok(issued.mcp !== undefined && issued.mcp > 1_800_000, `MCP capability ttl ${issued.mcp} must exceed the 30-minute turn`);
});

test("a wake that lowers the timeout lowers the capability lifetime with it", async () => {
  const issued = await runWith(1_800_000, { timeoutMs: 60_000 });
  assert.ok(issued.provider !== undefined && issued.provider > 60_000 && issued.provider < 1_800_000, `provider ttl ${issued.provider}`);
  assert.equal(issued.mcp, issued.provider, "both capabilities serve one turn and share one lifetime");
});

test("an issued grant is still authorized after the old fixed 15-minute horizon", () => {
  const capabilities = new EngineBrokerCapabilities();
  const realNow = Date.now;
  try {
    const start = realNow();
    Date.now = () => start;
    const token = capabilities.issue("agent:cogsworth", "turn-1", 1_800_000 + 60_000);
    Date.now = () => start + 16 * 60_000;
    assert.equal(capabilities.authorize("agent:cogsworth", "turn-1", token), true);
  } finally { Date.now = realNow; }
});

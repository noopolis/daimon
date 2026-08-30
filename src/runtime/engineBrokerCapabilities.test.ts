import assert from "node:assert/strict";
import test from "node:test";
import { EngineBrokerCapabilities } from "./engineBrokerCapabilities.js";

test("broker capabilities are opaque, scoped, bounded and revocable", () => {
  const capabilities = new EngineBrokerCapabilities(); const token = capabilities.issue("agent-a", "turn-a", 60_000, 2);
  assert.equal(token.length >= 40, true); assert.equal(capabilities.authorize("agent-a", "turn-a", token), true);
  assert.equal(capabilities.authorize("agent-b", "turn-a", token), false); assert.equal(capabilities.authorize("agent-a", "turn-a", "wrong"), false);
  assert.equal(capabilities.authorize("agent-a", "turn-a", token), true); assert.equal(capabilities.authorize("agent-a", "turn-a", token), false);
  capabilities.revoke("turn-a"); assert.equal(capabilities.authorize("agent-a", "turn-a", token), false);
});
test("proxy resolves scope from opaque token without caller identity", () => {
  const capabilities = new EngineBrokerCapabilities(); const token = capabilities.issue("agent-a", "turn-a");
  assert.deepEqual(capabilities.authorizeToken(token), { agentId: "agent-a", turnId: "turn-a" });
});

import assert from "node:assert/strict";
import test from "node:test";
import { EngineBrokerCapabilities } from "./engineBrokerCapabilities.js";
import { authorizeGrokBrokerProxyRequest } from "./grokBrokerProxyRequest.js";

const body = Buffer.from(JSON.stringify({ stream: true, messages: [] }));

test("proxy substitutes broker bearer, forwards bounded Grok client version, and rejects arbitrary routes and headers", () => {
  const caps = new EngineBrokerCapabilities(); const opaque = caps.issue("a", "t");
  const request = authorizeGrokBrokerProxyRequest({ method: "POST", pathname: "/v1/chat/completions", headers: { authorization: `Bearer ${opaque}`, cookie: "forbidden", "x-grok-client-version": "1.0.25", "x-grok-client-identifier": "attacker" }, body, agentId: "a", turnId: "t" }, caps, "real-bearer");
  assert.equal(request.url, "https://cli-chat-proxy.grok.com/v1/chat/completions");
  assert.equal(request.headers.authorization, "Bearer real-bearer");
  assert.equal(request.headers["x-grok-client-version"], "1.0.25");
  assert.equal(request.headers["x-grok-client-identifier"], "grok-shell");
  assert.equal("cookie" in request.headers, false);
  assert.throws(() => authorizeGrokBrokerProxyRequest({ method: "GET", pathname: "/", headers: { authorization: `Bearer ${opaque}`, "x-grok-client-version": "1.0.25" }, body, agentId: "a", turnId: "t" }, caps, "real-bearer"), /rejected/);
});

test("proxy fails closed when the worker omits or malforms the Grok client version", () => {
  for (const version of [undefined, "", "1", "1.0", "v1.0.25", "1.0.25\nInjected: yes", "1.0.25+build", `1.2.3-${"a".repeat(65)}`] as const) {
    const caps = new EngineBrokerCapabilities(); const opaque = caps.issue("a", "t");
    assert.throws(() => authorizeGrokBrokerProxyRequest({ method: "POST", pathname: "/v1/chat/completions", headers: { authorization: `Bearer ${opaque}`, ...(version === undefined ? {} : { "x-grok-client-version": version }) }, body, agentId: "a", turnId: "t" }, caps, "real-bearer"), /rejected/);
  }
});

test("proxy accepts prerelease Grok client versions", () => {
  const caps = new EngineBrokerCapabilities(); const opaque = caps.issue("a", "t");
  const request = authorizeGrokBrokerProxyRequest({ method: "POST", pathname: "/v1/chat/completions", headers: { authorization: `Bearer ${opaque}`, "x-grok-client-version": "1.0.25-beta.1" }, body, agentId: "a", turnId: "t" }, caps, "real-bearer");
  assert.equal(request.headers["x-grok-client-version"], "1.0.25-beta.1");
});

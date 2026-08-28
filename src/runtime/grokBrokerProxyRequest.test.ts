import assert from "node:assert/strict";
import test from "node:test";
import { EngineBrokerCapabilities } from "./engineBrokerCapabilities.js";
import { authorizeGrokBrokerProxyRequest } from "./grokBrokerProxyRequest.js";

test("proxy substitutes broker bearer and rejects arbitrary routes and headers", () => {
  const caps = new EngineBrokerCapabilities(); const opaque = caps.issue("a", "t"); const body = Buffer.from(JSON.stringify({ stream: true, messages: [] }));
  const request = authorizeGrokBrokerProxyRequest({ method: "POST", pathname: "/v1/chat/completions", headers: { authorization: `Bearer ${opaque}`, cookie: "forbidden" }, body, agentId: "a", turnId: "t" }, caps, "real-bearer");
  assert.equal(request.url, "https://cli-chat-proxy.grok.com/v1/chat/completions"); assert.equal(request.headers.authorization, "Bearer real-bearer"); assert.equal("cookie" in request.headers, false);
  assert.throws(() => authorizeGrokBrokerProxyRequest({ method: "GET", pathname: "/", headers: { authorization: `Bearer ${opaque}` }, body, agentId: "a", turnId: "t" }, caps, "real-bearer"), /rejected/);
});

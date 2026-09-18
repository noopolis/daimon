import assert from "node:assert/strict";
import { createServer } from "node:http";

import test from "node:test";

import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

import { ENGINE_BROKER_MCP_FACADE_PORT } from "./engineBrokerMcpFacade.js";

import { connectClient, FACADE_URL, releaseShared, sharedFacade, startFacade, startRig, withDeadline } from "./engineBrokerMcpFacadeRig.test.js";

test("MCP facade routes only valid active capabilities to the registered mount", async () => {
  const facade=await sharedFacade();
  let calls=0;const target=createServer((_request,response)=>{calls++;response.writeHead(200,{"content-type":"application/json"});response.end('{"ok":true}');});await new Promise<void>((resolve)=>target.listen(0,"127.0.0.1",resolve));const address=target.address();if(address===null||typeof address==="string")throw new Error();
  const token=facade.register("agent","turn-capabilities",`http://127.0.0.1:${address.port}/mcp`);const call=(value:string)=>fetch(FACADE_URL,{method:"POST",headers:{authorization:`Bearer ${value}`,"content-type":"application/json"},body:"{}"});
  try{assert.equal((await call("wrong-token-abcdefghijklmnopqrstuvwxyz0123456789")).status,403);assert.equal((await call(token)).status,200);assert.equal(calls,1);facade.revoke("turn-capabilities");assert.equal((await call(token)).status,403);assert.equal(calls,1);}finally{facade.revoke("turn-capabilities");await new Promise<void>((resolve)=>target.close(()=>resolve()));}
});

test("a brokered worker completes the whole MCP handshake through the facade and calls a mounted tool", async () => {
  const rig = await startRig();
  try {
    // connect() is initialize + notifications/initialized: before the session
    // header was forwarded the notification came back HTTP 400.
    const { client, transport } = await connectClient(rig.capability);
    try {
      assert.equal(typeof transport.sessionId, "string", "the mount's session id must reach the client");
      const listed = await client.listTools();
      assert.deepEqual(listed.tools.map((tool) => tool.name), ["moltnet_read"]);
      const called = await client.callTool({ name: "moltnet_read", arguments: { target: "room:desk" } });
      assert.deepEqual(called.structuredContent, { target: "room:desk" });
      assert.equal(called.isError, undefined);
    } finally {
      await client.close();
    }
  } finally {
    await rig.close();
  }
});

test("the facade carries the mount's server-initiated SSE stream, which only the GET route provides", async () => {
  const rig = await startRig();
  try {
    const { client, transport } = await connectClient(rig.capability);
    const notified = new Promise<void>((resolve) => client.setNotificationHandler(ToolListChangedNotificationSchema, () => resolve()));
    try {
      // The standalone GET stream is the only route a server notification can
      // take; a POST-only facade answers it 403 and this never arrives.
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
      rig.server.sendToolListChanged();
      await withDeadline(notified, 4_000, "no server notification reached the client");
      assert.ok(rig.observed.some((request) => request.method === "GET"), "the mount must have seen the GET stream");
      assert.equal(typeof transport.sessionId, "string");
    } finally {
      await client.close();
    }
  } finally {
    await rig.close();
  }
});

test("the facade carries the session-closing DELETE, and the mount then refuses the stale session", async () => {
  const rig = await startRig();
  try {
    const { client, transport } = await connectClient(rig.capability);
    const sessionId = transport.sessionId;
    assert.equal(typeof sessionId, "string");
    await transport.terminateSession();
    assert.equal(transport.sessionId, undefined, "DELETE must be accepted, not 403ed");
    assert.ok(rig.observed.some((request) => request.method === "DELETE"), "the mount must have seen the DELETE");
    const stale = await fetch(FACADE_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${rig.capability}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": sessionId!
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list", params: {} })
    });
    assert.ok(stale.status >= 400, `a terminated session must not still route (got ${stale.status})`);
    await stale.body?.cancel();
    await client.close().catch(() => undefined);
  } finally {
    await rig.close();
  }
});

test("the facade forwards a closed header allowlist and never the worker's bearer", async () => {
  const rig = await startRig();
  try {
    const { client } = await connectClient(rig.capability);
    await client.listTools();
    await client.close();
    const forwarded = rig.observed.flatMap((request) => Object.keys(request.headers));
    assert.equal(forwarded.includes("authorization"), false, "the turn capability must never reach the mount");
    assert.equal(forwarded.includes("cookie"), false);
    const allowed = new Set([
      "host", "connection", "content-length", "transfer-encoding", "accept-encoding", "accept-language", "user-agent",
      "content-type", "accept", "mcp-session-id", "mcp-protocol-version", "last-event-id",
      // undici's own outbound header, set by the facade's fetch rather than forwarded from the worker.
      "sec-fetch-mode"
    ]);
    const unexpected = [...new Set(forwarded)].filter((name) => !allowed.has(name));
    assert.deepEqual(unexpected, [], `unexpected headers reached the mount: ${unexpected.join(",")}`);
  } finally {
    await rig.close();
  }
});

test("the facade withholds a mount response header that is not on the allowlist", async () => {
  // The facade comes first: nothing must be listening while the fixed port is
  // still in doubt, or a refused start leaks this mount and parks the runner.
  const facade = await sharedFacade();
  const target = createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "application/json",
      "mcp-session-id": "session-from-mount",
      "set-cookie": "leak=1",
      "www-authenticate": "Bearer realm=\"mount\"",
      "x-mount-internal": "private"
    });
    response.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  const address = target.address();
  if (address === null || typeof address === "string") throw new Error("target address unavailable");
  const capability = facade.register("alpha", "turn-response-headers", `http://127.0.0.1:${address.port}/mcp`);
  try {
    const answered = await fetch(FACADE_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${capability}`, "content-type": "application/json" },
      body: "{}"
    });
    assert.equal(answered.status, 200);
    assert.equal(answered.headers.get("mcp-session-id"), "session-from-mount");
    assert.equal(answered.headers.get("cache-control"), "no-store");
    assert.equal(answered.headers.get("set-cookie"), null);
    assert.equal(answered.headers.get("www-authenticate"), null);
    assert.equal(answered.headers.get("x-mount-internal"), null);
    await answered.body?.cancel();
  } finally {
    facade.revoke("turn-response-headers");
    await new Promise<void>((resolve) => target.close(() => resolve()));
  }
});

test("the facade still refuses every route and method outside the MCP surface", async () => {
  const facade = await sharedFacade();
  const capability = facade.register("alpha", "turn-refusals", "http://127.0.0.1:1/mcp");
  const call = (method: string, path: string) => fetch(`http://127.0.0.1:${ENGINE_BROKER_MCP_FACADE_PORT}${path}`, {
    method, headers: { authorization: `Bearer ${capability}` }
  });
  try {
    assert.equal((await call("GET", "/")).status, 403);
    assert.equal((await call("GET", "/mcp?probe=1")).status, 403);
    assert.equal((await call("PUT", "/mcp")).status, 403);
    assert.equal((await call("PATCH", "/mcp")).status, 403);
    assert.equal((await fetch(`http://127.0.0.1:${ENGINE_BROKER_MCP_FACADE_PORT}/mcp`, { method: "GET" })).status, 403);
  } finally {
    facade.revoke("turn-refusals");
  }
});

/**
 * Last, because both cases take the fixed port for themselves: an open GET
 * tunnel must not survive its own capability, and must not stall shutdown
 * either — a server-to-client stream stays open for the whole session, so
 * before it existed nothing could hold the listener open.
 */
test("revoking a turn tears down its open server-to-client stream, and closing never stalls on one", async () => {
  await releaseShared();
  const facade = await startFacade();
  const rig = await startRig(facade);
  const { client } = await connectClient(rig.capability);
  await new Promise<void>((resolve) => setTimeout(resolve, 150));
  assert.ok(rig.observed.some((request) => request.method === "GET"), "the GET stream must be open before revoking");

  // The client's stream survives its own capability unless the facade ends the
  // tunnel: the mount's GET response is the side that has to close.
  facade.revoke(rig.turnId);
  await withDeadline(rig.getStreamClosed, 4_000, "a revoked capability left its SSE tunnel open");

  // A second turn's tunnel, deliberately left open, is what shutdown must not wait on.
  const second = await startRig(facade);
  const held = await connectClient(second.capability);
  await new Promise<void>((resolve) => setTimeout(resolve, 150));
  await withDeadline(facade.close(), 3_000, "closing the facade stalled on an open SSE tunnel");

  await held.client.close().catch(() => undefined);
  await client.close().catch(() => undefined);
  await second.close().catch(() => undefined);
  await rig.close().catch(() => undefined);
});

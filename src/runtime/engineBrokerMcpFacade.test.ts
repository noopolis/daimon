import assert from "node:assert/strict";
import { createServer, type Server as HttpServer, type IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";

import { createPiToolMcpServer } from "../mcp/toolServer.js";
import { ENGINE_BROKER_MCP_FACADE_PORT, startEngineBrokerMcpFacade } from "./engineBrokerMcpFacade.js";

const FACADE_URL = `http://127.0.0.1:${ENGINE_BROKER_MCP_FACADE_PORT}/mcp`;

test("MCP facade routes only valid active capabilities to the registered mount", async () => {
  let calls=0;const target=createServer((_request,response)=>{calls++;response.writeHead(200,{"content-type":"application/json"});response.end('{"ok":true}');});await new Promise<void>((resolve)=>target.listen(0,"127.0.0.1",resolve));const address=target.address();if(address===null||typeof address==="string")throw new Error();
  const facade=await startEngineBrokerMcpFacade();const token=facade.register("agent","turn",`http://127.0.0.1:${address.port}/mcp`);const call=(value:string)=>fetch(FACADE_URL,{method:"POST",headers:{authorization:`Bearer ${value}`,"content-type":"application/json"},body:"{}"});
  try{assert.equal((await call("wrong-token-abcdefghijklmnopqrstuvwxyz0123456789")).status,403);assert.equal((await call(token)).status,200);assert.equal(calls,1);facade.revoke("turn");assert.equal((await call(token)).status,403);assert.equal(calls,1);}finally{await facade.close();await new Promise<void>((resolve)=>target.close(()=>resolve()));}
});

/**
 * The brokered worker's real route: a real Daimon MCP mount behind a real
 * Streamable HTTP transport, reached by a real MCP client through the facade.
 * Asserting that a header is copied would pass while the route stayed broken,
 * so every case below drives the transport end to end.
 */
type Rig = Readonly<{
  facade: Awaited<ReturnType<typeof startEngineBrokerMcpFacade>>;
  mount: HttpServer;
  transport: StreamableHTTPServerTransport;
  server: ReturnType<typeof createPiToolMcpServer>;
  capability: string;
  observed: IncomingMessage[];
  close: () => Promise<void>;
}>;

const echoTool = defineTool({
  name: "moltnet_read",
  label: "Read a scoped Moltnet surface",
  description: "Reads the fixture room.",
  parameters: Type.Object({ target: Type.String() }, { additionalProperties: false }),
  async execute(_toolCallId: string, params: { target: string }) {
    return { content: [{ type: "text" as const, text: `read ${params.target}` }], details: { target: params.target } };
  }
});

const startRig = async (): Promise<Rig> => {
  const server = createPiToolMcpServer([echoTool], {});
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  await server.connect(transport);
  const observed: IncomingMessage[] = [];
  const mount = createServer((request, response) => {
    observed.push(request);
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks);
      let parsed: unknown;
      try { parsed = raw.length === 0 ? undefined : JSON.parse(raw.toString("utf8")); } catch { parsed = undefined; }
      void transport.handleRequest(request, response, parsed);
    });
  });
  await new Promise<void>((resolve) => mount.listen(0, "127.0.0.1", resolve));
  const address = mount.address();
  if (address === null || typeof address === "string") throw new Error("mount address unavailable");
  const facade = await startEngineBrokerMcpFacade();
  const capability = facade.register("alpha", "turn-1", `http://127.0.0.1:${address.port}/mcp`);
  return {
    facade, mount, transport, server, capability, observed,
    close: async () => {
      facade.revoke("turn-1");
      await facade.close();
      await new Promise<void>((resolve) => mount.close(() => resolve()));
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  };
};

const connectClient = async (capability: string): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> => {
  const transport = new StreamableHTTPClientTransport(new URL(FACADE_URL), {
    requestInit: { headers: { authorization: `Bearer ${capability}` } }
  });
  const client = new Client({ name: "daimon-facade-test-client", version: "0.1.0" });
  await client.connect(transport);
  return { client, transport };
};

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
      await Promise.race([
        notified,
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("no server notification reached the client")), 4_000))
      ]);
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
    const allowed = new Set(["host", "connection", "content-length", "transfer-encoding", "accept-encoding", "accept-language", "user-agent", "content-type", "accept", "mcp-session-id", "mcp-protocol-version", "last-event-id",
      // undici's own outbound headers, set by the facade's fetch rather than forwarded from the worker.
      "sec-fetch-mode"]);
    const unexpected = [...new Set(forwarded)].filter((name) => !allowed.has(name));
    assert.deepEqual(unexpected, [], `unexpected headers reached the mount: ${unexpected.join(",")}`);
  } finally {
    await rig.close();
  }
});

test("the facade withholds a mount response header that is not on the allowlist", async () => {
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
  const facade = await startEngineBrokerMcpFacade();
  const capability = facade.register("alpha", "turn-1", `http://127.0.0.1:${address.port}/mcp`);
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
    facade.revoke("turn-1");
    await facade.close();
    await new Promise<void>((resolve) => target.close(() => resolve()));
  }
});

test("the facade still refuses every route and method outside the MCP surface", async () => {
  const facade = await startEngineBrokerMcpFacade();
  const capability = facade.register("alpha", "turn-1", "http://127.0.0.1:1/mcp");
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
    facade.revoke("turn-1");
    await facade.close();
  }
});

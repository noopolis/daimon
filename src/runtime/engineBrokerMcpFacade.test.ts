import assert from "node:assert/strict";
import { createServer, type Server as HttpServer, type IncomingMessage } from "node:http";
import { connect, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";

import { createPiToolMcpServer } from "../mcp/toolServer.js";
import { awaitMcpTunnelDrain, ENGINE_BROKER_MCP_FACADE_PORT, startEngineBrokerMcpFacade } from "./engineBrokerMcpFacade.js";

const FACADE_URL = `http://127.0.0.1:${ENGINE_BROKER_MCP_FACADE_PORT}/mcp`;
type Facade = Awaited<ReturnType<typeof startEngineBrokerMcpFacade>>;

/**
 * One facade serves every turn of a broker, so the tests share one too. It
 * also keeps the fixed port free: a facade per test would leave the HTTP
 * client pooling a socket onto a server that no longer exists.
 */
let shared: Facade | undefined;
const sharedFacade = async (): Promise<Facade> => (shared ??= await startFacade());
const releaseShared = async (): Promise<void> => { const facade = shared; shared = undefined; if (facade) await facade.close(); };
test.after(releaseShared);

/**
 * Closing a facade destroys its sockets, and the port is fixed, so the HTTP
 * client can still hold a pooled connection to the server that just went away.
 * That is a test-harness artifact — one facade outlives a whole broker — so a
 * fresh facade is probed until a refusal proves the route is live again.
 */
const startFacade = async (): Promise<Facade> => {
  const facade = await startEngineBrokerMcpFacade();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const probe = await fetch(FACADE_URL, { method: "PUT" });
      await probe.body?.cancel();
      if (probe.status === 403) return facade;
    } catch { /* a pooled socket onto the previous facade: try the next one */ }
  }
  throw new Error("facade did not answer after starting");
};

test("MCP facade routes only valid active capabilities to the registered mount", async () => {
  let calls=0;const target=createServer((_request,response)=>{calls++;response.writeHead(200,{"content-type":"application/json"});response.end('{"ok":true}');});await new Promise<void>((resolve)=>target.listen(0,"127.0.0.1",resolve));const address=target.address();if(address===null||typeof address==="string")throw new Error();
  const facade=await sharedFacade();const token=facade.register("agent","turn-capabilities",`http://127.0.0.1:${address.port}/mcp`);const call=(value:string)=>fetch(FACADE_URL,{method:"POST",headers:{authorization:`Bearer ${value}`,"content-type":"application/json"},body:"{}"});
  try{assert.equal((await call("wrong-token-abcdefghijklmnopqrstuvwxyz0123456789")).status,403);assert.equal((await call(token)).status,200);assert.equal(calls,1);facade.revoke("turn-capabilities");assert.equal((await call(token)).status,403);assert.equal(calls,1);}finally{facade.revoke("turn-capabilities");await new Promise<void>((resolve)=>target.close(()=>resolve()));}
});

/**
 * The brokered worker's real route: a real Daimon MCP mount behind a real
 * Streamable HTTP transport, reached by a real MCP client through the facade.
 * Asserting that a header is copied would pass while the route stayed broken,
 * so every case below drives the transport end to end.
 */
type Rig = Readonly<{
  facade: Facade;
  turnId: string;
  server: ReturnType<typeof createPiToolMcpServer>;
  capability: string;
  observed: IncomingMessage[];
  /** Resolves when the mount's standalone GET stream is torn down. */
  getStreamClosed: Promise<void>;
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

let turns = 0;

const startRig = async (facade?: Facade): Promise<Rig> => {
  const host = facade ?? await sharedFacade();
  const turnId = `turn-${++turns}`;
  const server = createPiToolMcpServer([echoTool], {});
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  await server.connect(transport);
  const observed: IncomingMessage[] = [];
  let noteGetStreamClosed = (): void => undefined;
  const getStreamClosed = new Promise<void>((resolve) => { noteGetStreamClosed = resolve; });
  const mount = createServer((request, response) => {
    observed.push(request);
    if (request.method === "GET") response.on("close", () => noteGetStreamClosed());
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
  const capability = host.register("alpha", turnId, `http://127.0.0.1:${address.port}/mcp`);
  return {
    facade: host, turnId, server, capability, observed, getStreamClosed,
    close: async () => {
      host.revoke(turnId);
      await closeMount(mount, transport, server);
    }
  };
};

const closeMount = async (mount: HttpServer, transport: StreamableHTTPServerTransport, server: ReturnType<typeof createPiToolMcpServer>): Promise<void> => {
  mount.closeAllConnections();
  await new Promise<void>((resolve) => mount.close(() => resolve()));
  await transport.close().catch(() => undefined);
  await server.close().catch(() => undefined);
};

const connectClient = async (capability: string): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> => {
  const transport = new StreamableHTTPClientTransport(new URL(FACADE_URL), {
    requestInit: { headers: { authorization: `Bearer ${capability}` } }
  });
  const client = new Client({ name: "daimon-facade-test-client", version: "0.1.0" });
  await client.connect(transport);
  return { client, transport };
};

const withDeadline = async <T>(work: Promise<T>, ms: number, reason: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(reason)), ms); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
  const facade = await sharedFacade();
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

/**
 * The relay parks on this await whenever a tunnel is backpressured, and a
 * parked await is invisible from outside: no status, no refusal, no line. So
 * the assertion is that it settles at all — on a client that hung up
 * mid-write, on the turn's abort, and on a genuine drain — with a deadline
 * standing in for the hang.
 */
test("a backpressured MCP tunnel always settles: on a hang-up, on the turn's abort, and on a real drain", async () => {
  const parked = new Map<string, Promise<string>>();
  // One controller per phase: the turn whose abort is under test must not be
  // the turn that is still relaying.
  const controllers = new Map<string, AbortController>();
  const server = createServer((request, response) => {
    const phase = request.url ?? "";
    const controller = new AbortController(); controllers.set(phase, controller);
    response.writeHead(200, { "content-type": "text/event-stream" });
    // A paused client cannot absorb this, so `write` reports backpressure and
    // the relay would park exactly here.
    response.write("data: open\n\n");
    if (phase === "/drain") assert.equal(response.write(Buffer.alloc(16 * 1024 * 1024, 0x61)), false, "a paused client must backpressure the tunnel");
    parked.set(phase, awaitMcpTunnelDrain(response, controller.signal).then(() => "drained", (error: Error) => error.message));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (address === null || typeof address === "string") throw new Error();
  const open = (phase: string): Promise<Socket> => new Promise((resolve) => {
    const socket = connect(address.port, "127.0.0.1", () => socket.write(`GET ${phase} HTTP/1.1\r\nhost: facade\r\n\r\n`));
    socket.once("data", () => { socket.pause(); resolve(socket); });
  });
  const settled = (phase: string): Promise<string> => withDeadline(parked.get(phase)!, 3_000, `the ${phase} await never settled: the relay is parked`);
  const sockets: Socket[] = [];
  try {
    sockets.push(await open("/hangup"));
    sockets[0]!.destroy();
    assert.equal(await settled("/hangup"), "MCP tunnel closed", "a client that hung up mid-write wakes the await");
    sockets.push(await open("/abort"));
    controllers.get("/abort")!.abort();
    assert.equal(await settled("/abort"), "MCP tunnel aborted", "the turn's own abort wakes the await");
    const draining = await open("/drain");
    sockets.push(draining);
    draining.resume();
    assert.equal(await settled("/drain"), "drained", "a client that resumes reading resolves the await");
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

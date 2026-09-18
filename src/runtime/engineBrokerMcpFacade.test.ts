import assert from "node:assert/strict";
import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from "node:http";

import { randomUUID } from "node:crypto";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";

import { createPiToolMcpServer } from "../mcp/toolServer.js";
import type { EngineBrokerMcpTunnelObservation } from "./engineBrokerMcpCallLog.js";
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
  const facade=await sharedFacade();
  let calls=0;const target=createServer((_request,response)=>{calls++;response.writeHead(200,{"content-type":"application/json"});response.end('{"ok":true}');});await new Promise<void>((resolve)=>target.listen(0,"127.0.0.1",resolve));const address=target.address();if(address===null||typeof address==="string")throw new Error();
  const token=facade.register("agent","turn-capabilities",`http://127.0.0.1:${address.port}/mcp`);const call=(value:string)=>fetch(FACADE_URL,{method:"POST",headers:{authorization:`Bearer ${value}`,"content-type":"application/json"},body:"{}"});
  try{assert.equal((await call("wrong-token-abcdefghijklmnopqrstuvwxyz0123456789")).status,403);assert.equal((await call(token)).status,200);assert.equal(calls,1);facade.revoke("turn-capabilities");assert.equal((await call(token)).status,403);assert.equal(calls,1);}finally{facade.revoke("turn-capabilities");await new Promise<void>((resolve)=>target.close(()=>resolve()));}
});

/**
 * Daimon writes a tool receipt only on completion, so a call that started and
 * never returned reads exactly like a call that was never made — the one path
 * a seven-minute live hang left unlit. The facade is where that difference is
 * visible, and it has to survive the tear-down that ends the turn: a tunnel
 * destroyed when the worker dies must not mark the call it was blocked on as
 * answered, or the instrument erases the very evidence it exists to keep.
 */
test("MCP facade reports a tool call that started and never returned as outstanding, by name", async () => {
  const facade = await sharedFacade();
  const held: ServerResponse[] = [];
  // Two ways for a mount not to answer: never reply at all (`moltnet_read`),
  // or open the stream and never deliver the result (`memory_recall`).
  const target = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const asked = Buffer.concat(chunks).toString("utf8");
      if (asked.includes("moltnet_read")) { held.push(response); return; }
      if (asked.includes("memory_recall")) { response.writeHead(200, { "content-type": "text/event-stream" }); response.write(": open\n\n"); held.push(response); return; }
      response.writeHead(200, { "content-type": "application/json" }); response.end('{"jsonrpc":"2.0","id":1,"result":{}}');
    });
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  const address = target.address(); if (address === null || typeof address === "string") throw new Error();
  const turnId = "turn-outstanding", token = facade.register("agent", turnId, `http://127.0.0.1:${address.port}/mcp`);
  const post = (name: string, signal?: AbortSignal): Promise<Response> => fetch(FACADE_URL, { method: "POST", signal, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { text: "argument-bytes-that-must-never-be-recorded" } } }) });
  const pending = new AbortController();
  /**
   * A live call's elapsed time grows with every read, so two identical reads
   * mean every relay has settled — the only moment at which "answered" is
   * final. Polling for a name instead would read the log mid-teardown.
   */
  const settled = async (): Promise<ReturnType<typeof facade.observe>> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const before = JSON.stringify(facade.observe(turnId));
      await new Promise<void>((resolve) => setTimeout(resolve, 60));
      if (JSON.stringify(facade.observe(turnId)) === before) return facade.observe(turnId);
    }
    throw new Error("the facade's observation never settled");
  };
  const names = (observed: ReturnType<typeof facade.observe>): readonly string[] => (observed?.outstanding ?? []).map((call) => call.name);
  try {
    const answered = await post("daimon__moltnet_send");
    assert.equal(answered.status, 200); await answered.text();
    const hanging = post("daimon__moltnet_read", pending.signal).catch(() => undefined);
    for (let attempt = 0; attempt < 200 && held.length === 0; attempt += 1) await new Promise<void>((resolve) => setTimeout(resolve, 25));
    assert.equal(held.length, 1, "the mount never received the hung tool call");

    const observed = facade.observe(turnId);
    assert.deepEqual(names(observed), ["daimon__moltnet_read"], "the unanswered call must be outstanding, by name");
    assert.equal(observed?.started, 2); assert.equal(observed?.answered, 1, "the completed call must not be outstanding"); assert.equal(observed?.undecoded, 0);
    assert.ok((observed?.outstanding[0]?.outstandingMs ?? -1) >= 0, "an outstanding call reports how long it has been waiting");
    assert.ok(!JSON.stringify(observed).includes("argument-bytes"), "names and timings only: no arguments");

    // The turn's own death tears the tunnel down. The call was still never
    // answered, and must still say so.
    pending.abort(); await hanging;
    const afterTeardown = await settled();
    assert.deepEqual(names(afterTeardown), ["daimon__moltnet_read"], "a torn-down relay is not an answer");
    assert.equal(afterTeardown?.answered, 1);

    // A stream the facade opened and never finished relaying is not an answer
    // either. Awaiting the headers and one chunk puts the facade inside its own
    // streaming relay before the client walks away, which is the branch that
    // decides whether a half-written tunnel counts as an answer.
    const halted = new AbortController();
    const half = await post("memory_recall", halted.signal);
    assert.equal(half.status, 200); await half.body!.getReader().read(); halted.abort();
    const afterHalfRelay = await settled();
    assert.deepEqual(names(afterHalfRelay), ["daimon__moltnet_read", "memory_recall"], "a half-relayed stream is not an answer");
    assert.equal(afterHalfRelay?.answered, 1);

    facade.revoke(turnId);
    assert.equal(facade.observe(turnId), undefined, "a turn the facade never registered observes as absence, not as zero");
  } finally {
    pending.abort(); facade.revoke(turnId);
    for (const response of held) response.destroy();
    target.closeAllConnections();
    await new Promise<void>((resolve) => target.close(() => resolve()));
  }
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

/**
 * The channel the call log could not see.
 *
 * A brokered turn's tool calls all answer and its provider requests all close,
 * and the worker can still sit idle to the deadline — parked on the standalone
 * GET SSE tunnel, which stays open for the whole session and, until now, wrote
 * nothing anywhere. This drives the real transport: the tunnel the real client
 * opens must observe as open with an age while it is open, as *delivered* once
 * the mount pushes a frame through it, and as closed once the client ends it.
 *
 * Mutation: remove `calls.openTunnel` from the facade's route and the first
 * assertion goes red (an open tunnel reads as a turn that opened none); remove
 * `tunnel?.close()` from the relay's `finally` and the last one does (a closed
 * tunnel reads as still open, which is the reading the whole instrument is
 * meant to make trustworthy).
 */
test("the facade observes the standalone GET tunnel: open with its age, whether it delivered, and closed when it ends", async () => {
  const rig = await startRig();
  const tunnels = (): EngineBrokerMcpTunnelObservation | undefined => rig.facade.observe(rig.turnId)?.tunnels;
  const until = async (reason: string, ready: () => boolean): Promise<void> => {
    for (let attempt = 0; attempt < 200 && !ready(); attempt += 1) await new Promise<void>((resolve) => setTimeout(resolve, 25));
    assert.ok(ready(), reason);
  };
  try {
    // Before any request the turn is registered and has relayed nothing: a
    // measured zero, which is not the same statement as an open tunnel.
    assert.deepEqual(tunnels(), { opened: 0, closed: 0, delivered: 0, open: [] });
    const { client } = await connectClient(rig.capability);
    const notified = new Promise<void>((resolve) => client.setNotificationHandler(ToolListChangedNotificationSchema, () => resolve()));
    try {
      await until("the client never opened its GET tunnel", () => (tunnels()?.open.length ?? 0) > 0);
      const open = tunnels();
      assert.equal(open?.opened, 1); assert.equal(open?.closed, 0);
      assert.ok((open?.open[0]?.openMs ?? -1) >= 0, "an open tunnel reports how long it has been open");
      assert.equal(open?.open[0]?.delivered, false, "a tunnel the mount has not pushed through is held open in silence");
      assert.equal(open?.delivered, 0);

      // The same tunnel, now actually carrying a server frame. "Held open
      // having delivered nothing" and "in use" are different facts about it.
      rig.server.sendToolListChanged();
      await withDeadline(notified, 4_000, "no server notification reached the client");
      await until("the delivered frame was never attributed to the tunnel", () => (tunnels()?.delivered ?? 0) === 1);
      assert.equal(tunnels()?.open[0]?.delivered, true);
      assert.equal(tunnels()?.closed, 0, "a tunnel that delivered is still open");
    } finally {
      await client.close();
    }
    await until("the closed GET tunnel still reads as open", () => (tunnels()?.closed ?? 0) === 1);
    assert.deepEqual(tunnels(), { opened: 1, closed: 1, delivered: 1, open: [] });
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

import { createServer, type Server as HttpServer, type IncomingMessage } from "node:http";

import { randomUUID } from "node:crypto";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";

import { createPiToolMcpServer } from "../mcp/toolServer.js";
import { ENGINE_BROKER_MCP_FACADE_PORT, startEngineBrokerMcpFacade } from "./engineBrokerMcpFacade.js";

/**
 * The facade's shared test rig, and not a suite of its own.
 *
 * Two suites drive the same boundary — the facade's routing and header
 * contract, and the observations it records while relaying — and both need one
 * facade on the protocol's fixed port plus a real Daimon MCP mount behind a
 * real Streamable HTTP transport. Splitting them into one file each kept both
 * readable; duplicating the rig into each would have left two copies of the
 * thing every assertion depends on. It carries a `.test.ts` name so it never
 * reaches production `dist` (`tsconfig.build.json` excludes exactly that), and
 * running it on its own asserts nothing, which is what it is.
 *
 * Each suite is its own process, so each holds its own shared facade and each
 * takes the fixed port for the length of its file.
 */
export const FACADE_URL = `http://127.0.0.1:${ENGINE_BROKER_MCP_FACADE_PORT}/mcp`;
export type Facade = Awaited<ReturnType<typeof startEngineBrokerMcpFacade>>;

/**
 * One facade serves every turn of a broker, so the tests share one too. It
 * also keeps the fixed port free: a facade per test would leave the HTTP
 * client pooling a socket onto a server that no longer exists.
 */
let shared: Facade | undefined;
export const sharedFacade = async (): Promise<Facade> => (shared ??= await startFacade());
export const releaseShared = async (): Promise<void> => { const facade = shared; shared = undefined; if (facade) await facade.close(); };
test.after(releaseShared);

/**
 * Closing a facade destroys its sockets, and the port is fixed, so the HTTP
 * client can still hold a pooled connection to the server that just went away.
 * That is a test-harness artifact — one facade outlives a whole broker — so a
 * fresh facade is probed until a refusal proves the route is live again.
 */
/**
 * The facade's port is the control protocol's own, so the two suites that
 * drive it cannot each hold one at the same time. Whichever binds first runs;
 * the other waits for it to release the port rather than failing on the
 * collision, which is the whole cost of splitting this boundary in two.
 */
const bindFacade = async (): Promise<Facade> => {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    try { return await startEngineBrokerMcpFacade(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error("the MCP facade port never came free");
};

export const startFacade = async (): Promise<Facade> => {
  const facade = await bindFacade();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const probe = await fetch(FACADE_URL, { method: "PUT" });
      await probe.body?.cancel();
      if (probe.status === 403) return facade;
    } catch { /* a pooled socket onto the previous facade: try the next one */ }
  }
  throw new Error("facade did not answer after starting");
};

/**
 * The brokered worker's real route: a real Daimon MCP mount behind a real
 * Streamable HTTP transport, reached by a real MCP client through the facade.
 * Asserting that a header is copied would pass while the route stayed broken,
 * so every case below drives the transport end to end.
 */
export type Rig = Readonly<{
  facade: Facade;
  turnId: string;
  server: ReturnType<typeof createPiToolMcpServer>;
  capability: string;
  observed: IncomingMessage[];
  /** Resolves when the mount's standalone GET stream is torn down. */
  getStreamClosed: Promise<void>;
  close: () => Promise<void>;
}>;

export const echoTool = defineTool({
  name: "moltnet_read",
  label: "Read a scoped Moltnet surface",
  description: "Reads the fixture room.",
  parameters: Type.Object({ target: Type.String() }, { additionalProperties: false }),
  async execute(_toolCallId: string, params: { target: string }) {
    return { content: [{ type: "text" as const, text: `read ${params.target}` }], details: { target: params.target } };
  }
});

let turns = 0;

export const startRig = async (facade?: Facade): Promise<Rig> => {
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

export const closeMount = async (mount: HttpServer, transport: StreamableHTTPServerTransport, server: ReturnType<typeof createPiToolMcpServer>): Promise<void> => {
  mount.closeAllConnections();
  await new Promise<void>((resolve) => mount.close(() => resolve()));
  await transport.close().catch(() => undefined);
  await server.close().catch(() => undefined);
};

export const connectClient = async (capability: string): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> => {
  const transport = new StreamableHTTPClientTransport(new URL(FACADE_URL), {
    requestInit: { headers: { authorization: `Bearer ${capability}` } }
  });
  const client = new Client({ name: "daimon-facade-test-client", version: "0.1.0" });
  await client.connect(transport);
  return { client, transport };
};

export const withDeadline = async <T>(work: Promise<T>, ms: number, reason: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(reason)), ms); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

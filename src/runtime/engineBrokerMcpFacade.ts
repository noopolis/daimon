import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { EngineBrokerCapabilities } from "./engineBrokerCapabilities.js";
import { EngineBrokerMcpCallLog, type EngineBrokerMcpCallObservation } from "./engineBrokerMcpCallLog.js";

/**
 * The brokered worker's only route to its own per-wake Daimon MCP mount. The
 * worker holds a turn capability and nothing else: it never learns the mount's
 * address, and the mount never learns the capability. Every header crossing
 * either way is rebuilt from a closed allowlist, so this stays a boundary and
 * not a transparent proxy — a blanket passthrough would hand the mount the
 * worker's bearer and hand the worker whatever the mount chose to say.
 *
 * The allowlists are exactly the Streamable HTTP transport's own routing
 * headers. Anything outside them (authorization above all, cookies, auth
 * challenges, forwarding and tracing headers) is dropped in both directions.
 *
 * Client -> mount:
 * - `content-type`: the JSON-RPC body's media type; the mount refuses a POST
 *   without it.
 * - `accept`: the transport negotiates `application/json, text/event-stream`
 *   per request and the mount answers 406 when a POST does not accept both.
 * - `mcp-session-id`: the opaque session the mount issued on `initialize`.
 *   Dropping it made the mount answer every later request with HTTP 400
 *   `Mcp-Session-Id header is required`, so no tool was ever reachable. It is
 *   a routing value, not a secret — and not a value to log either.
 * - `mcp-protocol-version`: the version the handshake settled on. The mount
 *   validates it and otherwise assumes a default that can disagree with what
 *   the client negotiated.
 * - `last-event-id`: SSE resumability. A reconnecting stream replays from the
 *   last event it saw; without it the mount cannot tell where to resume.
 *
 * Mount -> client:
 * - `content-type`: tells the client whether it got JSON or an SSE stream.
 * - `mcp-session-id`: the id minted on `initialize`. The client must learn it
 *   or it can never make a second request.
 * - `mcp-protocol-version`: the version the mount confirms for the session.
 * - `cache-control: no-store` is the facade's own, not the mount's.
 *
 * Methods are the three the transport uses: POST for JSON-RPC, GET for the
 * server-to-client SSE stream (notifications and progress arrive only there),
 * and DELETE to end a session. POST alone left the GET stream answering 403.
 */
const FORWARDED_REQUEST_HEADERS = ["content-type", "accept", "mcp-session-id", "mcp-protocol-version", "last-event-id"] as const;
const FORWARDED_RESPONSE_HEADERS = ["content-type", "mcp-session-id", "mcp-protocol-version"] as const;
const FORWARDED_METHODS = new Set(["POST", "GET", "DELETE"]);
const MAX_REQUEST_BYTES = 1024 * 1024;
export const ENGINE_BROKER_MCP_FACADE_PORT = 43_124;

class FacadeRefusal extends Error {}

export async function startEngineBrokerMcpFacade() {
  const capabilities = new EngineBrokerCapabilities();
  const targets = new Map<string, string>();
  /** In-flight upstream calls per turn, so a revoke or a close tears down any open SSE tunnel. */
  const inflight = new Map<string, Set<AbortController>>();
  /**
   * What the facade saw of each turn's tool calls. A tool receipt is written
   * only on completion, so without this a call that started and never returned
   * and a call never made are the same absence (`engineBrokerMcpCallLog.ts`).
   */
  const calls = new EngineBrokerMcpCallLog();

  const server = createServer((request, response) => {
    void route(request, response).catch((error: unknown) => {
      if (response.headersSent || response.destroyed) { response.destroy(); return; }
      const status = error instanceof FacadeRefusal ? 403 : 502;
      const body = error instanceof FacadeRefusal ? '{"error":"forbidden"}' : '{"error":"bad_gateway"}';
      response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(body);
    });
  });

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? "";
    if (request.url !== "/mcp" || !FORWARDED_METHODS.has(method)) throw new FacadeRefusal();
    const match = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{40,})$/u);
    if (!match) throw new FacadeRefusal();
    const scope = capabilities.authorizeToken(match[1]!);
    if (!scope) throw new FacadeRefusal();
    const target = targets.get(scope.turnId);
    if (target === undefined) throw new FacadeRefusal();

    // Only POST carries a JSON-RPC body; drain anything else so the socket
    // never stalls waiting for a body the facade will not forward.
    let body: Buffer | undefined;
    // A body refused for size is a call the log can never name, and counting
    // it keeps "no tool call started" an honest reading rather than a gap.
    try { body = method === "POST" ? await bounded(request) : (request.resume(), undefined); }
    catch (error) { calls.undecodable(scope.turnId); throw error; }
    const payload = body === undefined ? undefined : (body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer);
    const call = calls.begin(scope.turnId, body);

    const controller = new AbortController();
    const open = inflight.get(scope.turnId) ?? new Set<AbortController>();
    open.add(controller);
    inflight.set(scope.turnId, open);
    const abort = (): void => controller.abort();
    response.on("close", abort);
    try {
      // Answered only on a relay that reached its own end: a tunnel torn down
      // by the worker's death must not mark the call it was blocked on as
      // finished.
      if (await forward(target, method, headersFor(method, request), payload, controller.signal, response)) call.answer();
    } finally {
      call.close();
      response.off("close", abort);
      open.delete(controller);
      if (open.size === 0) inflight.delete(scope.turnId);
    }
  }

  function endTurnStreams(turnId: string): void {
    for (const controller of inflight.get(turnId) ?? []) controller.abort();
    inflight.delete(turnId);
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(ENGINE_BROKER_MCP_FACADE_PORT, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });

  return {
    register(agentId: string, turnId: string, endpoint: string): string {
      const url = new URL(endpoint);
      if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/mcp") throw new TypeError("invalid scoped MCP mount");
      if (targets.has(turnId)) throw new Error("MCP turn already registered");
      targets.set(turnId, url.href);
      calls.open(turnId);
      return capabilities.issue(agentId, turnId, 15 * 60_000, 128);
    },
    revoke(turnId: string): void {
      targets.delete(turnId);
      capabilities.revoke(turnId);
      endTurnStreams(turnId);
      calls.close(turnId);
    },
    /**
     * What the facade saw of this turn's tool calls, or `undefined` for a turn
     * it never registered. Read on the failure path, before `revoke`.
     */
    observe: (turnId: string): EngineBrokerMcpCallObservation | undefined => calls.observe(turnId),
    close: async (): Promise<void> => {
      for (const turnId of [...inflight.keys()]) endTurnStreams(turnId);
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        // A GET SSE tunnel keeps its socket open indefinitely, and `close`
        // only stops accepting; without this a shutdown would hang on it.
        server.closeAllConnections();
      });
    }
  };
}

/** The client -> mount allowlist, with the two defaults the mount requires of a POST. */
function headersFor(method: string, request: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers[name];
    if (typeof value === "string" && value.length > 0) headers[name] = value;
  }
  if (method === "POST") {
    headers["content-type"] ??= "application/json";
    headers["accept"] ??= "application/json, text/event-stream";
  } else {
    delete headers["content-type"];
  }
  return headers;
}

/**
 * Streams the exchange rather than buffering it: a GET stream stays open for
 * the whole session, and a buffered POST would withhold progress
 * notifications until the call had already finished.
 */
async function forward(
  target: string,
  method: string,
  headers: Record<string, string>,
  body: ArrayBuffer | undefined,
  signal: AbortSignal,
  response: ServerResponse
): Promise<boolean> {
  const upstream = await fetch(target, { method, headers, body, signal, redirect: "manual" });
  // MCP never redirects, and following one would let the mount aim the facade
  // at a host the capability was never scoped to. `manual` also reports an
  // opaque redirect as status 0, which is not a status to relay at all.
  const relayable = (upstream.status >= 200 && upstream.status < 300) || (upstream.status >= 400 && upstream.status <= 599);
  if (!relayable) throw new Error("unexpected MCP mount status");
  const outbound: Record<string, string> = { "cache-control": "no-store" };
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null && value.length > 0) outbound[name] = value;
  }
  outbound["content-type"] ??= "application/json";
  response.writeHead(upstream.status, outbound);
  if (upstream.body === null) { response.end(); return true; }
  const stream = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);
  try {
    for await (const chunk of stream) {
      if (response.destroyed || response.writableEnded) throw new Error("MCP tunnel closed");
      if (!response.write(chunk as Uint8Array)) await awaitMcpTunnelDrain(response, signal);
    }
    response.end();
    return true;
  } catch {
    // The client hung up or the mount's stream broke: tear the tunnel down
    // rather than leaving a half-written response open.
    response.destroy();
    return false;
  } finally {
    stream.destroy();
  }
}

/**
 * Waits for a backpressured tunnel to drain, or for the tunnel to end —
 * whichever happens first, but always one of them.
 *
 * A bare `once("drain")` never settles for a client that hung up mid-write:
 * `drain` cannot fire on a socket nobody is reading, and neither the
 * response's own `close` nor the turn's abort woke that await. The GET SSE
 * tunnel stays open for a whole session, so the handler — and the upstream
 * call it was relaying — leaked for the life of the broker process, with no
 * refusal, no status and no line anywhere to read. Every outcome settles this
 * now, and every outcome but an actual drain *rejects*, so the caller tears
 * the tunnel down instead of writing into a socket that is gone.
 *
 * Exported for its own test: a hang is only observable from inside.
 */
export function awaitMcpTunnelDrain(response: ServerResponse, signal: AbortSignal): Promise<void> {
  if (response.destroyed || response.writableEnded) return Promise.reject(new Error("MCP tunnel closed"));
  if (signal.aborted) return Promise.reject(new Error("MCP tunnel aborted"));
  return new Promise<void>((resolve, reject) => {
    const settle = (finish: () => void) => (): void => {
      response.off("drain", onDrain); response.off("close", onClosed); response.off("error", onClosed);
      signal.removeEventListener("abort", onAborted);
      finish();
    };
    const onDrain = settle(resolve);
    const onClosed = settle(() => reject(new Error("MCP tunnel closed")));
    const onAborted = settle(() => reject(new Error("MCP tunnel aborted")));
    response.once("drain", onDrain); response.once("close", onClosed); response.once("error", onClosed);
    signal.addEventListener("abort", onAborted, { once: true });
  });
}

async function bounded(request: AsyncIterable<unknown>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const value = Buffer.from(chunk as Uint8Array);
    bytes += value.length;
    if (bytes > MAX_REQUEST_BYTES) throw new FacadeRefusal();
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

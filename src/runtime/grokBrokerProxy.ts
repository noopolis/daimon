import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { EngineBrokerCapabilities } from "./engineBrokerCapabilities.js";
import { DEFAULT_GROK_BROKER_MODEL_POLICY, parseGrokBrokerModelPolicy, type GrokBrokerModelPolicy } from "./grokBrokerModelPolicy.js";
import { authorizeGrokBrokerProxyRequest } from "./grokBrokerProxyRequest.js";
import { parseGrokUpstreamUsage, type GrokBrokerTurnMeter } from "./grokBrokerTurnMeter.js";
import { GROK_ENGINE_BROKER } from "../contracts/runtimeContractManifest.js";
import { serveGrokInferenceGrant } from "./grokInferenceProxy.js";
import type { GrokInferenceGrants } from "./grokInferenceGrants.js";

/** One running turn as the proxy sees it: its declared model/effort and its spend gate. */
export type GrokBrokerProxyTurn = Readonly<{ policy: GrokBrokerModelPolicy; meter: GrokBrokerTurnMeter }>;

export type GrokBrokerCredentialAuthority = Readonly<{ accessToken(forceRefresh: boolean): Promise<string>; refreshAfterRejection?(rejectedTokenDigest:string):Promise<string>; markRejected(rejectedTokenDigest?:string): Promise<void>; isStale?(): boolean }>;
export type GrokBrokerUpstream = (request: ReturnType<typeof authorizeGrokBrokerProxyRequest>, signal?: AbortSignal) => Promise<Readonly<{ status: number; headers: Readonly<Record<string, string>>; body: Uint8Array }>>;

/**
 * `policy` is the fallback declared model/effort (closed list); a registered
 * turn's own policy wins. A request whose turn has no registered meter is
 * refused like one without an isolation guard: nothing is forwarded unmetered.
 * `listenPort` exists for tests that must not contend for the production port.
 *
 * `grants` are evaluator inference grants (`grokInferenceGrants.ts`): a bearer
 * carrying the grant prefix is looked up only there and served by
 * `grokInferenceProxy.ts`; every other bearer is looked up only among turn
 * capabilities. Without `grants` a prefixed bearer is simply refused.
 */
export async function startGrokBrokerProxy(authority: GrokBrokerCredentialAuthority, upstream: GrokBrokerUpstream = defaultUpstream, policy: GrokBrokerModelPolicy = DEFAULT_GROK_BROKER_MODEL_POLICY, listenPort = 43_123, grants?: GrokInferenceGrants): Promise<Readonly<{ port: number; capabilities: EngineBrokerCapabilities; registerIsolationGuard(turnId:string,guard:()=>Promise<void>):void; revokeIsolationGuard(turnId:string):void; registerTurn(turnId:string,turn:GrokBrokerProxyTurn):void; revokeTurn(turnId:string):void; close(): Promise<void> }>> {
  const declared = parseGrokBrokerModelPolicy(policy); const capabilities = new EngineBrokerCapabilities();
  const guards=new Map<string,()=>Promise<void>>();const turns=new Map<string,GrokBrokerProxyTurn>();const server = createServer((request, response) => { void serve(request, response, authority, upstream, capabilities,guards,turns,declared,grants); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(listenPort, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
  const address = server.address() as AddressInfo;
  return { port: address.port, capabilities,registerIsolationGuard(turnId,guard){guards.set(turnId,guard);},revokeIsolationGuard(turnId){guards.delete(turnId);},registerTurn(turnId,turn){turns.set(turnId,{policy:parseGrokBrokerModelPolicy(turn.policy),meter:turn.meter});},revokeTurn(turnId){turns.delete(turnId);}, close: () => new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))) };
}

/**
 * A refusal the caller must not retry.
 *
 * Every internal refusal used to collapse into one bare 503. Grok treats 503 as
 * transient and blind-retries the same request (observed: 14 retries, ~141k
 * estimated tokens, then `exit 1`), so a policy miss burned a turn's budget and
 * reported itself as an engine crash. Policy refusals now answer 400 with a
 * reason, and only genuinely transient faults keep 503.
 */
export class GrokBrokerProxyRefusal extends Error {
  constructor(readonly reason: string) { super(`grok broker proxy refused: ${reason}`); }
}

async function serve(request: IncomingMessage, response: ServerResponse, authority: GrokBrokerCredentialAuthority, upstream: GrokBrokerUpstream, capabilities: EngineBrokerCapabilities,guards:Map<string,()=>Promise<void>>,turns:Map<string,GrokBrokerProxyTurn>,fallback:GrokBrokerModelPolicy,grants?:GrokInferenceGrants): Promise<void> {
  let settle:((usage:ReturnType<typeof parseGrokUpstreamUsage>)=>void)|undefined;
  try {
    const body = await readBody(request); const headers = Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value]));
    const match=headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{40,})$/u);
    if(match&&match[1]!.startsWith(GROK_ENGINE_BROKER.inferenceGrants.tokenPrefix)){if(!grants)throw new GrokBrokerProxyRefusal("inference_grants_unavailable");return await serveGrokInferenceGrant({method:request.method??"",pathname:new URL(request.url??"/","http://127.0.0.1").pathname,headers,body,token:match[1]!},response,grants,authority,upstream);}
    const scope=match?capabilities.inspectToken(match[1]!):undefined;if(!scope)throw new GrokBrokerProxyRefusal("unknown_capability");const guard=guards.get(scope.turnId),turn=turns.get(scope.turnId);if(!guard||!turn)throw new GrokBrokerProxyRefusal("no_active_turn");
    try { await guard(); } catch (error) { throw new GrokBrokerProxyRefusal("worker_isolation_unverified"); }
    let token = await authority.accessToken(false);const rejectedDigest=createHash("sha256").update(token).digest("hex"); let prepared = authorizeRequestOrRefuse({ method: request.method ?? "", pathname: new URL(request.url ?? "/", "http://127.0.0.1").pathname, headers, body }, capabilities, token, turn.policy ?? fallback); token = "";
    // The spend gate runs after the body is proven a real lean worker request
    // (a refused session-title body never counts) and before any upstream call.
    const admission=turn.meter.admit();
    if("refused" in admission){response.writeHead(429,{"content-type":"application/json","cache-control":"no-store"});response.end(JSON.stringify({error:"turn limit reached",limit:admission.refused}));return;}
    if("busy" in admission){response.writeHead(429,{"content-type":"application/json","cache-control":"no-store"});response.end('{"error":"turn request in flight"}');return;}
    settle=(usage)=>{turn.meter.settle(admission.index,usage,body.byteLength);settle=undefined;};
    let result = await upstream(prepared,admission.signal);
    if (result.status === 401) { token = authority.refreshAfterRejection?await authority.refreshAfterRejection(rejectedDigest):await authority.accessToken(true);const refreshedDigest=createHash("sha256").update(token).digest("hex"); prepared = { ...prepared, headers: { ...prepared.headers, authorization: `Bearer ${token}` } }; token = ""; result = await upstream(prepared,admission.signal);if(result.status===401)await authority.markRejected(refreshedDigest); }
    settle?.(parseGrokUpstreamUsage(result.body,result.headers["content-type"]));
    response.writeHead(result.status, { "content-type": result.headers["content-type"] ?? "application/json", "cache-control": "no-store" }); response.end(result.body);
  } catch (error) {
    settle?.(undefined);
    // Name the refusal on the broker's own stderr (reason code only, never a body
    // or a token) so a failing turn is diagnosable without a stub harness.
    const refusal = error instanceof GrokBrokerProxyRefusal ? error.reason : "broker_unavailable";
    process.stderr.write(`[grok-proxy] refused: ${refusal}\n`);
    if (error instanceof GrokBrokerProxyRefusal) {
      response.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ error: "broker refused this request", reason: refusal }));
      return;
    }
    response.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
    response.end('{"error":"broker unavailable"}');
  }
}

/** The body gate, refused non-retryably: a rejected body is a policy miss, never a transient fault. */
function authorizeRequestOrRefuse(...args: Parameters<typeof authorizeGrokBrokerProxyRequest>): ReturnType<typeof authorizeGrokBrokerProxyRequest> {
  try { return authorizeGrokBrokerProxyRequest(...args); }
  catch { throw new GrokBrokerProxyRefusal("request_body_rejected"); }
}
async function readBody(request: IncomingMessage): Promise<Buffer> { const chunks: Buffer[] = []; let bytes = 0; for await (const chunk of request) { const value = Buffer.from(chunk); bytes += value.length; if (bytes > 2 * 1024 * 1024) throw new Error("too large"); chunks.push(value); } return Buffer.concat(chunks); }
const defaultUpstream: GrokBrokerUpstream = async (request, signal) => { const result = await fetch(request.url, { method: "POST", headers: request.headers, body: Buffer.from(request.body), ...(signal === undefined ? {} : { signal }) }); return { status: result.status, headers: { "content-type": result.headers.get("content-type") ?? "application/json" }, body: new Uint8Array(await result.arrayBuffer()) }; };

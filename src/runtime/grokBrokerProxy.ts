import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { EngineBrokerCapabilities } from "./engineBrokerCapabilities.js";
import { authorizeGrokBrokerProxyRequest } from "./grokBrokerProxyRequest.js";

export type GrokBrokerCredentialAuthority = Readonly<{ accessToken(forceRefresh: boolean): Promise<string>; refreshAfterRejection?(rejectedTokenDigest:string):Promise<string>; markRejected(rejectedTokenDigest?:string): Promise<void> }>;
export type GrokBrokerUpstream = (request: ReturnType<typeof authorizeGrokBrokerProxyRequest>) => Promise<Readonly<{ status: number; headers: Readonly<Record<string, string>>; body: Uint8Array }>>;

export async function startGrokBrokerProxy(authority: GrokBrokerCredentialAuthority, upstream: GrokBrokerUpstream = defaultUpstream): Promise<Readonly<{ port: number; capabilities: EngineBrokerCapabilities; registerIsolationGuard(turnId:string,guard:()=>Promise<void>):void; revokeIsolationGuard(turnId:string):void; close(): Promise<void> }>> {
  const capabilities = new EngineBrokerCapabilities();
  const guards=new Map<string,()=>Promise<void>>();const server = createServer((request, response) => { void serve(request, response, authority, upstream, capabilities,guards); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(43_123, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
  const address = server.address() as AddressInfo;
  return { port: address.port, capabilities,registerIsolationGuard(turnId,guard){guards.set(turnId,guard);},revokeIsolationGuard(turnId){guards.delete(turnId);}, close: () => new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))) };
}

async function serve(request: IncomingMessage, response: ServerResponse, authority: GrokBrokerCredentialAuthority, upstream: GrokBrokerUpstream, capabilities: EngineBrokerCapabilities,guards:Map<string,()=>Promise<void>>): Promise<void> {
  try {
    const body = await readBody(request); const headers = Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value]));
    const match=headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{40,})$/u),scope=match?capabilities.inspectToken(match[1]!):undefined;if(!scope)throw new Error();const guard=guards.get(scope.turnId);if(!guard)throw new Error();await guard();
    let token = await authority.accessToken(false);const rejectedDigest=createHash("sha256").update(token).digest("hex"); let prepared = authorizeGrokBrokerProxyRequest({ method: request.method ?? "", pathname: new URL(request.url ?? "/", "http://127.0.0.1").pathname, headers, body }, capabilities, token); token = "";
    let result = await upstream(prepared);
    if (result.status === 401) { token = authority.refreshAfterRejection?await authority.refreshAfterRejection(rejectedDigest):await authority.accessToken(true);const refreshedDigest=createHash("sha256").update(token).digest("hex"); prepared = { ...prepared, headers: { ...prepared.headers, authorization: `Bearer ${token}` } }; token = ""; result = await upstream(prepared);if(result.status===401)await authority.markRejected(refreshedDigest); }
    response.writeHead(result.status, { "content-type": result.headers["content-type"] ?? "application/json", "cache-control": "no-store" }); response.end(result.body);
  } catch { response.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" }); response.end('{"error":"broker unavailable"}'); }
}
async function readBody(request: IncomingMessage): Promise<Buffer> { const chunks: Buffer[] = []; let bytes = 0; for await (const chunk of request) { const value = Buffer.from(chunk); bytes += value.length; if (bytes > 2 * 1024 * 1024) throw new Error("too large"); chunks.push(value); } return Buffer.concat(chunks); }
const defaultUpstream: GrokBrokerUpstream = async (request) => { const result = await fetch(request.url, { method: "POST", headers: request.headers, body: Buffer.from(request.body) }); return { status: result.status, headers: { "content-type": result.headers.get("content-type") ?? "application/json" }, body: new Uint8Array(await result.arrayBuffer()) }; };

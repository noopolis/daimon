import { createHash } from "node:crypto";
import type { ServerResponse } from "node:http";

import { GrokBrokerProxyRefusal } from "./grokBrokerProxy.js";
import type { GrokBrokerCredentialAuthority, GrokBrokerUpstream } from "./grokBrokerProxy.js";
import { parseGrokUpstreamUsage } from "./grokBrokerTurnMeter.js";
import type { GrokInferenceGrants } from "./grokInferenceGrants.js";
import { authorizeGrokInferenceProxyRequest } from "./grokInferenceProxyRequest.js";

export type GrokInferenceProxyInput = Readonly<{ method: string; pathname: string; headers: Readonly<Record<string, string | undefined>>; body: Buffer; token: string }>;

/** HTTP 401 with a fixed code: the broker realm is stale, distinct from a generic 503 broker failure. */
export const GROK_INFERENCE_AUTH_STALE_BODY = '{"error":"auth_stale"}';

/**
 * Serves one evaluator grant request; never throws.
 *
 * Order mirrors the subject path: the body is proven a grant-shaped request
 * (declared model/effort, no tools) before the credential is read, the grant
 * meter admits it before any upstream call, and exactly one ledger row is
 * written once an admitted request settles. No worker isolation guard applies:
 * grants are issued only to the organization uid.
 *
 * Stale realm: the grant shares the subject's credential authority, so a
 * stale realm fails judges and subject turns alike (accepted shared fate). A
 * grant request that finds the realm stale — before the upstream call or
 * after a rejected refresh — is answered 401 `{"error":"auth_stale"}`, never
 * the generic 503, so the evaluator can report it as a credential failure.
 */
export async function serveGrokInferenceGrant(input: GrokInferenceProxyInput, response: ServerResponse, grants: GrokInferenceGrants, authority: GrokBrokerCredentialAuthority, upstream: GrokBrokerUpstream): Promise<void> {
  let settle: ((usage: ReturnType<typeof parseGrokUpstreamUsage>) => void) | undefined;
  try {
    const grant = grants.authorize(input.token);
    if (grant === undefined) throw new GrokBrokerProxyRefusal("unknown_or_expired_grant");
    let prepared: ReturnType<typeof authorizeGrokInferenceProxyRequest>;
    try { prepared = authorizeGrokInferenceProxyRequest(input, "pending", grant.policy); }
    catch { throw new GrokBrokerProxyRefusal("request_body_rejected"); }
    let token = await authority.accessToken(false); const rejectedDigest = createHash("sha256").update(token).digest("hex");
    prepared = withBearer(prepared, token); token = "";
    const admission = grant.meter.admit();
    if ("refused" in admission) return json(response, 429, JSON.stringify({ error: "grant limit reached", limit: admission.refused }));
    if ("busy" in admission) return json(response, 429, '{"error":"grant request in flight"}');
    settle = (usage) => { settle = undefined; grants.settle(grant, admission.index, usage, input.body.byteLength); };
    let result = await upstream(prepared, admission.signal);
    if (result.status === 401) {
      token = authority.refreshAfterRejection ? await authority.refreshAfterRejection(rejectedDigest) : await authority.accessToken(true);
      const refreshedDigest = createHash("sha256").update(token).digest("hex"); prepared = withBearer(prepared, token); token = "";
      result = await upstream(prepared, admission.signal);
      if (result.status === 401) await authority.markRejected(refreshedDigest);
    }
    settle?.(parseGrokUpstreamUsage(result.body, result.headers["content-type"]));
    json(response, result.status, result.body, result.headers["content-type"]);
  } catch (error) {
    settle?.(undefined);
    // Same rule as the subject path: a policy miss is non-retryable (400), because a
    // retryable 503 makes the client re-send a request the broker will never accept,
    // charging estimated usage for every attempt. 503 stays for transient faults only.
    process.stderr.write(`[grok-proxy] inference refused: ${error instanceof GrokBrokerProxyRefusal ? error.reason : "broker_unavailable"}\n`);
    if (authority.isStale?.() === true) json(response, 401, GROK_INFERENCE_AUTH_STALE_BODY);
    else if (error instanceof GrokBrokerProxyRefusal) json(response, 400, JSON.stringify({ error: "broker refused this request", reason: error.reason }));
    else json(response, 503, '{"error":"broker unavailable"}');
  }
}

const withBearer = (prepared: ReturnType<typeof authorizeGrokInferenceProxyRequest>, token: string): ReturnType<typeof authorizeGrokInferenceProxyRequest> => {
  if (!token || /[\r\n]/u.test(token)) throw new Error("broker credential authority unavailable");
  return { ...prepared, headers: { ...prepared.headers, authorization: `Bearer ${token}` } };
};

function json(response: ServerResponse, status: number, body: string | Uint8Array, contentType = "application/json"): void {
  if (response.headersSent) return;
  response.writeHead(status, { "content-type": contentType, "cache-control": "no-store" }); response.end(body);
}

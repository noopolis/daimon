import type { EngineBrokerCapabilities } from "./engineBrokerCapabilities.js";

const MAX_BODY = 2 * 1024 * 1024;
export type GrokBrokerProxyInput = Readonly<{ method: string; pathname: string; headers: Readonly<Record<string, string | undefined>>; body: Uint8Array; agentId?: string; turnId?: string }>;
export type GrokBrokerUpstreamRequest = Readonly<{ url: "https://cli-chat-proxy.grok.com/v1/chat/completions"; headers: Readonly<Record<string, string>>; body: Uint8Array }>;

export function authorizeGrokBrokerProxyRequest(input: GrokBrokerProxyInput, capabilities: EngineBrokerCapabilities, bearer: string): GrokBrokerUpstreamRequest {
  if (input.method !== "POST" || input.pathname !== "/v1/chat/completions" || input.body.byteLength < 2 || input.body.byteLength > MAX_BODY) throw new Error("broker proxy request rejected");
  const authorization = input.headers.authorization; const match = authorization?.match(/^Bearer ([A-Za-z0-9_-]{40,})$/u);
  if (match === null || match === undefined) throw new Error("broker proxy request rejected");
  const scope = capabilities.authorizeToken(match[1]!);
  if (scope === undefined || (input.agentId !== undefined && scope.agentId !== input.agentId) || (input.turnId !== undefined && scope.turnId !== input.turnId)) throw new Error("broker proxy request rejected");
  if (!bearer || /[\r\n]/u.test(bearer)) throw new Error("broker credential authority unavailable");
  try { const parsed = JSON.parse(Buffer.from(input.body).toString("utf8")) as Record<string, unknown>; if (parsed.stream !== true || !Array.isArray(parsed.messages)) throw new Error(); } catch { throw new Error("broker proxy request rejected"); }
  return { url: "https://cli-chat-proxy.grok.com/v1/chat/completions", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", "x-xai-token-auth": "xai-grok-cli", "x-grok-model-override": "grok-build" }, body: input.body };
}

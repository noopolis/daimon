import { GROK_ENGINE_BROKER } from "../contracts/runtimeContractManifest.js";
import { GROK_WORKER_VISIBLE_TOOLS } from "../contracts/grokWorkerContract.js";
import type { EngineBrokerCapabilities } from "./engineBrokerCapabilities.js";
import { DEFAULT_GROK_BROKER_MODEL_POLICY, parseGrokBrokerModelPolicy, type GrokBrokerModelPolicy } from "./grokBrokerModelPolicy.js";

const MAX_BODY = 2 * 1024 * 1024;
export type GrokBrokerProxyInput = Readonly<{ method: string; pathname: string; headers: Readonly<Record<string, string | undefined>>; body: Uint8Array; agentId?: string; turnId?: string }>;
export type GrokBrokerUpstreamRequest = Readonly<{ url: "https://cli-chat-proxy.grok.com/v1/chat/completions"; headers: Readonly<Record<string, string>>; body: Uint8Array }>;

/**
 * Authorizes one worker request and rebuilds it for the provider.
 *
 * Everything that decides spend is checked here, before a bearer is attached
 * and before any upstream call:
 * - the client version is exactly the pinned Grok CLI (`GROK_ENGINE_BROKER.grokCliVersion`);
 * - the body model and `reasoning_effort` are exactly the declared policy, and
 *   the model override header follows that declaration instead of a constant;
 * - the offered tool names are exactly the lean visible set. Grok 1.0.34 turns
 *   an unmappable `--tools` entry into its full 19-tool set, and its per-turn
 *   `session_title` request carries a single forced tool; both are refused.
 */
export function authorizeGrokBrokerProxyRequest(input: GrokBrokerProxyInput, capabilities: EngineBrokerCapabilities, bearer: string, policy: GrokBrokerModelPolicy = DEFAULT_GROK_BROKER_MODEL_POLICY): GrokBrokerUpstreamRequest {
  const declared = parseGrokBrokerModelPolicy(policy);
  if (input.method !== "POST" || input.pathname !== "/v1/chat/completions" || input.body.byteLength < 2 || input.body.byteLength > MAX_BODY) throw new Error("broker proxy request rejected");
  const authorization = input.headers.authorization; const match = authorization?.match(/^Bearer ([A-Za-z0-9_-]{40,})$/u);
  if (match === null || match === undefined) throw new Error("broker proxy request rejected");
  const scope = capabilities.authorizeToken(match[1]!);
  if (scope === undefined || (input.agentId !== undefined && scope.agentId !== input.agentId) || (input.turnId !== undefined && scope.turnId !== input.turnId)) throw new Error("broker proxy request rejected");
  if (!bearer || /[\r\n]/u.test(bearer)) throw new Error("broker credential authority unavailable");
  const clientVersion = input.headers["x-grok-client-version"];
  if (clientVersion !== GROK_ENGINE_BROKER.grokCliVersion) throw new Error("broker proxy request rejected");
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(Buffer.from(input.body).toString("utf8")) as Record<string, unknown>; } catch { throw new Error("broker proxy request rejected"); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || parsed.stream !== true || !Array.isArray(parsed.messages)) throw new Error("broker proxy request rejected");
  if (parsed.model !== declared.model || parsed.reasoning_effort !== declared.reasoningEffort) throw new Error("broker proxy request rejected");
  if (!exactLeanTools(parsed.tools)) throw new Error("broker proxy request rejected");
  return { url: "https://cli-chat-proxy.grok.com/v1/chat/completions", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", "x-xai-token-auth": "xai-grok-cli", "x-grok-model-override": declared.model, "x-grok-client-version": clientVersion, "x-grok-client-identifier": "grok-shell" }, body: input.body };
}

export function exactLeanTools(tools: unknown): boolean {
  if (!Array.isArray(tools) || tools.length !== GROK_WORKER_VISIBLE_TOOLS.length) return false;
  const names = tools.map((tool) => {
    if (tool === null || typeof tool !== "object" || (tool as { type?: unknown }).type !== "function") return undefined;
    const fn = (tool as { function?: unknown }).function;
    return fn !== null && typeof fn === "object" ? (fn as { name?: unknown }).name : undefined;
  });
  return JSON.stringify([...names].sort()) === JSON.stringify(GROK_WORKER_VISIBLE_TOOLS);
}

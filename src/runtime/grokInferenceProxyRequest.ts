import { GROK_ENGINE_BROKER } from "../contracts/runtimeContractManifest.js";
import type { GrokBrokerProxyInput, GrokBrokerUpstreamRequest } from "./grokBrokerProxyRequest.js";
import { parseGrokBrokerModelPolicy, type GrokBrokerModelPolicy } from "./grokBrokerModelPolicy.js";

const MAX_BODY = 2 * 1024 * 1024;
const SPEC = GROK_ENGINE_BROKER.inferenceGrants;
const BODY_MEMBERS: ReadonlySet<string> = new Set(SPEC.bodyMembers);
const ROLES: ReadonlySet<string> = new Set(SPEC.messageRoles);
type JsonRecord = Record<string, unknown>;
const plain = (value: unknown): value is JsonRecord => value !== null && typeof value === "object" && !Array.isArray(value);
const rejected = (): Error => new Error("inference grant request rejected");

/**
 * Authorizes one evaluator grant request body and rebuilds it for the provider.
 *
 * The accepted shape is exactly what Grok CLI 1.0.34 sends for a Paideia
 * judge/optimizer call (`--tools read_file --disallowed-tools
 * read_file,search_tool,use_tool --max-turns 1`, with and without
 * `--system-prompt-override` and `--json-schema`; live stub capture):
 *
 * - `stream: true` with `stream_options: {include_usage: true}` — the CLI never
 *   sends a non-streaming request, so none is accepted;
 * - `model` and `reasoning_effort` equal to the grant's declaration;
 * - `messages` of plain `{role, content}` string turns, roles system/user/assistant;
 * - optional `response_format` `{type: "json_schema", json_schema: {name, schema, strict}}`;
 * - no `tools` and no `tool_choice` member at all, not even an empty one. The
 *   CLI's per-call `session_title` request carries both and is refused here.
 *
 * The client version must be the pinned CLI, and the forwarded body is the
 * re-serialized parse, never the caller's bytes.
 */
export function authorizeGrokInferenceProxyRequest(input: Omit<GrokBrokerProxyInput, "agentId" | "turnId">, bearer: string, policy: GrokBrokerModelPolicy): GrokBrokerUpstreamRequest {
  const declared = parseGrokBrokerModelPolicy(policy);
  if (input.method !== "POST" || input.pathname !== "/v1/chat/completions" || input.body.byteLength < 2 || input.body.byteLength > MAX_BODY) throw rejected();
  if (!bearer || /[\r\n]/u.test(bearer)) throw new Error("broker credential authority unavailable");
  const clientVersion = input.headers["x-grok-client-version"];
  if (clientVersion !== GROK_ENGINE_BROKER.grokCliVersion) throw rejected();
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(input.body).toString("utf8"), (key, value: unknown) => { if (key === "__proto__") throw new Error(); return value; }); } catch { throw rejected(); }
  if (!plain(parsed) || Object.keys(parsed).some((key) => !BODY_MEMBERS.has(key))) throw rejected();
  if (parsed.model !== declared.model || parsed.reasoning_effort !== declared.reasoningEffort || parsed.stream !== true) throw rejected();
  if (!plain(parsed.stream_options) || Object.keys(parsed.stream_options).length !== 1 || parsed.stream_options.include_usage !== true) throw rejected();
  if (!Array.isArray(parsed.messages) || parsed.messages.length === 0 || !parsed.messages.every(plainMessage)) throw rejected();
  if (parsed.response_format !== undefined && !jsonSchemaFormat(parsed.response_format)) throw rejected();
  return { url: "https://cli-chat-proxy.grok.com/v1/chat/completions", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", "x-xai-token-auth": "xai-grok-cli", "x-grok-model-override": declared.model, "x-grok-client-version": clientVersion, "x-grok-client-identifier": "grok-shell" }, body: Buffer.from(JSON.stringify(parsed)) };
}

const plainMessage = (message: unknown): boolean => plain(message) && Object.keys(message).length === 2 && ROLES.has(message.role as string) && typeof message.content === "string";

const jsonSchemaFormat = (value: unknown): boolean => {
  if (!plain(value) || Object.keys(value).length !== 2 || value.type !== "json_schema" || !plain(value.json_schema)) return false;
  const schema = value.json_schema;
  return Object.keys(schema).every((key) => key === "name" || key === "schema" || key === "strict") && typeof schema.name === "string" && plain(schema.schema) && (schema.strict === undefined || typeof schema.strict === "boolean");
};

import { types } from "node:util";

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { PiWorldToolContextRef, PiWorldTurnContext } from "./worldNudge.js";
import { createWorldClaimRequestBody, createWorldRequestBody, parseWorldClaimResponse, WORLD_ACTION_RESULT_PAGE_REQUEST_VERSION, type PiWorldProtocolOperation } from "./worldToolProtocol.js";

export const PI_WORLD_TOOL_NAMES = Object.freeze([
  "world_claim",
  "world_status",
  "world_capabilities",
  "world_observe",
  "world_affordances",
  "world_act",
  "world_ledger"
] as const);
export const PI_WORLD_TOOL_LIMITS = Object.freeze({
  requestBytes: 64 * 1024,
  responseBytes: 1024 * 1024,
  timeoutMs: 5_000
});
export { WORLD_ACTION_RESULT_PAGE_REQUEST_VERSION } from "./worldToolProtocol.js";

export type PiWorldToolName = typeof PI_WORLD_TOOL_NAMES[number];
export interface PiWorldBinding {
  readonly url: string;
  readonly tokenEnv: string;
}
export type PiWorldFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export interface CreatePiWorldToolsInput {
  readonly world: PiWorldBinding;
  readonly contextRef?: PiWorldToolContextRef;
  readonly fetch?: PiWorldFetch;
  readonly readEnvironment?: (name: string) => string | undefined;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}
export type PiWorldToolErrorCode =
  | "world_auth_unavailable"
  | "world_request_cancelled"
  | "world_request_denied"
  | "world_request_invalid"
  | "world_request_rejected"
  | "world_request_timeout"
  | "world_response_invalid"
  | "world_transport_unavailable";

const ERROR_MESSAGES: Readonly<Record<PiWorldToolErrorCode, string>> = Object.freeze({
  world_auth_unavailable: "World tool authentication is unavailable.",
  world_request_cancelled: "World tool request was cancelled.",
  world_request_denied: "World tool request was denied.",
  world_request_invalid: "World tool request is invalid.",
  world_request_rejected: "World tool request was rejected.",
  world_request_timeout: "World tool request timed out.",
  world_response_invalid: "World tool returned an invalid response.",
  world_transport_unavailable: "World tool transport is unavailable."
});

export class PiWorldToolError extends Error {
  public readonly code: PiWorldToolErrorCode;

  public constructor(code: PiWorldToolErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "PiWorldToolError";
    this.code = code;
  }
}

type PiWorldTool = ToolDefinition<any, unknown>;
type WorldOperation = PiWorldProtocolOperation;
class BodyReadCancelled extends Error {}
class RequestInterrupted extends Error {}
const UTF8 = new TextEncoder();
const fail = (code: PiWorldToolErrorCode): never => { throw new PiWorldToolError(code); };
const text = (value: unknown, maximum = 256): value is string => typeof value === "string"
  && value.length > 0 && value.length <= maximum && value === value.trim();
const token = (value: unknown): value is string => text(value, 1_024)
  && /^[A-Za-z0-9._~+\/-]+={0,2}$/u.test(value);
const binding = (value: unknown): PiWorldBinding | undefined => {
  try {
    if (value === null || typeof value !== "object" || types.isProxy(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 2 || !keys.includes("url") || !keys.includes("tokenEnv")) return undefined;
    const url = Object.getOwnPropertyDescriptor(value, "url");
    const tokenEnv = Object.getOwnPropertyDescriptor(value, "tokenEnv");
    if (!url?.enumerable || !("value" in url) || !tokenEnv?.enumerable || !("value" in tokenEnv)
      || typeof url.value !== "string" || url.value !== url.value.trim() || url.value.length > 2_048
      || url.value.includes("?") || url.value.includes("#")
      || typeof tokenEnv.value !== "string" || !/^[A-Z_][A-Z0-9_]{0,127}$/u.test(tokenEnv.value)) return undefined;
    const parsed = new URL(url.value);
    if (parsed.href !== url.value || (parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username !== ""
      || parsed.password !== "" || parsed.search !== "" || parsed.hash !== ""
      || !parsed.pathname.endsWith("/v1/world") || parsed.pathname.endsWith("/")) return undefined;
    return Object.freeze({ url: url.value, tokenEnv: tokenEnv.value });
  } catch { return undefined; }
};
const result = (details: unknown, bearer: string) => {
  const pending: unknown[] = [details];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string") {
      if (value.includes(bearer)) return fail("world_response_invalid");
    } else if (Array.isArray(value)) {
      pending.push(...value);
    } else if (value !== null && typeof value === "object") {
      for (const [key, nested] of Object.entries(value)) {
        if (key.includes(bearer)) return fail("world_response_invalid");
        pending.push(nested);
      }
    }
  }
  let serialized: string;
  try { serialized = JSON.stringify(details); } catch { return fail("world_response_invalid"); }
  if (serialized.includes(bearer)) return fail("world_response_invalid");
  return { content: [{ type: "text" as const, text: serialized }], details };
};
const serialize = (value: unknown): string => {
  try {
    const output = JSON.stringify(value);
    if (output === undefined || UTF8.encode(output).byteLength > PI_WORLD_TOOL_LIMITS.requestBytes) return fail("world_request_invalid");
    return output;
  } catch { return fail("world_request_invalid"); }
};
const fetchResponse = async (
  fetchWorld: PiWorldFetch,
  url: string,
  init: RequestInit,
  signal: AbortSignal
): Promise<Response> => {
  if (signal.aborted) throw new RequestInterrupted();
  let interrupted: (() => void) | undefined;
  const interruption = new Promise<never>((_resolve, reject) => {
    interrupted = () => reject(new RequestInterrupted());
    signal.addEventListener("abort", interrupted, { once: true });
  });
  try { return await Promise.race([fetchWorld(url, init), interruption]); } finally {
    if (interrupted !== undefined) signal.removeEventListener("abort", interrupted);
  }
};
const readChunk = async (reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal) => {
  if (signal.aborted) throw new BodyReadCancelled();
  let cancelled: (() => void) | undefined;
  const interruption = new Promise<never>((_resolve, reject) => {
    cancelled = () => reject(new BodyReadCancelled());
    signal.addEventListener("abort", cancelled, { once: true });
  });
  try { return await Promise.race([reader.read(), interruption]); } finally {
    if (cancelled !== undefined) signal.removeEventListener("abort", cancelled);
  }
};
const readResponse = async (response: Response, signal: AbortSignal, maximum: number): Promise<unknown> => {
  const contentType = response.headers.get("content-type")?.toLowerCase();
  const contentLength = response.headers.get("content-length");
  if (contentType === undefined || contentType.split(";", 1)[0]?.trim() !== "application/json"
    || contentLength !== null && (!/^(?:0|[1-9][0-9]*)$/u.test(contentLength) || Number(contentLength) > maximum)
    || response.body === null) return fail("world_response_invalid");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await readChunk(reader, signal);
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximum) return fail("world_response_invalid");
      chunks.push(next.value.slice());
    }
  } catch (error) {
    if (error instanceof BodyReadCancelled) throw error;
    return fail("world_response_invalid");
  } finally {
    const release = (): void => {
      try { reader.releaseLock(); } catch { /* A failed read must not mask the fixed error. */ }
    };
    if (length > maximum || signal.aborted) {
      try { void reader.cancel().then(release, release); } catch { release(); }
    } else release();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch { return fail("world_response_invalid"); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return fail("world_response_invalid");
  return parsed;
};
const cancelBody = (response: Response): void => {
  try {
    const body = response.body;
    if (body !== null) void body.cancel().catch(() => {});
  } catch { /* Never surface response diagnostics. */ }
};

const schemas = Object.freeze({
  status: Type.Object({ decision_token: Type.String({ description: "Opaque current world decision token." }) }, { additionalProperties: false }),
  capabilities: Type.Object({ decision_token: Type.String({ description: "Opaque current world decision token." }) }, { additionalProperties: false }),
  observe: Type.Object({
    decision_token: Type.String({ description: "Opaque current world decision token." }),
    sense: Type.String({ description: "Granted world sense address." })
  }, { additionalProperties: false }),
  affordances: Type.Object({ decision_token: Type.String({ description: "Opaque current world decision token." }) }, { additionalProperties: false }),
  act: Type.Object({
    decision_token: Type.String({ description: "Opaque current world decision token." }),
    request_id: Type.String({ description: "Stable caller-generated id reused only for an exact retry." }),
    affordance: Type.String({ description: "Granted world affordance address." }),
    target: Type.String({ description: "World target entity address." }),
    input: Type.Unknown({ description: "Typed input declared by the selected affordance." })
  }, { additionalProperties: false }),
  ledger: Type.Object({
    decision_token: Type.String({ description: "Opaque current or consumed world decision token." }),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    result_after: Type.Optional(Type.Unknown({ description: "Opaque result cursor returned by a previous ledger call." }))
  }, { additionalProperties: false })
});
const boundSchemas = Object.freeze({
  claim: Type.Object({}, { additionalProperties: false }),
  status: Type.Object({}, { additionalProperties: false }),
  capabilities: Type.Object({}, { additionalProperties: false }),
  observe: Type.Object({
    sense: Type.String({ description: "Granted world sense address." })
  }, { additionalProperties: false }),
  affordances: Type.Object({}, { additionalProperties: false }),
  act: Type.Object({
    affordance: Type.String({ description: "Granted world affordance address." }),
    target: Type.String({ description: "World target entity address." }),
    input: Type.Unknown({ description: "Typed input declared by the selected affordance." })
  }, { additionalProperties: false }),
  ledger: Type.Object({
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    result_after: Type.Optional(Type.Unknown({ description: "Opaque result cursor returned by a previous ledger call." }))
  }, { additionalProperties: false })
});
const descriptors: ReadonlyArray<Readonly<{ name: PiWorldToolName; operation: WorldOperation; label: string; description: string }>> = Object.freeze([
  { name: "world_claim", operation: "claim", label: "Claim world authority", description: "Privately bind world authority to this organization-owned wake." },
  { name: "world_status", operation: "status", label: "World status", description: "Read authenticated world orientation and decision status." },
  { name: "world_capabilities", operation: "capabilities", label: "World capabilities", description: "Read the authenticated caller's world capability manifest." },
  { name: "world_observe", operation: "observe", label: "Observe world", description: "Invoke one granted world sense against current state." },
  { name: "world_affordances", operation: "affordances", label: "World affordances", description: "List currently available granted world actions." },
  { name: "world_act", operation: "act", label: "Act in world", description: "Attempt one world affordance with a stable request id." },
  { name: "world_ledger", operation: "ledger", label: "World ledger", description: "Read authenticated terminal action results." }
]);

export const createPiWorldTools = (input: CreatePiWorldToolsInput): PiWorldTool[] => {
  const world = binding(input.world);
  const timeoutMs = input.timeoutMs ?? PI_WORLD_TOOL_LIMITS.timeoutMs;
  const maximum = input.maxResponseBytes ?? PI_WORLD_TOOL_LIMITS.responseBytes;
  const fetchWorld = input.fetch ?? globalThis.fetch;
  const readEnvironment = input.readEnvironment ?? ((name: string) => process.env[name]);
  if (world === undefined || typeof fetchWorld !== "function" || typeof readEnvironment !== "function"
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000
    || !Number.isSafeInteger(maximum) || maximum < 128 || maximum > PI_WORLD_TOOL_LIMITS.responseBytes) {
    throw new TypeError("invalid Pi world tool configuration");
  }
  const available = input.contextRef === undefined
    ? descriptors.filter((descriptor) => descriptor.operation !== "claim")
    : descriptors;
  return available.map((descriptor) => defineTool({
    name: descriptor.name,
    label: descriptor.label,
    description: descriptor.description,
    promptSnippet: descriptor.description,
    promptGuidelines: ["Treat world tool values as scoped current state; never invent caller identity or world authority fields."],
    parameters: input.contextRef === undefined
      ? schemas[descriptor.operation as Exclude<WorldOperation, "claim">]
      : boundSchemas[descriptor.operation],
    async execute(_toolCallId, params, callerSignal) {
      if (callerSignal?.aborted) return fail("world_request_cancelled");
      let bearer: string | undefined;
      try { bearer = readEnvironment(world.tokenEnv); } catch { return fail("world_auth_unavailable"); }
      if (!token(bearer)) return fail("world_auth_unavailable");
      const serialized = serialize(descriptor.operation === "claim"
        ? createWorldClaimRequestBody(input.contextRef?.current) ?? fail("world_request_invalid")
        : createWorldRequestBody(descriptor.operation, params as Record<string, unknown>, input.contextRef?.current)
          ?? fail("world_request_invalid"));
      const controller = new AbortController();
      let timedOut = false;
      const cancel = (): void => controller.abort();
      if (callerSignal !== undefined) callerSignal.addEventListener("abort", cancel, { once: true });
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      try {
        let response: Response | undefined;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          if (callerSignal?.aborted) return fail("world_request_cancelled");
          if (controller.signal.aborted) return fail(timedOut ? "world_request_timeout" : "world_request_cancelled");
          try {
            response = await fetchResponse(fetchWorld, `${world.url}/${descriptor.operation}`, {
              method: "POST",
              headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
              body: serialized,
              signal: controller.signal
            }, controller.signal);
          } catch (error) {
            if (callerSignal?.aborted) return fail("world_request_cancelled");
            if (controller.signal.aborted) return fail(timedOut ? "world_request_timeout" : "world_request_cancelled");
            if (descriptor.operation !== "act" || !(error instanceof TypeError) || attempt === 1) {
              return fail("world_transport_unavailable");
            }
            continue;
          }
          let status: number;
          try { status = response.status; } catch { return fail("world_response_invalid"); }
          if (descriptor.operation === "act" && status === 408 && attempt === 0) {
            cancelBody(response);
            response = undefined;
            continue;
          }
          break;
        }
        if (response === undefined) return fail("world_transport_unavailable");
        try {
          const status = response.status;
          if (!response.ok) {
            cancelBody(response);
            if (status === 401 || status === 403) return fail("world_request_denied");
            return fail("world_request_rejected");
          }
          const details = await readResponse(response, controller.signal, maximum);
          if (descriptor.operation === "claim") {
            if (input.contextRef === undefined || input.contextRef.current === undefined) {
              return fail("world_response_invalid");
            }
            const claimed = parseWorldClaimResponse(details) ?? fail("world_response_invalid");
            input.contextRef.current = Object.freeze({
              ...input.contextRef.current,
              decisionToken: claimed.decisionToken,
              tick: claimed.issuedAtTick,
            });
            return result({
              claimed: true,
              decision_id: claimed.decisionId,
              issued_at_tick: claimed.issuedAtTick,
              valid_through_tick: claimed.validThroughTick,
            }, bearer);
          }
          return result(details, bearer);
        } catch (error) {
          if (error instanceof BodyReadCancelled) return fail(timedOut ? "world_request_timeout" : "world_request_cancelled");
          if (error instanceof PiWorldToolError) throw error;
          return fail("world_response_invalid");
        }
      } finally {
        clearTimeout(timer);
        if (callerSignal !== undefined) callerSignal.removeEventListener("abort", cancel);
      }
    }
  }));
};

export const piWorldToolNames = (tools: PiWorldTool[]): string[] => tools.map((tool) => tool.name);

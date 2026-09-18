import { isEngineBrokerInferenceRequestKind, isEngineBrokerInferenceResponseKind, parseEngineBrokerInferenceRequest, parseEngineBrokerInferenceResponse, type EngineBrokerInferenceRequest, type EngineBrokerInferenceResponse } from "./engineBrokerInferenceProtocol.js";
import { ENGINE_BROKER_MCP_CALL_NAME, ENGINE_BROKER_MCP_OUTSTANDING_MAX, ENGINE_BROKER_MCP_REFUSAL_REASONS, ENGINE_BROKER_MCP_TUNNEL_MAX, type EngineBrokerMcpCallObservation, type EngineBrokerMcpRefusalObservation, type EngineBrokerMcpTunnelObservation } from "./engineBrokerMcpCallLog.js";
import { parseEngineBrokerTurnAccounting, parseEngineBrokerTurnLimitOverrides, type EngineBrokerTurnAccounting, type EngineBrokerTurnLimitOverrides } from "./engineBrokerTurnAccounting.js";

/**
 * Control protocol v2. Both ends ship in the same Daimon package and image
 * (organization runtime client, broker service), so the wire moved to v2 in
 * one step: v1 frames are refused. v1 survives only as a *durable record*
 * shape, which {@link parseEngineBrokerV1TerminalResponse} still reads so
 * turns sealed before the upgrade keep replaying.
 */
const VERSION = "noopolis.daimon.engine-broker.v2" as const;
export const ENGINE_BROKER_VERSION = VERSION;
const V1 = "noopolis.daimon.engine-broker.v1" as const;
export const ENGINE_BROKER_MAX_FRAME_BYTES = 1_048_576;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export type EngineBrokerRequest =
  | Readonly<{ version: typeof VERSION; kind: "health"; requestId: string }>
  | Readonly<{ version: typeof VERSION; kind: "start_turn"; requestId: string; turnId: string; agentId: string; wakeId: string; prompt: string; mcpEndpoint: string; limits?: EngineBrokerTurnLimitOverrides }>
  | Readonly<{ version: typeof VERSION; kind: "cancel_turn"; requestId: string; turnId: string }>
  | EngineBrokerInferenceRequest;

/**
 * `reason` is the worker's own last words (`engineBrokerNativeClient.ts`),
 * already redacted and flattened to one bounded line by the broker. It is the
 * only field a failed turn carries that the worker itself wrote, so it is
 * optional, bounded, control-character free, and admitted only for the
 * statuses where a worker actually ran and spoke.
 */
export interface EngineBrokerFailureDiagnostic { status:string;stage:string;failureClass:string;profileApplied:boolean;reason?:string;exitCode:number;termSignal:number;workerPid:number;workerUid:number;startTicks:string }
export const ENGINE_BROKER_MAX_DIAGNOSTIC_REASON_BYTES = 768;

export type EngineBrokerResponse =
  | Readonly<{ version: typeof VERSION; kind: "ready"; requestId: string; brokerUid: 2100; providerProxyPort: 43123; mcpFacadePort: 43124; registrations: number; credentialStale: false; realmLease: true; workerIsolation: true }>
  | Readonly<{ version: typeof VERSION; kind: "accepted"; requestId: string; turnId: string }>
  | (Readonly<{ version: typeof VERSION; kind: "completed"; requestId: string; turnId: string; text: string; workerPid: number; workerUid: number; workerStartTime: string }> & EngineBrokerTurnAccounting)
  | (Readonly<{ version: typeof VERSION; kind: "failed"; requestId: string; turnId: string; code: EngineBrokerFailureCode; diagnostic?: EngineBrokerFailureDiagnostic; mcpCalls?: EngineBrokerMcpCallObservation }> & EngineBrokerTurnAccounting)
  | EngineBrokerInferenceResponse;
/**
 * The one name for a fenced credential realm. The turn's failure code, the
 * proxy's refusal reason on a worker request, and the grant path's 401 body
 * (`GROK_INFERENCE_AUTH_STALE_BODY`) all say this same word, so an operator
 * greps one string across every surface instead of three spellings of it.
 */
export const ENGINE_BROKER_AUTH_STALE = "auth_stale" as const;
export const ENGINE_BROKER_FAILURE_CODES = [ENGINE_BROKER_AUTH_STALE, "cancelled", "engine_failed", "invalid_request", "limit_exceeded", "turn_conflict", "unavailable"] as const;
export type EngineBrokerFailureCode = (typeof ENGINE_BROKER_FAILURE_CODES)[number];
export type EngineBrokerTerminalResponse = Extract<EngineBrokerResponse, { kind: "completed" | "failed" }>;
type V1Completed = Readonly<{ version: typeof V1; kind: "completed"; requestId: string; turnId: string; text: string; workerPid: number; workerUid: number; workerStartTime: string }>;
type V1Failed = Readonly<{ version: typeof V1; kind: "failed"; requestId: string; turnId: string; code: Exclude<EngineBrokerFailureCode, "limit_exceeded">; diagnostic?: EngineBrokerFailureDiagnostic }>;
export type EngineBrokerV1TerminalResponse = V1Completed | V1Failed;
const ACCOUNTING = ["outcome", "usage", "model", "requests", "limitReason"] as const;

type JsonRecord = Record<string, unknown>;
const record = (value: unknown): JsonRecord => {
  if (value === null || typeof value !== "object" || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new TypeError("invalid broker frame");
  return value as JsonRecord;
};
const exact = (value: JsonRecord, fields: readonly string[]): void => {
  if (Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field))) throw new TypeError("invalid broker frame");
};
const text = (value: unknown, maxBytes: number): string => {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > maxBytes) throw new TypeError("invalid broker frame");
  return value;
};
const id = (value: unknown): string => { const result = text(value, 128); if (!ID.test(result)) throw new TypeError("invalid broker frame"); return result; };
const version = (value: unknown): typeof VERSION => { if (value !== VERSION) throw new TypeError("invalid broker frame"); return VERSION; };

export function parseEngineBrokerRequest(value: unknown): EngineBrokerRequest {
  const input = record(value); version(input.version);
  if(input.kind==="health"){exact(input,["version","kind","requestId"]);return {version:VERSION,kind:"health",requestId:id(input.requestId)};}
  if (input.kind === "start_turn") {
    const fields = ["version", "kind", "requestId", "turnId", "agentId", "wakeId", "prompt", "mcpEndpoint"];
    exact(input, input.limits === undefined ? fields : [...fields, "limits"]);
    const mcpEndpoint=text(input.mcpEndpoint,2048);const url=new URL(mcpEndpoint);if(url.protocol!=="http:"||url.hostname!=="127.0.0.1"||url.pathname!=="/mcp")throw new TypeError("invalid broker frame");
    let limits: EngineBrokerTurnLimitOverrides | undefined;
    if (input.limits !== undefined) { try { limits = parseEngineBrokerTurnLimitOverrides(input.limits); } catch { throw new TypeError("invalid broker frame"); } }
    return { version: VERSION, kind: "start_turn", requestId: id(input.requestId), turnId: id(input.turnId), agentId: id(input.agentId), wakeId: id(input.wakeId), prompt: text(input.prompt, 65_536),mcpEndpoint,...(limits === undefined ? {} : { limits }) };
  }
  if (input.kind === "cancel_turn") {
    exact(input, ["version", "kind", "requestId", "turnId"]);
    return { version: VERSION, kind: "cancel_turn", requestId: id(input.requestId), turnId: id(input.turnId) };
  }
  if (isEngineBrokerInferenceRequestKind(input.kind)) return parseEngineBrokerInferenceRequest(input, id(input.requestId), VERSION);
  throw new TypeError("invalid broker frame");
}

export function parseEngineBrokerResponse(value: unknown): EngineBrokerResponse {
  const input = record(value); version(input.version);
  if(input.kind==="ready"){exact(input,["version","kind","requestId","brokerUid","providerProxyPort","mcpFacadePort","registrations","credentialStale","realmLease","workerIsolation"]);if(input.brokerUid!==2100||input.providerProxyPort!==43123||input.mcpFacadePort!==43124||!Number.isSafeInteger(input.registrations)||(input.registrations as number)<1||input.credentialStale!==false||input.realmLease!==true||input.workerIsolation!==true)throw new TypeError("invalid broker frame");return {version:VERSION,kind:"ready",requestId:id(input.requestId),brokerUid:2100,providerProxyPort:43123,mcpFacadePort:43124,registrations:input.registrations as number,credentialStale:false,realmLease:true,workerIsolation:true};}
  if (input.kind === "accepted") {
    exact(input, ["version", "kind", "requestId", "turnId"]);
    return { version: VERSION, kind: "accepted", requestId: id(input.requestId), turnId: id(input.turnId) };
  }
  if (input.kind === "completed" || input.kind === "failed") return parseTerminal(input, VERSION) as EngineBrokerTerminalResponse;
  if (isEngineBrokerInferenceResponseKind(input.kind)) return parseEngineBrokerInferenceResponse(input, id(input.requestId), VERSION);
  throw new TypeError("invalid broker frame");
}

/**
 * A terminal response persisted by a pre-v2 broker: the v1 field sets exactly,
 * with no accounting. Accepted only from the durable turn registry, never from
 * the wire.
 */
export function parseEngineBrokerV1TerminalResponse(value: unknown): EngineBrokerV1TerminalResponse {
  const input = record(value); if (input.version !== V1 || (input.kind !== "completed" && input.kind !== "failed")) throw new TypeError("invalid broker frame");
  return parseTerminal(input, V1) as EngineBrokerV1TerminalResponse;
}

function parseTerminal(input: JsonRecord, expected: typeof VERSION | typeof V1): EngineBrokerTerminalResponse | EngineBrokerV1TerminalResponse {
  const accounting = expected === VERSION ? ACCOUNTING : [];
  if (input.kind === "completed") {
    exact(input, ["version", "kind", "requestId", "turnId", "text", "workerPid", "workerUid", "workerStartTime", ...accounting]);
    if (!Number.isSafeInteger(input.workerPid) || (input.workerPid as number) < 1 || !Number.isSafeInteger(input.workerUid) || (input.workerUid as number) < 1) throw new TypeError("invalid broker frame");
    const base = { kind: "completed", requestId: id(input.requestId), turnId: id(input.turnId), text: text(input.text, 262_144), workerPid: input.workerPid as number, workerUid: input.workerUid as number, workerStartTime: id(input.workerStartTime) } as const;
    return expected === VERSION ? { version: VERSION, ...base, ...parseEngineBrokerTurnAccounting(input, "completed") } : { version: V1, ...base };
  }
  // `mcpCalls` is the broker's own observation of the worker's tool calls
  // (`engineBrokerMcpCallLog.ts`), additive in v2 and never part of a v1
  // record, which predates the instrument entirely.
  if (expected === V1 && input.mcpCalls !== undefined) throw new TypeError("invalid broker frame");
  const fields = ["version", "kind", "requestId", "turnId", "code", ...accounting, ...(input.diagnostic === undefined ? [] : ["diagnostic"]), ...(input.mcpCalls === undefined ? [] : ["mcpCalls"])];
  exact(input, fields);
  const codes: readonly string[] = expected === VERSION ? ENGINE_BROKER_FAILURE_CODES : ENGINE_BROKER_FAILURE_CODES.filter((code) => code !== "limit_exceeded");
  if (!codes.includes(input.code as string)) throw new TypeError("invalid broker frame");
  let diagnostic:EngineBrokerFailureDiagnostic|undefined;
  if(input.diagnostic!==undefined){const value=record(input.diagnostic);const fields=["status","stage","failureClass","profileApplied","exitCode","termSignal","workerPid","workerUid","startTicks"];exact(value,value.reason===undefined?fields:[...fields,"reason"]);if(value.reason!==undefined&&(typeof value.reason!=="string"||value.reason.length===0||Buffer.byteLength(value.reason,"utf8")>ENGINE_BROKER_MAX_DIAGNOSTIC_REASON_BYTES||/[\u0000-\u001f\u007f]/u.test(value.reason)))throw new TypeError("invalid broker frame");const status=["prelaunch_failed","worker_failed","output_failed","cancelled"],stage=["peer","request","registration","executable","exec","wait","output","attestation"],failureClass=["peer","protocol","registration","executable","exec","wait","output_limit","cancelled","profile_missing","profile_invalid"];if(!status.includes(value.status as string)||!stage.includes(value.stage as string)||!failureClass.includes(value.failureClass as string)||typeof value.profileApplied!=="boolean"||![value.exitCode,value.termSignal,value.workerPid,value.workerUid].every(Number.isSafeInteger)||typeof value.startTicks!=="string"||!/^(0|[1-9][0-9]*)$/u.test(value.startTicks)||!closedDiagnostic(value))throw new TypeError("invalid broker frame");diagnostic=value as unknown as EngineBrokerFailureDiagnostic;}
  const base = { kind: "failed", requestId: id(input.requestId), turnId: id(input.turnId), code: input.code as EngineBrokerFailureCode, ...(diagnostic ? { diagnostic } : {}) } as const;
  if (expected === V1) return { version: V1, ...base } as V1Failed;
  const accountingValue = parseEngineBrokerTurnAccounting(input, "failed");
  if ((input.code === "limit_exceeded") !== (accountingValue.limitReason !== "none")) throw new TypeError("invalid broker frame");
  const mcpCalls = input.mcpCalls === undefined ? undefined : parseMcpCallObservation(input.mcpCalls);
  return { version: VERSION, ...base, ...(mcpCalls === undefined ? {} : { mcpCalls }), ...accountingValue };
}

/**
 * Names and timings, bounded, and internally consistent: a report can never
 * claim more answered calls than started ones, nor more outstanding ones than
 * started minus answered. Every count is its own measurement, so a missing
 * field is refused rather than defaulted — a zero the broker did not measure
 * would read exactly like one it did.
 */
function parseMcpCallObservation(value: unknown): EngineBrokerMcpCallObservation {
  const input = record(value);
  // `tunnels` is optional for one reason only: a turn sealed before the GET
  // tunnel was observed carries no such member, and its record must still
  // replay. Absence there means "the instrument did not exist", never zero.
  exact(input, ["started", "answered", "undecoded", "outstanding", ...(input.tunnels === undefined ? [] : ["tunnels"]), ...(input.refusals === undefined ? [] : ["refusals"])]);
  const started = input.started, answered = input.answered, undecoded = input.undecoded;
  if (![started, answered, undecoded].every((count) => Number.isSafeInteger(count) && (count as number) >= 0)) throw new TypeError("invalid broker frame");
  if (!Array.isArray(input.outstanding) || input.outstanding.length > ENGINE_BROKER_MCP_OUTSTANDING_MAX) throw new TypeError("invalid broker frame");
  const outstanding = input.outstanding.map((entry) => {
    const call = record(entry);
    exact(call, ["name", "outstandingMs"]);
    if (typeof call.name !== "string" || !ENGINE_BROKER_MCP_CALL_NAME.test(call.name)) throw new TypeError("invalid broker frame");
    if (!Number.isSafeInteger(call.outstandingMs) || (call.outstandingMs as number) < 0) throw new TypeError("invalid broker frame");
    return { name: call.name, outstandingMs: call.outstandingMs as number };
  });
  if ((answered as number) > (started as number) || outstanding.length > (started as number) - (answered as number)) throw new TypeError("invalid broker frame");
  const tunnels = input.tunnels === undefined ? undefined : parseMcpTunnelObservation(input.tunnels);
  const refusals = input.refusals === undefined ? undefined : parseMcpRefusalObservation(input.refusals);
  return { started: started as number, answered: answered as number, undecoded: undecoded as number, outstanding, ...(tunnels === undefined ? {} : { tunnels }), ...(refusals === undefined ? {} : { refusals }) };
}

/**
 * The refused requests, by reason class: one count per closed reason, all of
 * them required once the member is present. Optional for the same single
 * reason `tunnels` is — a turn sealed before the facade counted its refusals
 * must still replay — so its absence means "not measured" and never zero, and
 * a partial member is refused rather than zero-filled.
 */
function parseMcpRefusalObservation(value: unknown): EngineBrokerMcpRefusalObservation {
  const input = record(value);
  exact(input, ENGINE_BROKER_MCP_REFUSAL_REASONS);
  for (const reason of ENGINE_BROKER_MCP_REFUSAL_REASONS) {
    if (!Number.isSafeInteger(input[reason]) || (input[reason] as number) < 0) throw new TypeError("invalid broker frame");
  }
  return Object.fromEntries(ENGINE_BROKER_MCP_REFUSAL_REASONS.map((reason) => [reason, input[reason] as number])) as EngineBrokerMcpRefusalObservation;
}

/**
 * The GET SSE tunnels, under the call observation's rules: counts and elapsed
 * milliseconds, bounded, and internally consistent. A tunnel cannot close
 * before it opened, cannot deliver without having opened, and no more can be
 * reported open than `opened - closed` — a report claiming otherwise is a
 * frame, not a measurement.
 */
function parseMcpTunnelObservation(value: unknown): EngineBrokerMcpTunnelObservation {
  const input = record(value);
  exact(input, ["opened", "closed", "delivered", "open"]);
  const opened = input.opened, closed = input.closed, delivered = input.delivered;
  if (![opened, closed, delivered].every((count) => Number.isSafeInteger(count) && (count as number) >= 0)) throw new TypeError("invalid broker frame");
  if ((closed as number) > (opened as number) || (delivered as number) > (opened as number)) throw new TypeError("invalid broker frame");
  if (!Array.isArray(input.open) || input.open.length > ENGINE_BROKER_MCP_TUNNEL_MAX || input.open.length > (opened as number) - (closed as number)) throw new TypeError("invalid broker frame");
  const open = input.open.map((entry) => {
    const tunnel = record(entry);
    exact(tunnel, ["openMs", "delivered"]);
    if (!Number.isSafeInteger(tunnel.openMs) || (tunnel.openMs as number) < 0 || typeof tunnel.delivered !== "boolean") throw new TypeError("invalid broker frame");
    return { openMs: tunnel.openMs as number, delivered: tunnel.delivered };
  });
  return { opened: opened as number, closed: closed as number, delivered: delivered as number, open };
}

function closedDiagnostic(value:JsonRecord):boolean{
  if(value.profileApplied!==false||(value.workerPid as number)<0||(value.workerUid as number)<0)return false;
  // Only a worker that ran and wrote something can have said why it failed:
  // no prelaunch failure and no attestation refusal carries worker words.
  if(value.reason!==undefined&&!((value.status==="worker_failed"&&value.stage==="wait")||value.status==="output_failed"||value.status==="cancelled"))return false;
  const noWorker=value.workerPid===0&&value.workerUid===0&&value.startTicks==="0";
  const worker=(value.workerPid as number)>0&&(value.workerUid as number)>=2200&&value.startTicks!=="0";
  if(value.status==="prelaunch_failed")return noWorker&&({peer:"peer",request:"protocol",registration:"registration",executable:"executable",exec:"exec"} as Record<string,string>)[value.stage as string]===value.failureClass;
  if(value.status==="worker_failed"&&value.stage==="attestation")return worker&&(value.failureClass==="profile_missing"||value.failureClass==="profile_invalid");
  if(value.status==="worker_failed")return worker&&value.stage==="wait"&&(value.failureClass==="exec"||value.failureClass==="wait");
  if(value.status==="output_failed")return worker&&value.stage==="output"&&value.failureClass==="output_limit";
  return value.status==="cancelled"&&worker&&value.stage==="wait"&&value.failureClass==="cancelled";
}

export function encodeEngineBrokerFrame(value: EngineBrokerRequest | EngineBrokerResponse): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length > ENGINE_BROKER_MAX_FRAME_BYTES) throw new TypeError("invalid broker frame");
  const frame = Buffer.allocUnsafe(body.length + 4); frame.writeUInt32BE(body.length); body.copy(frame, 4); return frame;
}

export class EngineBrokerFrameDecoder {
  private buffered = Buffer.alloc(0);
  push(chunk: Uint8Array): unknown[] {
    this.buffered = Buffer.concat([this.buffered, chunk]);
    const values: unknown[] = [];
    while (this.buffered.length >= 4) {
      const length = this.buffered.readUInt32BE(0);
      if (length === 0 || length > ENGINE_BROKER_MAX_FRAME_BYTES) throw new TypeError("invalid broker frame");
      if (this.buffered.length < length + 4) break;
      const body = this.buffered.subarray(4, length + 4); this.buffered = this.buffered.subarray(length + 4);
      try { values.push(JSON.parse(body.toString("utf8"))); } catch { throw new TypeError("invalid broker frame"); }
    }
    return values;
  }
  finish(): void { if (this.buffered.length !== 0) throw new TypeError("incomplete broker frame"); }
}

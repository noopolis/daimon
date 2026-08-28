const VERSION = "noopolis.daimon.engine-broker.v1" as const;
export const ENGINE_BROKER_MAX_FRAME_BYTES = 1_048_576;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export type EngineBrokerRequest =
  | Readonly<{ version: typeof VERSION; kind: "health"; requestId: string }>
  | Readonly<{ version: typeof VERSION; kind: "start_turn"; requestId: string; turnId: string; agentId: string; wakeId: string; prompt: string; mcpEndpoint: string }>
  | Readonly<{ version: typeof VERSION; kind: "cancel_turn"; requestId: string; turnId: string }>;

export interface EngineBrokerFailureDiagnostic { status:string;stage:string;failureClass:string;profileApplied:boolean;exitCode:number;termSignal:number;workerPid:number;workerUid:number;startTicks:string }

export type EngineBrokerResponse =
  | Readonly<{ version: typeof VERSION; kind: "ready"; requestId: string; brokerUid: 2100; providerProxyPort: 43123; mcpFacadePort: 43124; registrations: number; credentialStale: false; realmLease: true; workerIsolation: true }>
  | Readonly<{ version: typeof VERSION; kind: "accepted"; requestId: string; turnId: string }>
  | Readonly<{ version: typeof VERSION; kind: "completed"; requestId: string; turnId: string; text: string; workerPid: number; workerUid: number; workerStartTime: string }>
  | Readonly<{ version: typeof VERSION; kind: "failed"; requestId: string; turnId: string; code: "auth_stale" | "cancelled" | "engine_failed" | "invalid_request" | "turn_conflict" | "unavailable"; diagnostic?: EngineBrokerFailureDiagnostic }>;

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
    exact(input, ["version", "kind", "requestId", "turnId", "agentId", "wakeId", "prompt", "mcpEndpoint"]);
    const mcpEndpoint=text(input.mcpEndpoint,2048);const url=new URL(mcpEndpoint);if(url.protocol!=="http:"||url.hostname!=="127.0.0.1"||url.pathname!=="/mcp")throw new TypeError("invalid broker frame");
    return { version: VERSION, kind: "start_turn", requestId: id(input.requestId), turnId: id(input.turnId), agentId: id(input.agentId), wakeId: id(input.wakeId), prompt: text(input.prompt, 65_536),mcpEndpoint };
  }
  if (input.kind === "cancel_turn") {
    exact(input, ["version", "kind", "requestId", "turnId"]);
    return { version: VERSION, kind: "cancel_turn", requestId: id(input.requestId), turnId: id(input.turnId) };
  }
  throw new TypeError("invalid broker frame");
}

export function parseEngineBrokerResponse(value: unknown): EngineBrokerResponse {
  const input = record(value); version(input.version);
  if(input.kind==="ready"){exact(input,["version","kind","requestId","brokerUid","providerProxyPort","mcpFacadePort","registrations","credentialStale","realmLease","workerIsolation"]);if(input.brokerUid!==2100||input.providerProxyPort!==43123||input.mcpFacadePort!==43124||!Number.isSafeInteger(input.registrations)||(input.registrations as number)<1||input.credentialStale!==false||input.realmLease!==true||input.workerIsolation!==true)throw new TypeError("invalid broker frame");return {version:VERSION,kind:"ready",requestId:id(input.requestId),brokerUid:2100,providerProxyPort:43123,mcpFacadePort:43124,registrations:input.registrations as number,credentialStale:false,realmLease:true,workerIsolation:true};}
  if (input.kind === "accepted") {
    exact(input, ["version", "kind", "requestId", "turnId"]);
    return { version: VERSION, kind: "accepted", requestId: id(input.requestId), turnId: id(input.turnId) };
  }
  if (input.kind === "completed") {
    exact(input, ["version", "kind", "requestId", "turnId", "text", "workerPid", "workerUid", "workerStartTime"]);
    if (!Number.isSafeInteger(input.workerPid) || (input.workerPid as number) < 1 || !Number.isSafeInteger(input.workerUid) || (input.workerUid as number) < 1) throw new TypeError("invalid broker frame");
    return { version: VERSION, kind: "completed", requestId: id(input.requestId), turnId: id(input.turnId), text: text(input.text, 262_144), workerPid: input.workerPid as number, workerUid: input.workerUid as number, workerStartTime: id(input.workerStartTime) };
  }
  if (input.kind === "failed") {
    exact(input, input.diagnostic === undefined ? ["version", "kind", "requestId", "turnId", "code"] : ["version", "kind", "requestId", "turnId", "code", "diagnostic"]);
    const codes = ["auth_stale", "cancelled", "engine_failed", "invalid_request", "turn_conflict", "unavailable"] as const;
    if (!codes.includes(input.code as typeof codes[number])) throw new TypeError("invalid broker frame");
    let diagnostic:EngineBrokerFailureDiagnostic|undefined;
    if(input.diagnostic!==undefined){const value=record(input.diagnostic);exact(value,["status","stage","failureClass","profileApplied","exitCode","termSignal","workerPid","workerUid","startTicks"]);const status=["prelaunch_failed","worker_failed","output_failed","cancelled"],stage=["peer","request","registration","executable","exec","wait","output","attestation"],failureClass=["peer","protocol","registration","executable","exec","wait","output_limit","cancelled","profile_missing","profile_invalid"];if(!status.includes(value.status as string)||!stage.includes(value.stage as string)||!failureClass.includes(value.failureClass as string)||typeof value.profileApplied!=="boolean"||![value.exitCode,value.termSignal,value.workerPid,value.workerUid].every(Number.isSafeInteger)||typeof value.startTicks!=="string"||!/^(0|[1-9][0-9]*)$/u.test(value.startTicks)||!closedDiagnostic(value))throw new TypeError("invalid broker frame");diagnostic=value as unknown as EngineBrokerFailureDiagnostic;}
    return { version: VERSION, kind: "failed", requestId: id(input.requestId), turnId: id(input.turnId), code: input.code as typeof codes[number],...(diagnostic?{diagnostic}:{}) };
  }
  throw new TypeError("invalid broker frame");
}

function closedDiagnostic(value:JsonRecord):boolean{
  if(value.profileApplied!==false||(value.workerPid as number)<0||(value.workerUid as number)<0)return false;
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

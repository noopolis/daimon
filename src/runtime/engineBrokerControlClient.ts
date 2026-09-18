import { createHash, randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { ENGINE_BROKER_VERSION, encodeEngineBrokerFrame,EngineBrokerFrameDecoder,parseEngineBrokerResponse } from "./engineBrokerProtocol.js";
import type { EngineBrokerInferenceFailureCode, EngineBrokerInferenceRequest, EngineBrokerInferenceResponse } from "./engineBrokerInferenceProtocol.js";
import type { EngineBrokerMcpCallObservation } from "./engineBrokerMcpCallLog.js";
import type { EngineBrokerTurnLimitOverrides } from "./engineBrokerTurnAccounting.js";
import type { GrokBrokerModel, GrokBrokerReasoningEffort } from "./grokBrokerModelPolicy.js";
import type { GrokInferencePurpose } from "./inferenceUsageLedger.js";

/**
 * What the broker saw of the worker's MCP tool calls on a failed turn
 * (`engineBrokerMcpCallLog.ts`). Absent for a turn with no observation at all;
 * `outstanding` names every call that started and was never answered, with how
 * long it had been waiting — the one thing a completion-only tool receipt can
 * never say.
 */
const renderMcpCalls=(calls:EngineBrokerMcpCallObservation|undefined):string=>calls===undefined?"":`; mcp=${calls.answered}/${calls.started} answered${calls.undecoded===0?"":`; mcp_undecoded=${calls.undecoded}`}${calls.outstanding.length===0?"":`; mcp_outstanding=${calls.outstanding.map((call)=>`${call.name}@${call.outstandingMs}ms`).join(",")}`}`;

export type EngineBrokerInferenceGrant = Omit<Extract<EngineBrokerInferenceResponse, { kind: "inference_grant" }>, "version" | "kind" | "requestId">;
/** A refused grant request; `code` is closed (`auth_stale` is the stale shared realm, `grant_limit` the live-grant cap). */
export class EngineBrokerInferenceGrantRefused extends Error {
  constructor(readonly code: EngineBrokerInferenceFailureCode) { super(`engine broker inference grant refused (${code})`); }
}

/**
 * What the organization runtime asks of a brokered turn beyond the prompt:
 * `limits` may only lower the registration's declared limits, and `model`,
 * when the agent declared one, must equal the model the broker sealed.
 */
export type EngineBrokerTurnOptions = Readonly<{ limits?: EngineBrokerTurnLimitOverrides; model?: string }>;
export interface EngineBrokerTurnClient { turn(agentId:string,wakeId:string,prompt:string,mcpEndpoint:string,signal?:AbortSignal,options?:EngineBrokerTurnOptions):Promise<string>; }
export class EngineBrokerControlClient implements EngineBrokerTurnClient {
  constructor(private readonly socketPath="/run/daimon-engine-broker/control.sock"){}
  async ready():Promise<void>{const requestId=randomUUID(),socket=createConnection({path:this.socketPath}),decoder=new EngineBrokerFrameDecoder();await new Promise<void>((resolve,reject)=>{let settled=false;const fail=()=>{if(settled)return;settled=true;socket.destroy();reject(new Error("engine broker unavailable"));};socket.once("error",fail);socket.once("close",fail);socket.once("connect",()=>socket.write(encodeEngineBrokerFrame({version:ENGINE_BROKER_VERSION,kind:"health",requestId})));socket.on("data",(chunk)=>{try{for(const value of decoder.push(chunk)){const response=parseEngineBrokerResponse(value);if(response.kind!=="ready"||response.requestId!==requestId||settled)throw new Error();settled=true;socket.destroy();resolve();}}catch{fail();}});});}
  /**
   * Evaluator side (organization uid only; the native relay enforces it):
   * borrow the broker credential for one sequential lane of judge or optimizer
   * requests. Refusals reject with {@link EngineBrokerInferenceGrantRefused};
   * a broker that cannot answer rejects with `engine broker unavailable`.
   */
  async requestInferenceGrant(request:Readonly<{model:GrokBrokerModel;reasoningEffort:GrokBrokerReasoningEffort;purpose:GrokInferencePurpose}>):Promise<EngineBrokerInferenceGrant>{
    const response=await this.exchange({version:ENGINE_BROKER_VERSION,kind:"request_inference_grant",requestId:randomUUID(),model:request.model,reasoningEffort:request.reasoningEffort,purpose:request.purpose});
    if(response.kind==="inference_grant_refused")throw new EngineBrokerInferenceGrantRefused(response.code);
    if(response.kind!=="inference_grant"||response.model!==request.model||response.reasoningEffort!==request.reasoningEffort||response.purpose!==request.purpose)throw new Error("engine broker unavailable");
    const {version:_version,kind:_kind,requestId:_requestId,...grant}=response;return grant;
  }
  async releaseInferenceGrant(grantId:string):Promise<boolean>{
    const response=await this.exchange({version:ENGINE_BROKER_VERSION,kind:"release_inference_grant",requestId:randomUUID(),grantId});
    if(response.kind==="inference_grant_refused")throw new EngineBrokerInferenceGrantRefused(response.code);
    if(response.kind!=="inference_grant_released"||response.grantId!==grantId)throw new Error("engine broker unavailable");
    return response.released;
  }
  private exchange(request:EngineBrokerInferenceRequest):Promise<EngineBrokerInferenceResponse>{const socket=createConnection({path:this.socketPath}),decoder=new EngineBrokerFrameDecoder();return new Promise((resolve,reject)=>{let settled=false;const fail=()=>{if(settled)return;settled=true;socket.destroy();reject(new Error("engine broker unavailable"));};socket.once("error",fail);socket.once("close",fail);socket.once("connect",()=>socket.write(encodeEngineBrokerFrame(request)));socket.on("data",(chunk)=>{try{for(const value of decoder.push(chunk)){const response=parseEngineBrokerResponse(value);if(settled||response.requestId!==request.requestId||(response.kind!=="inference_grant"&&response.kind!=="inference_grant_released"&&response.kind!=="inference_grant_refused"))throw new Error();settled=true;socket.destroy();resolve(response);}}catch{fail();}});});}
  async turn(agentId:string,wakeId:string,prompt:string,mcpEndpoint:string,signal?:AbortSignal,options:EngineBrokerTurnOptions={}):Promise<string>{
    const turnId=createHash("sha256").update(`${agentId}\0${wakeId}`).digest("hex"),requestId=randomUUID();const request={version:ENGINE_BROKER_VERSION,kind:"start_turn",requestId,turnId,agentId,wakeId,prompt,mcpEndpoint,...(options.limits===undefined?{}:{limits:options.limits})} as const;const socket=createConnection({path:this.socketPath});const decoder=new EngineBrokerFrameDecoder();
    return new Promise<string>((resolve,reject)=>{let accepted=false,settled=false;const fail=()=>{if(settled)return;settled=true;cleanup();reject(new Error("engine broker unavailable"));};const cleanup=()=>{signal?.removeEventListener("abort",abort);socket.destroy();};const abort=()=>fail();signal?.addEventListener("abort",abort,{once:true});if(signal?.aborted)return abort();socket.once("connect",()=>socket.write(encodeEngineBrokerFrame(request)));socket.on("data",(chunk)=>{try{for(const value of decoder.push(chunk)){const response=parseEngineBrokerResponse(value);if((response.kind!=="accepted"&&response.kind!=="completed"&&response.kind!=="failed")||response.requestId!==requestId||response.turnId!==turnId)throw new Error();if(response.kind==="accepted"){if(accepted)throw new Error();accepted=true;continue;}if(!accepted||settled)throw new Error();settled=true;cleanup();
      if(options.model!==undefined&&response.model!==options.model){reject(new Error(`engine broker turn used model ${response.model}, not the declared ${options.model}`));return;}
      if(response.kind==="completed")resolve(response.text);else reject(new Error(`engine broker turn failed (${response.code}${response.limitReason==="none"?"":`; limit=${response.limitReason}`}${response.diagnostic ? `; ${response.diagnostic.stage}/${response.diagnostic.failureClass}; exit=${response.diagnostic.exitCode}; signal=${response.diagnostic.termSignal}${response.diagnostic.reason===undefined?"":`; reason=${response.diagnostic.reason}`}` : ""}${renderMcpCalls(response.mcpCalls)})`));}}catch{fail();}});socket.once("error",fail);socket.once("close",()=>{if(!settled)fail();});});
  }
}

import { createHash, randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { ENGINE_BROKER_VERSION, encodeEngineBrokerFrame,EngineBrokerFrameDecoder,parseEngineBrokerResponse } from "./engineBrokerProtocol.js";
import type { EngineBrokerTurnLimitOverrides } from "./engineBrokerTurnAccounting.js";

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
  async turn(agentId:string,wakeId:string,prompt:string,mcpEndpoint:string,signal?:AbortSignal,options:EngineBrokerTurnOptions={}):Promise<string>{
    const turnId=createHash("sha256").update(`${agentId}\0${wakeId}`).digest("hex"),requestId=randomUUID();const request={version:ENGINE_BROKER_VERSION,kind:"start_turn",requestId,turnId,agentId,wakeId,prompt,mcpEndpoint,...(options.limits===undefined?{}:{limits:options.limits})} as const;const socket=createConnection({path:this.socketPath});const decoder=new EngineBrokerFrameDecoder();
    return new Promise<string>((resolve,reject)=>{let accepted=false,settled=false;const fail=()=>{if(settled)return;settled=true;cleanup();reject(new Error("engine broker unavailable"));};const cleanup=()=>{signal?.removeEventListener("abort",abort);socket.destroy();};const abort=()=>fail();signal?.addEventListener("abort",abort,{once:true});if(signal?.aborted)return abort();socket.once("connect",()=>socket.write(encodeEngineBrokerFrame(request)));socket.on("data",(chunk)=>{try{for(const value of decoder.push(chunk)){const response=parseEngineBrokerResponse(value);if(response.kind==="ready"||response.requestId!==requestId||response.turnId!==turnId)throw new Error();if(response.kind==="accepted"){if(accepted)throw new Error();accepted=true;continue;}if(!accepted||settled)throw new Error();settled=true;cleanup();
      if(options.model!==undefined&&response.model!==options.model){reject(new Error(`engine broker turn used model ${response.model}, not the declared ${options.model}`));return;}
      if(response.kind==="completed")resolve(response.text);else reject(new Error(`engine broker turn failed (${response.code}${response.limitReason==="none"?"":`; limit=${response.limitReason}`}${response.diagnostic ? `; ${response.diagnostic.stage}/${response.diagnostic.failureClass}; exit=${response.diagnostic.exitCode}; signal=${response.diagnostic.termSignal}` : ""})`));}}catch{fail();}});socket.once("error",fail);socket.once("close",()=>{if(!settled)fail();});});
  }
}

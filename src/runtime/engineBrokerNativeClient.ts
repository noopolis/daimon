import { spawn } from "node:child_process";
import { terminateChild, trackCliChild } from "../pi/cliProcess.js";

export const ENGINE_BROKER_NATIVE_REQUEST_BYTES = 396;
export const ENGINE_BROKER_NATIVE_RESULT_BYTES = 128;
const MAX_PROMPT = 65_536, MAX_CAPABILITY = 4_096, MAX_OUTPUT = 65_536;
const statuses = ["ok", "prelaunch_failed", "worker_failed", "output_failed", "cancelled"] as const;
const stages = ["none", "peer", "request", "registration", "executable", "exec", "wait", "output", "attestation"] as const;
const failures = ["none", "peer", "protocol", "registration", "executable", "exec", "wait", "output_limit", "cancelled", "profile_missing", "profile_invalid"] as const;

export interface NativeBrokerDiagnostic { exitCode:number;failureClass:typeof failures[number];profileApplied:boolean;stage:typeof stages[number];startTicks:string;status:typeof statuses[number];termSignal:number;workerPid:number;workerUid:number }
export class NativeBrokerTurnFailure extends Error { constructor(readonly diagnostic:NativeBrokerDiagnostic){super("engine broker turn failed");} }
export type NativeBrokerTurn = Readonly<{slot:number;requestId:string;turnId:string;agentId:string;wakeId:string;prompt:string;providerCapability:string;mcpCapability:string}>;
export interface NativeBrokerTurnResult {text:string;workerPid:number;workerUid:number;startTicks:bigint;diagnostic:NativeBrokerDiagnostic}

export async function runNativeBrokerTurn(executable:string,input:NativeBrokerTurn,signal?:AbortSignal):Promise<Readonly<NativeBrokerTurnResult>>{
  const frame=encodeNativeBrokerTurn(input),child=trackCliChild(spawn(executable,["--client"],{detached:process.platform!=="win32",env:{LANG:"C",LC_ALL:"C",TZ:"UTC"},stdio:["pipe","pipe","ignore"],...(signal===undefined?{}:{signal})}));const chunks:Buffer[]=[];let bytes=0;
  child.stdout!.on("data",(chunk:Buffer)=>{bytes+=chunk.length;if(bytes<=ENGINE_BROKER_NATIVE_RESULT_BYTES+MAX_OUTPUT)chunks.push(chunk);});child.stdin!.end(frame);frame.fill(0);
  try{const code=await new Promise<number|null>((resolve,reject)=>{child.once("error",reject);child.once("exit",resolve);});if(code!==0||bytes>ENGINE_BROKER_NATIVE_RESULT_BYTES+MAX_OUTPUT)throw new Error();return decodeNativeBrokerResult(Buffer.concat(chunks),input.turnId);}catch(error){if(error instanceof NativeBrokerTurnFailure)throw error;throw new Error("engine broker turn failed");}finally{await terminateChild(child).catch(()=>undefined);}
}
export function encodeNativeBrokerTurn(input:NativeBrokerTurn):Buffer{if(!Number.isInteger(input.slot)||input.slot<0)throw new TypeError("invalid engine broker turn");const p=Buffer.from(input.prompt),provider=Buffer.from(input.providerCapability),mcp=Buffer.from(input.mcpCapability);if(p.length<1||p.length>MAX_PROMPT||provider.length<1||provider.length>MAX_CAPABILITY||mcp.length<1||mcp.length>MAX_CAPABILITY||provider.equals(mcp))throw new TypeError("invalid engine broker turn");const c=Buffer.alloc(4+provider.length+mcp.length);c.writeUInt16LE(provider.length,0);provider.copy(c,2);c.writeUInt16LE(mcp.length,2+provider.length);mcp.copy(c,4+provider.length);const frame=Buffer.alloc(ENGINE_BROKER_NATIVE_REQUEST_BYTES+8+p.length+c.length);frame.writeUInt32LE(2,0);frame.writeUInt32LE(input.slot,4);field(frame,8,65,input.requestId);field(frame,73,65,input.turnId);field(frame,138,129,input.agentId);field(frame,267,129,input.wakeId);let o=ENGINE_BROKER_NATIVE_REQUEST_BYTES;frame.writeUInt32LE(p.length,o);o+=4;p.copy(frame,o);o+=p.length;frame.writeUInt32LE(c.length,o);o+=4;c.copy(frame,o);p.fill(0);provider.fill(0);mcp.fill(0);c.fill(0);return frame;}

export function decodeNativeBrokerResult(output:Buffer,turnId:string):NativeBrokerTurnResult{
  if(output.length<ENGINE_BROKER_NATIVE_RESULT_BYTES)throw new Error("engine broker turn failed");
  const status=output.readUInt32LE(4),uid=output.readUInt32LE(8),length=output.readUInt32LE(12),pid=output.readInt32LE(16),exitCode=output.readInt32LE(20),termSignal=output.readInt32LE(24),ticks=output.readBigUInt64LE(32),stage=output.readUInt32LE(108),failure=output.readUInt32LE(112),profile=output.readUInt32LE(116),reserved=output.readUInt32LE(120),observed=output.subarray(40,105).toString("utf8").replace(/\0.*$/u,"");
  const paddingZero=[output.subarray(28,32),output.subarray(105,108),output.subarray(124,128)].every((bytes)=>bytes.every((byte)=>byte===0));
  if(output.length!==ENGINE_BROKER_NATIVE_RESULT_BYTES+length||output.readUInt32LE(0)!==2||status>=statuses.length||stage>=stages.length||failure>=failures.length||profile>1||reserved!==0||!paddingZero||observed!==turnId||length>MAX_OUTPUT)throw new Error("engine broker turn failed");
  const diagnostic:NativeBrokerDiagnostic={status:statuses[status]!,stage:stages[stage]!,failureClass:failures[failure]!,profileApplied:profile===1,exitCode,termSignal,workerPid:pid,workerUid:uid,startTicks:ticks.toString()};
  const success=status===0&&stage===7&&failure===0&&profile===0&&pid>0&&uid>=2200&&ticks>0n&&exitCode===0&&termSignal===0;
  const prelaunch=status===1&&stage>=1&&stage<=5&&failure>=1&&failure<=5&&profile===0&&pid===0&&uid===0&&ticks===0n;
  const worker=status===2&&stage===6&&(failure===5||failure===6)&&profile===0&&pid>0&&uid>=2200&&ticks>0n;
  const outputFailure=status===3&&stage===7&&failure===7&&profile===0&&pid>0&&uid>=2200&&ticks>0n;
  const cancelled=status===4&&stage===6&&failure===8&&profile===0&&pid>0&&uid>=2200&&ticks>0n;
  if(!success){if(length!==0||(!prelaunch&&!worker&&!outputFailure&&!cancelled))throw new Error("engine broker turn failed");throw new NativeBrokerTurnFailure(diagnostic);}
  return{text:output.subarray(ENGINE_BROKER_NATIVE_RESULT_BYTES).toString("utf8"),workerUid:uid,workerPid:pid,startTicks:ticks,diagnostic};
}
function field(target:Buffer,offset:number,length:number,value:string):void{if(!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)||Buffer.byteLength(value)>=length)throw new TypeError("invalid engine broker turn");target.write(value,offset,"utf8");}

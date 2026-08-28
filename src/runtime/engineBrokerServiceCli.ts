import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { startEngineBrokerService } from "./engineBrokerService.js";
import { startGrokEngineBroker, type GrokEngineBrokerRegistration } from "./grokEngineBroker.js";

export const ENGINE_BROKER_SERVICE_CONFIG = "/etc/daimon-engine-broker/service.json";
const MAX_CONFIG_BYTES=65_536;

export async function runEngineBrokerServiceCli():Promise<void>{
  if(process.getuid?.()!==2100)throw new Error("engine broker service requires broker identity");
  const config=parseEngineBrokerServiceConfig(await readRootConfig(ENGINE_BROKER_SERVICE_CONFIG));
  const broker=await startGrokEngineBroker({grokCommand:"/usr/local/bin/grok",nativeClient:"/opt/daimon/bin/daimon-engine-broker",credentialHome:config.credentialHome,turnStore:config.turnStore,registrations:config.registrations});
  const service=await startEngineBrokerService(broker);let stopping:Promise<void>|undefined;
  const stop=()=>{stopping??=service.close();return stopping;};
  const onSignal=()=>{void stop().catch(()=>{process.exitCode=1;});};process.once("SIGINT",onSignal);process.once("SIGTERM",onSignal);
}

export function parseEngineBrokerServiceConfig(value:unknown):Readonly<{credentialHome:string;turnStore:string;registrations:readonly GrokEngineBrokerRegistration[]}>{
  if(value===null||typeof value!=="object"||Array.isArray(value))throw new TypeError("invalid engine broker service config");const input=value as Record<string,unknown>;
  if(Object.keys(input).length!==4||input.version!=="noopolis.daimon.engine-broker-service.v1"||typeof input.credentialHome!=="string"||typeof input.turnStore!=="string"||!Array.isArray(input.registrations))throw new TypeError("invalid engine broker service config");
  const absolute=(item:string)=>item.startsWith("/")&&!item.includes("/../")&&!item.endsWith("/..");if(!absolute(input.credentialHome)||!absolute(input.turnStore))throw new TypeError("invalid engine broker service config");
  const seen=new Set<string>();const registrations=input.registrations.map((entry)=>{if(entry===null||typeof entry!=="object"||Array.isArray(entry))throw new TypeError("invalid engine broker service config");const item=entry as Record<string,unknown>;if(Object.keys(item).length!==7||typeof item.agentId!=="string"||!item.agentId.trim()||!Number.isSafeInteger(item.slot)||(item.slot as number)<0||!Number.isSafeInteger(item.workerUid)||(item.workerUid as number)<2200||typeof item.workspace!=="string"||!absolute(item.workspace)||typeof item.profilePath!=="string"||!absolute(item.profilePath)||typeof item.eventsPath!=="string"||!absolute(item.eventsPath)||typeof item.profileSha256!=="string"||!/^[a-f0-9]{64}$/u.test(item.profileSha256)||item.profilePath!==`${item.eventsPath.replace(/\/sandbox-events\.jsonl$/u,"")}/sandbox.toml`||seen.has(item.agentId))throw new TypeError("invalid engine broker service config");seen.add(item.agentId);return {agentId:item.agentId,slot:item.slot as number,workerUid:item.workerUid as number,workspace:item.workspace,profilePath:item.profilePath,eventsPath:item.eventsPath,profileSha256:item.profileSha256};});
  if(registrations.length===0)throw new TypeError("invalid engine broker service config");return {credentialHome:input.credentialHome,turnStore:input.turnStore,registrations};
}

async function readRootConfig(file:string):Promise<unknown>{const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);try{const stat=await handle.stat();if(!stat.isFile()||stat.uid!==0||stat.gid!==2100||(stat.mode&0o777)!==0o440||stat.size<2||stat.size>MAX_CONFIG_BYTES)throw new Error("unsafe engine broker service config");const bytes=await handle.readFile();if(bytes.length>MAX_CONFIG_BYTES)throw new Error("unsafe engine broker service config");return JSON.parse(bytes.toString("utf8"));}finally{await handle.close();}}

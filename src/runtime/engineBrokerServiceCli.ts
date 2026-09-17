import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { startEngineBrokerService } from "./engineBrokerService.js";
import { parseEngineBrokerServiceConfig } from "./engineBrokerServiceConfig.js";
import { startGrokEngineBroker } from "./grokEngineBroker.js";

export { parseEngineBrokerServiceConfig };

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

async function readRootConfig(file:string):Promise<unknown>{const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);try{const stat=await handle.stat();if(!stat.isFile()||stat.uid!==0||stat.gid!==2100||(stat.mode&0o777)!==0o440||stat.size<2||stat.size>MAX_CONFIG_BYTES)throw new Error("unsafe engine broker service config");const bytes=await handle.readFile();if(bytes.length>MAX_CONFIG_BYTES)throw new Error("unsafe engine broker service config");return JSON.parse(bytes.toString("utf8"));}finally{await handle.close();}}

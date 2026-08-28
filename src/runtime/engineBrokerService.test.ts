import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { EngineBrokerControlClient } from "./engineBrokerControlClient.js";
import { startEngineBrokerServiceWithIdentity, type EngineBrokerServiceEngine } from "./engineBrokerService.js";

test("broker backend serves a turn and preserves worker attestation", async () => {
  await withService(async (client) => {await client.ready();assert.equal(await client.turn("agent-a","wake-a","hello","http://127.0.0.1:44001/mcp"),"answer");});
});

test("health challenge fails closed when the credential realm is stale",async()=>{
  await withService(async(client)=>assert.rejects(client.ready(),/unavailable/u),undefined,()=>({providerProxyPort:43123,mcpFacadePort:43124,registrations:1,credentialStale:true,realmLease:true,workerIsolation:true}));
});

test("client cancellation reaches the active broker worker", async () => {
  let aborted=false,markStarted!:()=>void,markAborted!:()=>void;const started=new Promise<void>((resolve)=>{markStarted=resolve;}),wasAborted=new Promise<void>((resolve)=>{markAborted=resolve;});
  await withService(async (client) => {
    const controller=new AbortController();
    const pending=client.turn("agent-a","wake-a","hello","http://127.0.0.1:44001/mcp",controller.signal);
    await started;controller.abort();
    await assert.rejects(pending,/unavailable/u);
    await wasAborted;assert.equal(aborted,true);
  }, async (_agent,_wake,_prompt,_endpoint,signal) => new Promise((_resolve,reject)=>{markStarted();signal?.addEventListener("abort",()=>{aborted=true;markAborted();reject(new Error("cancelled"));},{once:true});}));
});

test("service shutdown aborts turns and closes connected clients", async () => {
  const directory=await mkdtemp(path.join(tmpdir(),"daimon-broker-service-")),socketPath=path.join(directory,"broker.sock");
  let aborted=false,markStarted!:()=>void;const started=new Promise<void>((resolve)=>{markStarted=resolve;});const engine=makeEngine(async (_agent,_wake,_prompt,_endpoint,signal)=>new Promise((_resolve,reject)=>{markStarted();signal?.addEventListener("abort",()=>{aborted=true;reject(new Error("cancelled"));},{once:true});}));
  const service=await startEngineBrokerServiceWithIdentity(engine,socketPath,process.getuid!());
  const pending=new EngineBrokerControlClient(socketPath).turn("agent-a","wake-a","hello","http://127.0.0.1:44001/mcp");const rejected=assert.rejects(pending,/unavailable/u);
  await started;await service.close();await rejected;assert.equal(aborted,true);await rm(directory,{recursive:true,force:true});
});

async function withService(run:(client:EngineBrokerControlClient)=>Promise<void>,turn:EngineBrokerServiceEngine["turn"]=async()=>({text:"answer",workerPid:22,workerUid:2200,workerStartTime:"123"}),readiness:EngineBrokerServiceEngine["readiness"]=()=>({providerProxyPort:43123,mcpFacadePort:43124,registrations:1,credentialStale:false,realmLease:true,workerIsolation:true})):Promise<void>{
  const directory=await mkdtemp(path.join(tmpdir(),"daimon-broker-service-")),socketPath=path.join(directory,"broker.sock"),engine=makeEngine(turn,readiness);const service=await startEngineBrokerServiceWithIdentity(engine,socketPath,process.getuid!());
  try{await run(new EngineBrokerControlClient(socketPath));}finally{await service.close();await rm(directory,{recursive:true,force:true});}
}
function makeEngine(turn:EngineBrokerServiceEngine["turn"],readiness:EngineBrokerServiceEngine["readiness"]=()=>({providerProxyPort:43123,mcpFacadePort:43124,registrations:1,credentialStale:false,realmLease:true,workerIsolation:true})):EngineBrokerServiceEngine{return {turn,readiness,close:async()=>undefined};}

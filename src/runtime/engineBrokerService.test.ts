import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { EngineBrokerControlClient } from "./engineBrokerControlClient.js";
import { startEngineBrokerServiceWithIdentity, type EngineBrokerServiceEngine } from "./engineBrokerService.js";
import { EngineBrokerTurnFailure } from "./grokEngineBroker.js";

const completedAccounting = { outcome: "completed", usage: { input: 8, cacheRead: 2, cacheWrite: 0, output: 1, total: 11 }, model: "grok-4.6", requests: 1, limitReason: "none" } as const;

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

async function withService(run:(client:EngineBrokerControlClient)=>Promise<void>,turn:EngineBrokerServiceEngine["turn"]=async()=>({text:"answer",workerPid:22,workerUid:2200,workerStartTime:"123",...completedAccounting}),readiness:EngineBrokerServiceEngine["readiness"]=()=>({providerProxyPort:43123,mcpFacadePort:43124,registrations:1,credentialStale:false,realmLease:true,workerIsolation:true})):Promise<void>{
  const directory=await mkdtemp(path.join(tmpdir(),"daimon-broker-service-")),socketPath=path.join(directory,"broker.sock"),engine=makeEngine(turn,readiness);const service=await startEngineBrokerServiceWithIdentity(engine,socketPath,process.getuid!());
  try{await run(new EngineBrokerControlClient(socketPath));}finally{await service.close();await rm(directory,{recursive:true,force:true});}
}
function makeEngine(turn:EngineBrokerServiceEngine["turn"],readiness:EngineBrokerServiceEngine["readiness"]=()=>({providerProxyPort:43123,mcpFacadePort:43124,registrations:1,credentialStale:false,realmLease:true,workerIsolation:true})):EngineBrokerServiceEngine{return {turn,readiness,close:async()=>undefined};}

test("the wake's lowering limits reach the broker, and the client verifies the declared model", async () => {
  let seen: unknown;
  await withService(async (client) => {
    assert.equal(await client.turn("agent-a","wake-a","hello","http://127.0.0.1:44001/mcp",undefined,{limits:{maxTokens:1_000,timeoutMs:5_000},model:"grok-4.6"}),"answer");
    assert.deepEqual(seen,{maxTokens:1_000,timeoutMs:5_000});
    await assert.rejects(client.turn("agent-a","wake-b","hello","http://127.0.0.1:44001/mcp",undefined,{model:"grok-4.5"}),/model grok-4.6, not the declared grok-4.5/u);
  },async(_agent,_wake,_prompt,_endpoint,_signal,limits)=>{seen=limits;return {text:"answer",workerPid:22,workerUid:2200,workerStartTime:"123",...completedAccounting};});
});

test("a limit failure reaches the client with its code and limit reason", async () => {
  await withService(async (client) => {
    await assert.rejects(client.turn("agent-a","wake-a","hello","http://127.0.0.1:44001/mcp"),/engine broker turn failed \(limit_exceeded; limit=requests\)/u);
  },async()=>{throw new EngineBrokerTurnFailure("limit_exceeded",undefined,{outcome:"failed",usage:{input:1,cacheRead:0,cacheWrite:0,output:1,total:2},model:"grok-4.6",requests:3,limitReason:"requests"});});
});

test("a failed worker's own reason reaches the client instead of a bare exit code", async () => {
  await withService(async (client) => {
    await assert.rejects(client.turn("agent-a","wake-a","hello","http://127.0.0.1:44001/mcp"),/engine broker turn failed \(engine_failed; wait\/exec; exit=1; signal=0; reason=grok: session store unwritable\)/u);
  },async()=>{throw new EngineBrokerTurnFailure("engine_failed",{status:"worker_failed",stage:"wait",failureClass:"exec",profileApplied:false,exitCode:1,termSignal:0,workerPid:31,workerUid:2200,startTicks:"9",reason:"grok: session store unwritable"},{outcome:"failed",usage:null,model:"grok-4.6",requests:4,limitReason:"none"});});
});

/**
 * The end of the seam: an outstanding tool call has to be readable by whoever
 * reads the failure, not just sealed. The live hang would have read
 * `mcp=1/2 answered; mcp_outstanding=daimon__moltnet_read@419000ms`.
 */
test("an outstanding MCP tool call reaches the client by name, with how long it waited", async () => {
  await withService(async (client) => {
    await assert.rejects(client.turn("agent-a","wake-a","hello","http://127.0.0.1:44001/mcp"),/engine broker turn failed \(limit_exceeded; limit=timeout; mcp=1\/2 answered; mcp_undecoded=1; mcp_outstanding=daimon__moltnet_read@419000ms\)/u);
  },async()=>{throw new EngineBrokerTurnFailure("limit_exceeded",undefined,{outcome:"failed",usage:null,model:"grok-4.6",requests:8,limitReason:"timeout"},{started:2,answered:1,undecoded:1,outstanding:[{name:"daimon__moltnet_read",outstandingMs:419_000}]});});
});

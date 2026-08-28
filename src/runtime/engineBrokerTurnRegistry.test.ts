import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EngineBrokerTurnRegistry } from "./engineBrokerTurnRegistry.js";

const start = (prompt = "work") => ({ version: "noopolis.daimon.engine-broker.v1", kind: "start_turn", requestId: "request-1", turnId: "turn-1", agentId: "agent-1", wakeId: "wake-1", prompt,mcpEndpoint:"http://127.0.0.1:4567/mcp" } as const);
test("turn registry replays terminal results across restart and rejects conflicts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-broker-turns-"));
  try {
    const first = new EngineBrokerTurnRegistry(root,"boot-a"); assert.equal(await first.begin(start()), "start");
    await assert.rejects(first.begin(start()), /already active/);
    const response = { version: "noopolis.daimon.engine-broker.v1", kind: "completed", requestId: "request-1", turnId: "turn-1", text: "done", workerPid: 11, workerUid: 2200, workerStartTime: "123" } as const;
    await first.finish(start(), response);
    assert.deepEqual(await new EngineBrokerTurnRegistry(root,"boot-b").begin(start()), { replay: response });
    await assert.rejects(first.begin(start("different")), /conflict/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("turn registry fails an orphaned active turn once after broker restart",async()=>{const root=await mkdtemp(path.join(os.tmpdir(),"daimon-broker-turns-"));try{assert.equal(await new EngineBrokerTurnRegistry(root,"boot-a").begin(start()),"start");const replay=await new EngineBrokerTurnRegistry(root,"boot-b").begin(start());assert.equal(typeof replay,"object");if(typeof replay==="object")assert.equal(replay.replay.kind,"failed");assert.deepEqual(await new EngineBrokerTurnRegistry(root,"boot-c").begin(start()),replay);}finally{await rm(root,{recursive:true,force:true});}});
test("turn registry durably replays a sanitized pre-attestation failure",async()=>{const root=await mkdtemp(path.join(os.tmpdir(),"daimon-broker-turns-"));try{const registry=new EngineBrokerTurnRegistry(root,"boot-a");assert.equal(await registry.begin(start()),"start");const response={version:"noopolis.daimon.engine-broker.v1",kind:"failed",requestId:"request-1",turnId:"turn-1",code:"engine_failed",diagnostic:{status:"worker_failed",stage:"attestation",failureClass:"profile_missing",profileApplied:false,exitCode:0,termSignal:0,workerPid:42,workerUid:2200,startTicks:"123"}} as const;await registry.finish(start(),response);assert.deepEqual(await new EngineBrokerTurnRegistry(root,"boot-b").begin(start()),{replay:response});}finally{await rm(root,{recursive:true,force:true});}});
test("turn registry rejects a persisted diagnostic with undeclared secret-bearing fields",async()=>{const root=await mkdtemp(path.join(os.tmpdir(),"daimon-broker-turns-"));try{const registry=new EngineBrokerTurnRegistry(root,"boot-a");assert.equal(await registry.begin(start()),"start");const [name]=await readdir(root);const file=path.join(root,name!);const record=JSON.parse(await readFile(file,"utf8")) as Record<string,unknown>;record.state="terminal";record.response={version:"noopolis.daimon.engine-broker.v1",kind:"failed",requestId:"request-1",turnId:"turn-1",code:"engine_failed",rawOutput:"secret"};await writeFile(file,JSON.stringify(record));await assert.rejects(new EngineBrokerTurnRegistry(root,"boot-b").begin(start()),/invalid broker frame/u);}finally{await rm(root,{recursive:true,force:true});}});

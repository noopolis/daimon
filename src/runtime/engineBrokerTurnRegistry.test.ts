import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EngineBrokerTurnRegistry } from "./engineBrokerTurnRegistry.js";

const start = (prompt = "work") => ({ version: "noopolis.daimon.engine-broker.v2", kind: "start_turn", requestId: "request-1", turnId: "turn-1", agentId: "agent-1", wakeId: "wake-1", prompt,mcpEndpoint:"http://127.0.0.1:4567/mcp" } as const);
test("turn registry replays terminal results across restart and rejects conflicts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-broker-turns-"));
  try {
    const first = new EngineBrokerTurnRegistry(root,"boot-a"); assert.equal(await first.begin(start(),"grok-4.6"), "start");
    await assert.rejects(first.begin(start(),"grok-4.6"), /already active/);
    const response = { version: "noopolis.daimon.engine-broker.v2", kind: "completed", requestId: "request-1", turnId: "turn-1", text: "done", workerPid: 11, workerUid: 2200, workerStartTime: "123", outcome: "completed", usage: { input: 3, cacheRead: 2, cacheWrite: 0, output: 1, total: 6 }, model: "grok-4.6", requests: 1, limitReason: "none" } as const;
    await first.finish(start(), response);
    assert.deepEqual(await new EngineBrokerTurnRegistry(root,"boot-b").begin(start(),"grok-4.6"), { replay: response });
    await assert.rejects(first.begin(start("different"),"grok-4.6"), /conflict/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("turn registry fails an orphaned active turn once after broker restart",async()=>{const root=await mkdtemp(path.join(os.tmpdir(),"daimon-broker-turns-"));try{assert.equal(await new EngineBrokerTurnRegistry(root,"boot-a").begin(start(),"grok-4.6"),"start");const replay=await new EngineBrokerTurnRegistry(root,"boot-b").begin(start(),"grok-4.6");assert.equal(typeof replay,"object");if(typeof replay==="object")assert.equal(replay.replay.kind,"failed");assert.deepEqual(await new EngineBrokerTurnRegistry(root,"boot-c").begin(start(),"grok-4.6"),replay);}finally{await rm(root,{recursive:true,force:true});}});
test("turn registry durably replays a sanitized pre-attestation failure",async()=>{const root=await mkdtemp(path.join(os.tmpdir(),"daimon-broker-turns-"));try{const registry=new EngineBrokerTurnRegistry(root,"boot-a");assert.equal(await registry.begin(start(),"grok-4.6"),"start");const response={version:"noopolis.daimon.engine-broker.v2",kind:"failed",requestId:"request-1",turnId:"turn-1",code:"engine_failed",diagnostic:{status:"worker_failed",stage:"attestation",failureClass:"profile_missing",profileApplied:false,exitCode:0,termSignal:0,workerPid:42,workerUid:2200,startTicks:"123"},outcome:"failed",usage:null,model:"grok-4.6",requests:0,limitReason:"none"} as const;await registry.finish(start(),response);assert.deepEqual(await new EngineBrokerTurnRegistry(root,"boot-b").begin(start(),"grok-4.6"),{replay:response});}finally{await rm(root,{recursive:true,force:true});}});
test("turn registry rejects a persisted diagnostic with undeclared secret-bearing fields",async()=>{const root=await mkdtemp(path.join(os.tmpdir(),"daimon-broker-turns-"));try{const registry=new EngineBrokerTurnRegistry(root,"boot-a");assert.equal(await registry.begin(start(),"grok-4.6"),"start");const [name]=await readdir(root);const file=path.join(root,name!);const record=JSON.parse(await readFile(file,"utf8")) as Record<string,unknown>;record.state="terminal";record.response={version:"noopolis.daimon.engine-broker.v2",kind:"failed",requestId:"request-1",turnId:"turn-1",code:"engine_failed",rawOutput:"secret",outcome:"failed",usage:null,model:"grok-4.6",requests:0,limitReason:"none"};await writeFile(file,JSON.stringify(record));await assert.rejects(new EngineBrokerTurnRegistry(root,"boot-b").begin(start(),"grok-4.6"),/registry unavailable/u);}finally{await rm(root,{recursive:true,force:true});}});

const withRoot = async (run: (root: string) => Promise<void>): Promise<void> => { const root = await mkdtemp(path.join(os.tmpdir(), "daimon-broker-turns-")); try { await run(root); } finally { await rm(root, { recursive: true, force: true }); } };
const recordFile = async (root: string): Promise<string> => { const [name] = await readdir(root); return path.join(root, name!); };

test("a v1 record sealed before the upgrade still replays, upgraded with no usage and never re-metered", async () => {
  await withRoot(async (root) => {
    const registry = new EngineBrokerTurnRegistry(root, "boot-a");
    assert.equal(await registry.begin(start(), "grok-4.5"), "start");
    const file = await recordFile(root); const record = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    const v1 = { version: "noopolis.daimon.engine-broker.v1", kind: "completed", requestId: "request-1", turnId: "turn-1", text: "done", workerPid: 11, workerUid: 2200, workerStartTime: "123" };
    await writeFile(file, JSON.stringify({ version: "noopolis.daimon.engine-broker-turn.v1", digest: record.digest, state: "terminal", bootId: "boot-a", response: v1 }));
    assert.deepEqual(await new EngineBrokerTurnRegistry(root, "boot-b").begin(start(), "grok-4.5"), { replay: { ...v1, version: "noopolis.daimon.engine-broker.v2", outcome: "completed", usage: null, model: "grok-4.5", requests: 0, limitReason: "none" } });
  });
});

test("the v2 record parser is strict: an unknown member or a v1 frame inside a v2 record is refused", async () => {
  await withRoot(async (root) => {
    const registry = new EngineBrokerTurnRegistry(root, "boot-a");
    assert.equal(await registry.begin(start(), "grok-4.6"), "start");
    const response = { version: "noopolis.daimon.engine-broker.v2", kind: "completed", requestId: "request-1", turnId: "turn-1", text: "done", workerPid: 11, workerUid: 2200, workerStartTime: "123", outcome: "completed", usage: null, model: "grok-4.6", requests: 0, limitReason: "none" } as const;
    await registry.finish(start(), response);
    const file = await recordFile(root); const record = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    assert.equal(record.version, "noopolis.daimon.engine-broker-turn.v2");
    // Mutation guard: dropping the exact-member check accepts this record.
    await writeFile(file, JSON.stringify({ ...record, usageRow: "extra" }));
    await assert.rejects(new EngineBrokerTurnRegistry(root, "boot-b").begin(start(), "grok-4.6"), /registry unavailable/u);
    const { outcome: _o, usage: _u, model: _m, requests: _r, limitReason: _l, ...legacy } = response;
    await writeFile(file, JSON.stringify({ ...record, response: { ...legacy, version: "noopolis.daimon.engine-broker.v1" } }));
    await assert.rejects(new EngineBrokerTurnRegistry(root, "boot-b").begin(start(), "grok-4.6"), /registry unavailable/u);
  });
});

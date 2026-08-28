import assert from "node:assert/strict";
import test from "node:test";
import { decodeNativeBrokerResult,encodeNativeBrokerTurn,ENGINE_BROKER_NATIVE_RESULT_BYTES,NativeBrokerTurnFailure } from "./engineBrokerNativeClient.js";

const turnId="turn-1";
function frame(values:Readonly<{status?:number;uid?:number;pid?:number;exit?:number;signal?:number;ticks?:bigint;stage?:number;failure?:number;profile?:number;reserved?:number;text?:string}>={}):Buffer{
  const text=Buffer.from(values.text??"");const out=Buffer.alloc(ENGINE_BROKER_NATIVE_RESULT_BYTES+text.length);out.writeUInt32LE(2,0);out.writeUInt32LE(values.status??0,4);out.writeUInt32LE(values.uid??2200,8);out.writeUInt32LE(text.length,12);out.writeInt32LE(values.pid??42,16);out.writeInt32LE(values.exit??0,20);out.writeInt32LE(values.signal??0,24);out.writeBigUInt64LE(values.ticks??123n,32);out.write(turnId,40);out.writeUInt32LE(values.stage??7,108);out.writeUInt32LE(values.failure??0,112);out.writeUInt32LE(values.profile??0,116);out.writeUInt32LE(values.reserved??0,120);text.copy(out,ENGINE_BROKER_NATIVE_RESULT_BYTES);return out;
}

test("encodes ABI v2 and decodes a closed successful result",()=>{
  const encoded=encodeNativeBrokerTurn({slot:1,requestId:"request-1",turnId,agentId:"agent-1",wakeId:"wake-1",prompt:"work",providerCapability:"provider-cap",mcpCapability:"mcp-cap"});
  assert.equal(encoded.readUInt32LE(0),2);assert.equal(decodeNativeBrokerResult(frame({text:"done"}),turnId).text,"done");encoded.fill(0);
});

test("returns bounded typed diagnostics for closed native failures",()=>{
  for(const value of [
    {status:1,stage:4,failure:4,pid:0,uid:0,ticks:0n,exit:-1},
    {status:2,stage:6,failure:5,exit:127},
    {status:3,stage:7,failure:7},
    {status:4,stage:6,failure:8,signal:15},
  ])assert.throws(()=>decodeNativeBrokerResult(frame(value),turnId),(error:unknown)=>error instanceof NativeBrokerTurnFailure&&error.diagnostic.stage!=="none");
});

test("rejects unknown, reserved, output-bearing, and cross-class failure frames",()=>{
  for(const value of [{status:9},{reserved:1},{status:1,stage:7,failure:4,pid:0,uid:0,ticks:0n},{status:2,stage:6,failure:6,text:"secret"}])assert.throws(()=>decodeNativeBrokerResult(frame(value),turnId),/^Error: engine broker turn failed$/u);
  for(const offset of [28,31,105,107,124,127]){const hostile=frame({text:"done"});hostile[offset]=1;assert.throws(()=>decodeNativeBrokerResult(hostile,turnId),/^Error: engine broker turn failed$/u);}
});

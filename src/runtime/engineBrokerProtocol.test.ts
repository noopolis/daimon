import assert from "node:assert/strict";
import test from "node:test";
import { encodeEngineBrokerFrame, EngineBrokerFrameDecoder, parseEngineBrokerRequest, parseEngineBrokerResponse } from "./engineBrokerProtocol.js";

const start = { version: "noopolis.daimon.engine-broker.v1", kind: "start_turn", requestId: "request-1", turnId: "turn-1", agentId: "agent-1", wakeId: "wake-1", prompt: "work",mcpEndpoint:"http://127.0.0.1:4567/mcp" } as const;

test("broker frames survive arbitrary chunking and validate closed requests", () => {
  const encoded = encodeEngineBrokerFrame(start); const decoder = new EngineBrokerFrameDecoder(); const values: unknown[] = [];
  for (const byte of encoded) values.push(...decoder.push(Uint8Array.of(byte))); decoder.finish();
  assert.deepEqual(parseEngineBrokerRequest(values[0]), start);
  assert.throws(() => parseEngineBrokerRequest({ ...start, command: "/bin/sh" }), /invalid broker frame/);
  assert.throws(() => parseEngineBrokerRequest({ ...start, prompt: "x".repeat(262_145) }), /invalid broker frame/);
});

test("broker response attestation is mandatory and bounded", () => {
  const value = { version: start.version, kind: "completed", requestId: "request-1", turnId: "turn-1", text: "done", workerPid: 12, workerUid: 2200, workerStartTime: "12345" } as const;
  assert.deepEqual(parseEngineBrokerResponse(value), value);
  assert.throws(() => parseEngineBrokerResponse({ ...value, workerUid: 0 }), /invalid broker frame/);
  const decoder = new EngineBrokerFrameDecoder(); assert.throws(() => decoder.push(Uint8Array.from([0, 16, 0, 1])), /invalid broker frame/);
});

test("broker failure diagnostics are closed and contain no raw worker output",()=>{
  const value={version:start.version,kind:"failed",requestId:"request-1",turnId:"turn-1",code:"engine_failed",diagnostic:{status:"prelaunch_failed",stage:"executable",failureClass:"executable",profileApplied:false,exitCode:-1,termSignal:0,workerPid:0,workerUid:0,startTicks:"0"}} as const;
  assert.deepEqual(parseEngineBrokerResponse(value),value);
  assert.throws(()=>parseEngineBrokerResponse({...value,diagnostic:{...value.diagnostic,rawOutput:"secret"}}),/invalid broker frame/u);
  assert.throws(()=>parseEngineBrokerResponse({...value,diagnostic:{...value.diagnostic,failureClass:"secret"}}),/invalid broker frame/u);
});

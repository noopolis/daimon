import assert from "node:assert/strict";
import test from "node:test";
import { boundedDiagnosticWindow, CLI_ENGINE_MAX_DIAGNOSTIC_BYTES } from "../pi/cliChildOutput.js";
import { decodeNativeBrokerResult,encodeNativeBrokerTurn,ENGINE_BROKER_NATIVE_DIAGNOSTIC_BYTES,ENGINE_BROKER_NATIVE_RESULT_BYTES,NativeBrokerTurnFailure } from "./engineBrokerNativeClient.js";

const turnId="turn-1";
function frame(values:Readonly<{status?:number;uid?:number;pid?:number;exit?:number;signal?:number;ticks?:bigint;stage?:number;failure?:number;profile?:number;diagnosticLength?:number;diagnostic?:string|Buffer;text?:string}>={}):Buffer{
  const text=Buffer.from(values.text??""),diagnostic=Buffer.from(values.diagnostic??"");const out=Buffer.alloc(ENGINE_BROKER_NATIVE_RESULT_BYTES+text.length+diagnostic.length);out.writeUInt32LE(2,0);out.writeUInt32LE(values.status??0,4);out.writeUInt32LE(values.uid??2200,8);out.writeUInt32LE(text.length,12);out.writeInt32LE(values.pid??42,16);out.writeInt32LE(values.exit??0,20);out.writeInt32LE(values.signal??0,24);out.writeBigUInt64LE(values.ticks??123n,32);out.write(turnId,40);out.writeUInt32LE(values.stage??7,108);out.writeUInt32LE(values.failure??0,112);out.writeUInt32LE(values.profile??0,116);out.writeUInt32LE(values.diagnosticLength??diagnostic.length,120);text.copy(out,ENGINE_BROKER_NATIVE_RESULT_BYTES);diagnostic.copy(out,ENGINE_BROKER_NATIVE_RESULT_BYTES+text.length);return out;
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

test("rejects unknown, diagnostic-bearing success, output-bearing, and cross-class failure frames",()=>{
  for(const value of [{status:9},{diagnostic:"late words"},{status:1,stage:4,failure:4,pid:0,uid:0,ticks:0n,exit:-1,diagnostic:"no worker ran"},{status:2,stage:6,failure:5,exit:1,diagnosticLength:ENGINE_BROKER_NATIVE_DIAGNOSTIC_BYTES+1},{status:1,stage:7,failure:4,pid:0,uid:0,ticks:0n},{status:2,stage:6,failure:6,text:"secret"}])assert.throws(()=>decodeNativeBrokerResult(frame(value),turnId),/^Error: engine broker turn failed$/u);
  for(const offset of [28,31,105,107,124,127]){const hostile=frame({text:"done"});hostile[offset]=1;assert.throws(()=>decodeNativeBrokerResult(hostile,turnId),/^Error: engine broker turn failed$/u);}
});

test("a failed worker's own last words cross as a redacted, bounded reason",()=>{
  const words=`{"type":"error","message":"session store unwritable"}\nBearer provider-cap-secret-value\ngrok: exiting 1\n`;
  assert.throws(()=>decodeNativeBrokerResult(frame({status:2,stage:6,failure:5,exit:1,diagnostic:words}),turnId,["provider-cap-secret-value"]),(error:unknown)=>{
    assert.ok(error instanceof NativeBrokerTurnFailure);
    const reason=error.diagnostic.reason;
    assert.ok(reason!==undefined,"the worker's own reason must reach the diagnostic");
    assert.match(reason,/session store unwritable/u);
    assert.doesNotMatch(reason,/provider-cap-secret-value/u,"the turn capability must never reach a diagnostic");
    assert.doesNotMatch(reason,/[\n\r\u0000-\u001f]/u,"the reason is one bounded line");
    assert.ok(Buffer.byteLength(reason,"utf8")<=CLI_ENGINE_MAX_DIAGNOSTIC_BYTES);
    return true;
  });
  assert.throws(()=>decodeNativeBrokerResult(frame({status:2,stage:6,failure:5,exit:1}),turnId,[]),(error:unknown)=>error instanceof NativeBrokerTurnFailure&&error.diagnostic.reason===undefined,"a worker that said nothing reports no reason rather than an empty one");
});

/**
 * The assertion is the SENTENCE. A live turn reported its worker's last words
 * as `reason=108,111,110,101,46,32,87,104,101,110,...` — the bytes of "lone.
 * When ..." rendered as decimals, because a byte view that is not a Node
 * `Buffer` answers `toString("utf8")` with a comma-separated list and every
 * check the diagnostic passed on the way out (a string, no control bytes,
 * under the bound) is satisfied by digits. Nothing weaker than the decoded
 * text can catch that.
 */
const words = "lone. When assigned, read `room:assignment`, open my row in the desk index.";

test("a worker's last words cross as decoded text, not as the decimals of their bytes", () => {
  for (const [shape, view] of [["a Buffer", (bytes: Buffer): Uint8Array => bytes], ["a plain Uint8Array", (bytes: Buffer): Uint8Array => new Uint8Array(bytes)]] as const) {
    assert.throws(() => decodeNativeBrokerResult(view(frame({ status: 2, stage: 6, failure: 5, exit: 1, diagnostic: words })), turnId, []), (error: unknown) => {
      assert.ok(error instanceof NativeBrokerTurnFailure);
      assert.equal(error.diagnostic.reason, words, `${shape}: the reason must be the worker's sentence, byte-identical`);
      assert.doesNotMatch(error.diagnostic.reason ?? "", /^[0-9,]+$/u, `${shape}: a decimal byte list is what this regressed to before`);
      return true;
    });
  }
});

test("a window that cut a multi-byte sequence in half decodes with replacement instead of throwing", () => {
  // The launcher's window is a byte count: these first two bytes are the tail
  // of a three-byte sequence whose leading byte the window already dropped.
  const cut = Buffer.concat([Buffer.from([0x9c, 0xa8]), Buffer.from(" grok: exiting 1")]);
  assert.throws(() => decodeNativeBrokerResult(frame({ status: 2, stage: 6, failure: 5, exit: 1, diagnostic: cut }), turnId, []), (error: unknown) => {
    assert.ok(error instanceof NativeBrokerTurnFailure);
    const reason = error.diagnostic.reason ?? "";
    assert.match(reason, /grok: exiting 1$/u, "the legible remainder survives the cut sequence");
    assert.match(reason, /\uFFFD/u, "the cut sequence is replaced, not thrown on");
    return true;
  });
});

/**
 * The window keeps both ends. A pure tail is what turned the one diagnostic
 * this project has ever got out of a failed worker into 512 bytes of the
 * worker's own prompt echoed back, with the error itself off the front.
 */
test("the bounded diagnostic window keeps the head, the tail, and a marker naming what it dropped", () => {
  const blob = `START-OF-ERROR ${"m".repeat(40_000)} END-OF-ECHO`;
  const window = boundedDiagnosticWindow(blob, CLI_ENGINE_MAX_DIAGNOSTIC_BYTES);
  assert.ok(window.startsWith("START-OF-ERROR "), `the head must survive: ${window.slice(0, 40)}`);
  assert.ok(window.endsWith(" END-OF-ECHO"), "the tail must survive too");
  const marker = /\[… (\d+) bytes elided …\]/u.exec(window);
  assert.ok(marker !== null, "the elision is named, not silent");
  assert.equal(Number(marker[1]) + Buffer.byteLength(window.replace(marker[0], ""), "utf8"), Buffer.byteLength(blob, "utf8"), "the marker's count is exactly what was dropped");
  assert.ok(Buffer.byteLength(window, "utf8") <= CLI_ENGINE_MAX_DIAGNOSTIC_BYTES, `the marker is paid for out of the same budget: ${Buffer.byteLength(window, "utf8")} bytes`);
});

test("output that fits the window is returned byte-identical, with no marker", () => {
  for (const value of ["", "grok: exiting 1", `${"m".repeat(CLI_ENGINE_MAX_DIAGNOSTIC_BYTES - 4)}tail`])
    assert.equal(boundedDiagnosticWindow(value, CLI_ENGINE_MAX_DIAGNOSTIC_BYTES), value, "a short diagnostic must not be reshaped at all");
});

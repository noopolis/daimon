import assert from "node:assert/strict";
import test from "node:test";
import { encodeEngineBrokerFrame, EngineBrokerFrameDecoder, parseEngineBrokerRequest, parseEngineBrokerResponse, parseEngineBrokerV1TerminalResponse } from "./engineBrokerProtocol.js";

const accounting = { outcome: "completed", usage: { input: 20, cacheRead: 0, cacheWrite: 0, output: 10, total: 30 }, model: "grok-4.6", requests: 2, limitReason: "none" } as const;
const start = { version: "noopolis.daimon.engine-broker.v2", kind: "start_turn", requestId: "request-1", turnId: "turn-1", agentId: "agent-1", wakeId: "wake-1", prompt: "work",mcpEndpoint:"http://127.0.0.1:4567/mcp" } as const;

test("broker frames survive arbitrary chunking and validate closed requests", () => {
  const encoded = encodeEngineBrokerFrame(start); const decoder = new EngineBrokerFrameDecoder(); const values: unknown[] = [];
  for (const byte of encoded) values.push(...decoder.push(Uint8Array.of(byte))); decoder.finish();
  assert.deepEqual(parseEngineBrokerRequest(values[0]), start);
  assert.throws(() => parseEngineBrokerRequest({ ...start, command: "/bin/sh" }), /invalid broker frame/);
  assert.throws(() => parseEngineBrokerRequest({ ...start, prompt: "x".repeat(262_145) }), /invalid broker frame/);
});

test("broker response attestation is mandatory and bounded", () => {
  const value = { version: start.version, kind: "completed", requestId: "request-1", turnId: "turn-1", text: "done", workerPid: 12, workerUid: 2200, workerStartTime: "12345", ...accounting } as const;
  assert.deepEqual(parseEngineBrokerResponse(value), value);
  assert.throws(() => parseEngineBrokerResponse({ ...value, workerUid: 0 }), /invalid broker frame/);
  const decoder = new EngineBrokerFrameDecoder(); assert.throws(() => decoder.push(Uint8Array.from([0, 16, 0, 1])), /invalid broker frame/);
});

test("broker failure diagnostics are closed and contain no raw worker output",()=>{
  const value={version:start.version,kind:"failed",requestId:"request-1",turnId:"turn-1",code:"engine_failed",diagnostic:{status:"prelaunch_failed",stage:"executable",failureClass:"executable",profileApplied:false,exitCode:-1,termSignal:0,workerPid:0,workerUid:0,startTicks:"0"},outcome:"failed",usage:null,model:"grok-4.6",requests:0,limitReason:"none"} as const;
  assert.deepEqual(parseEngineBrokerResponse(value),value);
  assert.throws(()=>parseEngineBrokerResponse({...value,diagnostic:{...value.diagnostic,rawOutput:"secret"}}),/invalid broker frame/u);
  assert.throws(()=>parseEngineBrokerResponse({...value,diagnostic:{...value.diagnostic,failureClass:"secret"}}),/invalid broker frame/u);
});

test("v2 terminal frames carry closed numeric accounting and refuse anything else", () => {
  const completed = { version: start.version, kind: "completed", requestId: "request-1", turnId: "turn-1", text: "done", workerPid: 12, workerUid: 2200, workerStartTime: "12345", ...accounting } as const;
  assert.deepEqual(parseEngineBrokerResponse(completed), completed);
  for (const bad of [
    { ...completed, usage: { ...accounting.usage, total: 31 } },
    { ...completed, usage: { ...accounting.usage, note: "text" } },
    { ...completed, usage: { ...accounting.usage, input: "20" } },
    { ...completed, model: "grok-4.6-build" },
    { ...completed, outcome: "failed" },
    { ...completed, limitReason: "tokens" },
    { ...completed, limitReason: "budget" },
    { ...completed, requests: -1 },
    { ...completed, extra: 1 },
    (({ limitReason: _omit, ...rest }) => rest)(completed)
  ]) assert.throws(() => parseEngineBrokerResponse(bad), /invalid broker frame/u);
  const limit = { version: start.version, kind: "failed", requestId: "request-1", turnId: "turn-1", code: "limit_exceeded", outcome: "failed", usage: { input: 5, cacheRead: 5, cacheWrite: 0, output: 1, total: 11 }, model: "grok-4.6", requests: 3, limitReason: "requests" } as const;
  assert.deepEqual(parseEngineBrokerResponse(limit), limit);
  assert.throws(() => parseEngineBrokerResponse({ ...limit, limitReason: "none" }), /invalid broker frame/u);
  assert.throws(() => parseEngineBrokerResponse({ ...limit, code: "engine_failed" }), /invalid broker frame/u);
});

test("v1 frames are refused on the wire but a v1 terminal record still parses", () => {
  const v1 = { version: "noopolis.daimon.engine-broker.v1", kind: "completed", requestId: "request-1", turnId: "turn-1", text: "done", workerPid: 12, workerUid: 2200, workerStartTime: "12345" } as const;
  assert.throws(() => parseEngineBrokerResponse(v1), /invalid broker frame/u);
  assert.throws(() => parseEngineBrokerRequest({ ...start, version: "noopolis.daimon.engine-broker.v1" }), /invalid broker frame/u);
  assert.deepEqual(parseEngineBrokerV1TerminalResponse(v1), v1);
  assert.throws(() => parseEngineBrokerV1TerminalResponse({ ...v1, ...accounting }), /invalid broker frame/u);
});

test("start_turn limits are an optional closed subset inside their bounds", () => {
  assert.deepEqual(parseEngineBrokerRequest({ ...start, limits: { maxTokens: 1_000 } }), { ...start, limits: { maxTokens: 1_000 } });
  for (const limits of [{}, { maxTokens: 0 }, { maxRequests: 49 }, { timeoutMs: 999 }, { maxTokens: 1, raise: true }, { maxTokens: 1.5 }]) {
    assert.throws(() => parseEngineBrokerRequest({ ...start, limits }), /invalid broker frame/u);
  }
});

test("a failed worker's redacted reason is an optional bounded member of its diagnostic",()=>{
  const worker={status:"worker_failed",stage:"wait",failureClass:"exec",profileApplied:false,exitCode:1,termSignal:0,workerPid:31,workerUid:2200,startTicks:"9"} as const;
  const failed={version:start.version,kind:"failed",requestId:"request-1",turnId:"turn-1",code:"engine_failed",outcome:"failed",usage:null,model:"grok-4.6",requests:4,limitReason:"none"} as const;
  const named={...failed,diagnostic:{...worker,reason:"grok: session store unwritable"}} as const;
  assert.deepEqual(parseEngineBrokerResponse(named),named);
  const prelaunch={status:"prelaunch_failed",stage:"executable",failureClass:"executable",profileApplied:false,exitCode:-1,termSignal:0,workerPid:0,workerUid:0,startTicks:"0"} as const;
  for(const bad of [
    {...failed,diagnostic:{...worker,reason:""}},
    {...failed,diagnostic:{...worker,reason:"x".repeat(769)}},
    {...failed,diagnostic:{...worker,reason:"line\nbreak"}},
    {...failed,diagnostic:{...worker,reason:7}},
    {...failed,diagnostic:{...prelaunch,reason:"no worker ran"}}
  ])assert.throws(()=>parseEngineBrokerResponse(bad),/invalid broker frame/u);
});

/**
 * The in-flight tool-call observation (`engineBrokerMcpCallLog.ts`) rides the
 * sealed failed frame, so the seam that carries the worker's last words and
 * its accounting carries this too — nothing new on a tmpfs that dies with the
 * container. It is names and timings, bounded, and internally consistent: a
 * frame that claims more answered than started, or more outstanding than
 * started minus answered, is a fabrication and is refused rather than clamped.
 */
test("a failed frame carries the broker's in-flight MCP tool-call observation, bounded and consistent", () => {
  const value = { version: start.version, kind: "failed", requestId: "request-1", turnId: "turn-1", code: "limit_exceeded", mcpCalls: { started: 3, answered: 2, undecoded: 0, outstanding: [{ name: "daimon__moltnet_read", outstandingMs: 419_000 }] }, outcome: "failed", usage: null, model: "grok-4.6", requests: 8, limitReason: "timeout" } as const;
  assert.deepEqual(parseEngineBrokerResponse(value), value);
  for (const mcpCalls of [
    { ...value.mcpCalls, answered: 4 },
    { ...value.mcpCalls, started: 2 },
    { ...value.mcpCalls, outstanding: [{ name: "daimon__moltnet_read", outstandingMs: 1 }, { name: "memory_recall", outstandingMs: 1 }] },
    { ...value.mcpCalls, outstanding: [{ name: "daimon__moltnet_read", outstandingMs: -1 }] },
    { ...value.mcpCalls, outstanding: [{ name: "moltnet read; Bearer sk-live", outstandingMs: 1 }] },
    { ...value.mcpCalls, outstanding: [{ name: "daimon__moltnet_read", outstandingMs: 1, arguments: { text: "secret" } }] },
    { ...value.mcpCalls, outstanding: Array.from({ length: 17 }, () => ({ name: "tool", outstandingMs: 1 })) },
    { started: 3, answered: 2, outstanding: [] }
  ]) assert.throws(() => parseEngineBrokerResponse({ ...value, mcpCalls }), /invalid broker frame/u, JSON.stringify(mcpCalls));
  // A v1 record predates the instrument; a v1 frame that carries it is forged.
  assert.throws(() => parseEngineBrokerV1TerminalResponse({ version: "noopolis.daimon.engine-broker.v1", kind: "failed", requestId: "request-1", turnId: "turn-1", code: "engine_failed", mcpCalls: value.mcpCalls }), /invalid broker frame/u);

  /**
   * The session's standalone GET SSE tunnel rides the same member, under the
   * same rules. It is optional for exactly one reason — a turn sealed before
   * the facade observed that channel replays without it — so its absence means
   * "not measured" and never zero, and a record that carries it must still be
   * a measurement: nothing closes before it opens, nothing delivers without
   * opening, and no more can be open than `opened - closed`.
   */
  const tunnels = { opened: 2, closed: 1, delivered: 1, open: [{ openMs: 428_004, delivered: false }] } as const;
  const observed = { ...value, mcpCalls: { ...value.mcpCalls, tunnels } } as const;
  assert.deepEqual(parseEngineBrokerResponse(observed), observed);
  assert.deepEqual(parseEngineBrokerResponse(value), value, "a frame sealed before the tunnel was observed still replays, without the member");
  for (const forged of [
    { ...tunnels, closed: 3 },
    { ...tunnels, delivered: 3 },
    { ...tunnels, opened: 1, closed: 1, open: [{ openMs: 1, delivered: false }] },
    { ...tunnels, open: Array.from({ length: 9 }, () => ({ openMs: 1, delivered: false })), opened: 12, closed: 0 },
    { ...tunnels, open: [{ openMs: -1, delivered: false }] },
    { ...tunnels, open: [{ openMs: 1, delivered: "yes" }] },
    { ...tunnels, open: [{ openMs: 1, delivered: false, sessionId: "mcp-session-0" }] },
    { opened: 1, closed: 0, open: [] }
  ]) assert.throws(() => parseEngineBrokerResponse({ ...value, mcpCalls: { ...value.mcpCalls, tunnels: forged } }), /invalid broker frame/u, JSON.stringify(forged));
});

import { createHash, randomUUID } from "node:crypto";

import { decodeGrokHeadlessTurn } from "../pi/grokHeadlessResult.js";
import { decodeGrokStreamUsage, type GrokStreamUsage } from "../pi/grokStreamUsage.js";
import { ENGINE_BROKER_VERSION, type EngineBrokerFailureCode, type EngineBrokerTerminalResponse } from "./engineBrokerProtocol.js";
import { lowerEngineBrokerTurnLimits, mapGrokReportedModel, type EngineBrokerTurnAccounting, type EngineBrokerTurnLimitOverrides, type EngineBrokerTurnUsage } from "./engineBrokerTurnAccounting.js";
import { NativeBrokerTurnFailure, type NativeBrokerDiagnostic, type NativeBrokerTurn, type NativeBrokerTurnResult } from "./engineBrokerNativeClient.js";
import type { EngineBrokerTurnRegistry } from "./engineBrokerTurnRegistry.js";
import { engineBrokerRequestLedgerPathFor, type EngineBrokerServiceRegistration } from "./engineBrokerServiceConfig.js";
import { ensureBrokerTurnLedgered } from "./grokEngineBrokerLedger.js";
import { finishBrokerTurnWithUsage, type BrokerTurnMetering, type BrokerTurnMeteringDetail } from "./grokEngineBrokerMetering.js";
import type { GrokBrokerProxyTurn } from "./grokBrokerProxy.js";
import { GrokBrokerTurnMeter, type GrokBrokerTurnMeterSnapshot } from "./grokBrokerTurnMeter.js";
import { GrokWorkerAttestationFailure } from "./grokWorkerAttestation.js";

export type GrokEngineBrokerTurnResult = Readonly<{ text: string; workerPid: number; workerUid: number; workerStartTime: string }> & EngineBrokerTurnAccounting;
export class EngineBrokerTurnFailure extends Error {
  constructor(readonly code: Exclude<EngineBrokerFailureCode, "turn_conflict" | "unavailable">, readonly diagnostic?: NativeBrokerDiagnostic, readonly accounting?: EngineBrokerTurnAccounting) { super("engine broker turn failed"); }
}

/** Everything one broker turn touches, injected so the accounting and limit paths run under test without a native launcher. */
export type GrokEngineBrokerTurnDependencies = Readonly<{
  turns: EngineBrokerTurnRegistry;
  proxy: Readonly<{ capabilities: Readonly<{ issue(agentId: string, turnId: string): string; revoke(turnId: string): void }>; registerIsolationGuard(turnId: string, guard: () => Promise<void>): void; revokeIsolationGuard(turnId: string): void; registerTurn(turnId: string, turn: GrokBrokerProxyTurn): void; revokeTurn(turnId: string): void }>;
  mcp: Readonly<{ register(agentId: string, turnId: string, endpoint: string): string; revoke(turnId: string): void }>;
  credentialStale(): boolean;
  prepareIsolation(registration: EngineBrokerServiceRegistration): Promise<() => Promise<void>>;
  runNative(input: NativeBrokerTurn, signal: AbortSignal): Promise<Readonly<NativeBrokerTurnResult>>;
}>;

const limitReasonFor = { tokens: "token_ceiling", requests: "request_ceiling", timeout: "wake_timeout" } as const;
const usageOf = (usage: Readonly<{ input: number; cacheRead: number; cacheWrite: number; output: number; total: number }>): EngineBrokerTurnUsage => ({ input: usage.input, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, output: usage.output, total: usage.total });

/**
 * One brokered Grok turn under its declared limits.
 *
 * The limits are the registration's, lowered (never raised) by the wake. The
 * proxy meter refuses model requests past `maxRequests`, past the elapsed
 * deadline, or once the upstream-reported running total reached `maxTokens`,
 * and a tripped limit aborts the worker through the same cancel/kill path a
 * client cancellation uses. A wall-clock timer trips `timeout` for a worker
 * that is mid-request.
 *
 * Every terminal path — completed, failed, limit, cancelled — is sealed and
 * metered through {@link finishBrokerTurnWithUsage}; a replayed turn returns its
 * sealed accounting before any of this runs and never meters again.
 */
export async function runGrokEngineBrokerTurn(deps: GrokEngineBrokerTurnDependencies, registration: EngineBrokerServiceRegistration, wakeId: string, prompt: string, mcpEndpoint: string, signal?: AbortSignal, overrides?: EngineBrokerTurnLimitOverrides): Promise<GrokEngineBrokerTurnResult> {
  const { agentId } = registration, declared = registration.model.model;
  let limits;
  try { limits = lowerEngineBrokerTurnLimits(registration.limits, overrides); } catch { throw new EngineBrokerTurnFailure("invalid_request", undefined, { outcome: "failed", usage: null, model: declared, requests: 0, limitReason: "none" }); }
  const turnId = createHash("sha256").update(`${agentId}\0${wakeId}`).digest("hex");
  const request = { version: ENGINE_BROKER_VERSION, kind: "start_turn", requestId: randomUUID(), turnId, agentId, wakeId, prompt, mcpEndpoint, ...(overrides === undefined ? {} : { limits: overrides }) } as const;
  const begun = await deps.turns.begin(request, declared);
  const metering: BrokerTurnMetering = { usageLedgerPath: registration.usageLedgerPath, requestLedgerPath: engineBrokerRequestLedgerPathFor(registration.usageLedgerPath), agentId, wakeId };
  if (begun !== "start") { await ensureBrokerTurnLedgered(begun.ledger, turnId, metering); return replay(begun.replay); }
  const controller = new AbortController();
  const meter = new GrokBrokerTurnMeter(limits, () => controller.abort());
  const onAbort = () => controller.abort(); signal?.addEventListener("abort", onAbort, { once: true }); if (signal?.aborted) controller.abort();
  const timer = setTimeout(() => meter.trip("timeout"), limits.timeoutMs); timer.unref?.();

  let nativeDiagnostic: NativeBrokerDiagnostic | undefined, attested = false, output: string | undefined, rejected = false, sealed: GrokEngineBrokerTurnResult | undefined;
  try {
    const isolationGuard = await deps.prepareIsolation(registration);
    deps.proxy.registerIsolationGuard(turnId, isolationGuard);
    deps.proxy.registerTurn(turnId, { policy: registration.model, meter });
    const providerCapability = deps.proxy.capabilities.issue(agentId, turnId), mcpCapability = deps.mcp.register(agentId, turnId, mcpEndpoint);
    const result = await deps.runNative({ slot: registration.slot, requestId: request.requestId, turnId, agentId, wakeId, prompt, providerCapability, mcpCapability }, controller.signal);
    nativeDiagnostic = result.diagnostic; output = result.text;
    if (result.workerUid !== registration.workerUid) throw new Error("engine broker worker identity mismatch");
    await isolationGuard(); attested = true;
    rejected = true;
    const decoded = decodeGrokHeadlessTurn(result.text), stream = decodeGrokStreamUsage(result.text);
    if (stream.reportedModels.some((reported) => mapGrokReportedModel(reported, declared) === undefined)) throw new Error("engine broker reported an undeclared model");
    rejected = false;
    const snapshot = meter.snapshot();
    if (snapshot.limitReason !== "none") throw new Error("engine broker turn limit reached");
    const usage = decoded.usage === undefined ? streamOrMeterUsage(stream, snapshot) : usageOf(decoded.usage);
    const accounting = { outcome: "completed", usage, model: declared, requests: requestCount(stream, snapshot), limitReason: "none" } as const;
    const completed = { version: request.version, kind: "completed", requestId: request.requestId, turnId, text: decoded.text, workerPid: result.workerPid, workerUid: result.workerUid, workerStartTime: result.startTicks.toString(), ...accounting } as const;
    const result_ = { text: completed.text, workerPid: completed.workerPid, workerUid: completed.workerUid, workerStartTime: completed.workerStartTime, ...accounting };
    await finishBrokerTurnWithUsage(deps.turns, request, completed, metering, { notionalUsd: decoded.usage?.notionalUsd ?? 0, complete: decoded.usage?.complete ?? false, estimatedRequests: snapshot.estimatedRequests, requests: requestRows(stream, snapshot), ...(stream.sessionId === undefined ? {} : { session: stream.sessionId }) }, () => { sealed = result_; });
    return result_;
  } catch (error) {
    const snapshot = meter.snapshot();
    const code: EngineBrokerTurnFailure["code"] = snapshot.limitReason !== "none" ? "limit_exceeded" : deps.credentialStale() ? "auth_stale" : controller.signal.aborted ? "cancelled" : "engine_failed";
    const diagnostic = error instanceof NativeBrokerTurnFailure ? error.diagnostic : nativeDiagnostic && !attested ? { ...nativeDiagnostic, status: "worker_failed" as const, stage: "attestation" as const, failureClass: error instanceof GrokWorkerAttestationFailure ? error.failureClass : "profile_invalid" as const, profileApplied: false } : undefined;
    const stream = output === undefined ? undefined : decodeGrokStreamUsage(output);
    const accounting = { outcome: "failed", usage: streamOrMeterUsage(stream, snapshot), model: declared, requests: requestCount(stream, snapshot), limitReason: snapshot.limitReason } as const;
    const failed: EngineBrokerTerminalResponse = { version: request.version, kind: "failed", requestId: request.requestId, turnId, code, ...(diagnostic ? { diagnostic } : {}), ...accounting };
    const reason = snapshot.limitReason !== "none" ? limitReasonFor[snapshot.limitReason] : rejected ? "turn_rejected" : "unknown";
    await finishBrokerTurnWithUsage(deps.turns, request, failed, metering, { notionalUsd: 0, complete: false, reason, estimatedRequests: snapshot.estimatedRequests, requests: requestRows(stream, snapshot), ...(stream?.sessionId === undefined ? {} : { session: stream.sessionId }) });
    throw new EngineBrokerTurnFailure(code, diagnostic, accounting);
  } finally {
    clearTimeout(timer); signal?.removeEventListener("abort", onAbort); meter.abortInFlight();
    deps.proxy.revokeTurn(turnId); deps.proxy.revokeIsolationGuard(turnId); deps.proxy.capabilities.revoke(turnId); deps.mcp.revoke(turnId);
  }
}

function replay(response: EngineBrokerTerminalResponse): GrokEngineBrokerTurnResult {
  const accounting = { outcome: response.outcome, usage: response.usage, model: response.model, requests: response.requests, limitReason: response.limitReason };
  if (response.kind === "completed") return { text: response.text, workerPid: response.workerPid, workerUid: response.workerUid, workerStartTime: response.workerStartTime, ...accounting, outcome: "completed" };
  const code = response.code === "turn_conflict" || response.code === "unavailable" ? "engine_failed" : response.code;
  throw new EngineBrokerTurnFailure(code, response.diagnostic as NativeBrokerDiagnostic | undefined, accounting);
}

/** The proxy saw every forwarded request; the stream is the fallback when no request crossed this proxy. */
const requestCount = (stream: GrokStreamUsage | undefined, snapshot: GrokBrokerTurnMeterSnapshot): number => snapshot.requests > 0 ? snapshot.requests : stream?.requests.length ?? 0;

/** Best partial usage: the worker's own per-request frames when any arrived, else what upstream reported to the proxy. */
function streamOrMeterUsage(stream: GrokStreamUsage | undefined, snapshot: GrokBrokerTurnMeterSnapshot): EngineBrokerTurnUsage | null {
  if (stream !== undefined && stream.requests.length > 0) {
    const sum = (pick: (value: GrokStreamUsage["requests"][number]) => number) => stream.requests.reduce((total, value) => total + pick(value), 0);
    return { input: sum((value) => value.input), cacheRead: sum((value) => value.cacheRead), cacheWrite: sum((value) => value.cacheWrite), output: sum((value) => value.output), total: sum((value) => value.total) };
  }
  return snapshot.usage;
}

/** Per-request rows: stream usage with proxy timing when both describe the same requests, else the proxy's own measured requests. */
function requestRows(stream: GrokStreamUsage | undefined, snapshot: GrokBrokerTurnMeterSnapshot): BrokerTurnMeteringDetail["requests"] {
  if (stream !== undefined && stream.requests.length > 0) {
    const timed = snapshot.timings.length === stream.requests.length;
    return stream.requests.map((value, index) => ({ ...value, usageSource: "stream" as const, ...(timed ? clock(snapshot.timings[index]!) : {}) }));
  }
  return snapshot.timings.flatMap((timing, index) => timing.usage === undefined ? [] : [{ index, ...usageOf(timing.usage), usageSource: timing.estimated === true ? "estimated" as const : "upstream" as const, ...clock(timing) }]);
}
const clock = (timing: GrokBrokerTurnMeterSnapshot["timings"][number]) => ({ startedAt: timing.startedAt, ...(timing.endedAt === undefined ? {} : { endedAt: timing.endedAt }) });

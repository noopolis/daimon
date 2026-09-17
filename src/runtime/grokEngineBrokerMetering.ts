import type { EngineBrokerRequest, EngineBrokerTerminalResponse } from "./engineBrokerProtocol.js";
import type { EngineBrokerTurnRegistry } from "./engineBrokerTurnRegistry.js";
import { recordGrokTurnRequests, type GrokTurnRequest } from "./turnRequestLedger.js";
import { recordTurnUsage, type TurnUsageFailureReason } from "./turnUsageLedger.js";

export type BrokerTurnMetering = Readonly<{
  usageLedgerPath: string;
  requestLedgerPath: string;
  agentId: string;
  wakeId: string;
}>;
export type BrokerTurnMeteringDetail = Readonly<{ notionalUsd: number; complete: boolean; reason?: TurnUsageFailureReason; requests: readonly GrokTurnRequest[]; session?: string }>;

/**
 * Seal a terminal turn, then meter it. The broker is the single writer.
 *
 * Order is load-bearing. `turns.finish` publishes the durable terminal record
 * *with* its accounting; only after that are the advisory ledger rows appended.
 * A replayed turn returns before the broker's `try` block and never reaches
 * here, so a crash-recovered or repeated turn cannot double-count; every row
 * also carries the turn id as `turn`, so a reader that sees one twice counts
 * it once.
 *
 * Both terminal kinds meter: a failed turn spent real tokens, so its partial
 * usage is written with `outcome: failed` and its closed `limitReason`. A turn
 * with no usage at all (`usage: null`) writes nothing — a zero row is
 * byte-identical to a measured zero.
 *
 * `recordTurnUsage`/`recordGrokTurnRequests` never reject, so an append failure
 * cannot escape into the caller's `catch` and rewrite a completed turn as failed.
 */
export async function finishBrokerTurnWithUsage(turns: EngineBrokerTurnRegistry, request: Extract<EngineBrokerRequest, { kind: "start_turn" }>, terminal: EngineBrokerTerminalResponse, metering: BrokerTurnMetering, detail: BrokerTurnMeteringDetail): Promise<void> {
  await turns.finish(request, terminal);
  if (terminal.usage === null) return;
  const { usage } = terminal;
  await recordTurnUsage(metering.usageLedgerPath, {
    agent: metering.agentId, wake: metering.wakeId, engine: "grok",
    usage: { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, total: usage.total, calls: terminal.requests, notionalUsd: detail.notionalUsd, complete: detail.complete },
    outcome: terminal.kind === "completed" ? { status: "completed" } : { status: "failed", reason: detail.reason ?? "unknown" },
    turn: terminal.turnId, limitReason: terminal.limitReason, model: terminal.model
  });
  await recordGrokTurnRequests(metering.requestLedgerPath, { agent: metering.agentId, wake: metering.wakeId, turn: terminal.turnId, model: terminal.model, requests: detail.requests, requestCount: terminal.requests, ...(detail.session === undefined ? {} : { session: detail.session }) });
}

import type { EngineBrokerRequest, EngineBrokerTerminalResponse } from "./engineBrokerProtocol.js";
import type { EngineBrokerTurnRegistry } from "./engineBrokerTurnRegistry.js";
import { appendBrokerTurnLedger, renderBrokerTurnLedger } from "./grokEngineBrokerLedger.js";
import type { GrokTurnRequest } from "./turnRequestLedger.js";
import type { TurnUsageFailureReason } from "./turnUsageLedger.js";

export type BrokerTurnMetering = Readonly<{
  usageLedgerPath: string;
  requestLedgerPath: string;
  /** Where the sealed response's operator-visible projection is appended (`engineBrokerSealLedger.ts`). */
  sealLedgerPath: string;
  agentId: string;
  wakeId: string;
}>;
export type BrokerTurnMeteringDetail = Readonly<{ notionalUsd: number; complete: boolean; reason?: TurnUsageFailureReason; requests: readonly GrokTurnRequest[]; session?: string; estimatedRequests: number }>;

/**
 * Seal a terminal turn, then meter it. The broker is the single writer.
 *
 * Order is load-bearing. The ledger bytes are rendered first and sealed into
 * the durable terminal record together with its accounting
 * (`grokEngineBrokerLedger.ts`); only after `turns.finish` published that
 * record are the same bytes appended. A replayed turn returns before the
 * broker's `try` block and never meters again — it only completes an append a
 * crash interrupted (`ensureBrokerTurnLedgered`), and every row carries the
 * turn id as `turn`, so a reader that sees one twice counts it once.
 *
 * Remaining window, documented rather than closed: a crash before the record's
 * rename (while the turn is still `active`, including mid-turn) makes the next
 * boot seal that turn `failed` with `usage: null`, so its spend is unmetered.
 * Closing it needs the running proxy usage checkpointed into the active record
 * on every request (an fsync'd rewrite per model request); not done here.
 *
 * Both terminal kinds meter: a failed turn spent real tokens, so its partial
 * usage is written with `outcome: failed` and its closed `limitReason`. A turn
 * with no usage at all (`usage: null`) writes no *usage* row — a zero row is
 * byte-identical to a measured zero — but it still writes its seal row, which
 * is a record of what the turn did rather than of what it spent.
 *
 * Appends never reject, so an append failure cannot escape into the caller's
 * `catch` and rewrite a completed turn as failed; the caller also refuses to
 * re-seal a turn this helper already sealed.
 */
export async function finishBrokerTurnWithUsage(turns: EngineBrokerTurnRegistry, request: Extract<EngineBrokerRequest, { kind: "start_turn" }>, terminal: EngineBrokerTerminalResponse, metering: BrokerTurnMetering, detail: BrokerTurnMeteringDetail, onSealed: () => void = () => undefined): Promise<void> {
  const lines = renderBrokerTurnLedger(terminal, { ...detail, agentId: metering.agentId, wakeId: metering.wakeId });
  await turns.finish(request, terminal, lines);
  onSealed();
  await appendBrokerTurnLedger(lines, metering);
}

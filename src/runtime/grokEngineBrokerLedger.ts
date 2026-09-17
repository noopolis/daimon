import { readFile } from "node:fs/promises";

import { recordLedgerLines, renderGrokTurnRequestLines, TURN_REQUEST_LEDGER_VERSION, type GrokTurnRequest } from "./turnRequestLedger.js";
import { renderTurnUsageLine, TURN_USAGE_LEDGER_VERSION, type TurnUsageFailureReason } from "./turnUsageLedger.js";
import type { EngineBrokerTerminalResponse } from "./engineBrokerProtocol.js";

/**
 * The exact ledger bytes a terminal broker turn owes, sealed into its turn
 * record *before* they are appended.
 *
 * The record is published first and the ledger appended second, so a crash in
 * between used to leave a sealed turn whose spend never reached the ledger —
 * and a replay never metered. Now a replay re-checks: if the ledger holds no
 * row for this `turn`, it appends these same bytes (same `at`, same numbers).
 * That is completing the original metering, not re-metering: a replay after a
 * normal append finds the row and writes nothing, and readers dedupe on `turn`
 * should two replays race.
 */
export type BrokerTurnLedgerLines = Readonly<{ usage: string | null; requests: string }>;
export const EMPTY_BROKER_TURN_LEDGER: BrokerTurnLedgerLines = Object.freeze({ usage: null, requests: "" });

export type BrokerTurnLedgerDetail = Readonly<{ agentId: string; wakeId: string; notionalUsd: number; complete: boolean; reason?: TurnUsageFailureReason; requests: readonly GrokTurnRequest[]; session?: string; estimatedRequests: number }>;

export function renderBrokerTurnLedger(terminal: EngineBrokerTerminalResponse, detail: BrokerTurnLedgerDetail): BrokerTurnLedgerLines {
  if (terminal.usage === null) return EMPTY_BROKER_TURN_LEDGER;
  const { usage } = terminal, at = new Date().toISOString();
  return {
    usage: renderTurnUsageLine({
      agent: detail.agentId, wake: detail.wakeId, engine: "grok", at,
      usage: { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, total: usage.total, calls: terminal.requests, notionalUsd: detail.notionalUsd, complete: detail.complete },
      outcome: terminal.kind === "completed" ? { status: "completed" } : { status: "failed", reason: detail.reason ?? "unknown" },
      turn: terminal.turnId, limitReason: terminal.limitReason, model: terminal.model, estimatedRequests: detail.estimatedRequests
    }),
    requests: renderGrokTurnRequestLines({ agent: detail.agentId, wake: detail.wakeId, turn: terminal.turnId, model: terminal.model, requests: detail.requests, requestCount: terminal.requests, at, ...(detail.session === undefined ? {} : { session: detail.session }) })
  };
}

const MAX_USAGE_LINE_BYTES = 4_096, MAX_REQUEST_LINES_BYTES = 262_144;
const rows = (text: string): Record<string, unknown>[] => text.split("\n").filter((line) => line.length > 0).map((line) => { const value: unknown = JSON.parse(line); if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(); return value as Record<string, unknown>; });

/** Strict check of stored ledger bytes: exactly the turn's own rows, newline-terminated, bounded. */
export function parseBrokerTurnLedgerLines(value: unknown, turnId: string): BrokerTurnLedgerLines {
  const invalid = () => new Error("broker turn registry unavailable");
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 2 || !Object.hasOwn(value, "usage") || !Object.hasOwn(value, "requests")) throw invalid();
  const { usage, requests } = value as { usage: unknown; requests: unknown };
  try {
    if (usage !== null) {
      if (typeof usage !== "string" || !usage.endsWith("\n") || Buffer.byteLength(usage) > MAX_USAGE_LINE_BYTES) throw invalid();
      const parsed = rows(usage);
      if (parsed.length !== 1 || parsed[0]!.v !== TURN_USAGE_LEDGER_VERSION || parsed[0]!.turn !== turnId) throw invalid();
    }
    if (typeof requests !== "string" || (requests.length > 0 && (usage === null || !requests.endsWith("\n"))) || Buffer.byteLength(requests) > MAX_REQUEST_LINES_BYTES) throw invalid();
    if (rows(requests).some((row) => row.v !== TURN_REQUEST_LEDGER_VERSION || row.turn !== turnId)) throw invalid();
  } catch { throw invalid(); }
  return { usage: usage as string | null, requests };
}

/** Appends sealed lines on the first metering: no presence scan is needed, nothing was appended before the record existed. */
export async function appendBrokerTurnLedger(lines: BrokerTurnLedgerLines, paths: Readonly<{ usageLedgerPath: string; requestLedgerPath: string }>): Promise<void> {
  if (lines.usage !== null) await recordLedgerLines(paths.usageLedgerPath, lines.usage);
  await recordLedgerLines(paths.requestLedgerPath, lines.requests);
}

/** On replay: append each stream's sealed lines only when that stream (current file or its `.1`) holds no row for this turn. Never rejects. */
export async function ensureBrokerTurnLedgered(lines: BrokerTurnLedgerLines, turnId: string, paths: Readonly<{ usageLedgerPath: string; requestLedgerPath: string }>): Promise<void> {
  try {
    if (lines.usage !== null && !await ledgerHasTurn(paths.usageLedgerPath, turnId)) await recordLedgerLines(paths.usageLedgerPath, lines.usage);
    if (lines.requests.length > 0 && !await ledgerHasTurn(paths.requestLedgerPath, turnId)) await recordLedgerLines(paths.requestLedgerPath, lines.requests);
  } catch { /* advisory: a replay never fails on its ledger */ }
}

async function ledgerHasTurn(file: string, turnId: string): Promise<boolean> {
  for (const candidate of [`${file}.1`, file]) {
    let text: string;
    try { text = await readFile(candidate, "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      if (!line.includes(turnId)) continue;
      try { if ((JSON.parse(line) as { turn?: unknown }).turn === turnId) return true; } catch { /* a torn line is not this turn's row */ }
    }
  }
  return false;
}

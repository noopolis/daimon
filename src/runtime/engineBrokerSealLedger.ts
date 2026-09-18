import { ENGINE_BROKER_MCP_CALL_NAME, ENGINE_BROKER_MCP_OUTSTANDING_MAX } from "./engineBrokerMcpCallLog.js";
import type { EngineBrokerTerminalResponse } from "./engineBrokerProtocol.js";
import { TURN_USAGE_LEDGER, TURN_USAGE_MAX_IDENTIFIER_CHARS } from "./turnUsageLedger.js";

/**
 * The operator-visible half of a sealed terminal turn, as a durable row.
 *
 * The seal itself already carries everything an operator needs to read a turn
 * that stopped acting — the failure code, the worker's own redacted last words,
 * and `engineBrokerMcpCallLog.ts`'s observation of the tool call the worker was
 * blocked on. All of it travels in the control-protocol terminal response, and
 * that response is the one artifact a *hung* turn never produces: the client is
 * gone before the broker answers, the turn registry record lives in the
 * broker's own `0700` turn store, and a training slot's control root is tmpfs
 * that dies with the container. Six live runs reproduced the same signature and
 * none of them could read the instrument built for it.
 *
 * What does survive a slot is the broker's ledger directory: Paideia already
 * recovers `usage.jsonl` and `requests.jsonl` from it on the failure path. So
 * this is a third stream beside those two, written by the broker — still the
 * single sealed usage writer — from the sealed response and nothing else, at
 * the moment that response is sealed.
 *
 * Its rules are the two ledgers' rules:
 *
 * - **Numbers, names, timings and closed vocabularies only.** The failure code,
 *   the accounting, the diagnostic's closed `status`/`stage`/`failure_class`
 *   and its already-redacted, already-bounded, control-character-free `reason`
 *   (`engineBrokerNativeClient.ts` produced it; nothing here re-derives it),
 *   plus tool-call names and elapsed milliseconds. Never a prompt, a body, a
 *   reply, a bearer, a capability or a session id — none of which the terminal
 *   response carries in the first place.
 * - **Absence stays absence.** `mcp` is written only when the facade actually
 *   observed the turn, `diagnostic` only when the sealed response carried one,
 *   and `code` only for a failure. A turn that called no tool publishes
 *   `started: 0`, which is a measurement; a turn the facade never registered
 *   publishes no `mcp` member at all, which is not.
 * - **It can never fail a turn.** The row is rendered from an
 *   already-validated frame and appended through `recordLedgerLines`, which
 *   swallows every I/O fault.
 *
 * A separate stream and a separate `v`, for `turnRequestLedger.ts`'s reason:
 * Spawnfile's reader pins `noopolis.daimon.turn-usage.v1` and drops any other
 * `v` outright, and Paideia's request reader refuses a row it cannot type. A
 * row in a new file is invisible to both.
 */
export const TURN_SEAL_LEDGER_VERSION = "noopolis.daimon.turn-seal.v1" as const;

/** Default location: beside `usage.jsonl` and `requests.jsonl`, no new mount. */
export const TURN_SEAL_LEDGER = {
  version: TURN_SEAL_LEDGER_VERSION,
  directoryPath: TURN_USAGE_LEDGER.directoryPath,
  filePath: `${TURN_USAGE_LEDGER.directoryPath}/turns.jsonl`,
  rotatedFilePath: `${TURN_USAGE_LEDGER.directoryPath}/turns.jsonl.1`,
  fileMode: TURN_USAGE_LEDGER.fileMode
} as const;

/** A rendered seal line is bounded by its own contents: a 768-byte reason plus 16 bounded names. */
export const TURN_SEAL_MAX_LINE_BYTES = 8_192;

export type BrokerTurnSealEntry = Readonly<{ agent: string; wake: string; at: string }>;

const bounded = (value: string): string => [...value].slice(0, TURN_USAGE_MAX_IDENTIFIER_CHARS).join("");

/**
 * One newline-terminated row for one sealed terminal turn.
 *
 * Every member is copied from the terminal response the protocol already
 * validated, so this projection cannot widen what the response admits; it is an
 * allow-list rather than a spread, so a future additive member of the response
 * does not silently become a ledger field.
 */
export const renderBrokerTurnSealLine = (terminal: EngineBrokerTerminalResponse, entry: BrokerTurnSealEntry): string => `${JSON.stringify({
  v: TURN_SEAL_LEDGER_VERSION,
  agent: bounded(entry.agent),
  wake: bounded(entry.wake),
  engine: "grok",
  at: entry.at,
  turn: terminal.turnId,
  outcome: terminal.outcome,
  requests: terminal.requests,
  model: terminal.model,
  limit_reason: terminal.limitReason,
  ...(terminal.kind === "failed" ? { code: terminal.code } : {}),
  ...(terminal.kind === "failed" && terminal.diagnostic !== undefined
    ? {
      diagnostic: {
        status: terminal.diagnostic.status,
        stage: terminal.diagnostic.stage,
        failure_class: terminal.diagnostic.failureClass,
        exit_code: terminal.diagnostic.exitCode,
        term_signal: terminal.diagnostic.termSignal,
        ...(terminal.diagnostic.reason === undefined ? {} : { reason: terminal.diagnostic.reason })
      }
    }
    : {}),
  ...(terminal.kind === "failed" && terminal.mcpCalls !== undefined
    ? {
      mcp: {
        started: terminal.mcpCalls.started,
        answered: terminal.mcpCalls.answered,
        undecoded: terminal.mcpCalls.undecoded,
        outstanding: terminal.mcpCalls.outstanding
          .slice(0, ENGINE_BROKER_MCP_OUTSTANDING_MAX)
          .map((call) => ({ name: ENGINE_BROKER_MCP_CALL_NAME.test(call.name) ? call.name : "<invalid>", outstanding_ms: call.outstandingMs }))
      }
    }
    : {})
})}\n`;

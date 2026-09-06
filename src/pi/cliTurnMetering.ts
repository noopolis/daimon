import type { AgyTurnUsage } from "./agyHeadlessResult.js";
import { cliChildFailureReason, tagCliChildFailure } from "./cliChildOutput.js";
import { decodeCodexHeadlessTurn, type CodexHeadlessTurn, type CodexTurnUsage } from "./codexHeadlessResult.js";
import type { TurnUsageOutcome } from "../runtime/turnUsageLedger.js";

/**
 * What one CLI turn owes the usage ledger, and the rules for when it owes
 * nothing.
 *
 * A wake that fails spends exactly the money a wake that publishes spends, so
 * the engine's reported usage is metered on both paths and the row's outcome
 * says which. A Codex wake that breached its per-wake token ceiling used to
 * record nothing at all: the tokens it burned survived only as a number
 * interpolated into the error message, and a timeout, a killed child, or a
 * non-zero exit lost the figure entirely.
 *
 * The counterweight is that a number is never invented. A zero-filled row is
 * byte-identical to a real zero and would silently poison every aggregate
 * computed over the ledger, so "the engine reported nothing" stays absent.
 */
export type CliTurnMeter = Readonly<{
  /** Wire this to `readChild`'s `onCodexTurnCompleted`. */
  observeCodexTurnCompleted: (usage: CodexTurnUsage | undefined) => void;
  /**
   * The usage Codex reported mid-stream, for a wake that never reached its
   * decoder.
   *
   * Trustworthy only under `decodeCodexHeadlessTurn`'s own rule: exactly one
   * `turn.completed` frame. Codex may omit, repeat, or follow that frame with
   * another, and two completions leave no defensible answer for which one the
   * wake actually spent — so this declines rather than guessing, and no frame
   * at all means nothing was reported and nothing is written.
   */
  reported: () => CodexTurnUsage | undefined;
}>;

export const createCliTurnMeter = (): CliTurnMeter => {
  let usage: CodexTurnUsage | undefined;
  let completions = 0;
  return {
    observeCodexTurnCompleted: (reported) => {
      completions += 1;
      if (reported !== undefined) usage = reported;
    },
    reported: () => (completions === 1 ? usage : undefined)
  };
};

/**
 * A turn Codex reported usage for but that the decoder refuses to publish is
 * still a turn that spent tokens. Tagging the rejection is what lets the
 * ledger row name why the wake failed instead of matching on message prose.
 */
export const decodeCodexTurn = (output: string): CodexHeadlessTurn => {
  try { return decodeCodexHeadlessTurn(output); }
  catch (error) { throw tagCliChildFailure(error, "turn_rejected"); }
};

/** The failed row's marker, named by the bound that actually fired. */
export const failedTurnOutcome = (failure: unknown): TurnUsageOutcome =>
  ({ status: "failed", reason: cliChildFailureReason(failure) ?? "unknown" });

/**
 * Advisory: metering never fails, delays, or rewrites the wake it describes —
 * the same ordering rule the Grok engine broker states in
 * `finishBrokerTurnWithUsage`.
 */
export const publishTurnUsage = async (
  sink: ((usage: AgyTurnUsage | CodexTurnUsage, outcome: TurnUsageOutcome) => Promise<void>) | undefined,
  usage: AgyTurnUsage | CodexTurnUsage | undefined,
  outcome: TurnUsageOutcome
): Promise<void> => {
  if (usage === undefined) return;
  try { await sink?.(usage, outcome).catch(() => undefined); } catch { /* advisory */ }
};

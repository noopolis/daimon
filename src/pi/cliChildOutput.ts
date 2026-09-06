import type { ChildProcess } from "node:child_process";

import { redactCredentialText } from "../core/credentialRedaction.js";
import type { TurnUsageFailureReason } from "../runtime/turnUsageLedger.js";
import { decodeCodexTurnUsage, type CodexTurnUsage } from "./codexHeadlessResult.js";
import { terminateChild, trackCliChild } from "./cliProcess.js";

/** Maximum assistant reply bytes retained from stdout. */
export const CLI_ENGINE_MAX_OUTPUT_BYTES = 64 * 1024;
/** Tail bytes retained from stderr only for a failed-child diagnostic. */
export const CLI_ENGINE_MAX_DIAGNOSTIC_BYTES = 768;
const CLI_ENGINE_FAILURE_SCAN_CHARS = 256;

/**
 * Which bound or condition failed a wake, carried on the error object itself.
 *
 * The caller needs this to label the usage row a failed wake still owes the
 * ledger, and matching on the message text would make that label depend on
 * prose. The tag is a non-enumerable symbol property, so it never widens the
 * error's serialized form and never reaches a diagnostic string.
 */
const CLI_CHILD_FAILURE_REASON = Symbol("daimon.cliChildFailureReason");

export const tagCliChildFailure = <T>(error: T, reason: TurnUsageFailureReason): T => {
  if (!(error instanceof Error)) return error;
  // Labelling a failure must never become a second failure: a frozen or sealed
  // error simply goes untagged and its row reads `unknown`.
  try { Object.defineProperty(error, CLI_CHILD_FAILURE_REASON, { configurable: true, enumerable: false, value: reason, writable: true }); }
  catch { /* the reason is advisory; the failure it describes is not */ }
  return error;
};

export const cliChildFailureReason = (error: unknown): TurnUsageFailureReason | undefined =>
  error instanceof Error
    ? (error as Error & { [CLI_CHILD_FAILURE_REASON]?: TurnUsageFailureReason })[CLI_CHILD_FAILURE_REASON]
    : undefined;

const redactChildOutput = (value: string, secretValues: readonly string[]): string => {
  return redactCredentialText(value, secretValues, CLI_ENGINE_MAX_OUTPUT_BYTES);
};

const utf8Tail = (value: string, maxBytes: number): string => {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  let result = bytes.subarray(bytes.length - maxBytes).toString("utf8");
  while (result.startsWith("\uFFFD")) result = result.slice(1);
  return result;
};

const childDiagnostic = (stdout: string, stderr: string, secretValues: readonly string[]): string => {
  const output = stderr.trim().length > 0 ? stderr : stdout;
  const redacted = redactCredentialText(output, secretValues, Number.MAX_SAFE_INTEGER).trim();
  const bounded = utf8Tail(redacted, CLI_ENGINE_MAX_DIAGNOSTIC_BYTES).trim();
  return bounded.length > 0 ? `: ${bounded}` : "";
};

export const readChild = (
  child: ChildProcess,
  timeoutMs: number | undefined,
  secretValues: readonly string[],
  options: Readonly<{
    failureClassifier?: (diagnostic: string) => Error | undefined;
    retainNdjson?: "codex";
    retainStdoutTail?: boolean;
    /** Overrides the generic wall-clock-timeout message so the caller can name which bound was hit. */
    timeoutErrorMessage?: string;
    /**
     * Per-wake token ceiling for a Codex turn (`retainNdjson: "codex"` only).
     * Codex's `--json` stream reports usage exactly once, on `turn.completed`
     * — there is no incremental total to watch mid-turn — so this is
     * enforced at the earliest and only moment the crossing is observable:
     * the instant that frame is parsed off the stream. Crossing it kills the
     * child immediately (rather than letting an over-budget turn resolve as
     * a normal success) and fails the wake with a bound-named error.
     */
    codexTokenCeiling?: number;
    /**
     * Called once per parsed `turn.completed` frame (`retainNdjson: "codex"`
     * only), with that frame's decoded usage — or `undefined` when the usage
     * block is absent or malformed, which is never substituted with zeros.
     *
     * This is the only point at which a wake that is about to be killed — by
     * the ceiling, by the wall clock, or by a non-zero exit — can still hand
     * over what Codex reported it spent. Every path downstream of here either
     * rejects or discards the stream, which is how a breached wake's usage
     * used to survive only inside an error message.
     */
    onCodexTurnCompleted?: (usage: CodexTurnUsage | undefined) => void;
  }> = {}
): Promise<string> => new Promise((resolve, reject) => {
  trackCliChild(child);
  const stdout: Buffer[] = [];
  let stdoutTail = Buffer.alloc(0);
  let droppingStdoutLine = false;
  let stderrTail = Buffer.alloc(0);
  let stdoutBytes = 0;
  let stdoutRemainder = Buffer.alloc(0);
  let droppingNdjsonLine = false;
  let ndjsonCalls = 0;
  let settled = false;
  let cleanupStarted = false;
  let classifiedFailure: Error | undefined;
  let failureScanTail = "";
  const stderrRetentionBytes = CLI_ENGINE_MAX_DIAGNOSTIC_BYTES
    + Math.max(0, ...secretValues.map((secret) => Buffer.byteLength(secret, "utf8")));
  const settle = (action: () => void): void => {
    if (settled) return;
    settled = true;
    if (timer !== undefined) clearTimeout(timer);
    action();
  };
  const abort = (error: Error): void => {
    if (cleanupStarted) return;
    cleanupStarted = true;
    void terminateChild(child).then(
      () => settle(() => reject(error)),
      (cleanupError: unknown) => settle(() => reject(cleanupError instanceof Error ? cleanupError : error))
    );
  };
  const classifyFailure = (chunk: Buffer): void => {
    if (classifiedFailure !== undefined || options.failureClassifier === undefined) return;
    const diagnostic = `${failureScanTail}${chunk.toString("utf8")}`;
    classifiedFailure = options.failureClassifier(diagnostic);
    failureScanTail = diagnostic.slice(-CLI_ENGINE_FAILURE_SCAN_CHARS);
  };
  const retainStdout = (chunk: Buffer): void => {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    classifyFailure(value);
    if (options.retainNdjson !== undefined) {
      let incoming = value;
      if (droppingNdjsonLine) {
        const newline = incoming.indexOf(0x0a);
        if (newline < 0) return;
        droppingNdjsonLine = false;
        incoming = incoming.subarray(newline + 1);
      }
      stdoutRemainder = Buffer.concat([stdoutRemainder, incoming]);
      let newline: number;
      while ((newline = stdoutRemainder.indexOf(0x0a)) >= 0) {
        const line = stdoutRemainder.subarray(0, newline).toString("utf8");
        stdoutRemainder = Buffer.from(stdoutRemainder.subarray(newline + 1));
        let frame: Record<string, unknown> | undefined;
        try { const parsed = JSON.parse(line) as unknown; if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) frame = parsed as Record<string, unknown>; } catch { /* decoder reports malformed retained protocol lines */ }
        if (frame === undefined) { stdout.push(Buffer.from(`${line}\n`)); continue; }
        const item = typeof frame.item === "object" && frame.item !== null && !Array.isArray(frame.item) ? frame.item as Record<string, unknown> : undefined;
        if (frame.type === "item.completed" && (item?.type === "command_execution" || item?.type === "mcp_tool_call")) {
          ndjsonCalls += 1;
          stdout.push(Buffer.from(`${JSON.stringify({ type: frame.type, item: { type: item.type } })}\n`));
        } else if ((frame.type === "item.completed" && item?.type === "agent_message") || frame.type === "turn.completed" || frame.type === "turn.failed") {
          if (frame.type === "turn.completed") {
            // Decode and publish first, kill second: the ceiling breach is the
            // one path guaranteed to destroy this stream, so the accounting
            // has to leave the reader before the child does.
            const usage = decodeCodexTurnUsage(frame, ndjsonCalls);
            options.onCodexTurnCompleted?.(usage);
            if (options.codexTokenCeiling !== undefined && usage !== undefined && usage.total >= options.codexTokenCeiling) {
              abort(tagCliChildFailure(new Error(`Codex wake exceeded its ${options.codexTokenCeiling}-token per-wake ceiling (turn usage ${usage.total} tokens)`), "token_ceiling"));
              return;
            }
          }
          stdout.push(Buffer.from(`${line}\n`));
        }
        stdoutBytes = stdout.reduce((total, part) => total + part.length, 0);
        if (stdoutBytes > CLI_ENGINE_MAX_OUTPUT_BYTES) { abort(tagCliChildFailure(new Error(`CLI engine output exceeded ${CLI_ENGINE_MAX_OUTPUT_BYTES} bytes`), "output_limit")); return; }
      }
      if (stdoutRemainder.length > CLI_ENGINE_MAX_OUTPUT_BYTES) {
        const prefix = stdoutRemainder.subarray(0, Math.min(stdoutRemainder.length, 4096)).toString("utf8");
        if (/"type"\s*:\s*"item\.completed"/u.test(prefix)
          && !/"type"\s*:\s*"agent_message"/u.test(prefix)) {
          const toolType = prefix.match(/"type"\s*:\s*"(command_execution|mcp_tool_call)"/u)?.[1];
          if (toolType !== undefined) { ndjsonCalls += 1; stdout.push(Buffer.from(`${JSON.stringify({ type: "item.completed", item: { type: toolType } })}\n`)); }
          stdoutRemainder = Buffer.alloc(0);
          droppingNdjsonLine = true;
        } else abort(tagCliChildFailure(new Error(`CLI engine output exceeded ${CLI_ENGINE_MAX_OUTPUT_BYTES} bytes`), "output_limit"));
      }
      return;
    }
    if (options.retainStdoutTail === true) {
      let remainder = value;
      if (droppingStdoutLine) {
        const newline = remainder.indexOf(0x0a);
        if (newline < 0) return;
        droppingStdoutLine = false;
        remainder = remainder.subarray(newline + 1);
      }
      const combined = Buffer.concat([stdoutTail, remainder]);
      if (combined.length <= CLI_ENGINE_MAX_OUTPUT_BYTES) {
        stdoutTail = combined;
        return;
      }
      const overflow = combined.length - CLI_ENGINE_MAX_OUTPUT_BYTES;
      if (combined[overflow - 1] === 0x0a) {
        stdoutTail = Buffer.from(combined.subarray(overflow));
        return;
      }
      const newline = combined.indexOf(0x0a, overflow);
      stdoutTail = newline < 0 ? Buffer.alloc(0) : Buffer.from(combined.subarray(newline + 1));
      droppingStdoutLine = newline < 0;
      return;
    }
    stdoutBytes += value.length;
    if (stdoutBytes > CLI_ENGINE_MAX_OUTPUT_BYTES) {
      abort(tagCliChildFailure(new Error(`CLI engine output exceeded ${CLI_ENGINE_MAX_OUTPUT_BYTES} bytes`), "output_limit"));
      return;
    }
    stdout.push(value);
  };
  const retainStderrTail = (chunk: Buffer): void => {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    classifyFailure(value);
    if (value.length >= stderrRetentionBytes) {
      stderrTail = Buffer.from(value.subarray(value.length - stderrRetentionBytes));
      return;
    }
    const overflow = stderrTail.length + value.length - stderrRetentionBytes;
    stderrTail = Buffer.concat([overflow > 0 ? stderrTail.subarray(overflow) : stderrTail, value]);
  };
  child.stdout?.on("data", retainStdout);
  child.stderr?.on("data", retainStderrTail);
  const timer = timeoutMs === undefined ? undefined : setTimeout(() => abort(tagCliChildFailure(new Error(options.timeoutErrorMessage ?? "CLI engine timed out"), "wake_timeout")), timeoutMs);
  child.once("error", abort);
  child.once("close", (code, signal) => {
    if (cleanupStarted) return;
    if (options.retainNdjson !== undefined && stdoutRemainder.length > 0) stdout.push(stdoutRemainder);
    const retainedStdout = options.retainStdoutTail === true ? stdoutTail : Buffer.concat(stdout);
    if (code === 0) {
      settle(() => resolve(redactChildOutput(retainedStdout.toString("utf8"), secretValues).trim()));
      return;
    }
    settle(() => reject(tagCliChildFailure(classifiedFailure ?? new Error(`CLI engine exited ${code ?? signal}${childDiagnostic(
      retainedStdout.toString("utf8"), stderrTail.toString("utf8"), secretValues
    )}`), "engine_exit")));
  });
});

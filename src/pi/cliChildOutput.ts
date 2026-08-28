import type { ChildProcess } from "node:child_process";

import { redactCredentialText } from "../core/credentialRedaction.js";
import { terminateChild, trackCliChild } from "./cliProcess.js";

/** Maximum assistant reply bytes retained from stdout. */
export const CLI_ENGINE_MAX_OUTPUT_BYTES = 64 * 1024;
/** Tail bytes retained from stderr only for a failed-child diagnostic. */
export const CLI_ENGINE_MAX_DIAGNOSTIC_BYTES = 768;
const CLI_ENGINE_FAILURE_SCAN_CHARS = 256;

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
    retainStdoutTail?: boolean;
  }> = {}
): Promise<string> => new Promise((resolve, reject) => {
  trackCliChild(child);
  const stdout: Buffer[] = [];
  let stdoutTail = Buffer.alloc(0);
  let droppingStdoutLine = false;
  let stderrTail = Buffer.alloc(0);
  let stdoutBytes = 0;
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
      abort(new Error(`CLI engine output exceeded ${CLI_ENGINE_MAX_OUTPUT_BYTES} bytes`));
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
  const timer = timeoutMs === undefined ? undefined : setTimeout(() => abort(new Error("CLI engine timed out")), timeoutMs);
  child.once("error", abort);
  child.once("close", (code, signal) => {
    if (cleanupStarted) return;
    const retainedStdout = options.retainStdoutTail === true ? stdoutTail : Buffer.concat(stdout);
    if (code === 0) {
      settle(() => resolve(redactChildOutput(retainedStdout.toString("utf8"), secretValues).trim()));
      return;
    }
    settle(() => reject(classifiedFailure ?? new Error(`CLI engine exited ${code ?? signal}${childDiagnostic(
      retainedStdout.toString("utf8"), stderrTail.toString("utf8"), secretValues
    )}`)));
  });
});

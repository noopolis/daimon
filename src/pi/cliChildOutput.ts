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
    retainNdjson?: "codex";
    retainStdoutTail?: boolean;
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
          stdout.push(Buffer.from(`${JSON.stringify({ type: frame.type, item: { type: item.type } })}\n`));
        } else if ((frame.type === "item.completed" && item?.type === "agent_message") || frame.type === "turn.completed" || frame.type === "turn.failed") {
          stdout.push(Buffer.from(`${line}\n`));
        }
        stdoutBytes = stdout.reduce((total, part) => total + part.length, 0);
        if (stdoutBytes > CLI_ENGINE_MAX_OUTPUT_BYTES) { abort(new Error(`CLI engine output exceeded ${CLI_ENGINE_MAX_OUTPUT_BYTES} bytes`)); return; }
      }
      if (stdoutRemainder.length > CLI_ENGINE_MAX_OUTPUT_BYTES) {
        const prefix = stdoutRemainder.subarray(0, Math.min(stdoutRemainder.length, 4096)).toString("utf8");
        if (/"type"\s*:\s*"item\.completed"/u.test(prefix)
          && !/"type"\s*:\s*"agent_message"/u.test(prefix)) {
          const toolType = prefix.match(/"type"\s*:\s*"(command_execution|mcp_tool_call)"/u)?.[1];
          if (toolType !== undefined) stdout.push(Buffer.from(`${JSON.stringify({ type: "item.completed", item: { type: toolType } })}\n`));
          stdoutRemainder = Buffer.alloc(0);
          droppingNdjsonLine = true;
        } else abort(new Error(`CLI engine output exceeded ${CLI_ENGINE_MAX_OUTPUT_BYTES} bytes`));
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
    if (options.retainNdjson !== undefined && stdoutRemainder.length > 0) stdout.push(stdoutRemainder);
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

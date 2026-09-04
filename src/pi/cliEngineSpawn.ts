import { spawn, type ChildProcess } from "node:child_process";

import { trackCliChild } from "./cliProcess.js";
import { cliChildEnvironment } from "./cliEnvironment.js";
import type { CliEngineOptions, CliSessionInput } from "./cliSession.js";

export const GROK_STRICT_SANDBOX_PROFILE = "strict";

export const renderGrokSandboxArgs = (
  commandArgs: readonly string[] | undefined,
  profile: string
): string[] => [...assertSafeGrokCommandArgs(commandArgs), "--sandbox", profile];

/**
 * Codex's `--json` stream is unconditional: it is the only output shape that
 * carries `turn.completed.usage`, and an unmetered Codex turn is one whose
 * subscription cost is invisible. The guarded arguments make this Daimon's
 * security and metering boundary rather than a caller-controlled format.
 */
export const renderCodexArgs = (
  options: Pick<CliEngineOptions, "commandArgs">,
  cwd: string,
  endpoint: string | undefined,
  sandbox: string = process.env.DAIMON_CODEX_SANDBOX ?? "danger-full-access"
): string[] => [...assertSafeCodexCommandArgs(options.commandArgs), "exec", "--sandbox", sandbox, "--skip-git-repo-check", "--color", "never", "--json", "-C", cwd,
  "-c", `mcp_servers.daimon.url=${endpoint}`, "-"];

/**
 * AGY's headless invocation.
 *
 * `--output-format stream-json` is unconditional: it is the only shape that
 * carries `result.usage`, and an AGY turn that is not metered is an AGY turn
 * whose subscription cost is invisible (see `agyHeadlessResult.ts`).
 *
 * `--dangerously-skip-permissions` is required for tools to work at all. AGY's
 * default headless permission mode is `request-review`, and there is no
 * reviewer inside a container, so a tool call can never be approved without it;
 * the live probe that proved AGY's MCP tool calling ran with exactly this flag
 * and reported `permission_mode: always-proceed`. Every Daimon CLI agent mounts
 * at least the protected bash tool (`piHarness.ts`), so there is no AGY wake
 * for which this is unnecessary and no conditional worth forking behavior over.
 *
 * SECURITY: the flag also auto-approves AGY's own ~50 built-in tools —
 * `run_command`, `write_to_file`, the browser tools — none of which Daimon
 * mediates. Inside the container that is the exposure Codex already has
 * (`--sandbox danger-full-access`), but unlike Grok there is no kernel-enforced
 * per-agent profile confining it to this agent's own workspace and runtime
 * home. `DAIMON_AGY_SANDBOX=1` opts into AGY's own terminal-restricting
 * sandbox; it is off by default only because its interaction with the MCP
 * transport could not be verified without spending the operator's subscription
 * quota, and shipping an unverified default that silently disables every tool
 * would be worse than shipping the exposure with this note on it.
 */
export const renderAgyArgs = (
  options: Pick<CliEngineOptions, "commandArgs" | "timeoutMs">,
  prompt: string,
  sandbox: boolean = process.env.DAIMON_AGY_SANDBOX === "1"
): string[] => [
  ...assertSafeAgyCommandArgs(options.commandArgs),
  "--print", prompt,
  "--output-format", "stream-json",
  "--dangerously-skip-permissions",
  ...(sandbox ? ["--sandbox"] : []),
  ...(options.timeoutMs === undefined ? [] : ["--print-timeout", `${options.timeoutMs}ms`])
];

export const spawnEngine = (
  options: CliEngineOptions,
  prompt: string,
  input: CliSessionInput,
  endpoint: string | undefined,
  wakeId?: string
): ChildProcess => {
  const command = options.command ?? options.engine;
  const env = cliChildEnvironment([
    ...(options.redactedEnvironmentNames ?? []),
    ...(input.daimonSecretEnvironmentNames ?? [])
  ], input.runtimeHomePath, {
    dbusSessionBusAddress: options.engine === "agy" ? options.dbusSessionBusAddress : undefined,
    engine: options.engine,
    executablePath: options.command,
    engineHomePath: options.engineHomePath,
    wakeId
  });
  if (options.engine === "codex") {
    const child = trackCliChild(spawn(command, renderCodexArgs(options, input.cwd, endpoint), { cwd: input.cwd, env, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] }));
    child.stdin!.on("error", () => undefined);
    child.stdin!.write(prompt); child.stdin!.end();
    return child;
  }
  // Production supplies a Daimon-owned custom profile whose enforcement and
  // explicit realm/peer denies are verified before every Grok process.
  const args = options.engine === "grok"
    ? [...renderGrokSandboxArgs(options.commandArgs, options.grokSandboxProfile ?? GROK_STRICT_SANDBOX_PROFILE), "--always-approve", "--no-subagents", "--single", prompt, "--no-memory", "--disable-web-search", "--cwd", input.cwd,
      "--output-format", "streaming-messages-json"]
    : renderAgyArgs(options, prompt);
  return trackCliChild(spawn(command, args, { cwd: input.cwd, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] }));
};

/**
 * AGY's output format, permission mode, sandbox, and session continuity are
 * Daimon-owned, exactly as Grok's sandbox and approval flags are. A caller
 * cannot re-open the permission boundary, silence the metering stream, or turn
 * a per-wake cold process into a resumed conversation through `commandArgs`.
 */
const assertSafeAgyCommandArgs = (args: readonly string[] | undefined): readonly string[] => {
  const values = args ?? [];
  if (values.some((value) => /^(?:--dangerously-skip-permissions|--sandbox|--output-format|--print|--prompt|--prompt-interactive|--mode|--continue|--conversation|-p|-i|-c)(?:=|$)/u.test(value))) {
    throw new Error("AGY security-boundary arguments are Daimon-owned");
  }
  return values;
};

/** Caller arguments cannot reopen Codex's sandbox, output, cwd, or config boundary. */
const assertSafeCodexCommandArgs = (args: readonly string[] | undefined): readonly string[] => {
  const values = args ?? [];
  if (values.some((value) => /^(?:--json|--sandbox|--dangerously-bypass-approvals-and-sandbox|--output-last-message|--config|--skip-git-repo-check|--color|--cd|-c|-C)(?:=|$)/u.test(value))) {
    throw new Error("Codex security-boundary arguments are Daimon-owned");
  }
  return values;
};

const assertSafeGrokCommandArgs = (args: readonly string[] | undefined): readonly string[] => {
  const values = args ?? [];
  if (values.some((value) => /^(?:--sandbox|--always-approve|--permission-mode|--leader-socket)(?:=|$)/u.test(value))) {
    throw new Error("Grok security-boundary arguments are Daimon-owned");
  }
  return values;
};

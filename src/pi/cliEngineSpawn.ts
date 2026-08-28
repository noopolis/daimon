import { spawn, type ChildProcess } from "node:child_process";

import { trackCliChild } from "./cliProcess.js";
import { cliChildEnvironment } from "./cliEnvironment.js";
import type { CliEngineOptions, CliSessionInput } from "./cliSession.js";

export const GROK_STRICT_SANDBOX_PROFILE = "strict";

export const renderGrokSandboxArgs = (
  commandArgs: readonly string[] | undefined,
  profile: string
): string[] => [...assertSafeGrokCommandArgs(commandArgs), "--sandbox", profile];

export const renderCodexArgs = (
  options: Pick<CliEngineOptions, "commandArgs">,
  cwd: string,
  endpoint: string | undefined,
  sandbox: string = process.env.DAIMON_CODEX_SANDBOX ?? "danger-full-access"
): string[] => [...(options.commandArgs ?? []), "exec", "--sandbox", sandbox, "--skip-git-repo-check", "--color", "never", "-C", cwd,
  "-c", `mcp_servers.daimon.url=${endpoint}`, "-"];

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
    : [...(options.commandArgs ?? []), "--print", prompt, ...(options.timeoutMs === undefined ? [] : ["--print-timeout", `${options.timeoutMs}ms`])];
  return trackCliChild(spawn(command, args, { cwd: input.cwd, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] }));
};

const assertSafeGrokCommandArgs = (args: readonly string[] | undefined): readonly string[] => {
  const values = args ?? [];
  if (values.some((value) => /^(?:--sandbox|--always-approve|--permission-mode|--leader-socket)(?:=|$)/u.test(value))) {
    throw new Error("Grok security-boundary arguments are Daimon-owned");
  }
  return values;
};

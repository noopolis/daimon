import { spawn, type ChildProcess } from "node:child_process";

import { trackCliChild } from "./cliProcess.js";
import { cliChildEnvironment } from "./cliEnvironment.js";
import type { CliEngineOptions, CliSessionInput } from "./cliSession.js";

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
  endpoint: string | undefined
): ChildProcess => {
  const command = options.command ?? options.engine;
  const env = cliChildEnvironment([
    ...(options.redactedEnvironmentNames ?? []),
    ...(input.daimonSecretEnvironmentNames ?? [])
  ], input.runtimeHomePath, {
    dbusSessionBusAddress: options.engine === "agy" ? options.dbusSessionBusAddress : undefined,
    engine: options.engine,
    executablePath: options.command,
    engineHomePath: options.engineHomePath
  });
  if (options.engine === "codex") {
    const child = trackCliChild(spawn(command, renderCodexArgs(options, input.cwd, endpoint), { cwd: input.cwd, env, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] }));
    child.stdin!.on("error", () => undefined);
    child.stdin!.write(prompt); child.stdin!.end();
    return child;
  }
  const args = options.engine === "grok"
    ? [...(options.commandArgs ?? []), "--single", prompt, "--max-turns", String(options.maxToolTurns), "--no-memory", "--disable-web-search", "--cwd", input.cwd, "--output-format", "plain"]
    : [...(options.commandArgs ?? []), "--print", prompt, "--print-timeout", `${options.timeoutMs}ms`];
  return trackCliChild(spawn(command, args, { cwd: input.cwd, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] }));
};

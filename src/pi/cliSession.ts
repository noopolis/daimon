import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { createPiToolMcpServer } from "../mcp/toolServer.js";
import type { PiSessionLike } from "./piAgentHandle.js";
import type { PiSessionFactoryInput } from "./piHarness.js";
import { redactTraceText } from "./turnTrace.js";

export type CliEngineKind = "agy" | "codex" | "grok";

export type CliEngineOptions = {
  readonly commandArgs?: readonly string[];
  readonly command?: string;
  readonly maxToolTurns: number;
  readonly onToolsMounted?: (tools: readonly ToolDefinition[]) => void;
  readonly timeoutMs: number;
  readonly redactedEnvironmentNames?: readonly string[];
} & ({
  readonly engine: "codex" | "grok";
} | {
  /** AGY has no MCP client. Selecting this state explicitly permits tool-free participation. */
  readonly engine: "agy";
  readonly toolAccess: "none";
});

type SessionInput = {
  readonly cwd: string;
  readonly customTools?: ToolDefinition[];
  readonly daimonSecretEnvironmentNames?: readonly string[];
};

type SessionEvent = Parameters<PiSessionLike["subscribe"]>[0] extends (event: infer Event) => void ? Event : never;
type CliListener = Parameters<PiSessionLike["subscribe"]>[0];
type CliTurnEnd = Extract<SessionEvent, { type: "turn_end" }>;

const childEnvironment = (redactedNames: readonly string[]): NodeJS.ProcessEnv => {
  const redacted = new Set(redactedNames);
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !redacted.has(name)));
};

const childSecretValues = (redactedNames: readonly string[]): readonly string[] =>
  redactedNames
    .map((name) => process.env[name])
    .filter((value): value is string => typeof value === "string" && value.length > 0);

const redactChildOutput = (value: string, secretValues: readonly string[]): string => {
  let redacted = redactTraceText(value);
  for (const secret of secretValues) redacted = redacted.split(secret).join("[REDACTED]");
  return redacted;
};

const childDiagnostic = (stdout: string, stderr: string, secretValues: readonly string[]): string => {
  const output = stderr.trim().length > 0 ? stderr : stdout;
  const redacted = redactChildOutput(output, secretValues).trim();
  return redacted.length > 0 ? `: ${redacted}` : "";
};

const terminate = (child: ChildProcess): void => {
  if (!child.killed) child.kill("SIGTERM");
};

export const readChild = (child: ChildProcess, timeoutMs: number, secretValues: readonly string[]): Promise<string> => new Promise((resolve, reject) => {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  const timer = setTimeout(() => {
    terminate(child);
    reject(new Error("CLI engine timed out"));
  }, timeoutMs);
  child.once("error", (error) => {
    clearTimeout(timer);
    reject(error);
  });
  child.once("close", (code, signal) => {
    clearTimeout(timer);
    if (code === 0) {
      resolve(Buffer.concat(stdout).toString("utf8").trim());
    } else {
      reject(new Error(`CLI engine exited ${code ?? signal}${childDiagnostic(
        Buffer.concat(stdout).toString("utf8"),
        Buffer.concat(stderr).toString("utf8"),
        secretValues
      )}`));
    }
  });
});

const startMcp = async (
  tools: ToolDefinition[],
  maxToolTurns: number,
  wakeDeadline: number,
  onToolsMounted?: (tools: readonly ToolDefinition[]) => void
): Promise<{ endpoint: string; close: () => Promise<void> }> => {
  onToolsMounted?.(tools);
  const mcpServer = createPiToolMcpServer(tools, { maxToolTurns, wakeDeadline });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  await mcpServer.connect(transport);
  const httpServer: Server = createServer((request, response) => {
    void transport.handleRequest(request, response);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(0, "127.0.0.1", () => resolve());
    });
  } catch (error) {
    await transport.close().catch(() => undefined);
    await mcpServer.close().catch(() => undefined);
    throw error;
  }
  const address = httpServer.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await transport.close();
    await mcpServer.close();
    throw new Error("MCP server did not receive an ephemeral port");
  }
  const close = async (): Promise<void> => {
    await transport.close().catch(() => undefined);
    await mcpServer.close().catch(() => undefined);
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  };
  return { endpoint: `http://127.0.0.1:${address.port}/mcp`, close };
};

const addGrokServer = async (endpoint: string, cwd: string, env: NodeJS.ProcessEnv, command: string, commandArgs: readonly string[], secretValues: readonly string[]): Promise<void> => {
  const child = spawn(command, [...commandArgs, "mcp", "add", "--transport", "http", "--scope", "project", "daimon", endpoint], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  await readChild(child, 30_000, secretValues);
};

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
  input: SessionInput,
  endpoint: string | undefined
): ChildProcess => {
  const command: string = options.command ?? options.engine;
  const env = childEnvironment([
    ...(options.redactedEnvironmentNames ?? []),
    ...(input.daimonSecretEnvironmentNames ?? [])
  ]);
  if (options.engine === "codex") {
    const args = renderCodexArgs(options, input.cwd, endpoint);
    const child = spawn(command, args, { cwd: input.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.on("error", () => undefined);
    child.stdin.write(prompt);
    child.stdin.end();
    return child;
  }
  if (options.engine === "grok") {
    return spawn(command, [...(options.commandArgs ?? []), "--single", prompt, "--max-turns", String(options.maxToolTurns), "--no-memory",
      "--disable-web-search", "--cwd", input.cwd, "--output-format", "plain"], {
      cwd: input.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
  }
  return spawn(command, [...(options.commandArgs ?? []), "--print", prompt, "--print-timeout", `${options.timeoutMs}ms`], {
    cwd: input.cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
};

class CliSession implements PiSessionLike {
  private readonly listeners = new Set<CliListener>();
  private disposed = false;

  public constructor(
    private readonly options: CliEngineOptions,
    private readonly input: SessionInput
  ) {}

  public subscribe(listener: CliListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async prompt(text: string): Promise<void> {
    if (this.disposed) throw new Error("CLI session is disposed");
    const deadline = Date.now() + this.options.timeoutMs;
    const secretValues = childSecretValues([
      ...(this.options.redactedEnvironmentNames ?? []),
      ...(this.input.daimonSecretEnvironmentNames ?? [])
    ]);
    const needsMcp = this.options.engine !== "agy";
    const mount = needsMcp
      ? await startMcp(this.input.customTools ?? [], this.options.maxToolTurns, deadline, this.options.onToolsMounted)
      : undefined;
    let child: ChildProcess | undefined;
    try {
      if (this.options.engine === "grok" && mount !== undefined) {
        await addGrokServer(mount.endpoint, this.input.cwd, childEnvironment([
          ...(this.options.redactedEnvironmentNames ?? []),
          ...(this.input.daimonSecretEnvironmentNames ?? [])
        ]), this.options.command ?? "grok", this.options.commandArgs ?? [], secretValues);
      }
      child = spawnEngine(this.options, text, this.input, mount?.endpoint);
      const output = await readChild(child, Math.max(1, deadline - Date.now()), secretValues);
      for (const listener of this.listeners) listener({
        type: "turn_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: output }],
          api: "openai-completions",
          provider: "openai",
          model: "cli",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
          },
          stopReason: "stop",
          timestamp: Date.now()
        },
        toolResults: []
      } satisfies CliTurnEnd);
    } finally {
      if (child !== undefined) terminate(child);
      await mount?.close();
    }
  }

  public dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }
}

export const createCliSessionFactory = (options: CliEngineOptions) => async (
  input: PiSessionFactoryInput
): Promise<{ session: PiSessionLike }> => {
  if (input.cwd === undefined) throw new Error("CLI session cwd is required");
  return {
    session: new CliSession(options, {
      cwd: input.cwd,
      customTools: input.customTools,
      daimonSecretEnvironmentNames: input.daimonSecretEnvironmentNames
    })
  };
};

export interface EngineRunResult {
  readonly durationMs: number;
  readonly outputChars: number;
  readonly promptChars: number;
  readonly text: string;
}

export const runEngineDetailed = async (
  engine: CliEngineKind,
  prompt: string,
  paths: { readonly workspacePath: string; readonly runtimeHomePath?: string }
): Promise<EngineRunResult> => {
  const startedAt = Date.now();
  const options: CliEngineOptions = engine === "agy"
    ? { engine, maxToolTurns: 1, timeoutMs: 180_000, toolAccess: "none" }
    : { engine, maxToolTurns: 2, timeoutMs: 180_000 };
  const session = new CliSession(options, { cwd: paths.workspacePath });
  let text = "";
  const unsubscribe = session.subscribe((event) => {
    if (event.type !== "turn_end") return;
    if (!("content" in event.message)) return;
    text = Array.isArray(event.message.content)
      ? event.message.content.filter((entry) => entry.type === "text").map((entry) => entry.text).join("")
      : event.message.content;
  });
  await session.prompt(prompt);
  unsubscribe();
  session.dispose();
  return { durationMs: Date.now() - startedAt, outputChars: text.length, promptChars: prompt.length, text };
};

export const runEngine = async (
  engine: CliEngineKind,
  prompt: string,
  paths: { readonly workspacePath: string; readonly runtimeHomePath?: string }
): Promise<string> => (await runEngineDetailed(engine, prompt, paths)).text;

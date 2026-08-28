import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { createPiToolMcpServer } from "../mcp/toolServer.js";
import type { WakeEvent } from "../core/types.js";
import { redactCredentialError, redactCredentialText } from "../core/credentialRedaction.js";
import {
  asGrokAuthenticationRejected,
  classifyGrokAuthenticationDiagnostic,
  GrokSubscriptionAuthenticationRejectedError
} from "../runtime/grokAuthenticationError.js";
import { readChild } from "./cliChildOutput.js";
import { cliChildEnvironment } from "./cliEnvironment.js";
import {
  GROK_STRICT_SANDBOX_PROFILE,
  renderCodexArgs,
  renderGrokSandboxArgs,
  spawnEngine
} from "./cliEngineSpawn.js";
import { decodeGrokHeadlessResult } from "./grokHeadlessResult.js";
import { terminateChild, trackCliChild } from "./cliProcess.js";
import type { PiSessionLike } from "./piAgentHandle.js";
import type { PiSessionFactoryInput } from "./piHarness.js";

export type CliEngineKind = "agy" | "codex" | "grok";

export type CliEngineOptions = {
  readonly commandArgs?: readonly string[];
  readonly command?: string;
  /** Internal production authority: rechecked immediately before each child. */
  readonly verifyExecutable?: () => Promise<void>;
  readonly verifyRuntimePaths?: () => Promise<void>;
  readonly engineHomePath?: string;
  readonly maxToolTurns?: number;
  readonly onToolsMounted?: (tools: readonly ToolDefinition[]) => void;
  readonly timeoutMs?: number;
  /** Daimon-owned identity envelope prepended exactly once to every wake. */
  readonly identityPrompt?: string;
  readonly redactedEnvironmentNames?: readonly string[];
  /** Internal secret-file authority used only for exact reply redaction. */
  readonly credentialSecretValues?: () => Promise<readonly string[]>;
  /** Internal production boundary; confirms the custom kernel profile before every Grok process. */
  readonly verifyGrokSandbox?: () => Promise<void>;
  readonly grokSandboxProfile?: string;
  readonly grokBrokerTurn?: (prompt: string, mcpEndpoint: string, signal: AbortSignal) => Promise<string>;
} & ({
  readonly engine: "codex" | "grok";
} | {
  readonly dbusSessionBusAddress?: string;
  /** AGY has no MCP client. Selecting this state explicitly permits tool-free participation. */
  readonly engine: "agy";
  readonly toolAccess: "none";
});

export type CliSessionInput = {
  readonly cwd: string;
  readonly customTools?: ToolDefinition[];
  readonly daimonSecretEnvironmentNames?: readonly string[];
  readonly runtimeHomePath?: string;
};

type SessionEvent = Parameters<PiSessionLike["subscribe"]>[0] extends (event: infer Event) => void ? Event : never;
type CliListener = Parameters<PiSessionLike["subscribe"]>[0];
type CliTurnEnd = Extract<SessionEvent, { type: "turn_end" }>;


export const prepareCliRuntimeHome = async (runtimeHomePath: string | undefined): Promise<void> => {
  if (runtimeHomePath === undefined) return;
  await Promise.all([
    runtimeHomePath,
    `${runtimeHomePath}/.config`,
    `${runtimeHomePath}/.local/share`,
    `${runtimeHomePath}/.local/state`,
    `${runtimeHomePath}/.cache`,
    `${runtimeHomePath}/.tmp`
  ].map((directory) => mkdir(directory, { recursive: true })));
};

const childSecretValues = (redactedNames: readonly string[]): readonly string[] =>
  redactedNames
    .map((name) => process.env[name])
    .filter((value): value is string => typeof value === "string" && value.length > 0);

const captureCleanup = async (current: unknown, action: () => Promise<void>): Promise<unknown> => {
  try { await action(); } catch (error) { return current ?? error; }
  return current;
};

export { terminateChild } from "./cliProcess.js";
export { CLI_ENGINE_MAX_DIAGNOSTIC_BYTES, CLI_ENGINE_MAX_OUTPUT_BYTES, readChild } from "./cliChildOutput.js";

const startMcp = async (
  tools: ToolDefinition[],
  maxToolTurns: number | undefined,
  wakeDeadline: number | undefined,
  onToolsMounted: ((tools: readonly ToolDefinition[]) => void) | undefined,
  onStarted: (mount: { endpoint: string; close: () => Promise<void> }) => void
): Promise<{ endpoint: string; close: () => Promise<void> }> => {
  onToolsMounted?.(tools);
  const mcpServer = createPiToolMcpServer(tools, { maxToolTurns, wakeDeadline });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  const httpServer: Server = createServer((request, response) => {
    void transport.handleRequest(request, response);
  });
  let lifecycle: "starting" | "listening" | "closing" | "closed" = "starting";
  let cancelled = false;
  let endpoint = "";
  let closePromise: Promise<void> | undefined;
  let settleStartup!: () => void;
  const startupSettled = new Promise<void>((resolve) => { settleStartup = resolve; });
  const close = (): Promise<void> => closePromise ??= (async () => {
    cancelled = true;
    if (lifecycle !== "closed") lifecycle = "closing";
    // `listen()` begins synchronously but its callback is pending. Waiting for
    // startup prevents dispose from returning while that callback can still bind.
    await startupSettled;
    await transport.close().catch(() => undefined);
    await mcpServer.close().catch(() => undefined);
    if (httpServer.listening) await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    lifecycle = "closed";
  })();
  const mount = { get endpoint(): string { return endpoint; }, close };
  onStarted(mount);
  let startupError: unknown;
  try {
    if (cancelled) throw new Error("MCP startup was cancelled");
    await mcpServer.connect(transport);
    if (cancelled) throw new Error("MCP startup was cancelled");
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      httpServer.once("error", onError);
      httpServer.listen(0, "127.0.0.1", () => {
        httpServer.off("error", onError);
        // A disposer can run from a Server.prototype.listen interceptor before
        // this callback. Never publish the server as live in that interleaving.
        if (!cancelled) lifecycle = "listening";
        resolve();
      });
    });
    if (cancelled) throw new Error("MCP startup was cancelled");
    const address = httpServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("MCP server did not receive an ephemeral port");
    }
    endpoint = `http://127.0.0.1:${address.port}/mcp`;
    return mount;
  } catch (error) {
    startupError = error;
    throw error;
  } finally {
    settleStartup();
    if (cancelled || startupError !== undefined) await close();
  }
};

type GrokRegistration = { close: () => Promise<void> };

const grokCommand = async (
  args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, command: string, secretValues: readonly string[],
  onChild: (child: ChildProcess) => void, onChildSettled: (child: ChildProcess) => void
): Promise<void> => {
  const child = trackCliChild(spawn(command, args, {
    cwd,
    env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"]
  }));
  onChild(child);
  try {
    await readChild(child, 30_000, secretValues, {
      failureClassifier: classifyGrokAuthenticationDiagnostic
    });
  } finally {
    // The Grok CLI may let an auxiliary process outlive its leader. Do not
    // release the tracked setup child until its detached group is quiescent.
    await terminateChild(child);
    onChildSettled(child);
  }
};

const addGrokServer = async (
  endpoint: string, cwd: string, env: NodeJS.ProcessEnv, command: string, commandArgs: readonly string[], secretValues: readonly string[],
  onChild: (child: ChildProcess) => void, onChildSettled: (child: ChildProcess) => void,
  profile: string, verifySandbox: (() => Promise<void>) | undefined
): Promise<GrokRegistration> => {
  await verifySandbox?.();
  await grokCommand(
    [...renderGrokSandboxArgs(commandArgs, profile), "mcp", "add", "--transport", "http", "--scope", "project", "daimon", endpoint],
    cwd, env, command, secretValues, onChild, onChildSettled
  );
  let closePromise: Promise<void> | undefined;
  return {
    close: (): Promise<void> => closePromise ??= (async () => {
      await verifySandbox?.();
      await grokCommand(
        [...renderGrokSandboxArgs(commandArgs, profile), "mcp", "remove", "--scope", "project", "daimon"],
        cwd, env, command, secretValues, onChild, onChildSettled
      );
    })()
  };
};

class CliSession implements PiSessionLike {
  private readonly listeners = new Set<CliListener>();
  private readonly setupChildren = new Set<ChildProcess>();
  private disposed = false;
  private activeChild: ChildProcess | undefined;
  private activeMount: { close: () => Promise<void> } | undefined;
  private activeBrokerTurn: AbortController | undefined;
  private grokRegistration: GrokRegistration | undefined;
  private disposePromise: Promise<void> | undefined;
  private wakeId: string | undefined;

  public constructor(
    private readonly options: CliEngineOptions,
    private readonly input: CliSessionInput
  ) {}

  public subscribe(listener: CliListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public bindWake(event?: WakeEvent): void {
    this.wakeId = event?.id;
  }

  public async prompt(text: string): Promise<void> {
    if (this.disposed) throw new Error("CLI session is disposed");
    await prepareCliRuntimeHome(this.input.runtimeHomePath);
    const deadline = this.options.timeoutMs === undefined ? undefined : Date.now() + this.options.timeoutMs;
    const environmentSecretValues = childSecretValues([
      ...(this.options.redactedEnvironmentNames ?? []),
      ...(this.input.daimonSecretEnvironmentNames ?? [])
    ]);
    const stagedCredentialSecrets = await this.options.credentialSecretValues?.() ?? [];
    const secretValues = [...environmentSecretValues, ...stagedCredentialSecrets];
    const needsMcp = this.options.engine !== "agy";
    let mount: { endpoint: string; close: () => Promise<void> } | undefined;
    let registration: GrokRegistration | undefined;
    let child: ChildProcess | undefined;
    let output: string | undefined;
    let cleanupFailure: unknown;
    let promptFailure: unknown;
    try {
      mount = needsMcp
        ? await startMcp(this.input.customTools ?? [], this.options.maxToolTurns, deadline, this.options.onToolsMounted, (started) => {
          this.activeMount = started;
          if (this.disposed) void started.close();
        })
        : undefined;
      this.ensureLive();
      if (this.options.engine === "grok" && this.options.grokBrokerTurn !== undefined && mount !== undefined) {
        const controller=new AbortController();this.activeBrokerTurn=controller;
        try{output=await this.options.grokBrokerTurn(`${this.options.identityPrompt ?? ""}${text}`,mount.endpoint,controller.signal);}finally{if(this.activeBrokerTurn===controller)this.activeBrokerTurn=undefined;}
      } else {
      if (this.options.engine === "grok" && mount !== undefined) {
        await this.options.verifyExecutable?.();
        registration = await addGrokServer(mount.endpoint, this.input.cwd, cliChildEnvironment([
          ...(this.options.redactedEnvironmentNames ?? []),
          ...(this.input.daimonSecretEnvironmentNames ?? [])
        ], this.input.runtimeHomePath, { engine: this.options.engine, executablePath: this.options.command, engineHomePath: this.options.engineHomePath }), this.options.command ?? "grok", this.options.commandArgs ?? [], secretValues, (setupChild) => {
          this.setupChildren.add(setupChild);
        }, (setupChild) => this.setupChildren.delete(setupChild),
        this.options.grokSandboxProfile ?? GROK_STRICT_SANDBOX_PROFILE,
        this.options.verifyGrokSandbox);
        this.grokRegistration = registration;
      }
      this.ensureLive();
      await this.options.verifyRuntimePaths?.();
      await this.options.verifyExecutable?.();
      await this.options.verifyGrokSandbox?.();
      child = spawnEngine(this.options, `${this.options.identityPrompt ?? ""}${text}`, this.input, mount?.endpoint, this.wakeId);
      this.activeChild = child;
      // Attach terminal listeners synchronously. A fast local sentinel may
      // exit before an asynchronous post-spawn authority recheck completes.
      const outputPromise = readChild(child, deadline === undefined ? undefined : Math.max(1, deadline - Date.now()), secretValues, {
        failureClassifier: this.options.engine === "grok" ? classifyGrokAuthenticationDiagnostic : undefined,
        retainStdoutTail: this.options.engine === "grok"
      });
      await this.options.verifyRuntimePaths?.();
      await this.options.verifyExecutable?.();
      const childOutput = await outputPromise;
      output = this.options.engine === "grok" ? decodeGrokHeadlessResult(childOutput) : childOutput;
      }
    } catch (error) {
      promptFailure = error;
    } finally {
      cleanupFailure = await captureCleanup(cleanupFailure, async () => { if (child !== undefined) await terminateChild(child); });
      if (this.activeChild === child) this.activeChild = undefined;
      let registrationClosed = registration === undefined;
      cleanupFailure = await captureCleanup(cleanupFailure, async () => { await registration?.close(); registrationClosed = true; });
      if (registrationClosed && this.grokRegistration === registration) this.grokRegistration = undefined;
      cleanupFailure = await captureCleanup(cleanupFailure, async () => { await mount?.close(); });
      if (this.activeMount === mount) this.activeMount = undefined;
    }
    const refreshedCredentialSecrets = await this.options.credentialSecretValues?.().catch(() => []) ?? [];
    const finalSecrets = [...secretValues, ...refreshedCredentialSecrets];
    if (promptFailure !== undefined) {
      const authRejection = this.options.engine === "grok" ? asGrokAuthenticationRejected(promptFailure) : undefined;
      if (authRejection !== undefined) throw new GrokSubscriptionAuthenticationRejectedError(
        cleanupFailure === undefined ? undefined : redactCredentialError(cleanupFailure, finalSecrets)
      );
      if (cleanupFailure !== undefined) throw redactCredentialError(cleanupFailure, finalSecrets);
      throw redactCredentialError(promptFailure, finalSecrets);
    }
    if (cleanupFailure !== undefined) {
      if (this.options.engine === "grok" && asGrokAuthenticationRejected(cleanupFailure) !== undefined) {
        throw new GrokSubscriptionAuthenticationRejectedError();
      }
      throw redactCredentialError(cleanupFailure, finalSecrets);
    }
    if (output === undefined) return;
    output = redactCredentialText(output, finalSecrets, 64 * 1024);
    for (const listener of this.listeners) listener({
      type: "turn_end",
      message: {
        role: "assistant", content: [{ type: "text", text: output }], api: "openai-completions", provider: "openai", model: "cli",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop", timestamp: Date.now()
      }, toolResults: []
    } satisfies CliTurnEnd);
  }

  public dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    this.disposePromise ??= this.quiesce();
  }

  public async disposeAsync(): Promise<void> {
    this.dispose();
    await this.disposePromise;
  }

  private ensureLive(): void {
    if (this.disposed) throw new Error("CLI session is disposed");
  }

  private async quiesce(): Promise<void> {
    let cleanupFailure: unknown;
    cleanupFailure = await captureCleanup(cleanupFailure, async () => { if (this.activeChild !== undefined) await terminateChild(this.activeChild); });
    this.activeBrokerTurn?.abort();
    cleanupFailure = await captureCleanup(cleanupFailure, () => Promise.all([...this.setupChildren].map((child) => terminateChild(child))).then(() => undefined));
    cleanupFailure = await captureCleanup(cleanupFailure, async () => { await this.grokRegistration?.close(); });
    cleanupFailure = await captureCleanup(cleanupFailure, async () => { await this.activeMount?.close(); });
    if (cleanupFailure !== undefined) throw cleanupFailure;
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
      daimonSecretEnvironmentNames: input.daimonSecretEnvironmentNames,
      runtimeHomePath: input.runtimeHomePath
    })
  };
};

export { runEngine, runEngineDetailed, type EngineRunResult } from "./cliEngineRun.js";
export { renderCodexArgs, spawnEngine } from "./cliEngineSpawn.js";

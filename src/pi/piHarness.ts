import { mkdir } from "node:fs/promises";
import path from "node:path";

import {
  AuthStorage,
  createAgentSession,
  type ModelRegistry,
  SessionManager,
  SettingsManager
} from "@earendil-works/pi-coding-agent";

import type {
  AgentHandle,
  AgentHarnessAdapter,
  AgentStartInput,
  AgentStatus,
  HarnessModelSpec,
  WakeEvent,
  WakeResult
} from "../core/types.js";

import { resolvePiHarnessModel } from "./modelConfig.js";
import { createPiModelRegistry } from "./modelRegistry.js";
import { createPiMemoryTools, piMemoryToolNames, type PiMemoryToolContextRef } from "./memoryTools.js";
import { createResourceLoader, formatWakePrompt } from "./prompts.js";
import {
  createAwakeThreadId,
  createDreamSessionDirectory,
  createDreamSessionKey,
  createDreamThreadId,
  formatDreamPrompt
} from "./wakeModes.js";
import {
  createMemoryRuntime,
  memoryScopeId,
  readMemoryContext,
  type MemoryPrepareTurnResult,
  type MemoryRuntime,
  type MemoryWakeMode
} from "@noopolis/mneme";
import {
  persistPiTurnTrace,
  summarizeSessionEvent,
  type PiMemoryPrepareTraceInput,
  type PiTurnTraceModel,
  type PiTurnTraceToolEvent
} from "./turnTrace.js";

type TextBlock = { type: "text"; text: string };
type HarnessMemoryEmbeddingProvider = {
  dimensions?: number;
  embed(text: string): Promise<number[]>;
};

export interface PiHarnessOptions {
  authPath: string;
  sessionFactory?: PiSessionFactory;
  model?: {
    auth?: HarnessModelSpec["auth"];
    endpoint?: HarnessModelSpec["endpoint"];
    provider: string;
    name: string;
  };
  modelsPath?: string;
  memory?: {
    embeddingProvider?: HarnessMemoryEmbeddingProvider;
    source?: string;
    tokenBudget?: number;
    runtimeHomePath?: string;
  };
}

export type PiSessionFactory = (
  input: Parameters<typeof createAgentSession>[0]
) => ReturnType<typeof createAgentSession>;

type PiSession = Awaited<ReturnType<typeof createAgentSession>>["session"];
type PiSessionCreator = (mode: MemoryWakeMode, sessionDirectory: string) => Promise<PiSession>;
type WakeSessionSelection = { disposeAfterWake: boolean; mode: MemoryWakeMode; session: PiSession; threadId: string };

const extractOutputText = (chunks: string[]): string => chunks.join("\n").trim();

class PiAgentHandle implements AgentHandle {
  private state: AgentStatus["state"] = "idle";
  private lastWakeAt: string | undefined;
  private lastError: string | undefined;
  private wakeQueue: Promise<void> = Promise.resolve();

  constructor(
    readonly id: string,
    private readonly session: PiSession,
    private readonly createSession: PiSessionCreator,
    private readonly runtimeHomePath: string,
    private readonly traceModel: PiTurnTraceModel,
    private readonly memory?: MemoryRuntime,
    private readonly memoryToolContext?: PiMemoryToolContextRef
  ) {}

  async wake(event: WakeEvent): Promise<WakeResult> {
    const queued = this.wakeQueue.then(
      () => this.runWake(event),
      () => this.runWake(event)
    );
    this.wakeQueue = queued.then(
      () => undefined,
      () => undefined
    );
    return queued;
  }

  private async runWake(event: WakeEvent): Promise<WakeResult> {
    const startedAt = new Date();
    const startedAtMs = Date.now();
    const chunks: string[] = [];
    const tools: PiTurnTraceToolEvent[] = [];
    let enginePromptMs: number | undefined;
    let memoryPrepare: PiMemoryPrepareTraceInput | undefined;
    let selectedSession: WakeSessionSelection | undefined;
    let unsubscribe: (() => void) | undefined;
    let stage = "select_session";
    this.state = "running";
    this.lastWakeAt = new Date().toISOString();
    this.lastError = undefined;

    const memoryContext = readMemoryContext({
      kind: event.kind,
      id: event.id,
      from: event.from,
      text: event.text,
      context: event.context
    });
    const request = {
      eventId: event.id,
      kind: event.kind,
      text: event.text,
      from: event.from,
      context: memoryContext
    };

    let prepared: MemoryPrepareTurnResult | undefined;
    let promptText = formatWakePrompt(event);

    try {
      selectedSession = await this.selectSessionForWake(event, memoryContext);
      unsubscribe = selectedSession.session.subscribe((piEvent) => {
        const toolEvent = summarizeSessionEvent(piEvent);
        if (toolEvent) {
          tools.push(toolEvent);
        }
        if (piEvent.type !== "turn_end") {
          return;
        }

        const message = piEvent.message as { content?: unknown };
        const content = message.content;
        if (typeof content === "string") {
          chunks.push(content);
        } else if (Array.isArray(content)) {
          chunks.push(
            content
              .filter((item): item is TextBlock => {
                const candidate = item as Partial<TextBlock>;
                return candidate.type === "text" && typeof candidate.text === "string";
              })
              .map((item) => item.text)
              .join("")
          );
        }
      });

      if (this.memory) {
        stage = "memory_prepare";
        const memoryStartedAt = Date.now();
        try {
          prepared = await this.memory.prepareTurn(request);
        } catch (error) {
          memoryPrepare = {
            durationMs: Date.now() - memoryStartedAt,
            status: "failed"
          };
          throw error;
        }
        memoryPrepare = {
          durationMs: Date.now() - memoryStartedAt,
          prepared,
          status: "completed"
        };
        promptText = prepared.promptText;
        if (this.memoryToolContext) {
          this.memoryToolContext.observeTool = (toolEvent) => tools.push(toolEvent);
          this.memoryToolContext.current = {
            mode: selectedSession.mode,
            wakeId: event.id,
            threadId: selectedSession.threadId,
            principal: prepared.principal,
            conversationScope: memoryScopeId(prepared.principal),
            audienceKey: memoryContext.roomId ?? event.from ?? this.id,
            transport: "in_process"
          };
        }
      }

      if (selectedSession.mode === "dream") {
        promptText = formatDreamPrompt(promptText, selectedSession.threadId);
      }

      stage = "engine_prompt";
      const engineStartedAt = Date.now();
      await selectedSession.session.prompt(promptText, { expandPromptTemplates: false });
      enginePromptMs = Date.now() - engineStartedAt;
      this.state = "idle";
      const outputText = extractOutputText(chunks);
      await persistPiTurnTrace({
        agentId: this.id,
        enginePromptMs,
        event,
        memoryPrepare,
        memoryEnabled: Boolean(this.memory),
        model: this.traceModel,
        outputText,
        promptText,
        runtimeHomePath: this.runtimeHomePath,
        session: selectedSession,
        startedAt,
        status: "completed",
        tools,
        totalMs: Date.now() - startedAtMs
      });

      return {
        agentId: this.id,
        text: outputText,
        durationMs: Date.now() - startedAtMs
      };
    } catch (error) {
      this.state = "failed";
      this.lastError = error instanceof Error ? error.message : String(error);
      if (this.memory && !memoryPrepare) {
        memoryPrepare = {
          prepared,
          status: "failed"
        };
      }
      await persistPiTurnTrace({
        agentId: this.id,
        enginePromptMs,
        error: {
          message: this.lastError,
          stage
        },
        event,
        memoryPrepare,
        memoryEnabled: Boolean(this.memory),
        model: this.traceModel,
        outputText: extractOutputText(chunks),
        promptText,
        runtimeHomePath: this.runtimeHomePath,
        session: selectedSession,
        startedAt,
        status: "failed",
        tools,
        totalMs: Date.now() - startedAtMs
      });

      throw error;
    } finally {
      if (this.memoryToolContext) {
        this.memoryToolContext.current = undefined;
        this.memoryToolContext.observeTool = undefined;
      }
      unsubscribe?.();
      if (selectedSession?.disposeAfterWake) {
        selectedSession.session.dispose();
      }
    }
  }

  private async selectSessionForWake(
    event: WakeEvent,
    memoryContext: ReturnType<typeof readMemoryContext>
  ): Promise<WakeSessionSelection> {
    if (event.kind !== "dream") {
      return {
        disposeAfterWake: false,
        mode: "awake",
        session: this.session,
        threadId: createAwakeThreadId(memoryContext, this.id)
      };
    }

    const sessionKey = createDreamSessionKey(event);
    return {
      disposeAfterWake: true,
      mode: "dream",
      session: await this.createSession("dream", createDreamSessionDirectory(this.runtimeHomePath, sessionKey)),
      threadId: createDreamThreadId(sessionKey)
    };
  }

  status(): AgentStatus {
    return {
      agentId: this.id,
      state: this.state,
      lastWakeAt: this.lastWakeAt,
      lastError: this.lastError
    };
  }

  async stop(): Promise<void> {
    this.session.dispose();
    this.state = "stopped";
  }
}

export class PiHarnessAdapter implements AgentHarnessAdapter {
  private readonly authStorage: AuthStorage;
  private readonly modelRegistry: ModelRegistry;
  private readonly sessionFactory: PiSessionFactory;

  constructor(private readonly options: PiHarnessOptions) {
    this.authStorage = AuthStorage.create(options.authPath);
    this.modelRegistry = createPiModelRegistry(this.authStorage, options);
    this.sessionFactory = options.sessionFactory ?? createAgentSession;
  }

  async startAgent(input: AgentStartInput): Promise<AgentHandle> {
    await mkdir(input.runtimeHomePath, { recursive: true });
    await mkdir(input.workspacePath, { recursive: true });
    const memoryRuntimeHomePath = this.options.memory?.runtimeHomePath ?? input.runtimeHomePath;
    await mkdir(memoryRuntimeHomePath, { recursive: true });
    const modelSpec = this.options.model ?? {
      auth: { method: "codex" as const },
      provider: "openai",
      name: "gpt-5.4-mini"
    };
    const resolvedModel = resolvePiHarnessModel(modelSpec).model;
    const model = this.modelRegistry.find(resolvedModel.provider, resolvedModel.name);
    if (!model) {
      throw new Error(`Pi model not found: ${resolvedModel.provider}/${resolvedModel.name}`);
    }
    const memoryOptions = {
      agentId: input.id,
      embeddingProvider: this.options.memory?.embeddingProvider,
      runtimeHomePath: memoryRuntimeHomePath,
      source: this.options.memory?.source,
      tokenBudget: this.options.memory?.tokenBudget
    } as Parameters<typeof createMemoryRuntime>[0] & {
      embeddingProvider?: HarnessMemoryEmbeddingProvider;
    };
    const memory = createMemoryRuntime(memoryOptions);
    const memoryToolContext: PiMemoryToolContextRef = {};
    const createSession: PiSessionCreator = async (mode, sessionDirectory) => {
      const memoryTools = createPiMemoryTools({
        agentId: input.id,
        memory,
        contextRef: memoryToolContext,
        mode
      });
      const toolNames = [
        ...(input.tools ?? ["read", "write", "edit", "bash", "grep", "find", "ls"]),
        ...piMemoryToolNames(memoryTools)
      ];

      const { session } = await this.sessionFactory({
        cwd: input.workspacePath,
        agentDir: input.runtimeHomePath,
        authStorage: this.authStorage,
        modelRegistry: this.modelRegistry,
        model,
        thinkingLevel: "off",
        resourceLoader: createResourceLoader(input, mode),
        tools: [...new Set(toolNames)],
        customTools: memoryTools,
        sessionManager: SessionManager.create(input.workspacePath, sessionDirectory),
        settingsManager: SettingsManager.inMemory({
          compaction: { enabled: false },
          retry: { enabled: true, maxRetries: 1 }
        })
      });
      return session;
    };

    const session = await createSession("awake", path.join(input.runtimeHomePath, "sessions"));

    return new PiAgentHandle(
      input.id,
      session,
      createSession,
      input.runtimeHomePath,
      {
        authMethod: modelSpec.auth?.method ?? "none",
        model: resolvedModel.name,
        provider: resolvedModel.provider
      },
      memory,
      memoryToolContext
    );
  }
}

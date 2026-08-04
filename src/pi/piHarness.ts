import { mkdir } from "node:fs/promises";
import path from "node:path";

import {
  AuthStorage,
  createAgentSession,
  type ModelRegistry,
  SessionManager,
  SettingsManager
} from "@earendil-works/pi-coding-agent";
import { createMemoryRuntime, type MemoryAuthorityConfig } from "@noopolis/mneme";

import type { AgentHandle, AgentHarnessAdapter, AgentStartInput, HarnessModelSpec } from "../core/types.js";

import { resolvePiHarnessModel } from "./modelConfig.js";
import { createPiModelRegistry } from "./modelRegistry.js";
import { createPiMemoryTools, piMemoryToolNames, type PiMemoryToolContextRef } from "./memoryTools.js";
import { createResourceLoader } from "./prompts.js";
import { PiAgentHandle, type PiNativeSessionCreator, type PiSessionCreator, type PiSessionLike } from "./piAgentHandle.js";
import { createPiWorldTools, piWorldToolNames, type PiWorldBinding } from "./worldTools.js";
import type { PiWorldToolContextRef } from "./worldNudge.js";
import {
  bindPiRawTrainingCapture,
  validatePiRawTrainingCaptureOptions,
  type PiRawTrainingCaptureOptions,
  type PiRawTrainingCaptureRef
} from "./rawTrainingCapture.js";

type HarnessMemoryEmbeddingProvider = {
  dimensions?: number;
  embed(text: string): Promise<number[]>;
};

export type PiThinkingLevel = NonNullable<
  NonNullable<Parameters<typeof createAgentSession>[0]>["thinkingLevel"]
>;

type PiHarnessBaseOptions = {
  authPath: string;
  model?: {
    auth?: HarnessModelSpec["auth"];
    endpoint?: HarnessModelSpec["endpoint"];
    provider: string;
    name: string;
  };
  modelsPath?: string;
  memory?: {
    authority?: MemoryAuthorityConfig;
    embeddingProvider?: HarnessMemoryEmbeddingProvider;
    source?: string;
    tokenBudget?: number;
    runtimeHomePath?: string;
  };
  thinkingLevel?: PiThinkingLevel;
  world?: PiWorldBinding;
};

export type PiHarnessOptions = PiHarnessBaseOptions & (
  | {
    rawTrainingCapture?: PiRawTrainingCaptureOptions;
    sessionFactory?: never;
  }
  | {
    rawTrainingCapture?: never;
    sessionFactory: PiSessionFactory;
  }
);

export type PiSessionFactory = (
  input: Parameters<typeof createAgentSession>[0]
) => Promise<{ session: PiSessionLike }>;

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
    validatePiRawTrainingCaptureOptions(this.options.rawTrainingCapture);
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
    const memory = this.options.memory === undefined
      ? undefined
      : createMemoryRuntime({
        agentId: input.id,
        authority: this.options.memory.authority,
        embeddingProvider: this.options.memory.embeddingProvider,
        runtimeHomePath: memoryRuntimeHomePath,
        source: this.options.memory.source,
        tokenBudget: this.options.memory.tokenBudget
      } as Parameters<typeof createMemoryRuntime>[0] & {
        embeddingProvider?: HarnessMemoryEmbeddingProvider;
      });
    const memoryToolContext: PiMemoryToolContextRef | undefined =
      memory === undefined ? undefined : {};
    const worldToolContext: PiWorldToolContextRef | undefined =
      this.options.world === undefined ? undefined : {};
    const rawTrainingCaptureRef: PiRawTrainingCaptureRef | undefined =
      this.options.rawTrainingCapture === undefined ? undefined : {};
    const sessionInput = (mode: Parameters<PiSessionCreator>[0], sessionDirectory: string) => {
      const memoryTools = memory === undefined || memoryToolContext === undefined
        ? []
        : createPiMemoryTools({
          agentId: input.id,
          memory,
          contextRef: memoryToolContext,
          mode
        });
      const worldTools = this.options.world === undefined
        ? undefined
        : createPiWorldTools({
          world: this.options.world,
          contextRef: worldToolContext
        });
      const toolNames = [
        ...(input.tools ?? ["read", "write", "edit", "bash", "grep", "find", "ls"]),
        ...piMemoryToolNames(memoryTools),
        ...(worldTools === undefined ? [] : piWorldToolNames(worldTools))
      ];

      return {
        cwd: input.workspacePath,
        agentDir: input.runtimeHomePath,
        authStorage: this.authStorage,
        modelRegistry: this.modelRegistry,
        model,
        thinkingLevel: this.options.thinkingLevel ?? "off",
        resourceLoader: createResourceLoader(input, mode, {
          memory: memory !== undefined,
          world: worldTools !== undefined
        }),
        tools: [...new Set(toolNames)],
        customTools: worldTools === undefined ? memoryTools : [...memoryTools, ...worldTools],
        sessionManager: SessionManager.create(input.workspacePath, sessionDirectory),
        settingsManager: SettingsManager.inMemory({
          compaction: { enabled: false },
          retry: { enabled: true, maxRetries: 1 }
        })
      };
    };

    if (this.options.rawTrainingCapture !== undefined) {
      const createSession: PiNativeSessionCreator = async (mode, sessionDirectory) => {
        const { session } = await createAgentSession(sessionInput(mode, sessionDirectory));
        if (rawTrainingCaptureRef !== undefined) {
          bindPiRawTrainingCapture(session, rawTrainingCaptureRef);
        }
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
        memoryToolContext,
        {},
        worldToolContext,
        rawTrainingCaptureRef,
        this.options.rawTrainingCapture,
        worldToolContext === undefined
          ? undefined
          : { instructions: input.instructions, thinkingLevel: this.options.thinkingLevel ?? "off" },
        session
      );
    }

    const createSession: PiSessionCreator = async (mode, sessionDirectory) => {
      const { session } = await (this.options.sessionFactory ?? createAgentSession)(sessionInput(mode, sessionDirectory));
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
      memoryToolContext,
      {},
      worldToolContext,
      undefined,
      undefined,
      worldToolContext === undefined
        ? undefined
        : {
          instructions: input.instructions,
          thinkingLevel: this.options.thinkingLevel ?? "off"
        },
      undefined
    );
  }
}

import { mkdir } from "node:fs/promises";
import path from "node:path";

import {
  AuthStorage,
  createAgentSession,
  type ModelRegistry,
  SessionManager,
  SettingsManager
} from "@earendil-works/pi-coding-agent";
import { createMemoryRuntime } from "@noopolis/mneme";

import type { AgentHandle, AgentHarnessAdapter, AgentStartInput, HarnessModelSpec } from "../core/types.js";

import { resolvePiHarnessModel } from "./modelConfig.js";
import { createPiModelRegistry } from "./modelRegistry.js";
import { createPiMemoryTools, piMemoryToolNames, type PiMemoryToolContextRef } from "./memoryTools.js";
import { createResourceLoader } from "./prompts.js";
import { PiAgentHandle, type PiSessionCreator } from "./piAgentHandle.js";
import { createPiWorldTools, piWorldToolNames, type PiWorldBinding } from "./worldTools.js";

type HarnessMemoryEmbeddingProvider = {
  dimensions?: number;
  embed(text: string): Promise<number[]>;
};

export type PiThinkingLevel = NonNullable<
  NonNullable<Parameters<typeof createAgentSession>[0]>["thinkingLevel"]
>;

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
  thinkingLevel?: PiThinkingLevel;
  world?: PiWorldBinding;
}

export type PiSessionFactory = (
  input: Parameters<typeof createAgentSession>[0]
) => ReturnType<typeof createAgentSession>;

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
    const memory = this.options.memory === undefined
      ? undefined
      : createMemoryRuntime({
        agentId: input.id,
        embeddingProvider: this.options.memory.embeddingProvider,
        runtimeHomePath: memoryRuntimeHomePath,
        source: this.options.memory.source,
        tokenBudget: this.options.memory.tokenBudget
      } as Parameters<typeof createMemoryRuntime>[0] & {
        embeddingProvider?: HarnessMemoryEmbeddingProvider;
      });
    const memoryToolContext: PiMemoryToolContextRef | undefined =
      memory === undefined ? undefined : {};
    const createSession: PiSessionCreator = async (mode, sessionDirectory) => {
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
        : createPiWorldTools({ world: this.options.world });
      const toolNames = [
        ...(input.tools ?? ["read", "write", "edit", "bash", "grep", "find", "ls"]),
        ...piMemoryToolNames(memoryTools),
        ...(worldTools === undefined ? [] : piWorldToolNames(worldTools))
      ];

      const { session } = await this.sessionFactory({
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

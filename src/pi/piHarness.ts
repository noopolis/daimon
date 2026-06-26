import { mkdir } from "node:fs/promises";
import path from "node:path";

import {
  AuthStorage,
  createAgentSession,
  createExtensionRuntime,
  ModelRegistry,
  type ResourceLoader,
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
import { createMemoryRuntime } from "../memory/runtime.js";
import type {
  MemoryPacket,
  MemoryPrepareTurnResult,
  MemoryRuntime
} from "../memory/types.js";
import { readMemoryContext } from "../memory/scope.js";

type TextBlock = { type: "text"; text: string };

export interface PiHarnessOptions {
  authPath: string;
  model?: {
    auth?: HarnessModelSpec["auth"];
    endpoint?: HarnessModelSpec["endpoint"];
    provider: string;
    name: string;
  };
  modelsPath?: string;
  memory?: {
    source?: string;
    tokenBudget?: number;
  };
}

const createModelRegistry = (
  authStorage: AuthStorage,
  options: PiHarnessOptions
): ModelRegistry => {
  const registry = options.modelsPath
    ? ModelRegistry.create(authStorage, options.modelsPath)
    : ModelRegistry.inMemory(authStorage);

  if (!options.modelsPath && options.model?.endpoint) {
    const { modelsConfig } = resolvePiHarnessModel(options.model);
    for (const [provider, config] of Object.entries(modelsConfig.providers)) {
      registry.registerProvider(provider, {
        api: config.api,
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        models: config.models
      });
    }
  }

  return registry;
};

const fallbackPacket = (input: WakeEvent): MemoryPacket => ({
  principal: {
    agentId: "unknown",
    scope: "global"
  },
  sections: [{ heading: "Wake event", text: formatWakePrompt(input) }],
  rawHint: "memory bypass active"
});

const extractOutputText = (chunks: string[]): string => chunks.join("\n").trim();

class PiAgentHandle implements AgentHandle {
  private state: AgentStatus["state"] = "idle";
  private lastWakeAt: string | undefined;
  private lastError: string | undefined;

  constructor(
    readonly id: string,
    private readonly session: Awaited<ReturnType<typeof createAgentSession>>["session"],
    private readonly memory?: MemoryRuntime
  ) {}

  async wake(event: WakeEvent): Promise<WakeResult> {
    const startedAt = Date.now();
    const chunks: string[] = [];
    const toolEvents: unknown[] = [];
    this.state = "running";
    this.lastWakeAt = new Date().toISOString();
    this.lastError = undefined;

    const unsubscribe = this.session.subscribe((piEvent) => {
      if (piEvent && typeof piEvent === "object" && "type" in piEvent && piEvent.type !== "turn_end") {
        toolEvents.push(piEvent);
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
      if (this.memory) {
        prepared = await this.memory.prepareTurn(request);
        promptText = prepared.promptText;
      }

      await this.session.prompt(promptText, { expandPromptTemplates: false });
      this.state = "idle";
      const outputText = extractOutputText(chunks);

      if (this.memory) {
        const promptPacket = prepared?.packet ?? fallbackPacket(event);
        await this.memory.recordTurn({
          principal: {
            agentId: this.id,
            scope: prepared?.principal.scope ?? "global",
            qualifier: prepared?.principal.qualifier
          },
          prompt: {
            ...promptPacket,
            principal: {
              agentId: this.id,
              scope: prepared?.principal.scope ?? "global",
              qualifier: prepared?.principal.qualifier
            }
          },
          request,
          recall: prepared?.recall,
          result: "completed",
          outputText,
          toolEvents
        });
      }

      return {
        agentId: this.id,
        text: outputText,
        durationMs: Date.now() - startedAt
      };
    } catch (error) {
      this.state = "failed";
      this.lastError = error instanceof Error ? error.message : String(error);

      if (this.memory) {
        try {
          const promptPacket = prepared?.packet ?? fallbackPacket(event);
          await this.memory.recordTurn({
            principal: {
              agentId: this.id,
              scope: prepared?.principal.scope ?? "global",
              qualifier: prepared?.principal.qualifier
            },
            prompt: {
              ...promptPacket,
              principal: {
                agentId: this.id,
                scope: prepared?.principal.scope ?? "global",
                qualifier: prepared?.principal.qualifier
              }
            },
            request,
            result: "failed",
            outputText: extractOutputText(chunks),
            toolEvents,
            error: this.lastError
          });
        } catch {
          // Memory write-back is best-effort when waking fails.
        }
      }

      throw error;
    } finally {
      unsubscribe();
    }
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

const formatWakePrompt = (event: WakeEvent): string => `Wake event:
- id: ${event.id}
- kind: ${event.kind}
- from: ${event.from ?? "operator"}

${event.text}`;

const createResourceLoader = (input: AgentStartInput): ResourceLoader => {
  const systemPrompt = [
    `You are ${input.name} (${input.id}).`,
    input.instructions,
    "You are running inside a harnessed workspace prepared by the caller.",
    "Use the available coding tools when asked to read, write, edit, or inspect files.",
    "Keep responses brief and report the exact files you created or modified."
  ].join("\n\n");

  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {}
  };
};

export class PiHarnessAdapter implements AgentHarnessAdapter {
  private readonly authStorage: AuthStorage;
  private readonly modelRegistry: ModelRegistry;

  constructor(private readonly options: PiHarnessOptions) {
    this.authStorage = AuthStorage.create(options.authPath);
    this.modelRegistry = createModelRegistry(this.authStorage, options);
  }

  async startAgent(input: AgentStartInput): Promise<AgentHandle> {
    await mkdir(input.runtimeHomePath, { recursive: true });
    await mkdir(input.workspacePath, { recursive: true });
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
    const memory = createMemoryRuntime({
      agentId: input.id,
      runtimeHomePath: input.runtimeHomePath,
      source: this.options.memory?.source,
      tokenBudget: this.options.memory?.tokenBudget
    });

    const { session } = await createAgentSession({
      cwd: input.workspacePath,
      agentDir: input.runtimeHomePath,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      model,
      thinkingLevel: "off",
      resourceLoader: createResourceLoader(input),
      tools: input.tools ?? ["read", "write", "edit", "bash", "grep", "find", "ls"],
      sessionManager: SessionManager.create(input.workspacePath, path.join(input.runtimeHomePath, "sessions")),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: true, maxRetries: 1 }
      })
    });

    return new PiAgentHandle(input.id, session, memory);
  }
}

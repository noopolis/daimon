import type { createAgentSession } from "@earendil-works/pi-coding-agent";

import type { AgentHandle, AgentStatus, WakeEvent, WakeResult } from "../core/types.js";

import type { PiMemoryToolContextRef } from "./memoryTools.js";
import { formatWakePrompt } from "./prompts.js";
import { stampTurnInputSubmitted, stampTurnOutputCompleted } from "./turnCausal.js";
import {
  persistPiTurnTrace,
  summarizeSessionEvent,
  type PiMemoryPrepareTraceInput,
  type PiTurnTraceModel,
  type PiTurnTraceToolEvent
} from "./turnTrace.js";
import {
  createAwakeThreadId,
  createDreamSessionDirectory,
  createDreamSessionKey,
  createDreamThreadId,
  formatDreamPrompt
} from "./wakeModes.js";
import {
  capturePiRawTrainingEvent,
  createPiRawTrainingCapture,
  persistPiRawTrainingCapture,
  type PiRawTrainingCapture,
  type PiRawTrainingCaptureOptions,
  type PiRawTrainingCaptureRef
} from "./rawTrainingCapture.js";
import {
  formatWorldWakePrompt,
  worldTurnContext,
  type PiWorldToolContextRef
} from "./worldNudge.js";
import {
  capturePiWorldTrajectoryEvent,
  createPiWorldTrajectoryCapture,
  persistPiWorldTrajectory,
  type PiWorldTrajectoryIdentity
} from "./worldTrajectory.js";
import {
  memoryScopeId,
  readMemoryContext,
  type MemoryPrepareTurnResult,
  type MemoryRuntime,
  type MemoryWakeMode
} from "@noopolis/mneme";

type TextBlock = { type: "text"; text: string };

export type PiSession = Awaited<ReturnType<typeof createAgentSession>>["session"];
export type PiSessionCreator = (mode: MemoryWakeMode, sessionDirectory: string) => Promise<PiSession>;
type WakeSessionSelection = { disposeAfterWake: boolean; mode: MemoryWakeMode; session: PiSession; threadId: string };

const extractOutputText = (chunks: string[]): string => chunks.join("\n").trim();

export class PiAgentHandle implements AgentHandle {
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
    private readonly memoryToolContext?: PiMemoryToolContextRef,
    private readonly worldToolContext?: PiWorldToolContextRef,
    private readonly rawTrainingCaptureRef?: PiRawTrainingCaptureRef,
    private readonly rawTrainingCaptureOptions?: PiRawTrainingCaptureOptions,
    private readonly worldTrajectoryIdentity?: PiWorldTrajectoryIdentity
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
    let rawTrainingCapture: PiRawTrainingCapture | undefined;
    let rawTrainingCapturePersisted = false;
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
    const worldContext = this.worldToolContext === undefined
      ? undefined
      : worldTurnContext(event);
    const safeWakeText = worldContext === undefined
      ? event.text
      : formatWorldWakePrompt(worldContext);
    const worldTrajectory = worldContext === undefined
      ? undefined
      : createPiWorldTrajectoryCapture();
    const request = {
      eventId: event.id,
      kind: event.kind,
      text: safeWakeText,
      from: event.from,
      context: memoryContext
    };

    let prepared: MemoryPrepareTurnResult | undefined;
    let promptText = worldContext === undefined
      ? formatWakePrompt(event)
      : safeWakeText;

    try {
      if (this.worldToolContext !== undefined) {
        this.worldToolContext.current = worldContext;
      }
      selectedSession = await this.selectSessionForWake(event, memoryContext);
      if (this.rawTrainingCaptureRef !== undefined
        && this.rawTrainingCaptureOptions !== undefined) {
        rawTrainingCapture = createPiRawTrainingCapture();
        this.rawTrainingCaptureRef.current = rawTrainingCapture;
      }
      unsubscribe = selectedSession.session.subscribe((piEvent) => {
        if (rawTrainingCapture !== undefined) {
          capturePiRawTrainingEvent(rawTrainingCapture, piEvent);
        }
        if (worldTrajectory !== undefined) {
          capturePiWorldTrajectoryEvent(worldTrajectory, piEvent);
        }
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

      // promptText is final here; stamp before the engine sees it. See turnCausal.ts.
      stage = "causal_turn_input";
      const turnInputSubmitted = await stampTurnInputSubmitted({
        agentId: this.id,
        event,
        prepared,
        promptText,
        runtimeHomePath: this.runtimeHomePath
      });

      stage = "engine_prompt";
      const engineStartedAt = Date.now();
      await selectedSession.session.prompt(promptText, { expandPromptTemplates: false });
      enginePromptMs = Date.now() - engineStartedAt;
      this.state = "idle";
      const outputText = extractOutputText(chunks);

      // Success path only; chained to turnInputSubmitted above. See turnCausal.ts.
      stage = "causal_turn_output";
      await stampTurnOutputCompleted({
        agentId: this.id,
        causeEventId: turnInputSubmitted.event_id,
        outputText,
        runtimeHomePath: this.runtimeHomePath,
        turnId: event.id
      });

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
      if (rawTrainingCapture !== undefined
        && this.rawTrainingCaptureOptions !== undefined) {
        await persistPiRawTrainingCapture({
          agentId: this.id,
          capture: rawTrainingCapture,
          completedAt: new Date(),
          options: this.rawTrainingCaptureOptions,
          runtimeHomePath: this.runtimeHomePath,
          session: selectedSession.session,
          startedAt,
          status: "completed",
          totalMs: Date.now() - startedAtMs,
          turnId: event.id,
          world: worldContext
        });
        rawTrainingCapturePersisted = true;
      }
      if (worldContext !== undefined
        && worldTrajectory !== undefined
        && this.worldTrajectoryIdentity !== undefined) {
        await persistPiWorldTrajectory({
          agentId: this.id,
          capture: worldTrajectory,
          completedAt: new Date(),
          context: worldContext,
          instructions: this.worldTrajectoryIdentity.instructions,
          model: this.traceModel,
          promptText,
          runtimeHomePath: this.runtimeHomePath,
          startedAt,
          status: "completed",
          thinkingLevel: this.worldTrajectoryIdentity.thinkingLevel,
          totalMs: Date.now() - startedAtMs,
          turnId: event.id
        });
      }

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
      if (!rawTrainingCapturePersisted
        && rawTrainingCapture !== undefined
        && this.rawTrainingCaptureOptions !== undefined
        && selectedSession !== undefined) {
        await persistPiRawTrainingCapture({
          agentId: this.id,
          capture: rawTrainingCapture,
          completedAt: new Date(),
          options: this.rawTrainingCaptureOptions,
          runtimeHomePath: this.runtimeHomePath,
          session: selectedSession.session,
          startedAt,
          status: "failed",
          totalMs: Date.now() - startedAtMs,
          turnId: event.id,
          world: worldContext
        });
      }
      if (worldContext !== undefined
        && worldTrajectory !== undefined
        && this.worldTrajectoryIdentity !== undefined) {
        await persistPiWorldTrajectory({
          agentId: this.id,
          capture: worldTrajectory,
          completedAt: new Date(),
          context: worldContext,
          instructions: this.worldTrajectoryIdentity.instructions,
          model: this.traceModel,
          promptText,
          runtimeHomePath: this.runtimeHomePath,
          startedAt,
          status: "failed",
          thinkingLevel: this.worldTrajectoryIdentity.thinkingLevel,
          totalMs: Date.now() - startedAtMs,
          turnId: event.id
        });
      }

      throw error;
    } finally {
      if (this.memoryToolContext) {
        this.memoryToolContext.current = undefined;
        this.memoryToolContext.observeTool = undefined;
      }
      if (this.worldToolContext) {
        this.worldToolContext.current = undefined;
      }
      if (this.rawTrainingCaptureRef) {
        this.rawTrainingCaptureRef.current = undefined;
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

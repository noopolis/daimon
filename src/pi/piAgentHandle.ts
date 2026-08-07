import type { AgentHandle, AgentStatus, WakeEvent, WakeResult } from "../core/types.js";

import { createTrustedPiMemoryToolContext, type PiMemoryToolContextRef } from "./memoryTools.js";
import { formatWakePrompt } from "./prompts.js";
import {
  stampTurnInputSubmitted,
  stampTurnOutputCompleted,
  type StampTurnInputSubmittedInput,
  type StampTurnOutputCompletedInput
} from "./turnCausal.js";
import {
  WakeAcceptanceStore,
  type WakeAcceptanceCapability,
  type WakeAcceptanceStoreLike
} from "./wakeAcceptance.js";
import { persistPiTurnTrace, type PiMemoryPrepareTraceInput, type PiTurnTraceModel, type PiTurnTraceToolEvent } from "./turnTrace.js";
import { formatDreamPrompt } from "./wakeModes.js";
import { createPiRawTrainingCapture, type PiRawTrainingCapture, type PiRawTrainingCaptureOptions, type PiRawTrainingCaptureRef } from "./rawTrainingCapture.js";
import { formatWorldWakePrompt, worldWakeContext, type PiWorldToolContextRef } from "./worldNudge.js";
import { createPiWorldTrajectoryCapture, type PiWorldTrajectoryIdentity } from "./worldTrajectory.js";
import {
  cloneWakeEvent,
  persistPiTurnArtifacts,
  PiWakeDeliveryQueue,
  selectPiSessionForWake,
  subscribeToPiTurnEvents,
  type PiNativeSessionCreator,
  type PiSession,
  type PiSessionCreator,
  type PiSessionLike,
  type WakeSessionSelection
} from "./piAgentWakeSupport.js";
import { readMemoryContext, type MemoryPrepareTurnResult, type MemoryRuntime } from "@noopolis/mneme";

export type { PiSession, PiSessionLike, PiSessionCreator, PiNativeSessionCreator } from "./piAgentWakeSupport.js";

export type WakeAcceptanceInput = { runWake?: typeof stampTurnInputSubmitted; completeTurn?: typeof stampTurnOutputCompleted; traceTurn?: typeof persistPiTurnTrace; createWakeAcceptance?: (runtimeHomePath: string, agentId: string) => WakeAcceptanceStoreLike; };

export class PiAgentHandle implements AgentHandle {
  private state: AgentStatus["state"] = "idle";
  private lastWakeAt: string | undefined;
  private lastError: string | undefined;
  private readonly wakeDeliveryQueue: PiWakeDeliveryQueue;
  private readonly stampTurnInputSubmitted: typeof stampTurnInputSubmitted;
  private readonly stampTurnOutputCompleted: typeof stampTurnOutputCompleted;
  private readonly persistTrace: typeof persistPiTurnTrace;

  constructor(
    id: string,
    session: PiSession,
    createSession: PiNativeSessionCreator,
    runtimeHomePath: string,
    traceModel: PiTurnTraceModel,
    memory?: MemoryRuntime,
    memoryToolContext?: PiMemoryToolContextRef,
    dependencies?: WakeAcceptanceInput,
    worldToolContext?: PiWorldToolContextRef,
    rawTrainingCaptureRef?: PiRawTrainingCaptureRef,
    rawTrainingCaptureOptions?: PiRawTrainingCaptureOptions,
    worldTrajectoryIdentity?: PiWorldTrajectoryIdentity,
    rawTrainingCaptureSession?: PiSession
  );
  constructor(
    id: string,
    session: PiSessionLike,
    createSession: PiSessionCreator,
    runtimeHomePath: string,
    traceModel: PiTurnTraceModel,
    memory?: MemoryRuntime,
    memoryToolContext?: PiMemoryToolContextRef,
    dependencies?: WakeAcceptanceInput,
    worldToolContext?: PiWorldToolContextRef,
    rawTrainingCaptureRef?: never,
    rawTrainingCaptureOptions?: never,
    worldTrajectoryIdentity?: PiWorldTrajectoryIdentity,
    rawTrainingCaptureSession?: never
  );
  constructor(
    readonly id: string,
    private readonly session: PiSessionLike,
    private readonly createSession: PiSessionCreator,
    private readonly runtimeHomePath: string,
    private readonly traceModel: PiTurnTraceModel,
    private readonly memory?: MemoryRuntime,
    private readonly memoryToolContext?: PiMemoryToolContextRef,
    dependencies: WakeAcceptanceInput = {},
    private readonly worldToolContext?: PiWorldToolContextRef,
    private readonly rawTrainingCaptureRef?: PiRawTrainingCaptureRef,
    private readonly rawTrainingCaptureOptions?: PiRawTrainingCaptureOptions,
    private readonly worldTrajectoryIdentity?: PiWorldTrajectoryIdentity,
    private readonly piSessionForRawCapture?: PiSession
  ) {
    this.stampTurnInputSubmitted = dependencies.runWake ?? stampTurnInputSubmitted;
    this.stampTurnOutputCompleted = dependencies.completeTurn ?? stampTurnOutputCompleted;
    this.persistTrace = dependencies.traceTurn ?? persistPiTurnTrace;
    const wakeAcceptance =
      dependencies.createWakeAcceptance?.(runtimeHomePath, id) ??
      new WakeAcceptanceStore(runtimeHomePath, id);
    this.wakeDeliveryQueue = new PiWakeDeliveryQueue(id, wakeAcceptance);
  }

  async wake(event: WakeEvent): Promise<WakeResult> {
    const wakeEvent = cloneWakeEvent(event);
    return this.wakeDeliveryQueue.wake(
      wakeEvent,
      (queuedEvent, transition) => this.runWake(queuedEvent, transition)
    );
  }

  private async runWake(
    event: WakeEvent,
    transitionToInvoking?: () => Promise<WakeAcceptanceCapability>
  ): Promise<WakeResult> {
    const startedAt = new Date();
    const startedAtMs = Date.now();
    const chunks: string[] = [];
    const tools: PiTurnTraceToolEvent[] = [];
    let enginePromptMs: number | undefined;
    let memoryPrepare: PiMemoryPrepareTraceInput | undefined;
    let selectedSession: WakeSessionSelection | undefined;
    let rawTrainingCapture: PiRawTrainingCapture | undefined;
    let rawTrainingCapturePersistAttempted = false;
    let unsubscribe: (() => void) | undefined;
    let stage = "select_session";
    let prepared: MemoryPrepareTurnResult | undefined;

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
      : worldWakeContext(event);
    const safeWakeText = worldContext === undefined
      ? event.text
      : formatWorldWakePrompt(worldContext);
    const worldTrajectory = worldContext?.decisionToken === undefined
      ? undefined
      : createPiWorldTrajectoryCapture();
    const request = {
      eventId: event.id,
      kind: event.kind,
      text: safeWakeText,
      from: event.from,
      context: memoryContext
    };

    let promptText = worldContext === undefined
      ? formatWakePrompt(event)
      : safeWakeText;
    try {
      if (this.worldToolContext !== undefined) {
        this.worldToolContext.current = worldContext;
      }
      selectedSession = await selectPiSessionForWake({
        agentId: this.id,
        createSession: this.createSession,
        event,
        memoryContext,
        runtimeHomePath: this.runtimeHomePath,
        session: this.session
      });
      if (this.rawTrainingCaptureRef !== undefined
        && this.rawTrainingCaptureOptions !== undefined) {
        rawTrainingCapture = createPiRawTrainingCapture();
        this.rawTrainingCaptureRef.current = rawTrainingCapture;
      }
      unsubscribe = subscribeToPiTurnEvents({
        chunks,
        rawTrainingCapture,
        session: selectedSession.session,
        tools,
        worldTrajectory
      });

      if (this.memory !== undefined) {
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

        if (this.memoryToolContext !== undefined) {
          this.memoryToolContext.observeTool = (toolEvent) => tools.push(toolEvent);
          this.memoryToolContext.current = createTrustedPiMemoryToolContext({
            agentId: this.id,
            memory: this.memory,
            mode: selectedSession.mode,
            prepared,
            threadId: selectedSession.threadId,
            wakeId: event.id
          });
        }
      }

      if (selectedSession.mode === "dream") {
        promptText = formatDreamPrompt(promptText, selectedSession.threadId);
      }

      stage = "causal_input";
      const turnInput = await this.stampTurnInputSubmitted({
        agentId: this.id,
        event,
        prepared,
        promptText,
        runtimeHomePath: this.runtimeHomePath
      } satisfies StampTurnInputSubmittedInput);

      stage = "invoking";
      if (transitionToInvoking !== undefined) {
        await transitionToInvoking();
      }

      stage = "engine_prompt";
      const engineStartedAt = Date.now();
      await selectedSession.session.prompt(promptText, { expandPromptTemplates: false });
      enginePromptMs = Date.now() - engineStartedAt;

      this.state = "idle";
      const outputText = chunks.join("\n").trim();

      stage = "causal_output";
      await this.stampTurnOutputCompleted({
        agentId: this.id,
        causeEventId: turnInput.event_id,
        outputText,
        runtimeHomePath: this.runtimeHomePath,
        turnId: event.id
      } satisfies StampTurnOutputCompletedInput);

      await this.persistTrace({
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
        totalMs: Date.now() - startedAtMs,
        ...(this.worldToolContext === undefined
          ? {}
          : { worldContextBound: worldContext !== undefined })
      });
      if (rawTrainingCapture !== undefined
        && this.rawTrainingCaptureOptions !== undefined
        && this.piSessionForRawCapture !== undefined) {
        // Do not retry a partially failed private capture in the catch path.
        // The first failure is authoritative and retrying the same immutable
        // turn path would only mask it with an EEXIST/partial-write error.
        rawTrainingCapturePersistAttempted = true;
      }
      await persistPiTurnArtifacts({
        agentId: this.id,
        completedAt: new Date(),
        model: this.traceModel,
        piSessionForRawCapture: this.piSessionForRawCapture,
        promptText,
        rawTrainingCapture,
        rawTrainingCaptureOptions: this.rawTrainingCaptureOptions,
        runtimeHomePath: this.runtimeHomePath,
        startedAt,
        status: "completed",
        totalMs: Date.now() - startedAtMs,
        turnId: event.id,
        worldContext,
        worldTrajectory,
        worldTrajectoryIdentity: this.worldTrajectoryIdentity
      });

      return {
        agentId: this.id,
        text: outputText,
        durationMs: Date.now() - startedAtMs
      };
    } catch (error) {
      this.state = "failed";
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message;

      if (memoryPrepare === undefined && this.memory !== undefined) {
        memoryPrepare = {
          prepared,
          status: "failed"
        };
      }

      await this.persistTrace({
        agentId: this.id,
        enginePromptMs,
        error: {
          message,
          stage
        },
        event,
        memoryPrepare,
        memoryEnabled: Boolean(this.memory),
        model: this.traceModel,
        outputText: chunks.join("\n").trim(),
        promptText,
        runtimeHomePath: this.runtimeHomePath,
        session: selectedSession,
        startedAt,
        status: "failed",
        tools,
        totalMs: Date.now() - startedAtMs,
        ...(this.worldToolContext === undefined
          ? {}
          : { worldContextBound: worldContext !== undefined })
      }).catch(() => undefined);
      const persistRawCapture = !rawTrainingCapturePersistAttempted
        && selectedSession !== undefined;
      if (persistRawCapture && rawTrainingCapture !== undefined) {
        rawTrainingCapturePersistAttempted = true;
      }
      await persistPiTurnArtifacts({
        agentId: this.id,
        completedAt: new Date(),
        model: this.traceModel,
        piSessionForRawCapture: persistRawCapture
          ? this.piSessionForRawCapture
          : undefined,
        promptText,
        rawTrainingCapture: persistRawCapture ? rawTrainingCapture : undefined,
        rawTrainingCaptureOptions: persistRawCapture
          ? this.rawTrainingCaptureOptions
          : undefined,
        runtimeHomePath: this.runtimeHomePath,
        startedAt,
        status: "failed",
        totalMs: Date.now() - startedAtMs,
        turnId: event.id,
        worldContext,
        worldTrajectory,
        worldTrajectoryIdentity: this.worldTrajectoryIdentity
      });

      throw error;
    } finally {
      if (this.memoryToolContext !== undefined) {
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

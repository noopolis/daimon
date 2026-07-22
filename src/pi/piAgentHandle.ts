import type { createAgentSession } from "@earendil-works/pi-coding-agent";

import type { AgentHandle, AgentStatus, WakeEvent, WakeResult } from "../core/types.js";

import type { PiMemoryToolContextRef } from "./memoryTools.js";
import { formatWakePrompt } from "./prompts.js";
import { stampTurnInputSubmitted, stampTurnOutputCompleted, type StampTurnInputSubmittedInput, type StampTurnOutputCompletedInput } from "./turnCausal.js";
import { WakeAcceptanceError, WakeAcceptanceStore, type WakeAcceptanceCapability, type WakeAcceptanceStoreLike } from "./wakeAcceptance.js";
import { persistPiTurnTrace, summarizeSessionEvent, type PiMemoryPrepareTraceInput, type PiTurnTraceModel, type PiTurnTraceToolEvent } from "./turnTrace.js";
import { createAwakeThreadId, createDreamSessionDirectory, createDreamSessionKey, createDreamThreadId, formatDreamPrompt } from "./wakeModes.js";
import { memoryScopeId, readMemoryContext, type MemoryPrepareTurnResult, type MemoryRuntime, type MemoryWakeMode } from "@noopolis/mneme";

const cloneContext = (context: WakeEvent["context"]): WakeEvent["context"] => ({
  ...context,
  ...(context?.pairPeers === undefined ? {} : { pairPeers: [...context.pairPeers] }),
  ...(context?.artifactPaths === undefined ? {} : { artifactPaths: [...context.artifactPaths] })
});

const cloneWakeEvent = (event: WakeEvent): WakeEvent => ({
  ...event,
  ...(event.delivery === undefined ? {} : { delivery: { ...event.delivery } }),
  ...(event.context === undefined ? {} : { context: cloneContext(event.context) })
});

export type PiSession = Awaited<ReturnType<typeof createAgentSession>>["session"];
export type PiSessionCreator = (mode: MemoryWakeMode, sessionDirectory: string) => Promise<PiSession>;

export type WakeAcceptanceInput = { runWake?: typeof stampTurnInputSubmitted; completeTurn?: typeof stampTurnOutputCompleted; traceTurn?: typeof persistPiTurnTrace; createWakeAcceptance?: (runtimeHomePath: string, agentId: string) => WakeAcceptanceStoreLike; };

type WakeSessionSelection = {
  disposeAfterWake: boolean;
  mode: MemoryWakeMode;
  session: PiSession;
  threadId: string;
};

type QueuedDelivery = { digest: string; promise: Promise<WakeResult> };

export class PiAgentHandle implements AgentHandle {
  private state: AgentStatus["state"] = "idle";
  private lastWakeAt: string | undefined;
  private lastError: string | undefined;
  private wakeQueue: Promise<void> = Promise.resolve();
  private readonly wakeAcceptance: WakeAcceptanceStoreLike;
  private readonly deliveryInProgress = new Map<string, QueuedDelivery>();
  private readonly stampTurnInputSubmitted: typeof stampTurnInputSubmitted;
  private readonly stampTurnOutputCompleted: typeof stampTurnOutputCompleted;
  private readonly persistTrace: typeof persistPiTurnTrace;

  constructor(
    readonly id: string,
    private readonly session: PiSession,
    private readonly createSession: PiSessionCreator,
    private readonly runtimeHomePath: string,
    private readonly traceModel: PiTurnTraceModel,
    private readonly memory?: MemoryRuntime,
    private readonly memoryToolContext?: PiMemoryToolContextRef,
    dependencies: WakeAcceptanceInput = {}
  ) {
    this.stampTurnInputSubmitted = dependencies.runWake ?? stampTurnInputSubmitted;
    this.stampTurnOutputCompleted = dependencies.completeTurn ?? stampTurnOutputCompleted;
    this.persistTrace = dependencies.traceTurn ?? persistPiTurnTrace;
    this.wakeAcceptance =
      dependencies.createWakeAcceptance?.(runtimeHomePath, id) ??
      new WakeAcceptanceStore(runtimeHomePath, id);
  }

  async wake(event: WakeEvent): Promise<WakeResult> {
    const wakeEvent = cloneWakeEvent(event);
    const wakeDelivery = wakeEvent.delivery !== undefined
      ? this.wakeAcceptance.candidateFromDelivery(wakeEvent)
      : undefined;

    if (wakeDelivery === undefined) {
      const queued = this.wakeQueue.then(() => this.runWake(wakeEvent), () => this.runWake(wakeEvent));
      this.wakeQueue = queued.then(() => undefined, () => undefined);
      return queued;
    }

    const inProgress = this.deliveryInProgress.get(wakeDelivery.identity);
    if (inProgress !== undefined) {
      if (inProgress.digest !== wakeDelivery.digest) {
        throw new WakeAcceptanceError("wake_delivery_conflict");
      }
      return inProgress.promise;
    }

    const queued = this.wakeQueue.then(
      () => this.runDeliveryWake(wakeEvent),
      () => this.runDeliveryWake(wakeEvent)
    );

    const promise = queued.finally(() => {
      if (this.deliveryInProgress.get(wakeDelivery.identity)?.promise === promise) {
        this.deliveryInProgress.delete(wakeDelivery.identity);
      }
    });

    this.deliveryInProgress.set(wakeDelivery.identity, {
      digest: wakeDelivery.digest,
      promise
    });
    this.wakeQueue = promise.then(() => undefined, () => undefined);

    return promise;
  }

  private async runDeliveryWake(
    event: WakeEvent
  ): Promise<WakeResult> {
    const admission = await this.wakeAcceptance.begin(event);

    if (admission.mode === "replay") {
      return {
        agentId: this.id,
        text: "",
        durationMs: 0
      };
    }

    let capability: WakeAcceptanceCapability = admission.capability;

    try {
      const result = await this.runWake(event, async () => {
        capability = await this.wakeAcceptance.markInvoking(capability);
        return capability;
      });
      await this.wakeAcceptance.markCompleted(capability);
      return result;
    } catch (error) {
      await this.wakeAcceptance.markIncomplete(capability).catch(() => undefined);
      throw error;
    }
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

    let promptText = formatWakePrompt(event);

    const request = {
      eventId: event.id,
      kind: event.kind,
      text: event.text,
      from: event.from,
      context: memoryContext
    };

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

        if (!("content" in piEvent.message)) {
          return;
        }
        const { content } = piEvent.message;

        if (typeof content === "string") {
          chunks.push(content);
        } else if (Array.isArray(content)) {
          chunks.push(
            content
              .filter((entry) => entry.type === "text")
              .map((entry) => entry.text)
              .join("")
          );
        }
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
          this.memoryToolContext.current = {
            audienceKey: memoryContext.roomId ?? event.from ?? this.id,
            conversationScope: memoryScopeId(prepared.principal),
            mode: selectedSession.mode,
            principal: prepared.principal,
            threadId: selectedSession.threadId,
            transport: "in_process",
            wakeId: event.id
          };
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
        totalMs: Date.now() - startedAtMs
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
        totalMs: Date.now() - startedAtMs
      }).catch(() => undefined);

      throw error;
    } finally {
      if (this.memoryToolContext !== undefined) {
        this.memoryToolContext.current = undefined;
        this.memoryToolContext.observeTool = undefined;
      }
      if (unsubscribe !== undefined) {
        unsubscribe();
      }
      if (selectedSession !== undefined && selectedSession.disposeAfterWake) {
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
      session: await this.createSession(
        "dream",
        createDreamSessionDirectory(this.runtimeHomePath, sessionKey)
      ),
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

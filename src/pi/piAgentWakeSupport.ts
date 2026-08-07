import type { createAgentSession } from "@earendil-works/pi-coding-agent";
import type { WakeMemoryContext, MemoryWakeMode } from "@noopolis/mneme";

import type { WakeEvent, WakeResult } from "../core/types.js";

import {
  capturePiRawTrainingEvent,
  persistPiRawTrainingCapture,
  type PiRawTrainingCapture,
  type PiRawTrainingCaptureOptions,
} from "./rawTrainingCapture.js";
import {
  summarizeSessionEvent,
  type PiTurnTraceModel,
  type PiTurnTraceToolEvent,
} from "./turnTrace.js";
import {
  createAwakeThreadId,
  createDreamSessionDirectory,
  createDreamSessionKey,
  createDreamThreadId,
} from "./wakeModes.js";
import type { PiWorldTurnContext } from "./worldNudge.js";
import {
  WakeAcceptanceError,
  type WakeAcceptanceCapability,
  type WakeAcceptanceStoreLike,
} from "./wakeAcceptance.js";
import {
  capturePiWorldTrajectoryEvent,
  persistPiWorldTrajectory,
  type PiWorldTrajectoryCapture,
  type PiWorldTrajectoryIdentity,
} from "./worldTrajectory.js";

export type PiSession = Awaited<ReturnType<typeof createAgentSession>>["session"];
export interface PiSessionLike {
  subscribe(listener: Parameters<PiSession["subscribe"]>[0]): () => void;
  prompt(text: string, options?: Parameters<PiSession["prompt"]>[1]): Promise<void>;
  dispose(): void;
}
export type PiSessionCreator = (
  mode: MemoryWakeMode,
  sessionDirectory: string,
) => Promise<PiSessionLike>;
export type PiNativeSessionCreator = (
  mode: MemoryWakeMode,
  sessionDirectory: string,
) => Promise<PiSession>;

export interface WakeSessionSelection {
  disposeAfterWake: boolean;
  mode: MemoryWakeMode;
  session: PiSessionLike;
  threadId: string;
}

type WakeRunner = (
  event: WakeEvent,
  transitionToInvoking?: () => Promise<WakeAcceptanceCapability>,
) => Promise<WakeResult>;
type QueuedDelivery = { digest: string; promise: Promise<WakeResult> };

export class PiWakeDeliveryQueue {
  private queue: Promise<void> = Promise.resolve();
  private readonly inProgress = new Map<string, QueuedDelivery>();

  public constructor(
    private readonly agentId: string,
    private readonly acceptance: WakeAcceptanceStoreLike,
  ) {}

  public async wake(event: WakeEvent, run: WakeRunner): Promise<WakeResult> {
    const candidate = event.delivery === undefined
      ? undefined
      : this.acceptance.candidateFromDelivery(event);
    if (candidate === undefined) return this.enqueue(() => run(event));
    const active = this.inProgress.get(candidate.identity);
    if (active !== undefined) {
      if (active.digest !== candidate.digest) {
        throw new WakeAcceptanceError("wake_delivery_conflict");
      }
      return active.promise;
    }
    const queued = this.enqueue(() => this.runDelivery(event, run));
    const promise = queued.finally(() => {
      if (this.inProgress.get(candidate.identity)?.promise === promise) {
        this.inProgress.delete(candidate.identity);
      }
    });
    this.inProgress.set(candidate.identity, { digest: candidate.digest, promise });
    return promise;
  }

  private enqueue(run: () => Promise<WakeResult>): Promise<WakeResult> {
    const queued = this.queue.then(run, run);
    this.queue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  private async runDelivery(event: WakeEvent, run: WakeRunner): Promise<WakeResult> {
    const admission = await this.acceptance.begin(event);
    if (admission.mode === "replay") {
      return { agentId: this.agentId, text: "", durationMs: 0 };
    }
    let capability = admission.capability;
    try {
      const result = await run(event, async () => {
        capability = await this.acceptance.markInvoking(capability);
        return capability;
      });
      await this.acceptance.markCompleted(capability);
      return result;
    } catch (error) {
      await this.acceptance.markIncomplete(capability).catch(() => undefined);
      throw error;
    }
  }
}

const cloneContext = (context: WakeEvent["context"]): WakeEvent["context"] => ({
  ...context,
  ...(context?.pairPeers === undefined ? {} : { pairPeers: [...context.pairPeers] }),
  ...(context?.artifactPaths === undefined ? {} : { artifactPaths: [...context.artifactPaths] }),
});

export const cloneWakeEvent = (event: WakeEvent): WakeEvent => ({
  ...event,
  ...(event.delivery === undefined ? {} : { delivery: { ...event.delivery } }),
  ...(event.context === undefined ? {} : { context: cloneContext(event.context) }),
});

export const selectPiSessionForWake = async (input: {
  agentId: string;
  createSession: PiSessionCreator;
  event: WakeEvent;
  memoryContext: WakeMemoryContext;
  runtimeHomePath: string;
  session: PiSessionLike;
}): Promise<WakeSessionSelection> => {
  if (input.event.kind !== "dream") {
    return {
      disposeAfterWake: false,
      mode: "awake",
      session: input.session,
      threadId: createAwakeThreadId(input.memoryContext, input.agentId),
    };
  }
  const sessionKey = createDreamSessionKey(input.event);
  return {
    disposeAfterWake: true,
    mode: "dream",
    session: await input.createSession(
      "dream",
      createDreamSessionDirectory(input.runtimeHomePath, sessionKey),
    ),
    threadId: createDreamThreadId(sessionKey),
  };
};

export const subscribeToPiTurnEvents = (input: {
  chunks: string[];
  rawTrainingCapture?: PiRawTrainingCapture;
  session: PiSessionLike;
  tools: PiTurnTraceToolEvent[];
  worldTrajectory?: PiWorldTrajectoryCapture;
}): (() => void) => {
  const unsubscribe = input.session.subscribe((event) => {
    if (input.rawTrainingCapture !== undefined) {
      capturePiRawTrainingEvent(input.rawTrainingCapture, event);
    }
    if (input.worldTrajectory !== undefined) {
      capturePiWorldTrajectoryEvent(input.worldTrajectory, event);
    }
    const toolEvent = summarizeSessionEvent(event);
    if (toolEvent !== undefined) input.tools.push(toolEvent);
    if (event.type !== "turn_end" || !("content" in event.message)) return;
    const { content } = event.message;
    input.chunks.push(typeof content === "string"
      ? content
      : content.filter((entry) => entry.type === "text")
        .map((entry) => entry.text).join(""));
  });
  return unsubscribe;
};

export const persistPiTurnArtifacts = async (input: {
  agentId: string;
  completedAt: Date;
  model: PiTurnTraceModel;
  piSessionForRawCapture?: PiSession;
  promptText: string;
  rawTrainingCapture?: PiRawTrainingCapture;
  rawTrainingCaptureOptions?: PiRawTrainingCaptureOptions;
  runtimeHomePath: string;
  startedAt: Date;
  status: "completed" | "failed";
  totalMs: number;
  turnId: string;
  worldContext?: PiWorldTurnContext;
  worldTrajectory?: PiWorldTrajectoryCapture;
  worldTrajectoryIdentity?: PiWorldTrajectoryIdentity;
}): Promise<void> => {
  if (input.rawTrainingCapture !== undefined
    && input.rawTrainingCaptureOptions !== undefined
    && input.piSessionForRawCapture !== undefined) {
    await persistPiRawTrainingCapture({
      agentId: input.agentId,
      capture: input.rawTrainingCapture,
      completedAt: input.completedAt,
      options: input.rawTrainingCaptureOptions,
      runtimeHomePath: input.runtimeHomePath,
      session: input.piSessionForRawCapture,
      startedAt: input.startedAt,
      status: input.status,
      totalMs: input.totalMs,
      turnId: input.turnId,
      world: input.worldContext,
    });
  }
  if (input.worldContext !== undefined
    && input.worldTrajectory !== undefined
    && input.worldTrajectoryIdentity !== undefined) {
    await persistPiWorldTrajectory({
      agentId: input.agentId,
      capture: input.worldTrajectory,
      completedAt: input.completedAt,
      context: input.worldContext,
      instructions: input.worldTrajectoryIdentity.instructions,
      model: input.model,
      promptText: input.promptText,
      runtimeHomePath: input.runtimeHomePath,
      startedAt: input.startedAt,
      status: input.status,
      thinkingLevel: input.worldTrajectoryIdentity.thinkingLevel,
      totalMs: input.totalMs,
      turnId: input.turnId,
    });
  }
};

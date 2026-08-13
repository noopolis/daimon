import { createHash } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { MemoryPrepareTurnResult, MemoryWakeMode } from "@noopolis/mneme";

import type { HarnessModelSpec, WakeEvent } from "../core/types.js";

export interface PiTurnTraceModel {
  authMethod: NonNullable<HarnessModelSpec["auth"]>["method"];
  model: string;
  provider: string;
}

export interface PiTurnTraceToolEvent {
  contentCount?: number;
  decision?: string;
  durationMs?: number;
  error?: string;
  kind: "memory" | "session";
  name: string;
  redactionCount?: number;
  status?: string;
  type?: string;
}

export interface PiTurnTraceRecord {
  agent_id: string;
  completed_at: string;
  engine: {
    auth_method: NonNullable<HarnessModelSpec["auth"]>["method"];
    kind: "pi";
    model: string;
    provider: string;
  };
  error?: {
    message: string;
    stage: string;
  };
  memory: {
    enabled: boolean;
    prepare?: {
      duration_ms: number;
      principal?: {
        agent_id: string;
        qualifier?: string;
        scope: string;
      };
      recall?: {
        redaction_count: number;
        selected_count: number;
        token_budget_used: number;
        total_candidates: number;
      };
      status: "completed" | "failed";
    };
  };
  prompt: {
    chars: number;
    has_active_environment: boolean;
    has_dream_mode: boolean;
    has_memory_context: boolean;
    lines: number;
    sha256: string;
  };
  reply: {
    output_chars: number;
    reply_given: boolean;
  };
  schema: "daimon.turn_trace.v1";
  session: {
    dispose_after_wake: boolean;
    mode: "awake" | "dream";
    thread_id: string;
  };
  started_at: string;
  status: "completed" | "failed";
  timings_ms: {
    engine_prompt?: number;
    memory_prepare?: number;
    total: number;
  };
  tools: PiTurnTraceToolEvent[];
  turn_id: string;
  wake: {
    context?: WakeEvent["context"];
    delivery_authenticated?: boolean;
    event_id: string;
    from?: string;
    kind: WakeEvent["kind"];
    transport_text_present?: boolean;
    world_context_bound?: boolean;
  };
}

export interface PiMemoryPrepareTraceInput {
  durationMs?: number;
  prepared?: MemoryPrepareTurnResult;
  status: "completed" | "failed";
}

export interface BuildPiTurnTraceRecordInput {
  agentId: string;
  completedAt: Date;
  enginePromptMs?: number;
  error?: {
    message: string;
    stage: string;
  };
  event: WakeEvent;
  memoryEnabled: boolean;
  memoryPrepare?: PiMemoryPrepareTraceInput;
  model: PiTurnTraceModel;
  outputText: string;
  promptText: string;
  session: {
    disposeAfterWake: boolean;
    mode: MemoryWakeMode;
    threadId: string;
  };
  startedAt: Date;
  status: "completed" | "failed";
  tools: PiTurnTraceToolEvent[];
  totalMs: number;
  worldContextBound?: boolean;
}

export interface PersistPiTurnTraceInput extends Omit<BuildPiTurnTraceRecordInput, "completedAt" | "session"> {
  runtimeHomePath: string;
  session?: BuildPiTurnTraceRecordInput["session"];
}

export const redactTraceText = (value: unknown): string => {
  let redacted = String(value);
  redacted = redacted.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/giu, "Bearer [REDACTED]");
  redacted = redacted.replace(/\bmagt_v1_[A-Za-z0-9_-]{16,}\b/gu, "[REDACTED]");
  redacted = redacted.replace(/\b(?:sk|sk-proj)-[A-Za-z0-9_-]{20,}\b/gu, "[REDACTED]");
  redacted = redacted.replace(
    /("([^"]*(?:api[_-]?key|token|secret|password)[^"]*)"\s*:\s*")([^"]+)(")/giu,
    "$1[REDACTED]$4"
  );
  redacted = redacted.replace(/\/(?:Users|home|private|tmp|var|opt|run)\/[^\s"']+/gu, "[path]");
  return redacted.length > 1000 ? `${redacted.slice(0, 1000)}...` : redacted;
};

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

export const summarizePrompt = (prompt: string): PiTurnTraceRecord["prompt"] => ({
  chars: prompt.length,
  has_active_environment: prompt.includes("Active environment context:"),
  has_dream_mode: prompt.includes("## Dream Mode"),
  has_memory_context: prompt.includes("Memory context") || prompt.includes("# Mneme"),
  lines: prompt.length === 0 ? 0 : prompt.split(/\r?\n/u).length,
  sha256: sha256(prompt)
});

const summarizeMemoryPrepare = (
  input: PiMemoryPrepareTraceInput
): NonNullable<PiTurnTraceRecord["memory"]["prepare"]> => ({
  duration_ms: input.durationMs ?? 0,
  ...(input.prepared ? {
    principal: {
      agent_id: input.prepared.principal.agentId,
      ...(input.prepared.principal.qualifier ? { qualifier: input.prepared.principal.qualifier } : {}),
      scope: input.prepared.principal.scope
    },
    recall: {
      redaction_count: input.prepared.recall.redactionCount,
      selected_count: input.prepared.recall.selectedEventIds.length,
      token_budget_used: input.prepared.recall.tokenBudgetUsed,
      total_candidates: input.prepared.recall.totalCandidates
    }
  } : {}),
  status: input.status
});

const asObject = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

export const summarizeSessionEvent = (event: unknown): PiTurnTraceToolEvent | undefined => {
  const record = asObject(event);
  const type = asString(record?.type);
  if (!record || !type || type === "turn_end") {
    return undefined;
  }

  const tool = asObject(record.tool) ?? asObject(record.toolCall) ?? asObject(record.call);
  const name =
    asString(record.tool_name) ??
    asString(record.toolName) ??
    asString(record.name) ??
    asString(tool?.name) ??
    "session_event";

  return {
    durationMs: asNumber(record.durationMs) ?? asNumber(record.duration_ms),
    kind: "session",
    name,
    status: asString(record.status),
    type
  };
};

export const sanitizeTraceFileId = (value: string): string => {
  const normalized = value.replace(/[^A-Za-z0-9._-]+/gu, "_").slice(0, 128);
  return normalized.length > 0 ? normalized : "turn";
};

export const buildPiTurnTraceRecord = (input: BuildPiTurnTraceRecordInput): PiTurnTraceRecord => ({
  agent_id: input.agentId,
  completed_at: input.completedAt.toISOString(),
  engine: {
    auth_method: input.model.authMethod,
    kind: "pi",
    model: input.model.model,
    provider: input.model.provider
  },
  ...(input.error ? {
    error: {
      message: redactTraceText(input.error.message),
      stage: input.error.stage
    }
  } : {}),
  memory: {
    enabled: input.memoryEnabled,
    ...(input.memoryPrepare ? { prepare: summarizeMemoryPrepare(input.memoryPrepare) } : {})
  },
  prompt: summarizePrompt(input.promptText),
  reply: {
    output_chars: input.outputText.length,
    reply_given: input.outputText.trim().length > 0
  },
  schema: "daimon.turn_trace.v1",
  session: {
    dispose_after_wake: input.session.disposeAfterWake,
    mode: input.session.mode,
    thread_id: input.session.threadId
  },
  started_at: input.startedAt.toISOString(),
  status: input.status,
  timings_ms: {
    ...(input.enginePromptMs !== undefined ? { engine_prompt: input.enginePromptMs } : {}),
    ...(input.memoryPrepare?.durationMs !== undefined ? { memory_prepare: input.memoryPrepare.durationMs } : {}),
    total: input.totalMs
  },
  tools: input.tools.map((tool) => ({
    ...tool,
    ...(tool.error ? { error: redactTraceText(tool.error) } : {})
  })),
  turn_id: input.event.id,
  wake: {
    ...(input.event.context ? { context: input.event.context } : {}),
    ...(input.worldContextBound === undefined
      ? {}
      : {
        delivery_authenticated: input.event.delivery !== undefined,
        transport_text_present: typeof input.event.transportText === "string",
        world_context_bound: input.worldContextBound
      }),
    event_id: input.event.id,
    ...(input.event.from ? { from: input.event.from } : {}),
    kind: input.event.kind
  }
});

export const writeTurnTraceRecord = async (
  runtimeHomePath: string,
  record: PiTurnTraceRecord
): Promise<void> => {
  const telemetryPath = path.join(runtimeHomePath, "telemetry");
  const turnsPath = path.join(telemetryPath, "turns");
  await mkdir(turnsPath, { recursive: true });
  const body = `${JSON.stringify(record, null, 2)}\n`;
  await writeFile(path.join(turnsPath, `${sanitizeTraceFileId(record.turn_id)}.json`), body, "utf8");
  await appendFile(path.join(telemetryPath, "turns.ndjson"), `${JSON.stringify(record)}\n`, "utf8");
};

export const persistPiTurnTrace = async (input: PersistPiTurnTraceInput): Promise<void> => {
  const record = buildPiTurnTraceRecord({
    ...input,
    completedAt: new Date(),
    session: input.session ?? {
      disposeAfterWake: false,
      mode: "awake",
      threadId: "unavailable"
    }
  });
  await writeTurnTraceRecord(input.runtimeHomePath, record);
};

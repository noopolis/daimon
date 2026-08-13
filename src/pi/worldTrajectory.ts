import { createHash } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { PiTurnTraceModel } from "./turnTrace.js";
import { redactTraceText, sanitizeTraceFileId } from "./turnTrace.js";
import type { PiWorldTurnContext } from "./worldNudge.js";

export const WORLD_TRAJECTORY_SCHEMA = "daimon.world_trajectory.v1" as const;

/**
 * Pi's SessionManager remains the private raw session recorder. This module
 * derives a minimized public/evaluation projection from the same subscribed
 * session events. Raw training capture is deliberately separate; see
 * docs/WORLD_TRAJECTORIES.md.
 */

export interface PiWorldTrajectoryToolCall {
  arguments?: unknown;
  completed_at?: string;
  duration_ms?: number;
  name: string;
  result?: unknown;
  sequence: number;
  started_at?: string;
  status: "running" | "completed" | "failed";
  tool_call_id: string;
}

export interface PiWorldTrajectoryCapture {
  readonly calls: PiWorldTrajectoryToolCall[];
  readonly starts: Map<string, number>;
}

export interface PiWorldTrajectoryIdentity {
  readonly instructions: string;
  readonly thinkingLevel: string;
}

export interface PersistPiWorldTrajectoryInput {
  agentId: string;
  capture: PiWorldTrajectoryCapture;
  completedAt: Date;
  context: PiWorldTurnContext;
  instructions: string;
  model: PiTurnTraceModel;
  promptText: string;
  runtimeHomePath: string;
  startedAt: Date;
  status: "completed" | "failed";
  thinkingLevel: string;
  totalMs: number;
  turnId: string;
}

const asObject = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const forbiddenKey = /(?:authorization|bearer|credential|memory|password|prompt|reasoning|secret|thinking|token)/iu;
const maxArrayItems = 256;
const maxObjectKeys = 256;
const maxStringChars = 32_768;
const maxDepth = 12;

/**
 * Keeps the scoped world projection exact while removing authority, hidden
 * reasoning, private memory, credentials, and host diagnostics.
 */
export const redactWorldTrajectoryValue = (
  value: unknown,
  depth = 0
): unknown => {
  if (depth > maxDepth) return "[TRUNCATED]";
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "string") {
    const redacted = redactTraceText(value);
    return redacted.length > maxStringChars
      ? `${redacted.slice(0, maxStringChars)}...[TRUNCATED]`
      : redacted;
  }
  if (Array.isArray(value)) {
    return value.slice(0, maxArrayItems)
      .map((entry) => redactWorldTrajectoryValue(entry, depth + 1));
  }
  const record = asObject(value);
  if (record === undefined) return String(value);
  return Object.fromEntries(
    Object.entries(record)
      .filter(([key]) => !forbiddenKey.test(key))
      .slice(0, maxObjectKeys)
      .map(([key, nested]) => [key, redactWorldTrajectoryValue(nested, depth + 1)])
  );
};

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

export const createPiWorldTrajectoryCapture = (): PiWorldTrajectoryCapture => ({
  calls: [],
  starts: new Map()
});

export const capturePiWorldTrajectoryEvent = (
  capture: PiWorldTrajectoryCapture,
  event: unknown,
  now = new Date()
): void => {
  const record = asObject(event);
  const type = text(record?.type);
  if (type !== "tool_execution_start" && type !== "tool_execution_end") return;
  const name = text(record?.toolName);
  const toolCallId = text(record?.toolCallId);
  if (name === undefined || toolCallId === undefined || !name.startsWith("world_")) return;
  if (type === "tool_execution_start") {
    capture.starts.set(toolCallId, now.getTime());
    capture.calls.push({
      arguments: redactWorldTrajectoryValue(record?.args),
      name,
      sequence: capture.calls.length,
      started_at: now.toISOString(),
      status: "running",
      tool_call_id: toolCallId
    });
    return;
  }
  const call = capture.calls.findLast((candidate) => candidate.tool_call_id === toolCallId);
  const resultRecord = asObject(record?.result);
  const result = record?.isError === true
    ? record?.result
    : resultRecord?.details ?? record?.result;
  const startedAt = capture.starts.get(toolCallId);
  const completed = call ?? {
    name,
    sequence: capture.calls.length,
    status: "running" as const,
    tool_call_id: toolCallId
  };
  completed.completed_at = now.toISOString();
  completed.duration_ms = startedAt === undefined ? undefined : Math.max(0, now.getTime() - startedAt);
  completed.result = redactWorldTrajectoryValue(result);
  completed.status = record?.isError === true ? "failed" : "completed";
  if (call === undefined) capture.calls.push(completed);
  capture.starts.delete(toolCallId);
};

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

export const persistPiWorldTrajectory = async (
  input: PersistPiWorldTrajectoryInput
): Promise<void> => {
  const chosenAction = input.capture.calls.findLast((call) =>
    call.name === "world_act" && call.status === "completed");
  const record = {
    agent_id: input.agentId,
    chosen_action: chosenAction === undefined ? undefined : {
      arguments: chosenAction.arguments,
      result: chosenAction.result,
      tool_call_id: chosenAction.tool_call_id
    },
    completed_at: input.completedAt.toISOString(),
    engine: {
      auth_method: input.model.authMethod,
      kind: "pi",
      model: input.model.model,
      provider: input.model.provider,
      thinking_level: input.thinkingLevel
    },
    instruction: { sha256: sha256(input.instructions) },
    outcome: {
      status: chosenAction === undefined ? "no_action" : "pending_world_join",
      join: chosenAction?.result
    },
    prompt: { sha256: sha256(input.promptText) },
    schema: WORLD_TRAJECTORY_SCHEMA,
    started_at: input.startedAt.toISOString(),
    terminal_status: input.status,
    timings_ms: { total: input.totalMs },
    tool_calls: input.capture.calls,
    turn_id: input.turnId,
    world: {
      run_id: input.context.runId,
      tick: input.context.tick,
      wake_id: input.context.wakeId
    }
  };
  const telemetryPath = path.join(input.runtimeHomePath, "telemetry");
  const trajectoriesPath = path.join(telemetryPath, "world-trajectories");
  await mkdir(trajectoriesPath, { recursive: true });
  const bytes = `${JSON.stringify(record, null, 2)}\n`;
  await writeFile(
    path.join(trajectoriesPath, `${sanitizeTraceFileId(input.turnId)}.json`),
    bytes,
    { encoding: "utf8", mode: 0o600 }
  );
  await appendFile(
    path.join(telemetryPath, "world-trajectories.ndjson"),
    `${JSON.stringify(record)}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
};

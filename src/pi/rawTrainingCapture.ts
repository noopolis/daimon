import { chmod, readFile, readdir, rm, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { createAgentSession } from "@earendil-works/pi-coding-agent";

import type { PiWorldTurnContext } from "./worldNudge.js";
import { sanitizeTraceFileId } from "./turnTrace.js";

export const PI_RAW_TRAINING_CAPTURE_SCHEMA =
  "daimon.pi.raw_training_capture.v1" as const;

export interface PiRawTrainingCaptureOptions {
  enabled: true;
  retention: {
    maxTurns: number;
  };
}

export interface PiRawTrainingCapture {
  readonly events: string[];
  readonly requests: Array<{
    model: unknown;
    payload: unknown;
    requested_at: string;
    response?: unknown;
    response_at?: string;
    sequence: number;
  }>;
}

export interface PiRawTrainingCaptureRef {
  current?: PiRawTrainingCapture;
}

type PiNativeSession =
  Awaited<ReturnType<typeof createAgentSession>>["session"];
type PiRawTrainingSession = Pick<
  PiNativeSession,
  "agent" | "model" | "sessionFile" | "sessionId" | "thinkingLevel"
>;

export interface PersistPiRawTrainingCaptureInput {
  agentId: string;
  capture: PiRawTrainingCapture;
  completedAt: Date;
  options: PiRawTrainingCaptureOptions;
  runtimeHomePath: string;
  session: PiRawTrainingSession;
  startedAt: Date;
  status: "completed" | "failed";
  totalMs: number;
  turnId: string;
  world?: PiWorldTurnContext;
}

const json = (value: unknown): string => JSON.stringify(value);

/**
 * Installs a transparent recorder at Pi's native provider-payload seam.
 *
 * The recorder returns the exact result of any pre-existing hook, so enabling
 * capture cannot alter the request sent to the model.
 */
export const bindPiRawTrainingCapture = (
  session: PiRawTrainingSession,
  ref: PiRawTrainingCaptureRef
): void => {
  const previousPayload = session.agent.onPayload;
  const previousResponse = session.agent.onResponse;

  session.agent.onPayload = async (payload, model) => {
    const transformed = await previousPayload?.(payload, model);
    const effectivePayload = transformed === undefined ? payload : transformed;
    const capture = ref.current;
    if (capture !== undefined) {
      capture.requests.push({
        model: structuredClone(model),
        payload: structuredClone(effectivePayload),
        requested_at: new Date().toISOString(),
        sequence: capture.requests.length
      });
    }
    return transformed;
  };

  session.agent.onResponse = async (response, model) => {
    await previousResponse?.(response, model);
    const capture = ref.current;
    const request = capture?.requests.at(-1);
    if (request !== undefined) {
      request.response = structuredClone(response);
      request.response_at = new Date().toISOString();
    }
  };
};

export const createPiRawTrainingCapture = (): PiRawTrainingCapture => ({
  events: [],
  requests: []
});

export const capturePiRawTrainingEvent = (
  capture: PiRawTrainingCapture,
  event: unknown,
  now = new Date()
): void => {
  // Serialize at event time so later mutation cannot change the captured event.
  capture.events.push(
    `{"recorded_at":${json(now.toISOString())},"event":${json(event)}}`
  );
};

export const validatePiRawTrainingCaptureOptions = (
  options: PiRawTrainingCaptureOptions | undefined
): void => {
  if (options === undefined) return;
  if (options.enabled !== true
    || !Number.isSafeInteger(options.retention.maxTurns)
    || options.retention.maxTurns < 1
    || options.retention.maxTurns > 100_000) {
    throw new Error(
      "Pi raw training capture requires enabled: true and retention.maxTurns between 1 and 100000"
    );
  }
};

const pruneTurns = async (turnsPath: string, maxTurns: number): Promise<void> => {
  const names = (await readdir(turnsPath, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  await Promise.all(
    names.slice(0, Math.max(0, names.length - maxTurns))
      .map((name) => rm(path.join(turnsPath, name), { force: true, recursive: true }))
  );
};

/**
 * Persists a deliberately private, unredacted training artifact.
 *
 * `pi-session.jsonl` is copied byte-for-byte from Pi's SessionManager. The
 * request payloads come from Pi AI's `onPayload` seam after any prior payload
 * transform, so they contain the exact structured provider input, including
 * system/character prompts, messages, tool schemas, and sampling fields.
 */
export const persistPiRawTrainingCapture = async (
  input: PersistPiRawTrainingCaptureInput
): Promise<string> => {
  validatePiRawTrainingCaptureOptions(input.options);
  if (input.session.sessionFile === undefined) {
    throw new Error("Pi raw training capture requires a persisted native session");
  }

  const nativeSessionBytes = await readFile(input.session.sessionFile);
  const root = path.join(input.runtimeHomePath, "private-training", "pi", "raw");
  const turnsPath = path.join(root, "turns");
  const turnPath = path.join(
    turnsPath,
    `${String(input.startedAt.getTime()).padStart(13, "0")}-${sanitizeTraceFileId(input.turnId)}`
  );
  await mkdir(turnsPath, { mode: 0o700, recursive: true });
  await Promise.all([chmod(root, 0o700), chmod(turnsPath, 0o700)]);
  await mkdir(turnPath, { mode: 0o700 });

  const manifest = {
    access: {
      classification: "private_raw_training",
      export_by_default: false,
      contains_unredacted_model_context: true
    },
    agent_id: input.agentId,
    completed_at: input.completedAt.toISOString(),
    files: {
      events: "events.ndjson",
      native_pi_session: "pi-session.jsonl",
      provider_exchange: "provider-exchange.json"
    },
    join: input.world === undefined ? undefined : {
      run_id: input.world.runId,
      tick: input.world.tick,
      wake_id: input.world.wakeId
    },
    native_session: {
      id: input.session.sessionId
    },
    retention: {
      max_turns: input.options.retention.maxTurns
    },
    schema: PI_RAW_TRAINING_CAPTURE_SCHEMA,
    started_at: input.startedAt.toISOString(),
    terminal_status: input.status,
    timings_ms: {
      total: input.totalMs
    },
    turn_id: input.turnId
  };
  const providerExchange = {
    model: structuredClone(input.session.model),
    requests: input.capture.requests,
    session_id: input.session.sessionId,
    thinking_level: input.session.thinkingLevel
  };

  await Promise.all([
    writeFile(
      path.join(turnPath, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 }
    ),
    writeFile(
      path.join(turnPath, "provider-exchange.json"),
      `${JSON.stringify(providerExchange, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 }
    ),
    writeFile(
      path.join(turnPath, "events.ndjson"),
      input.capture.events.length === 0 ? "" : `${input.capture.events.join("\n")}\n`,
      { encoding: "utf8", mode: 0o600 }
    ),
    writeFile(
      path.join(turnPath, "pi-session.jsonl"),
      nativeSessionBytes,
      { mode: 0o600 }
    )
  ]);
  await Promise.all([
    chmod(turnPath, 0o700),
    ...["manifest.json", "provider-exchange.json", "events.ndjson", "pi-session.jsonl"]
      .map((name) => chmod(path.join(turnPath, name), 0o600))
  ]);
  await pruneTurns(turnsPath, input.options.retention.maxTurns);
  return turnPath;
};

import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { emitTurnInputSubmitted, emitTurnOutputCompleted, resolveRunId, sha256Hex, type CausalEvent } from "./causalEvents.js";

/**
 * Standalone fixture emitter, run via `npm run emit-causal-fixture`
 * (or `npm run emit-causal-fixture:spoof` for the adversarial mode below).
 *
 * Stamps one synthetic `turn.input.submitted` -> `turn.output.completed`
 * chain into a scratch runtime home under `.runtime/causal-fixture[-spoof]/`,
 * using the same `causalEvents.ts` functions `turnCausal.ts` uses for real
 * turns. This is a fixture, not a live engine run: no Pi session, no mneme
 * recall.
 *
 * `principal_id` here is stamped as `agent:<agentId>` directly (rather than
 * importing `turnCausal.ts`'s `agentPrincipalId` helper) because this file
 * lives under `src/observability/`, which stays engine-neutral and must not
 * import `src/pi/` implementation details (see this folder's `AGENTS.md`).
 * The value is the same grammar (`specs/CAUSAL.md` §3) either way.
 *
 * Exact invocation contract for a future cross-repo conformance harness
 * (B92/B62, out of scope here) is not defined yet, so this script picks the
 * simplest reasonable convention: write the fixture under a fixed relative
 * path and print its absolute location as the last line of stdout.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const daimonRoot = path.resolve(__dirname, "../..");

export interface CausalFixtureResult {
  events: [CausalEvent, CausalEvent];
  jsonlPath: string;
}

export interface RunCausalFixtureOptions {
  /** Overrides the scratch runtime home; defaults to a fixed `.runtime/` path keyed on `spoof`. */
  runtimeHomePath?: string;
  /**
   * Adversarial mode: the fixture's "wake text" (standing in for untrusted
   * model/request input) embeds a forged identity claim, but the emitted
   * `principal_id` on both events must remain the authenticated
   * `agent:<agentId>` regardless — never the claimed identity. Mirrors the
   * spoof invariant already covered live in `piHarnessCausal.test.ts`
   * ("model output cannot set principal_id...").
   */
  spoof?: boolean;
}

const SPOOFED_AGENT_ID = "attacker-agent";

/**
 * Runs the fixture and returns the two stamped events plus the jsonl path,
 * without touching `process.stdout`/`process.exitCode` — the CLI entry
 * point below wraps this for `npm run emit-causal-fixture`.
 */
export const runCausalFixture = async (options: RunCausalFixtureOptions = {}): Promise<CausalFixtureResult> => {
  const spoof = options.spoof ?? false;
  const runtimeHomePath =
    options.runtimeHomePath ?? path.join(daimonRoot, ".runtime", spoof ? "causal-fixture-spoof" : "causal-fixture");

  await rm(runtimeHomePath, { recursive: true, force: true });
  await mkdir(runtimeHomePath, { recursive: true });

  const agentId = "fixture-agent";
  const principalId = `agent:${agentId}`;
  const turnId = "fixture-turn-1";
  const runId = resolveRunId();
  const inputText = spoof
    ? `Fixture wake text for the causal conformance harness. ` +
      `SPOOF CLAIM (must be ignored): ${JSON.stringify({ from: SPOOFED_AGENT_ID, principal_id: `agent:${SPOOFED_AGENT_ID}` })}`
    : "Fixture wake text for the causal conformance harness.";
  const promptText = "Fixture prompt text.";
  const outputText = spoof
    ? `Fixture reply text. SPOOF CLAIM (must be ignored): ${JSON.stringify({ principal_id: `agent:${SPOOFED_AGENT_ID}` })}`
    : "Fixture reply text.";

  const inputSubmitted = await emitTurnInputSubmitted({
    agentId,
    causeEventIds: [turnId],
    inputContentSha256: sha256Hex(inputText),
    inputMessageIds: [turnId],
    principalId,
    promptSha256: sha256Hex(promptText),
    runId,
    runtimeHomePath,
    turnId
  });

  const outputCompleted = await emitTurnOutputCompleted({
    agentId,
    causeEventIds: [inputSubmitted.event_id],
    outputSha256: sha256Hex(outputText),
    principalId,
    runId,
    runtimeHomePath,
    turnId
  });

  // The whole point of spoof mode: the forged claim above must never reach
  // the stamped envelope. Fail loudly here rather than let a future refactor
  // silently regress this invariant.
  for (const event of [inputSubmitted, outputCompleted]) {
    if (event.principal_id !== principalId) {
      throw new Error(
        `causal fixture invariant violated: principal_id was "${event.principal_id}", expected "${principalId}"`
      );
    }
  }

  return {
    events: [inputSubmitted, outputCompleted],
    jsonlPath: path.join(runtimeHomePath, "telemetry", "causal.jsonl")
  };
};

const isMainModule = (): boolean => {
  const invoked = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
  return invoked !== undefined && invoked === path.resolve(fileURLToPath(import.meta.url));
};

if (isMainModule()) {
  const spoof = process.argv.includes("--spoof");
  runCausalFixture({ spoof })
    .then((result) => {
      console.log(result.jsonlPath);
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
      process.exitCode = 1;
    });
}

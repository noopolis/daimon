import { GROK_BROKER_MODELS } from "../contracts/grokWorkerContract.js";
import { GROK_ENGINE_BROKER } from "../contracts/runtimeContractManifest.js";
import type { EngineBrokerTurnUsage } from "./engineBrokerTurnAccounting.js";
import type { GrokBrokerModel } from "./grokBrokerModelPolicy.js";
import { recordLedgerLines } from "./turnRequestLedger.js";

/**
 * Evaluator inference spend, one row per upstream model request of one grant.
 *
 * This is a separate stream at a separate path (`service.json`
 * `inferenceLedgerPath`), never the subject usage ledger: the org wake fuse and
 * Spawnfile's subject accounting sum that ledger, and a judge's tokens are not
 * a subject wake's. Rows carry `kind: "inference"` so a reader that is pointed
 * at the wrong file can still tell them apart (`wakeFuse.ts` skips them).
 *
 * Grants are not sealed in a durable registry: each request is appended when
 * it settles. `(grant, request)` identifies a row; readers dedupe on it
 * ({@link dedupeInferenceUsageRows}).
 */
export const INFERENCE_USAGE_LEDGER_VERSION = GROK_ENGINE_BROKER.inferenceGrants.ledgerVersion;
export const GROK_INFERENCE_PURPOSES = GROK_ENGINE_BROKER.inferenceGrants.purposes;
export type GrokInferencePurpose = (typeof GROK_INFERENCE_PURPOSES)[number];

export type InferenceUsageEntry = Readonly<{
  grant: string;
  purpose: GrokInferencePurpose;
  model: GrokBrokerModel;
  request: number;
  usage: EngineBrokerTurnUsage;
  usageSource: "upstream" | "estimated";
  startedAt: string;
  endedAt: string;
  at?: string;
}>;

export const renderInferenceUsageLine = (entry: InferenceUsageEntry): string => {
  if (!/^[a-f0-9]{32}$/u.test(entry.grant) || !(GROK_INFERENCE_PURPOSES as readonly string[]).includes(entry.purpose) || !(GROK_BROKER_MODELS as readonly string[]).includes(entry.model) || !Number.isSafeInteger(entry.request) || entry.request < 0) throw new TypeError("invalid inference usage entry");
  const { usage } = entry;
  return `${JSON.stringify({
    v: INFERENCE_USAGE_LEDGER_VERSION, kind: "inference", purpose: entry.purpose, grant: entry.grant, request: entry.request,
    at: entry.at ?? new Date().toISOString(), started_at: entry.startedAt, ended_at: entry.endedAt, model: entry.model,
    input: usage.input, cache_read: usage.cacheRead, cache_write: usage.cacheWrite, output: usage.output, total: usage.total,
    usage_source: entry.usageSource
  })}\n`;
};

/** Advisory, never rejects: an evaluator request that already spent tokens must not fail on its ledger. */
export const recordInferenceUsage = async (file: string, entry: InferenceUsageEntry): Promise<boolean> => {
  let line: string;
  try { line = renderInferenceUsageLine(entry); } catch { return false; }
  return recordLedgerLines(file, line);
};

/** Keeps the first row of each `(grant, request)`; rows without both keys are not inference rows and are dropped. */
export const dedupeInferenceUsageRows = <T extends Readonly<{ grant?: unknown; request?: unknown }>>(rows: readonly T[]): T[] => {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (typeof row.grant !== "string" || typeof row.request !== "number") return false;
    const key = `${row.grant}\0${row.request}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
};

/**
 * The closed model and reasoning-effort vocabulary a Grok broker worker may be
 * declared with.
 *
 * Both halves of one declaration are consumed from this single parser: the
 * worker `config.toml` renderer (`grokBrokerWorkerConfig.ts`) writes them into
 * the worker's only custom model, and the provider proxy
 * (`grokBrokerProxyRequest.ts`) refuses any request body that does not carry
 * exactly them. Nothing is inherited: Grok 1.0.34 silently drops an effort for
 * a model that does not declare effort support, and its embedded catalog
 * default for `grok-4.6` is `high`.
 */
import { GROK_BROKER_MODELS, GROK_BROKER_REASONING_EFFORTS } from "../contracts/grokWorkerContract.js";

export { GROK_BROKER_MODELS, GROK_BROKER_REASONING_EFFORTS };
export type GrokBrokerModel = (typeof GROK_BROKER_MODELS)[number];
export type GrokBrokerReasoningEffort = (typeof GROK_BROKER_REASONING_EFFORTS)[number];
export type GrokBrokerModelPolicy = Readonly<{ model: GrokBrokerModel; reasoningEffort: GrokBrokerReasoningEffort }>;

export const DEFAULT_GROK_BROKER_MODEL_POLICY: GrokBrokerModelPolicy = Object.freeze({ model: "grok-4.6", reasoningEffort: "low" });

export function parseGrokBrokerModelPolicy(value: unknown = {}): GrokBrokerModelPolicy {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("invalid Grok broker model policy");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== "model" && key !== "reasoningEffort")) throw new TypeError("invalid Grok broker model policy");
  const model = input.model ?? DEFAULT_GROK_BROKER_MODEL_POLICY.model;
  const reasoningEffort = input.reasoningEffort ?? DEFAULT_GROK_BROKER_MODEL_POLICY.reasoningEffort;
  if (!(GROK_BROKER_MODELS as readonly unknown[]).includes(model) || !(GROK_BROKER_REASONING_EFFORTS as readonly unknown[]).includes(reasoningEffort)) {
    throw new TypeError("invalid Grok broker model policy");
  }
  return Object.freeze({ model: model as GrokBrokerModel, reasoningEffort: reasoningEffort as GrokBrokerReasoningEffort });
}

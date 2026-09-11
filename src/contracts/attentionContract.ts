export type AttentionConfig = Readonly<{ maxBatchMessages?: number; maxBatchBytes?: number; maxExecutions?: number; maxTokens?: number }>;
/** Additive control surfaces; delivery receipts remain the v2 wire contract. */
const count = { type: "integer", minimum: 0 } as const;
const budget = { type: "object", additionalProperties: false, required: ["armed", "epoch", "state", "executions_used", "executions_remaining", "tokens_used", "tokens_remaining", "agent_executions_used", "agent_tokens_used"], properties: {
  armed: { type: "boolean" }, epoch: { type: "string" }, state: { enum: ["available", "paused", "stopped"] }, reason: { type: "string" },
  executions_used: count, executions_remaining: count, tokens_used: count, tokens_remaining: count,
  agent_executions_used: count, agent_executions_remaining: count, agent_tokens_used: count, agent_tokens_remaining: count
} } as const;
export const WORK_AVAILABILITY_SCHEMA = { type: "object", additionalProperties: false, required: ["version", "state", "agents"], properties: {
  version: { const: "noopolis.daimon.work-availability.v1" }, state: { enum: ["running", "paused", "stopped"] },
  agents: { type: "array", maxItems: 32, items: { type: "object", additionalProperties: false, required: ["agent_id", "pending", "running", "deferred", "budget"], properties: { agent_id: { type: "string" }, pending: count, running: { type: "boolean" }, deferred: count, budget, error: { type: "string" } } } }
} } as const;
export const WORK_BLOCKED_SCHEMA = { type: "object", additionalProperties: false, required: ["version", "reason", "retry_after_ms"], properties: {
  version: { const: "noopolis.daimon.work-blocked.v1" }, reason: { enum: ["operator_stop", "ledger_unavailable", "host_stopping", "host_stopped", "queue_full"] }, retry_after_ms: { type: "integer", minimum: 1000, maximum: 300000 }
} } as const;

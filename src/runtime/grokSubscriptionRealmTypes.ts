import type { OrganizationRuntimeAgentConfig } from "./organizationRuntime.js";

export type GrokAgent = OrganizationRuntimeAgentConfig & { engine: { kind: "grok" } };

export type GrokCredentialJournal = Readonly<{
  agent_id: string;
  promoted_digest?: string;
  source_digest: string;
  state: "active" | "preparing" | "promoted" | "promoting";
  version: "noopolis.daimon.grok-credential-lease.v1";
}>;

export type GrokSubscriptionRealm = Readonly<{
  withCredential<T>(agent: GrokAgent, operation: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}>;

export type GrokSubscriptionRealmOptions = Readonly<{
  bootstrapPath?: string;
  durablePath?: string;
  flock?: string;
  /** @internal deterministic crash-transition test seam. */
  onTransitionForTest?: (stage: "authority_replaced" | "promotion_prepared") => Promise<void> | void;
  shell?: string;
}>;

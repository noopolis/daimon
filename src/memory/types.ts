import type { WakeEvent } from "../core/types.js";

export interface MemoryPrincipalRef {
  agentId: string;
  scope: "global" | "team" | "room" | "pair" | "task" | "role" | "artifact";
  qualifier?: string;
}

export interface MemoryContext {
  networkId?: string;
  roomId?: string;
  teamId?: string;
  taskId?: string;
  roleId?: string;
  pairPeers?: string[];
  artifactPaths?: string[];
  from?: string;
}

export interface WakeMemoryContext extends MemoryContext {
  participants?: string[];
}

export type MemoryVisibility = "private" | "pair" | "team" | "room" | "global" | "public" | "sealed";

export type MemorySensitivity = "normal" | "sensitive" | "secret";

export type MemoryEventType =
  | "memory.observed"
  | "memory.claimed"
  | "memory.summarized"
  | "memory.recalled"
  | "memory.disclosed"
  | "memory.denied"
  | "memory.forgotten";

export type MemoryContent =
  | { kind: "text"; text: string }
  | { kind: "claim"; subject: string; predicate: string; object: string }
  | { kind: "decision"; decision: string; rationale?: string }
  | { kind: "artifact"; path?: string; uri?: string; description: string }
  | { kind: "relationship"; from: string; relation: string; to: string };

export interface MemoryEvent {
  id: string;
  type: MemoryEventType;
  createdAt: string;
  principal: MemoryPrincipalRef;
  scope: string;
  visibility: MemoryVisibility;
  source: string;
  content: MemoryContent;
  tags: string[];
  entities: string[];
  sensitivity: MemorySensitivity;
  ttl?: string;
  parentEventIds: string[];
  checksum: string;
}

export interface MemoryEventInput {
  type: MemoryEventType;
  principal: MemoryPrincipalRef;
  scope: string;
  visibility: MemoryVisibility;
  source: string;
  content: MemoryContent;
  tags?: string[];
  entities?: string[];
  sensitivity?: MemorySensitivity;
  ttl?: string;
  parentEventIds?: string[];
}

export type MemoryDecision =
  | "allow_raw"
  | "allow_summary"
  | "allow_redacted_summary"
  | "known_but_private"
  | "route_private_question"
  | "deny";

export interface MemoryPolicyInput {
  request: MemoryPrincipalRef;
  activeScope?: MemoryPrincipalRef;
  candidate: MemoryEvent;
}

export interface MemoryRecallAudit {
  totalCandidates: number;
  selectedEventIds: string[];
  selected?: Array<{
    eventId: string;
    decision: MemoryDecision;
    scope: string;
    representation: string;
  }>;
  decisions: Array<{
    eventId: string;
    decision: MemoryDecision;
    reason: string;
  }>;
  tokenBudgetUsed: number;
  redactionCount: number;
}

export interface MemoryPacket {
  principal: MemoryPrincipalRef;
  sections: Array<{
    heading: string;
    text: string;
  }>;
  rawHint?: string;
}

export interface MemoryPacketInput {
  activePrincipal: MemoryPrincipalRef;
  event: {
    id: string;
    kind: string;
    text: string;
    from?: string;
  };
  context: WakeMemoryContext;
  recalls: Array<{
    event: MemoryEvent;
    decision: MemoryDecision;
    representation: string;
    scope: string;
  }>;
}

export interface MemoryBrokerQuery {
  requester: MemoryPrincipalRef;
  query: string;
  activeContext?: WakeMemoryContext;
  maxResults?: number;
}

export interface MemoryDisclosureEnvelope {
  eventId: string;
  sourcePrincipal: MemoryPrincipalRef;
  decision: MemoryDecision;
  representation: string;
  reason: string;
  scope: string;
}

export interface MemoryBrokerResult {
  requestedBy: string;
  query: string;
  envelopes: MemoryDisclosureEnvelope[];
  totalMatches: number;
}

export interface MemoryRecallRequest {
  eventId: string;
  kind: WakeEvent["kind"];
  text: string;
  from?: string;
  context: WakeMemoryContext;
  tokenBudget?: number;
}

export interface MemoryPrepareTurnResult {
  principal: MemoryPrincipalRef;
  packet: MemoryPacket;
  promptText: string;
  recall: MemoryRecallAudit;
}

export interface MemoryTurnRecord {
  principal: MemoryPrincipalRef;
  prompt: MemoryPacket;
  request: MemoryRecallRequest;
  recall?: MemoryRecallAudit;
  result: "completed" | "failed";
  outputText: string;
  toolEvents?: unknown[];
  error?: string;
}

export interface MemoryRuntime {
  prepareTurn(request: MemoryRecallRequest): Promise<MemoryPrepareTurnResult>;
  recordTurn(input: MemoryTurnRecord): Promise<void>;
  broker: {
    lookup(input: MemoryBrokerQuery): Promise<MemoryBrokerResult>;
  };
}

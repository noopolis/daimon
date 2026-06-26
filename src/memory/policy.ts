import { canonicalPrincipalKey, sanitizePrincipalQualifier } from "./ids.js";
import type {
  MemoryDecision,
  MemoryPolicyInput,
  MemoryVisibility,
  MemorySensitivity,
  MemoryPrincipalRef
} from "./types.js";

const isPairMatch = (
  request: MemoryPrincipalRef,
  source: MemoryPrincipalRef,
  candidateVisibility: MemoryVisibility
): boolean => {
  if (candidateVisibility !== "pair" && candidateVisibility !== "private") {
    return false;
  }

  if (request.scope === "pair" && source.scope === "pair") {
    return sanitizePrincipalQualifier(request.qualifier) === sanitizePrincipalQualifier(source.qualifier);
  }

  return request.agentId === source.agentId && request.qualifier !== undefined && source.qualifier !== undefined
    ? request.qualifier.toLowerCase() === source.qualifier.toLowerCase()
    : false;
};

const samePrincipal = (a: MemoryPrincipalRef, b: MemoryPrincipalRef): boolean =>
  a.agentId === b.agentId && a.scope === b.scope &&
  sanitizePrincipalQualifier(a.qualifier) === sanitizePrincipalQualifier(b.qualifier);

const roomMatch = (a: MemoryPrincipalRef, b: MemoryPrincipalRef): boolean =>
  a.scope === "room" && b.scope === "room" && a.agentId === b.agentId &&
  sanitizePrincipalQualifier(a.qualifier) === sanitizePrincipalQualifier(b.qualifier);

const teamMatch = (a: MemoryPrincipalRef, b: MemoryPrincipalRef): boolean =>
  a.scope === "team" && b.scope === "team" && a.agentId === b.agentId &&
  sanitizePrincipalQualifier(a.qualifier) === sanitizePrincipalQualifier(b.qualifier);

const roleMatch = (a: MemoryPrincipalRef, b: MemoryPrincipalRef): boolean =>
  a.scope === "role" && b.scope === "role" && a.agentId === b.agentId &&
  sanitizePrincipalQualifier(a.qualifier) === sanitizePrincipalQualifier(b.qualifier);

const scopePriority = (request: MemoryPrincipalRef, candidate: MemoryPrincipalRef): number => {
  if (samePrincipal(request, candidate)) {
    return 100;
  }
  if (roomMatch(request, candidate) || roleMatch(request, candidate)) {
    return 80;
  }
  if (teamMatch(request, candidate)) {
    return 70;
  }
  if (request.scope === "pair" && candidate.scope === "pair") {
    return 90;
  }
  return 40;
};

export const memoryPolicy = ({ request, candidate }: MemoryPolicyInput): {
  decision: MemoryDecision;
  reason: string;
} => {
  const visible = candidate.visibility;
  const sensitive = candidate.sensitivity;
  if (samePrincipal(request, candidate.principal)) {
    return {
      decision: "allow_raw",
      reason: "same principal"
    };
  }

  if (visible === "sealed") {
    return {
      decision: "deny",
      reason: "sealed content"
    };
  }

  if (visible === "private") {
    return {
      decision: request.scope === "pair" ? "route_private_question" : "known_but_private",
      reason: "private visibility"
    };
  }

  if (visible === "pair") {
    return isPairMatch(request, candidate.principal, visible)
      ? {
        decision: sensitive === "secret" ? "allow_summary" : "allow_raw",
        reason: "pair scope match"
      }
      : {
        decision: "known_but_private",
        reason: "pair visibility mismatch"
      };
  }

  if (visible === "team" && teamMatch(request, candidate.principal)) {
    if (sensitive === "secret") {
      return {
        decision: "allow_summary",
        reason: "team scope match with sensitive visibility"
      };
    }
    return {
      decision: "allow_summary",
      reason: "team scope match"
    };
  }

  if (visible === "room" && roomMatch(request, candidate.principal)) {
    if (sensitive === "secret") {
      return {
        decision: "allow_redacted_summary",
        reason: "room scope match with secret visibility"
      };
    }
    return {
      decision: "allow_summary",
      reason: "room scope match"
    };
  }

  if (visible === "global" && candidate.principal.scope === "global") {
    return {
      decision: "allow_summary",
      reason: "global visibility"
    };
  }

  if (visible === "public") {
    return {
      decision: "allow_summary",
      reason: "public visibility"
    };
  }

  return {
    decision: "deny",
    reason: "scope mismatch"
  };
};

export const memoryPriority = (request: MemoryPrincipalRef, candidate: MemoryPrincipalRef): number =>
  scopePriority(request, candidate);

export const shouldRecordDecisionEvent = (decision: MemoryDecision): boolean =>
  decision !== "allow_summary" && decision !== "allow_raw";

export const principalKey = canonicalPrincipalKey;

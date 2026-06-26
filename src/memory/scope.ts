import type { WakeEvent } from "../core/types.js";
import type { WakeMemoryContext, MemoryPrincipalRef, MemoryContext } from "./types.js";

export interface ResolvedScopePlan {
  activePrincipal: MemoryPrincipalRef;
  readableScopes: MemoryPrincipalRef[];
  brokerCandidates: MemoryPrincipalRef[];
  deniedScopes: MemoryPrincipalRef[];
}

const roomPrincipal = (agentId: string, context?: WakeMemoryContext): MemoryPrincipalRef | undefined => {
  if (!context?.networkId || !context.roomId) {
    return undefined;
  }
  return {
    agentId,
    scope: "room",
    qualifier: `${context.networkId}:${context.roomId}`
  };
};

const teamPrincipal = (agentId: string, context?: WakeMemoryContext): MemoryPrincipalRef | undefined => {
  if (!context?.teamId) {
    return undefined;
  }
  return {
    agentId,
    scope: "team",
    qualifier: context.teamId
  };
};

const pairPrincipals = (
  agentId: string,
  context?: WakeMemoryContext
): MemoryPrincipalRef[] => {
  const peers = context?.pairPeers ?? [];
  return peers
    .filter((peer) => peer.trim().length > 0)
    .map((peer) => ({
      agentId,
      scope: "pair",
      qualifier: peer.trim().toLowerCase()
    }));
};

const taskPrincipal = (agentId: string, context?: WakeMemoryContext): MemoryPrincipalRef | undefined => {
  if (!context?.taskId) {
    return undefined;
  }
  return {
    agentId,
    scope: "task",
    qualifier: context.taskId
  };
};

const rolePrincipal = (agentId: string, context?: WakeMemoryContext): MemoryPrincipalRef | undefined => {
  if (!context?.roleId) {
    return undefined;
  }
  return {
    agentId,
    scope: "role",
    qualifier: context.roleId
  };
};

export const resolveScopePlan = (input: {
  agentId: string;
  context?: WakeMemoryContext;
  wake: Pick<WakeEvent, "kind" | "from" | "id">;
}): ResolvedScopePlan => {
  const fromPeer = input.context?.from;
  const room = roomPrincipal(input.agentId, input.context);
  const team = teamPrincipal(input.agentId, input.context);
  const task = taskPrincipal(input.agentId, input.context);
  const role = rolePrincipal(input.agentId, input.context);
  const fromPair: MemoryPrincipalRef[] = fromPeer ? [{
    agentId: input.agentId,
    scope: "pair" as const,
    qualifier: fromPeer
  }] : [];

  const isMessage = input.wake.kind === "message" || input.wake.kind === "manual";

  const activePrincipal: MemoryPrincipalRef = (
    (isMessage && fromPair.length > 0) ? fromPair[0]
    : room ? room
    : team ? team
    : task ? task
    : role ? role
    : {
      agentId: input.agentId,
      scope: "global"
    }
  );

  const readableScopes = [
    activePrincipal,
    room,
    team,
    task,
    role
  ].filter((value): value is MemoryPrincipalRef => Boolean(value));

  const pairEntries = pairPrincipals(input.agentId, input.context);
  const fromPairScope = fromPair[0];

  if (isMessage && (pairEntries.length > 0 || fromPairScope)) {
    const pairs = [...pairEntries, ...(fromPairScope ? [fromPairScope] : [])];
    readableScopes.push(...pairs);
  }

  const brokerCandidates = [
    roomPrincipal(input.agentId, input.context),
    teamPrincipal(input.agentId, input.context),
    ...pairEntries,
    taskPrincipal(input.agentId, input.context),
    rolePrincipal(input.agentId, input.context)
  ].filter((value): value is MemoryPrincipalRef => Boolean(value));

  const deniedScopes: MemoryPrincipalRef[] = [];

  return {
    activePrincipal,
    readableScopes,
    brokerCandidates,
    deniedScopes
  };
};

export const readMemoryContext = (
  event: Pick<WakeEvent, "kind" | "from" | "text"> & { id?: string; context?: WakeMemoryContext }
): WakeMemoryContext => {
  const context = event.context ?? {};

  const participants = (context as WakeMemoryContext).participants;
  const pairPeers = context.pairPeers ?? participants;
  const resolvedParticipants = participants ?? pairPeers;

  return {
    from: event.from ?? context.from,
    networkId: context.networkId,
    roomId: context.roomId,
    teamId: context.teamId,
    taskId: context.taskId,
    roleId: context.roleId,
    pairPeers,
    artifactPaths: context.artifactPaths,
    participants: resolvedParticipants
  };
};

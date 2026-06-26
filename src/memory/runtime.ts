import type { WakeEvent } from "../core/types.js";
import { JsonlMemoryStore } from "./store.js";
import { runRecall, buildWakePacketText } from "./recall.js";
import type {
  MemoryDecision,
  MemoryDisclosureEnvelope,
  MemoryEvent,
  MemoryEventInput,
  MemoryPacket,
  MemoryPrepareTurnResult,
  MemoryRecallAudit,
  MemoryRecallRequest,
  MemoryRuntime,
  MemoryTurnRecord,
  MemoryBrokerQuery,
  MemoryBrokerResult,
  MemoryPrincipalRef,
  WakeMemoryContext
} from "./types.js";
import { memoryScopeId, makeEventId } from "./ids.js";
import { readMemoryContext, resolveScopePlan } from "./scope.js";

type WakeKind = WakeEvent["kind"];

export interface MemoryBrokerEntry {
  event: MemoryEvent;
  decision: MemoryDecision;
  representation: string;
  scope: string;
}

const defaultTokenBudget = 1200;
const defaultSourcePrefix = "daimon";

const defaultSource = (agentId: string): string => `${defaultSourcePrefix}/${agentId}`;

const clampTokenBudget = (value: number | undefined): number => {
  if (!value || Number.isNaN(value) || value <= 0) {
    return defaultTokenBudget;
  }
  return Math.max(128, Math.floor(value));
};

const trimText = (value: string, maxLength: number): string => {
  const normalized = value.trim();
  return normalized.length <= maxLength ? normalized : normalized.slice(0, maxLength).trim();
};

const normalizeScopeIds = (ids: string[]): string[] => {
  return [...new Set(ids.map((value) => value.trim().toLowerCase()).filter(Boolean))];
};

const extractTokens = (text: string): string[] => {
  const payload = `${text}`.toLowerCase();
  return [...new Set(payload
    .split(/[^a-z0-9]+/u)
    .map((value) => value.trim())
    .filter((value) => value.length > 3)
  )].slice(0, 32);
};

const readByScopes = async (
  store: JsonlMemoryStore,
  scopeIds: string[]
): Promise<MemoryEvent[]> => {
  const queries = await Promise.all(scopeIds.map((scope) => store.read({ scope })));
  const seen = new Set<string>();
  const events: MemoryEvent[] = [];

  for (const event of queries.flat()) {
    if (seen.has(event.id)) {
      continue;
    }
    seen.add(event.id);
    events.push(event);
  }

  return events;
};

const buildRecallInput = (input: {
  actor: MemoryPrincipalRef;
  scopeIds: string[];
  events: MemoryEvent[];
  text: string;
  maxTokens?: number;
}): ReturnType<typeof runRecall> => {
  return runRecall({
    actor: input.actor,
    scopeIds: input.scopeIds,
    events: input.events,
    query: input.text,
    maxTokens: clampTokenBudget(input.maxTokens)
  });
};

const toDecisionText = (decision: MemoryDecision): string => {
  return decision === "allow_raw" ? "used raw"
    : decision === "allow_summary" ? "used summary"
      : decision === "allow_redacted_summary" ? "used redacted summary"
        : decision === "known_but_private" ? "used private memory via scope policy"
          : decision === "route_private_question" ? "routed private context"
            : "denied by policy";
};

const memoryTagsFromRequest = (
  request: MemoryRecallRequest,
  packet: MemoryPacket,
  result: MemoryPrepareTurnResult
): string[] => {
  const context = request.context ?? {};
  const tokens = [
    ...extractTokens(request.text),
    ...extractTokens(packet.principal.scope),
    request.kind,
    result.principal.scope,
    ...extractTokens(result.principal.qualifier ?? ""),
    ...context.networkId ? [context.networkId] : [],
    ...context.roomId ? [context.roomId] : []
  ];
  return [...new Set(tokens)].slice(0, 64);
};

const baseEventInput = (input: {
  principal: MemoryPrincipalRef;
  scope: string;
  source: string;
  visibility: "global" | "pair" | "team" | "room" | "private" | "public" | "sealed";
  tags: string[];
  entities: string[];
  parentEventIds: string[];
}): Omit<MemoryEventInput, "content" | "type"> => {
  return {
    principal: input.principal,
    scope: input.scope,
    visibility: input.visibility,
    source: input.source,
    parentEventIds: input.parentEventIds,
    tags: input.tags,
    entities: input.entities,
    sensitivity: "normal"
  };
};

const buildDecisionEvents = (input: {
  principal: MemoryPrincipalRef;
  scope: string;
  source: string;
  request: MemoryRecallRequest;
  packet: MemoryPacket;
  recall: MemoryRecallAudit;
  result: MemoryTurnRecord["result"];
  outputText: string;
  error?: string;
  parentEventIds: string[];
}): MemoryEventInput[] => {
  const entities = [
    ...extractTokens(input.request.text),
    ...extractTokens(input.packet.principal.agentId),
    ...extractTokens(input.packet.principal.scope)
  ];

  const tags = memoryTagsFromRequest(input.request, input.packet, {
    principal: input.principal,
    packet: input.packet,
    promptText: input.outputText,
    recall: input.recall
  });

  const base = baseEventInput({
    principal: input.principal,
    scope: input.scope,
    source: input.source,
    visibility: "global",
    tags,
    entities,
    parentEventIds: input.parentEventIds
  });

  const events: MemoryEventInput[] = [
    {
      ...base,
      type: "memory.claimed",
      content: {
        kind: "text",
        text: `Wake request ${input.request.eventId} from ${input.request.from ?? "operator"}: ${trimText(input.request.text, 480)}`
      }
    },
    {
      ...base,
      type: "memory.observed",
      tags: [...tags, "output", input.result],
      content: {
        kind: "text",
        text: `Agent output: ${trimText(input.outputText, 620)}`
      }
    }
  ];

  for (const selected of input.recall.selected ?? []) {
    events.push({
      ...base,
      type: "memory.recalled",
      tags: [...tags, "memory", selected.decision, selected.scope],
      content: {
        kind: "text",
        text: `Recalled ${selected.eventId}: ${selected.representation}. Decision=${toDecisionText(selected.decision)} (${selected.scope})`
      },
      entities: [...entities, selected.eventId]
    });
  }

  if (input.result === "failed" && input.error) {
    events.push({
      ...base,
      type: "memory.denied",
      tags: [...tags, "failed"],
      content: {
        kind: "text",
        text: `Turn failed: ${trimText(input.error, 480)}`
      }
    });
  }

  if (input.packet.sections.length > 0) {
    for (const section of input.packet.sections) {
      events.push({
        ...base,
        type: "memory.observed",
        tags: [...tags, "section", section.heading.toLowerCase()],
        content: {
          kind: "text",
          text: `${section.heading}: ${trimText(section.text, 420)}`
        },
        entities: [...entities, ...extractTokens(section.heading), ...extractTokens(section.text)]
      });
    }
  }

  return events;
};

const selectToolSummary = (toolEvents: unknown[]): MemoryEventInput | undefined => {
  if (!Array.isArray(toolEvents) || toolEvents.length === 0) {
    return undefined;
  }

  return {
    principal: {
      agentId: "daimon",
      scope: "global"
    },
    type: "memory.summarized",
    scope: "global",
    visibility: "global",
    source: "daimon/tool",
    content: {
      kind: "text",
      text: `Observed ${toolEvents.length} tool event(s) during turn.`
    },
    tags: ["tool", "summary"],
    entities: ["tool"],
    parentEventIds: []
  };
};

const runBrokerSelection = (input: {
  requester: MemoryPrincipalRef;
  scopeIds: string[];
  events: MemoryEvent[];
  query: string;
  maxResults?: number;
}): MemoryBrokerEntry[] => {
  const selection = runRecall({
    actor: input.requester,
    scopeIds: input.scopeIds,
    events: input.events,
    query: input.query,
    maxTokens: clampTokenBudget((input.maxResults ?? 1) * 160)
  });

  const limited = input.maxResults !== undefined ? selection.selected.slice(0, input.maxResults) : selection.selected;
  return limited.map((entry) => ({
    event: entry.event,
    decision: entry.decision,
    representation: entry.representation,
    scope: entry.scope
  }));
};

const resolveContextFromRequest = (request: MemoryRecallRequest): WakeMemoryContext => {
  return readMemoryContext({
    kind: request.kind,
    from: request.from,
    text: request.text,
    id: request.eventId,
    context: request.context
  });
};

export interface JsonlMemoryRuntimeConfig {
  agentId: string;
  runtimeHomePath: string;
  source?: string;
  tokenBudget?: number;
}

export class JsonlMemoryRuntime implements MemoryRuntime {
  private readonly store: JsonlMemoryStore;
  private readonly source: string;
  private readonly defaultTokenBudget: number;

  constructor(private readonly options: JsonlMemoryRuntimeConfig) {
    this.store = new JsonlMemoryStore(options.runtimeHomePath);
    this.source = options.source ?? defaultSource(options.agentId);
    this.defaultTokenBudget = clampTokenBudget(options.tokenBudget);
  }

  async prepareTurn(request: MemoryRecallRequest): Promise<MemoryPrepareTurnResult> {
    const context = resolveContextFromRequest(request);
    const scopePlan = resolveScopePlan({
      agentId: this.options.agentId,
      context,
      wake: {
        id: request.eventId,
        kind: request.kind,
        from: request.from
      }
    });

    const scopeIds = normalizeScopeIds(scopePlan.readableScopes.map(memoryScopeId));
    const events = await readByScopes(this.store, scopeIds);
    const recall = buildRecallInput({
      actor: scopePlan.activePrincipal,
      scopeIds,
      events,
      text: request.text,
      maxTokens: request.tokenBudget ?? this.defaultTokenBudget
    });

    const wakeText = [
      "## Wake",
      `id: ${request.eventId}`,
      `kind: ${request.kind}`,
      `from: ${request.from ?? "operator"}`,
      `network: ${context.networkId ?? "global"}`,
      `room: ${context.roomId ?? "global"}`,
      "",
      request.text
    ].join("\n");

    const promptText = buildWakePacketText(context, wakeText, recall.packet);

    return {
      principal: scopePlan.activePrincipal,
      packet: recall.packet,
      promptText,
      recall: recall.audit
    };
  }

  async recordTurn(input: MemoryTurnRecord): Promise<void> {
    const scope = memoryScopeId(input.principal);
    const parentEventIds = (await this.store.read({
      principalAgentId: input.principal.agentId,
      principalScope: input.principal.scope
    })).map((event) => event.id);

    const recall = input.recall ?? {
      totalCandidates: 0,
      selectedEventIds: [],
      selected: [],
      decisions: [],
      tokenBudgetUsed: 0,
      redactionCount: 0
    };

    const events: MemoryEventInput[] = buildDecisionEvents({
      principal: input.principal,
      scope,
      source: this.source,
      request: input.request,
      packet: input.prompt,
      recall,
      result: input.result,
      outputText: input.outputText,
      error: input.error,
      parentEventIds
    });

    const toolSummary = selectToolSummary(input.toolEvents ?? []);
    if (toolSummary) {
      toolSummary.parentEventIds = parentEventIds;
      toolSummary.scope = scope;
      toolSummary.principal = input.principal;
      events.push(toolSummary);
    }

    await this.store.appendBatch(events);
  }

  get broker() {
    return {
      lookup: async (input: MemoryBrokerQuery): Promise<MemoryBrokerResult> => {
        const context = resolveContextFromRequest({
          eventId: `lookup:${makeEventId()}`,
          kind: "message",
          text: input.query,
          context: input.activeContext ?? {},
          tokenBudget: undefined
        });

        const scopePlan = resolveScopePlan({
          agentId: input.requester.agentId,
          context,
          wake: {
            id: `lookup:${makeEventId()}`,
            kind: "message" as WakeKind,
            from: input.requester.agentId
          }
        });

        const readableScopeIds = normalizeScopeIds([
          memoryScopeId(scopePlan.activePrincipal),
          ...scopePlan.readableScopes.map(memoryScopeId),
          ...scopePlan.brokerCandidates.map(memoryScopeId)
        ]);

        const candidates = await readByScopes(this.store, readableScopeIds);
        const selected = runBrokerSelection({
          requester: scopePlan.activePrincipal,
          scopeIds: readableScopeIds,
          events: candidates,
          query: input.query,
          maxResults: input.maxResults
        });

        const envelopes: MemoryDisclosureEnvelope[] = selected.map((entry) => ({
          eventId: entry.event.id,
          sourcePrincipal: entry.event.principal,
          decision: entry.decision,
          representation: entry.representation,
          reason: "memory match",
          scope: entry.scope
        }));

        return {
          requestedBy: input.requester.agentId,
          query: input.query,
          envelopes,
          totalMatches: candidates.length
        };
      }
    };
  }
}

export const createMemoryRuntime = (options: JsonlMemoryRuntimeConfig): MemoryRuntime =>
  new JsonlMemoryRuntime(options);

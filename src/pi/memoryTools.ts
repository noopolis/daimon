import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";

import { canonicalScopeKey, createMemoryToolDescriptors, memoryScopeId } from "@noopolis/mneme";
import type {
  MemoryPrepareTurnResult,
  MemoryRuntime,
  MemoryToolExecutionContext,
  MemoryToolResult,
  MemoryWakeMode
} from "@noopolis/mneme";

export interface PiMemoryToolContextRef {
  current?: MemoryToolExecutionContext;
  observeTool?: (event: PiMemoryToolTraceEvent) => void;
}

export interface PiMemoryToolTraceEvent {
  contentCount?: number;
  decision?: string;
  durationMs: number;
  error?: string;
  kind: "memory";
  name: string;
  redactionCount?: number;
  status: "completed" | "failed";
}

interface PiMemoryToolInput {
  agentId: string;
  memory: MemoryRuntime;
  contextRef: PiMemoryToolContextRef;
  mode?: MemoryWakeMode;
}

type PiMemoryTool = ToolDefinition<any, unknown>;

const MAX_ALLOWED_SCOPES = 32;
const MEMORY_PRINCIPAL_SCOPES = new Set([
  "artifact",
  "global",
  "pair",
  "role",
  "room",
  "task",
  "team"
]);

const trustedAllowedScopes = (
  agentId: string,
  prepared: MemoryPrepareTurnResult
): ReadonlyArray<string> => {
  if (!Array.isArray(prepared.allowedScopes)
    || prepared.allowedScopes.length === 0
    || prepared.allowedScopes.length > MAX_ALLOWED_SCOPES) {
    throw new Error("prepared memory turn requires a bounded finite scope set");
  }

  const scopes = prepared.allowedScopes.map((scope) => {
    if (typeof scope !== "string" || scope !== canonicalScopeKey(scope)
      || scope.length > 512 || /[\u0000-\u001f\u007f]/u.test(scope)) {
      throw new Error("prepared memory turn contains an invalid scope");
    }
    return scope;
  });
  const agentPrefix = canonicalScopeKey(`agent:${agentId}/scope:`);
  if (new Set(scopes).size !== scopes.length || scopes.some((scope) => !scope.startsWith(agentPrefix))) {
    throw new Error("prepared memory turn contains a foreign or duplicate scope");
  }
  const activeScope = canonicalScopeKey(memoryScopeId(prepared.principal));
  if (!scopes.includes(activeScope)) {
    throw new Error("prepared memory turn omits its active principal scope");
  }
  return Object.freeze([...scopes]);
};

export const createTrustedPiMemoryToolContext = (input: {
  agentId: string;
  memory: MemoryRuntime;
  mode: MemoryWakeMode;
  prepared: MemoryPrepareTurnResult;
  threadId: string;
  wakeId: string;
}): MemoryToolExecutionContext => {
  if (input.prepared.principal.agentId !== input.agentId
    || input.memory.authority.bankId !== input.agentId) {
    throw new Error("prepared memory authority does not match the Pi agent");
  }
  if (!MEMORY_PRINCIPAL_SCOPES.has(input.prepared.principal.scope)) {
    throw new Error("prepared memory turn contains an invalid principal scope");
  }
  const principal = Object.freeze({ ...input.prepared.principal });
  const activeScope = canonicalScopeKey(memoryScopeId(principal));
  return Object.freeze({
    allowedScopes: trustedAllowedScopes(input.agentId, input.prepared),
    audienceKey: activeScope,
    authority: input.memory.authority,
    conversationScope: activeScope,
    mode: input.mode,
    principal,
    threadId: input.threadId,
    transport: "in_process",
    wakeId: input.wakeId
  });
};

const requireTrustedContext = (
  agentId: string,
  contextRef: PiMemoryToolContextRef
): MemoryToolExecutionContext => {
  const context = contextRef.current;
  if (context === undefined
    || context.principal.agentId !== agentId
    || context.authority?.bankId !== agentId
    || !Array.isArray(context.allowedScopes)) {
    throw new Error("Pi memory tool requires the active trusted turn context");
  }
  return context;
};

const textContent = (result: MemoryToolResult) => ({
  content: [{ type: "text" as const, text: JSON.stringify(result) }],
  details: result
});

const MEMORY_TOOL_ARGUMENT_FIELDS: Readonly<Record<string, ReadonlySet<string>>> = {
  memory_forget: new Set(["event_ids", "reason", "scope"]),
  memory_locate: new Set(["active_scope", "limit", "query"]),
  memory_promote: new Set(["memory_id", "reason", "scope"]),
  memory_register: new Set([
    "confidence",
    "content",
    "evidence_event_ids",
    "kind",
    "memory_id",
    "scope",
    "sensitivity",
    "source_type",
    "visibility"
  ]),
  memory_search: new Set(["limit", "query", "scope"]),
  memory_summarize: new Set(["horizon", "scope"])
};

const requireExactModelArguments = (toolName: string, params: unknown): void => {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new Error("Pi memory tool arguments must be an object");
  }
  const allowed = MEMORY_TOOL_ARGUMENT_FIELDS[toolName];
  if (allowed === undefined) {
    throw new Error(`Pi memory tool ${toolName} has no argument contract`);
  }
  for (const field of Reflect.ownKeys(params)) {
    if (typeof field !== "string" || !allowed.has(field)) {
      throw new Error(`Pi memory tool ${toolName} received unexpected top-level argument ${String(field)}`);
    }
  }
};

const contentSchema = Type.Object({
  kind: Type.String({ description: "Memory content kind: text, claim, decision, artifact, or relationship." })
}, { additionalProperties: true });

const schemaFor = (name: string) => {
  if (name === "memory_search") {
    return Type.Object({
      scope: Type.String({ description: "Scope alias or canonical scope id. Use current, global, or all when appropriate." }),
      query: Type.String({ description: "Search query." }),
      limit: Type.Optional(Type.Number({ description: "Maximum result count." }))
    }, { additionalProperties: false });
  }
  if (name === "memory_locate") {
    return Type.Object({
      query: Type.String({ description: "What to locate in memory." }),
      limit: Type.Optional(Type.Number({ description: "Maximum candidate count." })),
      active_scope: Type.Optional(Type.String({ description: "Optional active scope hint." }))
    }, { additionalProperties: false });
  }
  if (name === "memory_register") {
    return Type.Object({
      scope: Type.String({ description: "Scope alias or canonical scope id where the memory belongs." }),
      kind: Type.String({ description: "Memory content kind." }),
      content: contentSchema,
      visibility: Type.String({ description: "private, pair, team, room, global, public, or sealed." }),
      sensitivity: Type.String({ description: "normal, sensitive, or secret." }),
      evidence_event_ids: Type.Array(Type.String(), { description: "Event ids that justify the memory." }),
      source_type: Type.String({ description: "Source label for the registered memory." }),
      confidence: Type.Optional(Type.Number({ description: "Confidence from 0 to 1." })),
      memory_id: Type.Optional(Type.String({ description: "Existing memory chain id for a new revision." }))
    }, { additionalProperties: false });
  }
  if (name === "memory_summarize") {
    return Type.Object({
      scope: Type.String({ description: "Scope alias or canonical scope id to summarize." }),
      horizon: Type.Optional(Type.Number({ description: "Approximate number of recent memories to include." }))
    }, { additionalProperties: false });
  }
  if (name === "memory_promote") {
    return Type.Object({
      scope: Type.String({ description: "Scope alias or canonical scope id the memory belongs to." }),
      memory_id: Type.String({ description: "Current memory chain head to promote." }),
      reason: Type.Optional(Type.String({ description: "Why this memory is being promoted." }))
    }, { additionalProperties: false });
  }
  return Type.Object({
    scope: Type.String({ description: "Scope alias or canonical scope id for the tombstone." }),
    event_ids: Type.Array(Type.String(), { description: "Memory event ids to tombstone." }),
    reason: Type.Optional(Type.String({ description: "Why these memories should be forgotten." }))
  }, { additionalProperties: false });
};

export const createPiMemoryTools = (input: PiMemoryToolInput): PiMemoryTool[] =>
  createMemoryToolDescriptors(input.memory.kernel, { mode: input.mode ?? "awake" }).map((descriptor) =>
    defineTool({
      name: descriptor.modelName,
      label: descriptor.label,
      description: descriptor.description,
      promptSnippet: descriptor.promptSnippet,
      promptGuidelines: descriptor.promptGuidelines,
      parameters: schemaFor(descriptor.modelName),
      async execute(_toolCallId, params) {
        const startedAt = Date.now();
        try {
          requireExactModelArguments(descriptor.modelName, params);
          const result = await descriptor.invoke(
            params as Record<string, unknown>,
            requireTrustedContext(input.agentId, input.contextRef)
          );
          input.contextRef.observeTool?.({
            contentCount: result.content.length,
            decision: result.decision,
            durationMs: Date.now() - startedAt,
            kind: "memory",
            name: descriptor.modelName,
            redactionCount: result.content.reduce((total, content) => total + content.redactions.length, 0),
            status: "completed"
          });
          return textContent(result);
        } catch (error) {
          input.contextRef.observeTool?.({
            durationMs: Date.now() - startedAt,
            error: error instanceof Error ? error.message : String(error),
            kind: "memory",
            name: descriptor.modelName,
            status: "failed"
          });
          throw error;
        }
      }
    })
  );

export const piMemoryToolNames = (tools: PiMemoryTool[]): string[] =>
  tools.map((tool) => tool.name);

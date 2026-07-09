import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";

import { createMemoryToolDescriptors } from "@noopolis/mneme";
import type { MemoryRuntime, MemoryToolExecutionContext, MemoryToolResult, MemoryWakeMode } from "@noopolis/mneme";

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

const fallbackContext = (agentId: string): MemoryToolExecutionContext => ({
  wakeId: "manual",
  threadId: "manual",
  principal: { agentId, scope: "global" },
  conversationScope: "global",
  audienceKey: agentId,
  transport: "in_process"
});

const textContent = (result: MemoryToolResult) => ({
  content: [{ type: "text" as const, text: JSON.stringify(result) }],
  details: result
});

const contentSchema = Type.Object({
  kind: Type.String({ description: "Memory content kind: text, claim, decision, artifact, or relationship." })
}, { additionalProperties: true });

const schemaFor = (name: string) => {
  if (name === "memory_search") {
    return Type.Object({
      scope: Type.String({ description: "Scope alias or canonical scope id. Use current, global, or all when appropriate." }),
      query: Type.String({ description: "Search query." }),
      limit: Type.Optional(Type.Number({ description: "Maximum result count." }))
    });
  }
  if (name === "memory_locate") {
    return Type.Object({
      query: Type.String({ description: "What to locate in memory." }),
      limit: Type.Optional(Type.Number({ description: "Maximum candidate count." })),
      active_scope: Type.Optional(Type.String({ description: "Optional active scope hint." }))
    });
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
      confidence: Type.Optional(Type.Number({ description: "Confidence from 0 to 1." }))
    });
  }
  if (name === "memory_summarize") {
    return Type.Object({
      scope: Type.String({ description: "Scope alias or canonical scope id to summarize." }),
      horizon: Type.Optional(Type.Number({ description: "Approximate number of recent memories to include." }))
    });
  }
  return Type.Object({
    scope: Type.String({ description: "Scope alias or canonical scope id for the tombstone." }),
    event_ids: Type.Array(Type.String(), { description: "Memory event ids to tombstone." }),
    reason: Type.Optional(Type.String({ description: "Why these memories should be forgotten." }))
  });
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
          const result = await descriptor.invoke(
            params as Record<string, unknown>,
            input.contextRef.current ?? fallbackContext(input.agentId)
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

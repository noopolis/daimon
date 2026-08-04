import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type ServerNotification,
  type ServerRequest
} from "@modelcontextprotocol/sdk/types.js";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export class McpToolTurnLimitError extends Error {
  public constructor(maxToolTurns: number) {
    super(`McpToolTurnLimitError: maximum ${maxToolTurns} calls per wake`);
    this.name = "McpToolTurnLimitError";
  }
}

export class McpWakeDeadlineError extends Error {
  public constructor() {
    super("McpWakeDeadlineError: wake deadline exceeded");
    this.name = "McpWakeDeadlineError";
  }
}

export interface PiToolMcpServerOptions {
  readonly maxToolTurns: number;
  readonly wakeDeadline: number;
}

type JsonSchema = Record<string, unknown>;

const jsonSchema = (parameters: unknown): JsonSchema => {
  if (parameters === null || typeof parameters !== "object" || Array.isArray(parameters)) {
    throw new TypeError("Pi tool parameters must be a JSON schema object");
  }
  return Object.fromEntries(Object.entries(parameters));
};

const toolResult = (result: { content: CallToolResult["content"]; details?: unknown }): CallToolResult => ({
  content: result.content,
  ...(result.details !== undefined && typeof result.details === "object" && result.details !== null
    ? { structuredContent: Object.fromEntries(Object.entries(result.details)) }
    : {})
});

const toolError = (error: unknown): CallToolResult => ({
  content: [{ type: "text", text: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }],
  isError: true
});

// Pi's ExtensionContext has no meaning outside a Pi session. Mounted tools
// must not read it; this named value documents the explicit absence.
// The MCP mount deliberately has no Pi session context; `never` preserves typed positional checks.
const NO_PI_EXTENSION_CONTEXT = undefined as never;

const validateOptions = (options: PiToolMcpServerOptions): void => {
  if (!Number.isSafeInteger(options.maxToolTurns) || options.maxToolTurns < 1) {
    throw new TypeError("maxToolTurns must be a positive safe integer");
  }
  if (!Number.isFinite(options.wakeDeadline)) {
    throw new TypeError("wakeDeadline must be a finite epoch-millisecond deadline");
  }
};

export const createPiToolMcpServer = (
  tools: ToolDefinition[],
  options: PiToolMcpServerOptions
): Server => {
  validateOptions(options);
  const server = new Server({ name: "daimon-pi-tools", version: "0.1.2" });
  const validators = new Map(tools.map((tool): [string, ValidateFunction] => {
    const schema = jsonSchema(tool.parameters);
    return [tool.name, new Ajv2020({ strict: false }).compile(schema)];
  }));
  let toolTurns = 0;

  server.registerCapabilities({ tools: { listChanged: true } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      title: tool.label,
      description: tool.description,
      inputSchema: jsonSchema(tool.parameters)
    }))
  }));
  server.setRequestHandler(
    CallToolRequestSchema,
    async (request, extra: RequestHandlerExtra<ServerRequest, ServerNotification>) => {
      try {
        if (Date.now() >= options.wakeDeadline) throw new McpWakeDeadlineError();
        if (toolTurns >= options.maxToolTurns) throw new McpToolTurnLimitError(options.maxToolTurns);
        const tool = tools.find((candidate) => candidate.name === request.params.name);
        const validator = validators.get(request.params.name);
        if (tool === undefined || validator === undefined) {
          throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${request.params.name}`);
        }
        const args = request.params.arguments ?? {};
        if (!validator(args)) {
          throw new McpError(ErrorCode.InvalidParams, `Invalid arguments for tool ${tool.name}`);
        }
        toolTurns += 1;
        // Ajv validated this value against this tool's own schema immediately above.
        const validatedArgs = args as Parameters<typeof tool.execute>[1];
        const deadlineController = new AbortController();
        const remainingMs = Math.max(0, options.wakeDeadline - Date.now());
        const deadlineTimer = setTimeout(() => deadlineController.abort(), remainingMs);
        const signal = extra.signal === undefined
          ? deadlineController.signal
          : AbortSignal.any([extra.signal, deadlineController.signal]);
        const deadline = new Promise<never>((_resolve, reject) => {
          deadlineController.signal.addEventListener("abort", () => reject(new McpWakeDeadlineError()), { once: true });
        });
        let result: Awaited<ReturnType<typeof tool.execute>>;
        try {
          result = await Promise.race([
            tool.execute(
              `mcp-tool-turn-${toolTurns}`,
              validatedArgs,
              signal,
              undefined,
              NO_PI_EXTENSION_CONTEXT
            ),
            deadline
          ]);
        } finally {
          clearTimeout(deadlineTimer);
        }
        return toolResult(result);
      } catch (error) {
        return toolError(error);
      }
    }
  );
  return server;
};

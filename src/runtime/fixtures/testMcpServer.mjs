import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { writeFile } from "node:fs/promises";
import path from "node:path";
const server = new Server({ name: "daimon-test-fixture", version: "1" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "checkpoint", description: "Records one bounded checkpoint", inputSchema: { type: "object", additionalProperties: false, required: ["phase"], properties: { phase: { type: "string" } } } }] }));
server.setRequestHandler(CallToolRequestSchema, async (request) => { await writeFile(path.join(process.env.HOME, "mcp-home-writable"), "ok"); return { content: [{ type: "text", text: `checkpoint:${request.params.arguments.phase}:home=${process.env.HOME}` }] }; });
await server.connect(new StdioServerTransport());

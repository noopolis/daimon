import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import path from "node:path";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import type { OrganizationRuntimeAgentConfig, OrganizationRuntimeMcpServer } from "./organizationRuntime.js";
import { cliChildEnvironment } from "../pi/cliEnvironment.js";
import type { PiWakeEnvironmentContextRef } from "../pi/piAgentWakeSupport.js";

const MAX_RESULT = 65_536; const TIMEOUT = 10_000;

export async function createProductionAgentTools(agent: OrganizationRuntimeAgentConfig, wakeContext: PiWakeEnvironmentContextRef = {}): Promise<ToolDefinition[]> {
  await mkdir(path.join(agent.runtimeHomePath, "tool-state"), { recursive: true, mode: 0o700 });
  const tools = [...await Promise.all((agent.mcp ?? []).map((server) => mcpTools(agent, server, wakeContext)))].flat();
  if (agent.moltnet !== undefined) tools.push(moltnetTool(agent, wakeContext));
  if (new Set(tools.map((tool) => tool.name)).size !== tools.length) throw new Error("compiled cognition tool names collide");
  return tools;
}

async function mcpTools(agent: OrganizationRuntimeAgentConfig, server: OrganizationRuntimeMcpServer, wakeContext: PiWakeEnvironmentContextRef): Promise<ToolDefinition[]> {
  const { client, close } = await connect(agent, server); const listed = await client.listTools(undefined, { timeout: TIMEOUT });
  if (Buffer.byteLength(JSON.stringify(listed)) > MAX_RESULT) { await close(); throw new Error(`MCP server ${server.name} tool list exceeds bound`); }
  const available = new Map(listed.tools.map((tool) => [tool.name, tool]));
  const undeclared = [...available.keys()].filter((name) => !server.tools.includes(name));
  if (undeclared.length > 0) { await close(); throw new Error(`MCP server ${server.name} exposed undeclared tools`); }
  const missing = server.tools.filter((name) => !available.has(name)); if (missing.length > 0) { await close(); throw new Error(`MCP server ${server.name} omitted declared tools`); }
  await close();
  return server.tools.map((name) => {
    const declared = available.get(name)!;
    return {
      name: `mcp_${safe(server.name)}_${safe(name)}`,
      label: `${server.name}: ${name}`,
      description: declared.description ?? `Call declared MCP tool ${server.name}/${name}`,
      parameters: declared.inputSchema as ToolDefinition["parameters"],
      async execute(_id, params) {
        if (!wakeContext.current) throw new Error("MCP call requires an active wake");
        const actionId = `daimon:${createHash("sha256").update(JSON.stringify([wakeContext.current, agent.id, server.name, name, params])).digest("hex")}`;
        const prior = await priorReceipt(agent, actionId); if (prior !== undefined) return { content: [{ type: "text", text: JSON.stringify(prior) }], details: prior };
        const active = await connect(agent, server);
        try {
          const result = await active.client.callTool({ name, arguments: params as Record<string, unknown> }, undefined, { timeout: TIMEOUT });
          const bytes = JSON.stringify(result); if (Buffer.byteLength(bytes) > MAX_RESULT) throw new Error("MCP tool result exceeds bound");
          await receipt(agent, { kind: "mcp", agent_id: agent.id, engine: agent.engine.kind, delivery_id: actionId, server: server.name, tool: name, digest: digest(bytes), is_error: result.isError === true });
          return { content: "content" in result ? result.content as never : [{ type: "text", text: bytes }], details: { server: server.name, tool: name, is_error: result.isError === true } };
        } finally { await active.close(); }
      }
    } as ToolDefinition;
  });
}

function moltnetTool(agent: OrganizationRuntimeAgentConfig, wakeContext: PiWakeEnvironmentContextRef): ToolDefinition {
  return {
    name: "moltnet_send", label: "Send a scoped Moltnet message", description: "Send to one room or DM declared for this agent.",
    parameters: { type: "object", additionalProperties: false, required: ["network", "target", "text"], properties: { network: { type: "string" }, target: { type: "string" }, text: { type: "string", minLength: 1, maxLength: 2048 } } },
    async execute(_id, params) {
      const input = params as { network: string; target: string; text: string }; const network = agent.moltnet!.networks.find((entry) => entry.id === input.network);
      if (network === undefined || Buffer.byteLength(input.text) > 2_048) throw new Error("Moltnet action exceeds declared scope");
      const [kind, target] = input.target.split(":", 2); if ((kind === "room" && !network.rooms.includes(target ?? "")) || (kind === "dm" && !network.dms) || !target || !["room", "dm"].includes(kind ?? "")) throw new Error("Moltnet target is not declared");
      if (!wakeContext.current) throw new Error("Moltnet send requires an active wake");
      const deliveryId = `daimon:${createHash("sha256").update(JSON.stringify([wakeContext.current, agent.id, input.network, input.target, input.text])).digest("hex")}`;
      const prior = await priorReceipt(agent, deliveryId); if (prior !== undefined) return { content: [{ type: "text", text: JSON.stringify(prior) }], details: prior };
      const response = await machine(agent.moltnet!.cliPath, agent.moltnet!.configPath, input.network, { version: "moltnet.machine.v1", correlation_id: deliveryId, operation: "send_nudge", send_nudge: { delivery_id: deliveryId, target: { kind, id: target }, body: input.text } });
      const result = response.send_nudge as { accepted?: boolean; message_id?: string } | undefined; if (result?.accepted !== true || typeof result.message_id !== "string") throw new Error("Moltnet send was not accepted");
      await receipt(agent, { kind: "moltnet", agent_id: agent.id, engine: agent.engine.kind, delivery_id: deliveryId, network: input.network, target: input.target, message_id: result.message_id });
      return { content: [{ type: "text", text: JSON.stringify({ accepted: true, message_id: result.message_id }) }], details: { accepted: true } };
    }
  } as ToolDefinition;
}

async function connect(agent: OrganizationRuntimeAgentConfig, server: OrganizationRuntimeMcpServer): Promise<{ client: Client; close(): Promise<void> }> {
  const client = new Client({ name: "daimon-production", version: "0.2.0" }); const headers: Record<string, string> = server.authSecretEnv === undefined ? {} : { authorization: `Bearer ${requiredSecret(server.authSecretEnv)}` };
  const transport = server.transport === "stdio"
    ? new StdioClientTransport({ command: server.command!, args: [...server.args], env: stringEnvironment({ ...server.env, ...cliChildEnvironment([], agent.runtimeHomePath, { executablePath: server.command }) }) })
    : server.transport === "sse" ? new SSEClientTransport(new URL(server.url!), { requestInit: { headers } })
      : new StreamableHTTPClientTransport(new URL(server.url!), { requestInit: { headers } });
  await client.connect(transport); return { client, close: () => client.close() };
}
function requiredSecret(name: string): string { const value = process.env[name]; if (!value) throw new Error(`required MCP secret ${name} is missing`); return value; }
function receiptPath(agent: OrganizationRuntimeAgentConfig, deliveryId: string): string { return path.join(agent.runtimeHomePath, "tool-state", `${digest(deliveryId).slice(7)}.json`); }
async function receipt(agent: OrganizationRuntimeAgentConfig, value: Record<string, unknown>): Promise<void> { const deliveryId = String(value.delivery_id); const file = receiptPath(agent, deliveryId); const temporary = `${file}.${process.pid}.${Date.now()}.tmp`; const bytes = `${JSON.stringify({ ...value, at: new Date().toISOString() })}\n`; if (Buffer.byteLength(bytes) > MAX_RESULT) throw new Error("tool receipt exceeds bound"); const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); } try { await rename(temporary, file); await pruneReceipts(path.dirname(file)); const directory = await open(path.dirname(file), constants.O_RDONLY); try { await directory.sync(); } finally { await directory.close(); } } catch (error) { await unlink(temporary).catch(() => undefined); throw error; } }
async function pruneReceipts(directory: string): Promise<void> { const candidates = await Promise.all((await readdir(directory)).filter((name) => /^[a-f0-9]{64}\.json$/u.test(name)).map(async (name) => ({ name, info: await lstat(path.join(directory, name)) }))); if (candidates.some(({ info }) => !info.isFile() || info.nlink !== 1)) throw new Error("tool receipt directory contains an unsafe entry"); for (const candidate of candidates.sort((left, right) => right.info.mtimeMs - left.info.mtimeMs || right.name.localeCompare(left.name)).slice(2048)) await unlink(path.join(directory, candidate.name)); }
async function priorReceipt(agent: OrganizationRuntimeAgentConfig, deliveryId: string): Promise<Record<string, unknown> | undefined> { const file = receiptPath(agent, deliveryId); let handle; try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; } try { const entry = await handle.stat(); if (!entry.isFile() || entry.size > MAX_RESULT) throw new Error("tool receipt is unsafe or exceeds bound"); const value = JSON.parse(await handle.readFile("utf8")) as Record<string, unknown>; if (value.delivery_id !== deliveryId || value.agent_id !== agent.id || value.engine !== agent.engine.kind) throw new Error("tool receipt identity mismatch"); return value; } finally { await handle.close(); } }
async function machine(cli: string, config: string, network: string, request: unknown): Promise<Record<string, unknown>> { return await new Promise((resolve, reject) => { const child = spawn(cli, ["machine", "--config", config, "--network", network], { stdio: ["pipe", "pipe", "pipe"] }); let output = "", error = ""; const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Moltnet machine timed out")); }, TIMEOUT); child.stdout.on("data", (chunk) => { output += chunk; if (Buffer.byteLength(output) > MAX_RESULT) child.kill("SIGKILL"); }); child.stderr.on("data", (chunk) => { error += chunk; }); child.once("error", reject); child.once("exit", (code) => { clearTimeout(timer); if (code !== 0) reject(new Error(`Moltnet machine failed: ${error.slice(0, 1024)}`)); else { try { resolve(JSON.parse(output.trim().split("\n")[0]!) as Record<string, unknown>); } catch (cause) { reject(cause); } } }); child.stdin.end(`${JSON.stringify(request)}\n`); }); }
function digest(value: string): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function safe(value: string): string { return value.replace(/[^A-Za-z0-9_]/gu, "_").slice(0, 48); }
function stringEnvironment(value: NodeJS.ProcessEnv): Record<string, string> { return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => entry[1] !== undefined)); }

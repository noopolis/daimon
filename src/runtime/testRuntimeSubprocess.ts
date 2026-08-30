import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { createInterface } from "node:readline";

import {
  type OrganizationRuntimeActivityPage,
  type OrganizationRuntimeHealth,
  type OrganizationRuntimeHost,
  type OrganizationRuntimeShutdownCompletion,
  type OrganizationRuntimeWakeRequest,
  type OrganizationRuntimeWakeResult
} from "./organizationRuntime.js";
import {
  createOrganizationRuntimeControlHostWithCoreForTest,
  type OrganizationRuntimeControlHost
} from "./organizationRuntimeControl.js";
import { MAX_WAKE_ACCEPTANCE_BYTES } from "./wakeAcceptanceTypes.js";
import { createScriptedMoltnetActions, type ScriptedMoltnetReceipt } from "./testRuntimeMoltnetActions.js";
import { createScriptedMcpActions, type ScriptedMcpReceipt } from "./testRuntimeMcpActions.js";

if (process.env.DAIMON_EXPLICIT_TEST_RUNTIME !== "1") {
  throw new Error("Daimon test runtime requires DAIMON_EXPLICIT_TEST_RUNTIME=1");
}

type Timer = ReturnType<typeof setTimeout>;
type Command =
  | Readonly<{ type: "start"; acceptance_store_path: string; config: unknown; control_token: string; now_ms: number; http_host?: unknown; http_port?: unknown; cognition_actions?: unknown; moltnet_cli_path?: unknown; moltnet_client_config_path?: unknown; mcp_config_path?: unknown; mcp_receipt_path?: unknown }>
  | Readonly<{ type: "advance"; now_ms: number }>
  | Readonly<{ type: "snapshot" }>
  | Readonly<{ type: "stop" }>;

class ControlledClock {
  now = 0;
  private sequence = 0;
  private readonly timers = new Map<number, { callback: () => void; due: number }>();
  readonly options = {
    now: (): number => this.now,
    setTimer: ((callback: () => void, delay: number): Timer => {
      const id = ++this.sequence;
      this.timers.set(id, { callback, due: this.now + delay });
      return { id, unref() {} } as unknown as Timer;
    }),
    clearTimer: ((timer: Timer): void => {
      this.timers.delete((timer as unknown as { id: number }).id);
    })
  };
  async advance(value: number): Promise<number> {
    if (!Number.isSafeInteger(value) || value < this.now) throw new Error("test clock must advance monotonically");
    this.now = value; let fired = 0;
    while (true) {
      const due = [...this.timers.entries()].filter(([, timer]) => timer.due <= value).sort((left, right) => left[1].due - right[1].due || left[0] - right[0]);
      if (due.length === 0) break;
      for (const [id, timer] of due) { if (this.timers.delete(id)) { fired += 1; timer.callback(); } }
      await turn();
    }
    await turn();
    return fired;
  }
}

class ScriptedCore implements OrganizationRuntimeHost {
  readonly wakes: Array<{ agent_id: string; kind: string; occurred_at: string; result_digest: string; wake_id: string }> = [];
  readonly actionReceipts: Array<ScriptedMoltnetReceipt | ScriptedMcpReceipt> = [];
  actions: (request: OrganizationRuntimeWakeRequest) => Promise<Array<ScriptedMoltnetReceipt | ScriptedMcpReceipt>> = async () => [];
  async start(): Promise<void> {}
  async wake(request: OrganizationRuntimeWakeRequest): Promise<OrganizationRuntimeWakeResult> {
    this.actionReceipts.push(...await this.actions(request));
    const text = `scripted:${createHash("sha256").update(request.event.id).digest("hex")}`;
    this.wakes.push({ agent_id: request.agentId, kind: request.event.kind, occurred_at: request.event.occurredAt, result_digest: text.slice("scripted:".length), wake_id: request.event.id });
    return { version: "noopolis.daimon.wake-result.v1", status: "completed", agentId: request.agentId, wakeId: request.event.id, text, durationMs: 0 };
  }
  async health(): Promise<OrganizationRuntimeHealth> { return { version: "noopolis.daimon.organization-runtime-health.v1", state: "running", agents: [] }; }
  async activity(): Promise<OrganizationRuntimeActivityPage> { return { version: "noopolis.daimon.organization-runtime-activity.v1", items: [] }; }
  async stop(): Promise<OrganizationRuntimeShutdownCompletion> { return { version: "noopolis.daimon.organization-runtime-stop.v1", state: "stopped" }; }
}

const clock = new ControlledClock();
const core = new ScriptedCore();
let control: OrganizationRuntimeControlHost | undefined;
let token: string | undefined;
let server: Server | undefined;

const respond = (value: unknown): void => { process.stdout.write(`${JSON.stringify(value)}\n`); };
const snapshot = async (): Promise<unknown> => ({
  activity: control && token ? await control.activityV2(token) : undefined,
  action_receipts: core.actionReceipts,
  now_ms: clock.now,
  type: "snapshot",
  wakes: core.wakes
});
const execute = async (command: Command): Promise<unknown> => {
  if (command.type === "start") {
    if (control !== undefined || !pathValue(command.acceptance_store_path) || !nonblank(command.control_token) || !Number.isSafeInteger(command.now_ms) || command.now_ms < 0) throw new Error("invalid test runtime start");
    const httpHost = command.http_host === undefined ? "127.0.0.1" : command.http_host;
    const httpPort = command.http_port === undefined ? 0 : command.http_port;
    if ((httpHost !== "127.0.0.1" && httpHost !== "0.0.0.0") || !Number.isSafeInteger(httpPort) || (httpPort as number) < 0 || (httpPort as number) > 65_535) throw new Error("invalid test runtime HTTP bind");
    clock.now = command.now_ms; token = command.control_token;
    const moltnetActions = await createScriptedMoltnetActions(command.cognition_actions, command.moltnet_cli_path, command.moltnet_client_config_path);
    const mcpActions = await createScriptedMcpActions(command.cognition_actions, command.mcp_config_path, command.mcp_receipt_path);
    core.actions = async (request) => [...await moltnetActions(request.event.id), ...await mcpActions(request)];
    control = createOrganizationRuntimeControlHostWithCoreForTest(command.config, core, {
      acceptanceStorePath: command.acceptance_store_path,
      controlToken: token,
      scheduleOptions: clock.options,
      storeOptions: {
        nowForTest: () => clock.now,
        ownerLiveness: async () => false,
        processIdentity: async () => ({ pid: process.pid, process_start: "explicit-test-runtime", boot_id: "explicit-test-runtime", pid_namespace_dev: 1, pid_namespace_ino: 1 })
      }
    });
    await control.start(); await turn();
    server = createServer(async (request, response) => {
      try {
        if (request.method !== "POST" || request.url !== "/v2/wakes") return json(response, 404, { error: "not_found" });
        if (request.headers.authorization !== `Bearer ${token}`) return json(response, 401, { error: "unauthorized" });
        if (request.headers["content-type"] !== "application/json") return json(response, 400, { error: "invalid_content_type" });
        const body = JSON.parse(await readBody(request));
        const result = await control!.accept({ ...objectBody(body), token });
        const status = result.state === "accepted" ? 202 : result.state === "stopped" ? 409 : result.code === "invalid_request" ? 400 : result.code === "unauthorized" ? 401 : 409;
        return json(response, status, result);
      } catch { return json(response, 400, { error: "invalid_request" }); }
    });
    await new Promise<void>((resolve, reject) => { server!.once("error", reject); server!.listen(httpPort as number, httpHost, resolve); });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("test runtime listener did not bind");
    return { base_url: `http://${httpHost}:${address.port}`, http_host: httpHost, http_port: address.port, now_ms: clock.now, type: "started" };
  }
  if (control === undefined) throw new Error("test runtime is not started");
  if (command.type === "advance") {
    const before = core.wakes.length;
    const fired = await clock.advance(command.now_ms);
    await waitFor(() => core.wakes.length >= before + fired);
    return await snapshot();
  }
  if (command.type === "snapshot") return await snapshot();
  await closeServer();
  await control.stop(); control = undefined;
  return { action_receipts: core.actionReceipts, now_ms: clock.now, type: "stopped", wakes: core.wakes };
};

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  try { respond(await execute(JSON.parse(line) as Command)); }
  catch (error) { respond({ error: error instanceof Error ? error.message : "test runtime failed", type: "error" }); }
}
await closeServer();
await control?.stop();

function nonblank(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function pathValue(value: unknown): value is string { return nonblank(value) && value.startsWith("/"); }
async function turn(): Promise<void> { await new Promise<void>((resolve) => setImmediate(resolve)); }
async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("test runtime did not settle");
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
}
async function closeServer(): Promise<void> {
  if (server === undefined) return;
  const active = server; server = undefined;
  await new Promise<void>((resolve, reject) => active.close((error) => error ? reject(error) : resolve()));
}
async function readBody(request: import("node:http").IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_WAKE_ACCEPTANCE_BYTES) { request.destroy(); throw new Error("request too large"); }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
function objectBody(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid body");
  return value as Record<string, unknown>;
}
function json(response: import("node:http").ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value));
}

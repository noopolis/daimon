import { createHash, timingSafeEqual } from "node:crypto";
import { parseOrganizationRuntimeConfig, parseOrganizationRuntimeWakeRequest, type OrganizationRuntimeConfig, type OrganizationRuntimeHost, type OrganizationRuntimeShutdownCompletion } from "./organizationRuntime.js";
import { createOrganizationRuntimeHostWithAttention } from "./organizationRuntimeHost.js";
import { WakeFuse, type WakeBudgetSnapshot } from "./wakeFuse.js";
import { AttentionDispatcher } from "./attentionDispatcher.js";
import type { AttentionRegistry } from "./attention.js";
import { createScheduleController, type ScheduleController, type ScheduleControllerOptions } from "./schedule.js";
import { WakeAcceptanceConflictError, WakeAcceptanceStore, WakeInboxFullError, publicAcceptance, type WakeAcceptanceStoreTestOptions } from "./wakeAcceptanceStore.js";
import { parseWakeAcceptanceRequest, ACTIVITY_V2_VERSION, type OrganizationRuntimeActivityV2, type OrganizationRuntimeWakeAcceptanceResult, type OrganizationRuntimeWakeReceiptStatus } from "./wakeAcceptanceTypes.js";

type BlockReason = "operator_stop" | "ledger_unavailable" | "host_stopping" | "host_stopped" | "queue_full";
export type WorkAvailability = Readonly<{ version: "noopolis.daimon.work-availability.v1"; state: "running" | "paused" | "stopped"; agents: readonly Readonly<{ agent_id: string; pending: number; running: boolean; deferred: number; budget: WakeBudgetSnapshot; error?: string }>[] }>;
export type OrganizationRuntimeControlHost = OrganizationRuntimeHost & Readonly<{
  accept(request: unknown): Promise<OrganizationRuntimeWakeAcceptanceResult>;
  wakeReceipt(token: string | undefined, acceptanceId: string): Promise<OrganizationRuntimeWakeReceiptStatus | undefined>;
  activityV2(token: string | undefined): Promise<OrganizationRuntimeActivityV2 | undefined>;
  availability(token: string | undefined): Promise<WorkAvailability | undefined>;
}>;
export type OrganizationRuntimeControlOptions = Readonly<{ acceptanceStorePath: string; controlToken?: string }>;
type TestControlOptions = OrganizationRuntimeControlOptions & Readonly<{
  scheduleOptions?: Pick<ScheduleControllerOptions, "clearTimer" | "now" | "setTimer">;
  storeOptions?: WakeAcceptanceStoreTestOptions;
  fuseEnvironment?: NodeJS.ProcessEnv;
  fusePollIntervalMsForTest?: number;
  attentionRegistryForTest?: AttentionRegistry;
}>;

/** Durable acceptance owns inbox delivery; only dispatch owns execution admission. */
export function createOrganizationRuntimeControlHost(config: unknown, options: OrganizationRuntimeControlOptions): OrganizationRuntimeControlHost {
  const parsed = parseOrganizationRuntimeConfig(config);
  const registry: AttentionRegistry = new Map();
  return createControl(parsed, createOrganizationRuntimeHostWithAttention(parsed, { sharedProtectedPaths: [options.acceptanceStorePath] }, registry), options, registry);
}
/** @internal Test seam; intentionally absent from the public runtime barrel. */
export function createOrganizationRuntimeControlHostWithCoreForTest(config: unknown, host: OrganizationRuntimeHost, options: TestControlOptions): OrganizationRuntimeControlHost {
  return createControl(parseOrganizationRuntimeConfig(config), host, { ...options, fuseEnvironment: options.fuseEnvironment ?? { DAIMON_WAKE_FUSE: "off" } }, options.attentionRegistryForTest ?? new Map());
}

function createControl(config: OrganizationRuntimeConfig, host: OrganizationRuntimeHost, options: TestControlOptions, registry: AttentionRegistry): OrganizationRuntimeControlHost {
  const expectedToken = options.controlToken ?? process.env[config.host.controlTokenEnv];
  const knownAgents = new Set(config.agents.map((agent) => agent.id));
  const persistence = new Set<Promise<unknown>>();
  let store: WakeAcceptanceStore | undefined;
  let schedules: ScheduleController | undefined;
  let fuse: WakeFuse | undefined;
  let dispatcher: AttentionDispatcher | undefined;
  let fusePoll: ReturnType<typeof setInterval> | undefined;
  let started = false;
  let stopping = false;

  const hardReason = (): BlockReason | undefined => {
    if (!started || stopping) return stopping ? "host_stopping" : "host_stopped";
    if (dispatcher?.fatalReason()) return dispatcher.fatalReason();
    const reason = fuse?.tripped();
    return reason === "operator_stop" || reason === "ledger_unavailable" ? reason : undefined;
  };
  const accept = async (value: unknown): Promise<OrganizationRuntimeWakeAcceptanceResult> => {
    let request;
    try { request = parseWakeAcceptanceRequest(value); } catch { return rejected("invalid_request"); }
    if (!tokensEqual(expectedToken, request.token)) return rejected("unauthorized");
    if (!knownAgents.has(request.agent_id)) return rejected("unknown_agent");
    // Check the operator latch before taking ownership, even between polls.
    await fuse?.pollOperatorStop();
    const reason = hardReason(); if (reason) return blocked(reason);
    const operation = (async (): Promise<OrganizationRuntimeWakeAcceptanceResult> => {
      try {
        const accepted = await store!.accept(request);
        // A stop racing this fsync cannot revoke already durable ownership.
        // It remains accepted for restart instead of being terminalized.
        dispatcher?.notify(request.agent_id, accepted.created);
        return publicAcceptance(accepted.record);
      } catch (error) {
        if (error instanceof WakeAcceptanceConflictError) return rejected("delivery_conflict");
        if (error instanceof WakeInboxFullError) return blocked("queue_full");
        throw error;
      }
    })();
    persistence.add(operation);
    try { return await operation; } finally { persistence.delete(operation); }
  };

  return {
    wake: async (request) => {
      try { request = parseOrganizationRuntimeWakeRequest(request); } catch { return { version: "noopolis.daimon.wake-result.v1", status: "rejected", agentId: "", wakeId: "", code: "invalid_request" }; }
      // Inbox attention requires durable ownership; synchronous v1 cannot
      // provide a receipt or leave deferred messages pending.
      if (!tokensEqual(expectedToken, request.token)) return { version: "noopolis.daimon.wake-result.v1", status: "rejected", agentId: request.agentId, wakeId: request.event.id, code: "unauthorized" };
      if (!knownAgents.has(request.agentId)) return { version: "noopolis.daimon.wake-result.v1", status: "rejected", agentId: request.agentId, wakeId: request.event.id, code: "unknown_agent" };
      if (config.agents.find((agent) => agent.id === request.agentId)?.attention !== undefined) return { version: "noopolis.daimon.wake-result.v1", status: "rejected", agentId: request.agentId, wakeId: request.event.id, code: "durable_inbox_required" };
      if (hardReason() || (await fuse!.admit(request.agentId, request.event.id, config.agents.find((agent) => agent.id === request.agentId)?.attention)).state !== "admitted") return { version: "noopolis.daimon.wake-result.v1", status: "stopped", agentId: request.agentId, wakeId: request.event.id, code: "host_stopping" };
      return await host.wake(request);
    },
    health: async (agentId) => await host.health(agentId),
    activity: async (request) => await host.activity(request),
    async start(): Promise<void> {
      if (started) return;
      if (stopping) throw new Error("organization runtime control host has been stopped");
      if (!expectedToken?.trim()) throw new Error("required control token is missing or blank");
      const opened = await WakeAcceptanceStore.open(options.acceptanceStorePath, options.storeOptions);
      let openedFuse: WakeFuse | undefined;
      try {
        openedFuse = await WakeFuse.open({ organizationKey: [...knownAgents].sort().join("\u0000"), environment: options.fuseEnvironment });
        await host.start();
        store = opened; fuse = openedFuse; started = true;
        dispatcher = new AttentionDispatcher({ store, host, fuse, agents: config.agents, registry, token: expectedToken, onIdle: (agentId) => { void schedules?.drain(agentId).catch(() => undefined); } });
        if (!hardReason()) for (const agentId of new Set((await opened.recoverable(knownAgents)).filter((record) => !record.deferred).map((record) => record.agent_id))) dispatcher.notify(agentId);
        fusePoll = setInterval(() => {
          void fuse?.pollOperatorStop().then((reason) => {
            if (reason === "operator_stop" || reason === "ledger_unavailable") dispatcher?.halt();
          }).catch(() => undefined);
        }, options.fusePollIntervalMsForTest ?? WAKE_FUSE_OPERATOR_POLL_MS);
        fusePoll.unref();
        if (config.version === "noopolis.daimon.organization-runtime.v2") {
          schedules = createScheduleController({ acceptanceStorePath: options.acceptanceStorePath, agents: config.agents, ...options.scheduleOptions,
            accept: async (occurrence) => {
              if (dispatcher?.busy(occurrence.agentId) || hardReason()) return false;
              const result = await accept({ token: expectedToken, agent_id: occurrence.agentId, delivery_id: occurrence.deliveryId, event: { version: "noopolis.daimon.wake.v2", kind: "schedule", text: occurrence.prompt, occurred_at: occurrence.occurredAt } });
              return result.state === "accepted";
            }
          });
          await schedules.start();
        }
      } catch (error) {
        dispatcher?.halt(); await host.stop().catch(() => undefined); await dispatcher?.stop().catch(() => undefined);
        await openedFuse?.close().catch(() => undefined); await opened.close().catch(() => undefined);
        throw error;
      }
    },
    accept,
    async wakeReceipt(token, acceptanceId) {
      if (!tokensEqual(expectedToken, token) || store === undefined) return undefined;
      return await store.status(acceptanceId);
    },
    async activityV2(token) {
      if (!tokensEqual(expectedToken, token) || store === undefined) return undefined;
      const executions = dispatcher?.activeExecutions() ?? [];
      const items = (await store.activity()).map((item) => ({ ...item, active: item.active && executions.some((execution) => execution.agent_id === item.agent_id && execution.delivery_ids.includes(item.delivery_id)) }));
      return { version: ACTIVITY_V2_VERSION, items, executions };
    },
    async availability(token) {
      if (!tokensEqual(expectedToken, token) || !store || !fuse) return undefined;
      await fuse.pollOperatorStop();
      const items = await store.activityWithExecutionErrors();
      const executionErrors = new Map(items.filter((record) => (record.state === "accepted" || record.state === "running")
        && record.execution_error !== undefined).map((record) => [record.agent_id, record.execution_error!]));
      const agents = await Promise.all(config.agents.map(async (agent) => ({
        agent_id: agent.id, pending: items.filter((item) => item.agent_id === agent.id && (item.state === "accepted" || item.state === "running" && !dispatcher?.activeExecutions().some((execution) => execution.agent_id === agent.id))).length,
        running: dispatcher?.activeExecutions().some((execution) => execution.agent_id === agent.id) ?? false,
        deferred: items.filter((item) => item.agent_id === agent.id && item.state === "accepted" && item.deferred).length,
        budget: await fuse!.snapshot(agent.id, agent.attention),
        ...((dispatcher?.failure(agent.id) ?? executionErrors.get(agent.id))
          ? { error: dispatcher?.failure(agent.id) ?? executionErrors.get(agent.id) } : {})
      })));
      return { version: "noopolis.daimon.work-availability.v1", state: hardReason() ? "stopped" : agents.some((agent) => agent.budget.state !== "available" || agent.error) ? "paused" : "running", agents };
    },
    async stop(): Promise<OrganizationRuntimeShutdownCompletion> {
      if (!started && stopping) return { version: "noopolis.daimon.organization-runtime-stop.v1", state: "stopped" };
      stopping = true; dispatcher?.halt();
      if (fusePoll !== undefined) clearInterval(fusePoll);
      await schedules?.stop();
      await Promise.allSettled(persistence);
      const result = await host.stop();
      await dispatcher?.stop();
      await store?.close(); await fuse?.close();
      store = undefined; fuse = undefined; schedules = undefined; started = false;
      return result;
    }
  };
}
export const WAKE_FUSE_OPERATOR_POLL_MS = 1000;
function rejected(code: "invalid_request" | "unauthorized" | "unknown_agent" | "delivery_conflict"): OrganizationRuntimeWakeAcceptanceResult { return { version: "noopolis.daimon.wake-acceptance.v2", state: "rejected", code }; }
function blocked(reason: BlockReason): OrganizationRuntimeWakeAcceptanceResult { return { version: "noopolis.daimon.wake-acceptance.v2", state: "stopped", code: reason === "host_stopped" ? "host_stopped" : "host_stopping", blocked: { version: "noopolis.daimon.work-blocked.v1", reason, retry_after_ms: 30000 } }; }
function tokensEqual(expected: string | undefined, actual: string | undefined): boolean {
  if (!expected?.trim()) return false;
  const digest = (value: string): Buffer => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(expected), digest(actual ?? ""));
}

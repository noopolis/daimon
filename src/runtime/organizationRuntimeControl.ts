import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import {
  parseOrganizationRuntimeConfig,
  type OrganizationRuntimeConfig,
  type OrganizationRuntimeHost,
  type OrganizationRuntimeShutdownCompletion,
  type OrganizationRuntimeWakeRequest
} from "./organizationRuntime.js";
import { createOrganizationRuntimeHost } from "./organizationRuntimeHost.js";
import { createScheduleController, type ScheduleController, type ScheduleControllerOptions } from "./schedule.js";
import { WakeAcceptanceConflictError, WakeAcceptanceStore, WakeExecutionClaimLostError, publicAcceptance, type WakeAcceptanceStoreTestOptions } from "./wakeAcceptanceStore.js";
import {
  parseWakeAcceptanceRequest,
  ACTIVITY_V2_VERSION,
  type OrganizationRuntimeActivityV2,
  type OrganizationRuntimeWakeAcceptanceRequest,
  type OrganizationRuntimeWakeAcceptanceResult,
  type OrganizationRuntimeWakeReceiptStatus
} from "./wakeAcceptanceTypes.js";

export type OrganizationRuntimeControlHost = OrganizationRuntimeHost & Readonly<{
  accept(request: unknown): Promise<OrganizationRuntimeWakeAcceptanceResult>;
  wakeReceipt(token: string | undefined, acceptanceId: string): Promise<OrganizationRuntimeWakeReceiptStatus | undefined>;
  activityV2(token: string | undefined): Promise<OrganizationRuntimeActivityV2 | undefined>;
}>;
export type OrganizationRuntimeControlOptions = Readonly<{ acceptanceStorePath: string; controlToken?: string }>;
type TestControlOptions = OrganizationRuntimeControlOptions & Readonly<{
  scheduleOptions?: Pick<ScheduleControllerOptions, "clearTimer" | "now" | "setTimer">;
  storeOptions?: WakeAcceptanceStoreTestOptions;
}>;
type CoreHost = OrganizationRuntimeHost;
type AcceptanceRecord = Awaited<ReturnType<WakeAcceptanceStore["accept"]>>["record"];

/**
 * The v2 control facade persists acceptance before delegating a turn to the
 * unchanged v1 host. It owns no scheduling, message routing, or engine logic.
 */
export function createOrganizationRuntimeControlHost(config: unknown, options: OrganizationRuntimeControlOptions): OrganizationRuntimeControlHost {
  const parsed = parseOrganizationRuntimeConfig(config);
  return createControl(parsed, createOrganizationRuntimeHost(parsed, {
    sharedProtectedPaths: [options.acceptanceStorePath]
  }), options);
}

/** @internal Test seam; intentionally absent from the public runtime barrel. */
export function createOrganizationRuntimeControlHostWithCoreForTest(config: unknown, host: CoreHost, options: TestControlOptions): OrganizationRuntimeControlHost {
  return createControl(parseOrganizationRuntimeConfig(config), host, options, options.storeOptions);
}

function createControl(config: OrganizationRuntimeConfig, host: CoreHost, options: TestControlOptions, storeOptions?: WakeAcceptanceStoreTestOptions): OrganizationRuntimeControlHost {
  const expectedToken = options.controlToken ?? process.env[config.host.controlTokenEnv];
  const knownAgents = new Set(config.agents.map((agent) => agent.id));
  const ownerId = randomUUID();
  const inFlight = new Map<string, Promise<void>>();
  const agentTails = new Map<string, Promise<void>>();
  const acceptanceTails = new Map<string, Promise<void>>();
  const retryWaiters = new Set<() => void>();
  let store: WakeAcceptanceStore | undefined;
  let schedules: ScheduleController | undefined;
  let started = false;
  let stopping = false;

  const waitUntil = async (timestamp: string): Promise<void> => {
    if (stopping) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const finish = (): void => { if (settled) return; settled = true; clearTimeout(timer); retryWaiters.delete(finish); resolve(); };
      timer = setTimeout(finish, Math.max(1, Date.parse(timestamp) - Date.now()));
      retryWaiters.add(finish);
    });
  };

  const serializeAcceptance = async <T>(agentId: string, operation: () => Promise<T>): Promise<T> => {
    const prior = acceptanceTails.get(agentId) ?? Promise.resolve();
    const result = prior.catch(() => undefined).then(operation);
    const tail = result.then(() => undefined, () => undefined);
    acceptanceTails.set(agentId, tail);
    try { return await result; } finally { if (acceptanceTails.get(agentId) === tail) acceptanceTails.delete(agentId); }
  };

  const dispatch = (record: AcceptanceRecord): void => {
    if (inFlight.has(record.acceptance_id) || store === undefined) return;
    const activeStore = store;
    const execute = async (): Promise<void> => {
      while (!stopping) {
        const acquired = await activeStore.acquireClaim(record.acceptance_id, ownerId);
        if (acquired.state === "terminal") return;
        if (acquired.state === "held") { await waitUntil(acquired.retry_at); continue; }
        let activeClaim = acquired.claim;
        try {
          const current = await activeStore.transitionClaimed(record.acceptance_id, activeClaim, "running");
          if (current.state !== "running") return;
          let renewal: Promise<void> = Promise.resolve();
          const heartbeat = setInterval(() => {
            renewal = renewal.then(async () => {
              activeClaim = await activeStore.renewClaim(current.acceptance_id, activeClaim);
              await activeStore.transitionClaimed(current.acceptance_id, activeClaim, "running");
            });
          }, activeStore.claimHeartbeatIntervalMs());
          const request: OrganizationRuntimeWakeRequest = {
            token: expectedToken, agentId: current.agent_id,
            event: { version: "noopolis.daimon.wake.v1", id: current.delivery_id, kind: current.event.kind, text: current.event.text, occurredAt: current.event.occurred_at }
          };
          let result;
          try { result = await host.wake(request); } catch {
            clearInterval(heartbeat); await renewal;
            await activeStore.transitionClaimed(current.acceptance_id, activeClaim, "failed", "engine_failed"); return;
          }
          clearInterval(heartbeat); await renewal;
          // A crash here retries at least once with the same delivery/wake id.
          if (result.status === "completed") await activeStore.transitionClaimed(current.acceptance_id, activeClaim, "completed", undefined, result.text);
          else if (result.status === "failed") await activeStore.transitionClaimed(current.acceptance_id, activeClaim, "failed", "engine_failed");
          else if (result.status === "stopped") await activeStore.transitionClaimed(current.acceptance_id, activeClaim, "stopped", result.code === "host_stopped" ? "host_stopped" : "host_stopping");
          else await activeStore.transitionClaimed(current.acceptance_id, activeClaim, "failed", result.code === "queue_full" ? "queue_full" : result.code === "unknown_agent" ? "unknown_agent" : "host_stopped");
          return;
        } catch (error) {
          if (!(error instanceof WakeExecutionClaimLostError)) await waitUntil(activeClaim.expires_at);
        }
      }
    };
    const prior = agentTails.get(record.agent_id) ?? Promise.resolve();
    const work = prior.catch(() => undefined).then(execute).finally(() => {
      inFlight.delete(record.acceptance_id);
      if (agentTails.get(record.agent_id) === work) {
        agentTails.delete(record.agent_id);
        void schedules?.drain(record.agent_id);
      }
    });
    inFlight.set(record.acceptance_id, work);
    agentTails.set(record.agent_id, work);
  };

  const persistRequest = async (request: OrganizationRuntimeWakeAcceptanceRequest): Promise<OrganizationRuntimeWakeAcceptanceResult> => {
      try {
        const accepted = await store!.accept(request); dispatch(accepted.record); return publicAcceptance(accepted.record);
      } catch (error) {
        if (error instanceof WakeAcceptanceConflictError) return { version: "noopolis.daimon.wake-acceptance.v2", state: "rejected", code: "delivery_conflict" };
        throw error;
      }
  };
  const acceptRequest = async (request: OrganizationRuntimeWakeAcceptanceRequest): Promise<OrganizationRuntimeWakeAcceptanceResult> =>
    await serializeAcceptance(request.agent_id, async () => await persistRequest(request));

  return {
    wake: async (request) => await host.wake(request),
    health: async (agentId) => await host.health(agentId),
    activity: async (request) => await host.activity(request),
    async start(): Promise<void> {
      if (started) return;
      if (stopping) throw new Error("organization runtime control host has been stopped");
      if (expectedToken === undefined || !expectedToken.trim()) throw new Error("required control token is missing or blank");
      const opened = await WakeAcceptanceStore.open(options.acceptanceStorePath, storeOptions);
      try {
        await host.start();
        store = opened;
        started = true;
        for (const record of await opened.recoverable(knownAgents)) dispatch(record);
        if (config.version === "noopolis.daimon.organization-runtime.v2") {
          schedules = createScheduleController({
            acceptanceStorePath: options.acceptanceStorePath, agents: config.agents,
            ...options.scheduleOptions,
            accept: async (occurrence) => await serializeAcceptance(occurrence.agentId, async () => {
              if (agentTails.has(occurrence.agentId)) return false;
              const accepted = await persistRequest({ token: expectedToken, agent_id: occurrence.agentId, delivery_id: occurrence.deliveryId, event: { version: "noopolis.daimon.wake.v2", kind: "schedule", text: occurrence.prompt, occurred_at: occurrence.occurredAt } });
              if (accepted.state !== "accepted") throw new Error(`scheduled wake ${occurrence.deliveryId} was not durably accepted`);
              return true;
            })
          });
          await schedules.start();
        }
      } catch (error) {
        await host.stop().catch(() => undefined);
        await opened.close().catch(() => undefined);
        throw error;
      }
    },
    async accept(value: unknown): Promise<OrganizationRuntimeWakeAcceptanceResult> {
      let request: OrganizationRuntimeWakeAcceptanceRequest;
      try { request = parseWakeAcceptanceRequest(value); } catch { return { version: "noopolis.daimon.wake-acceptance.v2", state: "rejected", code: "invalid_request" }; }
      if (!tokensEqual(expectedToken, request.token)) return { version: "noopolis.daimon.wake-acceptance.v2", state: "rejected", code: "unauthorized" };
      if (!started || stopping) return { version: "noopolis.daimon.wake-acceptance.v2", state: "stopped", code: stopping ? "host_stopping" : "host_stopped" };
      if (!knownAgents.has(request.agent_id)) return { version: "noopolis.daimon.wake-acceptance.v2", state: "rejected", code: "unknown_agent" };
      return await acceptRequest(request);
    },
    async wakeReceipt(token: string | undefined, acceptanceId: string): Promise<OrganizationRuntimeWakeReceiptStatus | undefined> {
      if (!tokensEqual(expectedToken, token) || store === undefined) return undefined;
      return await store.status(acceptanceId);
    },
    async activityV2(token: string | undefined): Promise<OrganizationRuntimeActivityV2 | undefined> {
      if (!tokensEqual(expectedToken, token) || store === undefined) return undefined;
      return { version: ACTIVITY_V2_VERSION, items: await store.activity() };
    },
    async stop(): Promise<OrganizationRuntimeShutdownCompletion> {
      stopping = true;
      for (const wake of retryWaiters) wake();
      await schedules?.stop();
      const result = await host.stop();
      await Promise.allSettled(inFlight.values());
      await store?.releaseClaims(ownerId);
      await store?.close();
      store = undefined;
      schedules = undefined;
      started = false;
      return result;
    }
  };
}

function tokensEqual(expected: string | undefined, actual: string | undefined): boolean {
  if (expected === undefined || !expected.trim()) return false;
  const digest = (value: string): Buffer => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(expected), digest(actual ?? ""));
}

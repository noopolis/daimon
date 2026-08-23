import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import {
  parseOrganizationRuntimeConfig,
  type OrganizationRuntimeConfig,
  type OrganizationRuntimeHost,
  type OrganizationRuntimeShutdownCompletion,
  type OrganizationRuntimeWakeRequest
} from "./organizationRuntime.js";
import { createOrganizationRuntimeHost } from "./organizationRuntimeHost.js";
import { WakeAcceptanceConflictError, WakeAcceptanceStore, WakeExecutionClaimLostError, publicAcceptance, type WakeAcceptanceStoreTestOptions } from "./wakeAcceptanceStore.js";
import {
  parseWakeAcceptanceRequest,
  type OrganizationRuntimeWakeAcceptanceRequest,
  type OrganizationRuntimeWakeAcceptanceResult,
  type OrganizationRuntimeWakeReceiptStatus
} from "./wakeAcceptanceTypes.js";

export type OrganizationRuntimeControlHost = OrganizationRuntimeHost & Readonly<{
  accept(request: unknown): Promise<OrganizationRuntimeWakeAcceptanceResult>;
  wakeReceipt(token: string | undefined, acceptanceId: string): Promise<OrganizationRuntimeWakeReceiptStatus | undefined>;
}>;
export type OrganizationRuntimeControlOptions = Readonly<{ acceptanceStorePath: string; controlToken?: string }>;
type TestControlOptions = OrganizationRuntimeControlOptions & Readonly<{ storeOptions?: WakeAcceptanceStoreTestOptions }>;
type CoreHost = OrganizationRuntimeHost;
type AcceptanceRecord = Awaited<ReturnType<WakeAcceptanceStore["accept"]>>["record"];

/**
 * The v2 control facade persists acceptance before delegating a turn to the
 * unchanged v1 host. It owns no scheduling, message routing, or engine logic.
 */
export function createOrganizationRuntimeControlHost(config: unknown, options: OrganizationRuntimeControlOptions): OrganizationRuntimeControlHost {
  const parsed = parseOrganizationRuntimeConfig(config);
  return createControl(parsed, createOrganizationRuntimeHost(parsed), options);
}

/** @internal Test seam; intentionally absent from the public runtime barrel. */
export function createOrganizationRuntimeControlHostWithCoreForTest(config: unknown, host: CoreHost, options: TestControlOptions): OrganizationRuntimeControlHost {
  return createControl(parseOrganizationRuntimeConfig(config), host, options, options.storeOptions);
}

function createControl(config: OrganizationRuntimeConfig, host: CoreHost, options: OrganizationRuntimeControlOptions, storeOptions?: WakeAcceptanceStoreTestOptions): OrganizationRuntimeControlHost {
  const expectedToken = options.controlToken ?? process.env[config.host.controlTokenEnv];
  const knownAgents = new Set(config.agents.map((agent) => agent.id));
  const ownerId = randomUUID();
  const inFlight = new Map<string, Promise<void>>();
  let store: WakeAcceptanceStore | undefined;
  let started = false;
  let stopping = false;

  const dispatch = (record: AcceptanceRecord): void => {
    if (inFlight.has(record.acceptance_id) || store === undefined) return;
    const activeStore = store;
    const work = (async () => {
      const claim = await activeStore.acquireClaim(record.acceptance_id, ownerId);
      if (claim.state !== "acquired") return;
      const current = await activeStore.transitionClaimed(record.acceptance_id, claim.claim, "running");
      if (current.state !== "running") return;
      const request: OrganizationRuntimeWakeRequest = {
        token: expectedToken,
        agentId: current.agent_id,
        event: { version: "noopolis.daimon.wake.v1", id: current.delivery_id, kind: current.event.kind, text: current.event.text, occurredAt: current.event.occurred_at }
      };
      const result = await host.wake(request);
      if (result.status === "completed") await activeStore.transitionClaimed(current.acceptance_id, claim.claim, "completed");
      else if (result.status === "failed") await activeStore.transitionClaimed(current.acceptance_id, claim.claim, "failed", "engine_failed");
      else if (result.status === "stopped") await activeStore.transitionClaimed(current.acceptance_id, claim.claim, "stopped", result.code === "host_stopped" ? "host_stopped" : "host_stopping");
      else await activeStore.transitionClaimed(current.acceptance_id, claim.claim, "failed", result.code === "queue_full" ? "queue_full" : result.code === "unknown_agent" ? "unknown_agent" : "host_stopped");
    })().catch(async (error: unknown) => {
      if (error instanceof WakeExecutionClaimLostError) return;
      const claim = await activeStore.acquireClaim(record.acceptance_id, ownerId).catch(() => undefined);
      if (claim?.state === "acquired") await activeStore.transitionClaimed(record.acceptance_id, claim.claim, "failed", "engine_failed").catch(() => undefined);
    }).finally(() => { inFlight.delete(record.acceptance_id); });
    inFlight.set(record.acceptance_id, work);
  };

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
      try {
        const accepted = await store!.accept(request);
        dispatch(accepted.record);
        return publicAcceptance(accepted.record);
      } catch (error) {
        if (error instanceof WakeAcceptanceConflictError) return { version: "noopolis.daimon.wake-acceptance.v2", state: "rejected", code: "delivery_conflict" };
        throw error;
      }
    },
    async wakeReceipt(token: string | undefined, acceptanceId: string): Promise<OrganizationRuntimeWakeReceiptStatus | undefined> {
      if (!tokensEqual(expectedToken, token) || store === undefined) return undefined;
      return await store.status(acceptanceId);
    },
    async stop(): Promise<OrganizationRuntimeShutdownCompletion> {
      stopping = true;
      const result = await host.stop();
      await Promise.allSettled(inFlight.values());
      await store?.releaseClaims(ownerId);
      await store?.close();
      store = undefined;
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

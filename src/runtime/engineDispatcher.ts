import path from "node:path";

import type { AgentHandle } from "../core/types.js";
import { AGY_MAX_TOOL_TURNS, createCliSessionFactory } from "../pi/cliSession.js";
import {
  GROK_DAIMON_SANDBOX_PROFILE,
  prepareAndVerifyGrokSandbox
} from "../pi/grokSandbox.js";
import { PiHarnessAdapter } from "../pi/piHarness.js";

import type { OrganizationRuntimeAgentConfig } from "./organizationRuntime.js";
import type { OrganizationRuntimePathAuthority } from "./physicalReadiness.js";
import { engineHomeName, prepareEngineExecutable, prepareEngineReadiness, readPortableEngineCredentialSecrets } from "./engineReadiness.js";
import type { EngineBrokerTurnClient } from "./engineBrokerControlClient.js";
import { createProductionAgentTools } from "./productionAgentTools.js";
import { AGY_SUBSCRIPTION_REALM, GROK_SUBSCRIPTION_REALM } from "./contractManifest.js";
import { recordTurnUsage, resolveTurnUsageLedgerPath } from "./turnUsageLedger.js";

/**
 * The production-only bridge from a closed runtime engine intent to Daimon's
 * existing one-agent harness. Configuration never carries a command or env.
 */
export async function startOrganizationRuntimeEngine(
  agent: OrganizationRuntimeAgentConfig,
  controlTokenEnv: string,
  paths?: ReturnType<OrganizationRuntimePathAuthority["forAgent"]>,
  agyBusAddress?: string,
  grokBroker?: EngineBrokerTurnClient,
  organizationAgents?: readonly OrganizationRuntimeAgentConfig[],
  sharedProtectedPaths: readonly string[] = []
): Promise<AgentHandle> {
  await paths?.verify();
  const canonicalAgent = paths === undefined ? agent : { ...agent, workspacePath: paths.workspacePath, runtimeHomePath: paths.runtimeHomePath };
  const readiness = canonicalAgent.engine.kind === "grok" && grokBroker !== undefined
    ? { ...(await prepareEngineExecutable(canonicalAgent.id, "grok")), engineHomePath: path.join(canonicalAgent.runtimeHomePath, engineHomeName("grok")) }
    : await prepareEngineReadiness(canonicalAgent, canonicalAgent.runtimeHomePath, agyBusAddress);
  const wakeContext: import("../pi/piAgentWakeSupport.js").PiWakeEnvironmentContextRef = {};
  const grokSandbox = canonicalAgent.engine.kind === "grok" && paths !== undefined && organizationAgents !== undefined
    ? () => prepareAndVerifyGrokSandbox({
        command: readiness.executablePath,
        cwd: canonicalAgent.workspacePath,
        engineHomePath: readiness.engineHomePath,
        protectedPaths: grokSandboxProtectedPaths(canonicalAgent.id, organizationAgents, sharedProtectedPaths),
        runtimeHomePath: canonicalAgent.runtimeHomePath
      })
    : undefined;
  const adapter = adapterFor(canonicalAgent, controlTokenEnv, readiness.verify, readiness.executablePath, readiness.engineHomePath, paths?.verify, agyBusAddress, await createProductionAgentTools(canonicalAgent, wakeContext), wakeContext, grokSandbox,grokBroker);
  const handle = await adapter.startAgent({
    id: canonicalAgent.id,
    name: canonicalAgent.name,
    instructions: canonicalAgent.instructions,
    runtimeHomePath: canonicalAgent.runtimeHomePath,
    workspacePath: canonicalAgent.workspacePath
  });
  await paths?.verify();
  const result: AgentHandle = {
    ...handle,
    async wake(event) {
      await paths?.verify();
      await readiness.verify();
      try { return await handle.wake(event); } finally { await paths?.verify(); await readiness.verify(); }
    },
    async stop() { await handle.stop(); },
    status: () => handle.status()
  };
  return result;
}

export function grokSandboxProtectedPaths(
  currentAgentId: string,
  organizationAgents: readonly OrganizationRuntimeAgentConfig[],
  sharedProtectedPaths: readonly string[] = []
): readonly string[] {
  return [
    GROK_SUBSCRIPTION_REALM.bootstrapMountPath,
    GROK_SUBSCRIPTION_REALM.durableMountPath,
    ...(organizationAgents.some((peer) => peer.engine.kind === "agy") ? [
      AGY_SUBSCRIPTION_REALM.unlockMountPath,
      AGY_SUBSCRIPTION_REALM.durableMountPath
    ] : []),
    ...sharedProtectedPaths,
    ...organizationAgents.filter((peer) => peer.id !== currentAgentId)
      .flatMap((peer) => [peer.runtimeHomePath, peer.workspacePath])
  ];
}

function adapterFor(agent: OrganizationRuntimeAgentConfig, controlTokenEnv: string, verifyExecutable: () => Promise<void>, executablePath: string, engineHomePath: string, verifyRuntimePaths?: () => Promise<void>, agyBusAddress?: string, productionTools: readonly import("@earendil-works/pi-coding-agent").ToolDefinition[] = [], wakeEnvironmentContext: import("../pi/piAgentWakeSupport.js").PiWakeEnvironmentContextRef = {}, verifyGrokSandbox?: () => Promise<void>,grokBroker?:EngineBrokerTurnClient): PiHarnessAdapter {
  const engine = agent.engine.kind;
  const sessionFactory = createCliSessionFactory(
    engine === "agy"
      ? { engine, maxToolTurns: AGY_MAX_TOOL_TURNS, timeoutMs: 180_000, dbusSessionBusAddress: agyBusAddress, redactedEnvironmentNames: [controlTokenEnv], identityPrompt: identityEnvelope(agent), command: executablePath, engineHomePath, verifyExecutable, verifyRuntimePaths,
        // AGY has no broker to meter it, so the session hands its decoded
        // terminal-frame usage straight to the same ledger the Grok broker
        // appends to. `recordTurnUsage` is advisory and never rejects.
        onTurnUsage: (usage) => recordTurnUsage(resolveTurnUsageLedgerPath(), { agent: agent.id, wake: wakeEnvironmentContext.current ?? "wake", engine: "agy", usage }) }
      : { engine, redactedEnvironmentNames: [controlTokenEnv], identityPrompt: identityEnvelope(agent), command: executablePath, engineHomePath, verifyExecutable, verifyRuntimePaths,
        ...(engine==="grok"&&grokBroker!==undefined?{}:{credentialSecretValues: () => readPortableEngineCredentialSecrets(agent.id, engine, engineHomePath)}),
        ...(engine==="grok"&&grokBroker!==undefined?{grokBrokerTurn:(prompt:string,endpoint:string,signal:AbortSignal)=>grokBroker.turn(agent.id,wakeEnvironmentContext.current??"wake",prompt,endpoint,signal)}:{}),
        ...(engine === "grok" && verifyGrokSandbox ? {
          grokSandboxProfile: GROK_DAIMON_SANDBOX_PROFILE,
          verifyGrokSandbox
        } : {}) }
  );
  return cliHarness(agent, sessionFactory, [controlTokenEnv], productionTools, wakeEnvironmentContext);
}

/**
 * CLI engines do not consume Pi's resource loader. Frame the same immutable
 * identity in JSON so arbitrary names/instructions cannot change its shape.
 */
function identityEnvelope(agent: OrganizationRuntimeAgentConfig): string {
  return [
    "<daimon-agent-identity>",
    JSON.stringify({ id: agent.id, name: agent.name, instructions: agent.instructions }),
    "</daimon-agent-identity>",
    "Put the intended outward reply in your terminal response; the caller owns delivery to the source conversation. "
      + "Do not seek transport credentials or invoke a transport CLI unless the caller explicitly mounted an authenticated transport tool.",
    "The following is the current wake event."
  ].join("\n") + "\n";
}

function cliHarness(
  agent: OrganizationRuntimeAgentConfig,
  sessionFactory: ReturnType<typeof createCliSessionFactory>,
  protectedEnvironmentNames: readonly string[], productionTools: readonly import("@earendil-works/pi-coding-agent").ToolDefinition[], wakeEnvironmentContext: import("../pi/piAgentWakeSupport.js").PiWakeEnvironmentContextRef
): PiHarnessAdapter {
  return new PiHarnessAdapter({
    authPath: path.join(agent.runtimeHomePath, "auth.json"),
    // Pi owns the harness envelope while the session factory owns this CLI.
    model: {
      auth: { method: "none" },
      endpoint: { baseUrl: "http://127.0.0.1/daimon-cli", compatibility: "openai" },
      name: "daimon-cli",
      provider: "daimon-cli"
    },
    sessionFactory,
    protectedEnvironmentNames,
    productionTools,
    wakeEnvironmentContext,
    ...(agent.memory === undefined ? {} : { memory: {
      runtimeHomePath: agent.memory.runtimeHomePath,
      ...(agent.memory.source === undefined ? {} : { source: agent.memory.source }),
      ...(agent.memory.tokenBudget === undefined ? {} : { tokenBudget: agent.memory.tokenBudget })
    } })
  });
}

import path from "node:path";

import type { AgentHandle } from "../core/types.js";
import { createCliSessionFactory } from "../pi/cliSession.js";
import { PiHarnessAdapter } from "../pi/piHarness.js";

import type { OrganizationRuntimeAgentConfig } from "./organizationRuntime.js";
import type { OrganizationRuntimePathAuthority } from "./physicalReadiness.js";
import { prepareEngineReadiness } from "./engineReadiness.js";

/**
 * The production-only bridge from a closed runtime engine intent to Daimon's
 * existing one-agent harness. Configuration never carries a command or env.
 */
export async function startOrganizationRuntimeEngine(
  agent: OrganizationRuntimeAgentConfig,
  controlTokenEnv: string,
  paths?: ReturnType<OrganizationRuntimePathAuthority["forAgent"]>,
  agyBusAddress?: string
): Promise<AgentHandle> {
  await paths?.verify();
  const canonicalAgent = paths === undefined ? agent : { ...agent, workspacePath: paths.workspacePath, runtimeHomePath: paths.runtimeHomePath };
  const readiness = await prepareEngineReadiness(canonicalAgent, canonicalAgent.runtimeHomePath, agyBusAddress);
  const adapter = adapterFor(canonicalAgent, controlTokenEnv, readiness.verify, readiness.executablePath, readiness.engineHomePath, paths?.verify, agyBusAddress);
  const handle = await adapter.startAgent({
    id: canonicalAgent.id,
    name: canonicalAgent.name,
    instructions: canonicalAgent.instructions,
    runtimeHomePath: canonicalAgent.runtimeHomePath,
    workspacePath: canonicalAgent.workspacePath
  });
  await paths?.verify();
  return {
    ...handle,
    async wake(event) {
      await paths?.verify();
      await readiness.verify();
      try { return await handle.wake(event); } finally { await paths?.verify(); await readiness.verify(); }
    },
    async stop() { await handle.stop(); },
    status: () => handle.status()
  };
}

function adapterFor(agent: OrganizationRuntimeAgentConfig, controlTokenEnv: string, verifyExecutable: () => Promise<void>, executablePath: string, engineHomePath: string, verifyRuntimePaths?: () => Promise<void>, agyBusAddress?: string): PiHarnessAdapter {
  const engine = agent.engine.kind;
  const sessionFactory = createCliSessionFactory(
    engine === "agy"
      ? { engine, maxToolTurns: 1, timeoutMs: 180_000, toolAccess: "none", dbusSessionBusAddress: agyBusAddress, redactedEnvironmentNames: [controlTokenEnv], identityPrompt: identityEnvelope(agent), command: executablePath, engineHomePath, verifyExecutable, verifyRuntimePaths }
      : { engine, maxToolTurns: 2, timeoutMs: 180_000, redactedEnvironmentNames: [controlTokenEnv], identityPrompt: identityEnvelope(agent), command: executablePath, engineHomePath, verifyExecutable, verifyRuntimePaths }
  );
  return cliHarness(agent, sessionFactory, [controlTokenEnv]);
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
    "The following is the current wake event."
  ].join("\n") + "\n";
}

function cliHarness(
  agent: OrganizationRuntimeAgentConfig,
  sessionFactory: ReturnType<typeof createCliSessionFactory>,
  protectedEnvironmentNames: readonly string[]
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
    protectedEnvironmentNames
  });
}

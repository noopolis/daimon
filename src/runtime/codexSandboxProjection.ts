import path from "node:path";
import { renderCodexArgs } from "../pi/cliEngineSpawn.js";
import { codexSandboxProtectedPaths, codexSandboxReadablePaths } from "./engineDispatcher.js";
import { engineHomeName, prepareEngineExecutable } from "./engineReadiness.js";
import { parseOrganizationRuntimeConfig } from "./organizationRuntime.js";
import { prepareOrganizationRuntimePaths } from "./physicalReadiness.js";

export const CODEX_SANDBOX_PROJECTION_VERSION = "noopolis.daimon.codex-sandbox-projection.v1";
export type OrganizationCodexSandboxProjection = Readonly<{
  version: typeof CODEX_SANDBOX_PROJECTION_VERSION;
  agentId: string;
  workspacePath: string;
  runtimeHomePath: string;
  engineHomePath: string;
  executablePath: string;
  profileName: string;
  permissionConfig: string;
  sandboxArgs: readonly string[];
}>;

/** Resolves the production command policy without importing auth or accepting a wake. */
export async function resolveOrganizationCodexSandboxProjection(config: unknown, agentId: string,
  options: Readonly<{ acceptanceStorePath: string }>): Promise<OrganizationCodexSandboxProjection> {
  const parsed = parseOrganizationRuntimeConfig(config);
  const selected = parsed.agents.find(agent => agent.id === agentId);
  if (!selected || selected.engine.kind !== "codex" || selected.engine.codexSandbox === undefined) {
    throw new Error("Sandbox projection requires a known strict Codex agent");
  }
  if (!path.isAbsolute(options.acceptanceStorePath)) throw new Error("Sandbox projection requires an absolute acceptance store path");
  const authority = await prepareOrganizationRuntimePaths(parsed.agents);
  try {
    const paths = authority.forAgent(selected);
    await paths.verify();
    const agent = { ...selected, workspacePath: paths.workspacePath, runtimeHomePath: paths.runtimeHomePath };
    const engineHomePath = path.join(agent.runtimeHomePath, engineHomeName("codex"));
    const executable = await prepareEngineExecutable(agent.id, "codex");
    // These are the same collectors, canonical roots and renderer used by
    // startOrganizationRuntimeEngine and its strict production invocation.
    const args = renderCodexArgs({ codexSandbox: agent.engine.codexSandbox,
      codexSandboxProtectedPaths: codexSandboxProtectedPaths(agent.id, agent, engineHomePath, parsed.agents, [options.acceptanceStorePath]),
      codexSandboxReadablePaths: codexSandboxReadablePaths(agent) }, agent.workspacePath, undefined);
    const permissionConfig = args.find(arg => arg.startsWith("permissions="))!;
    const profileName = JSON.parse(args.find(arg => arg.startsWith("default_permissions="))!.slice("default_permissions=".length)) as string;
    await paths.verify();
    await executable.verify();
    return { version: CODEX_SANDBOX_PROJECTION_VERSION, agentId, workspacePath: agent.workspacePath,
      runtimeHomePath: agent.runtimeHomePath, engineHomePath, executablePath: executable.executablePath, profileName, permissionConfig,
      sandboxArgs: ["sandbox", "-P", profileName, "-C", agent.workspacePath, "-c", permissionConfig] };
  } finally { await authority.close(); }
}

import { createHash } from "node:crypto";
import path from "node:path";

import { canonicalJson } from "../contracts/canonicalJson.js";
import { DAIMON_GROK_SYSTEM_PROMPT } from "../contracts/grokWorkerContract.js";
import { GROK_ENGINE_BROKER } from "../contracts/runtimeContractManifest.js";
import { grokSandboxProtectedPaths } from "./engineDispatcher.js";
import { parseEngineBrokerServiceConfig, type EngineBrokerServiceRegistration } from "./engineBrokerServiceConfig.js";
import { parseEngineBrokerTurnLimits, type EngineBrokerTurnLimits } from "./engineBrokerTurnAccounting.js";
import { grokBrokerWorkerConfigSha256 } from "./grokBrokerWorkerConfig.js";
import type { GrokBrokerModel, GrokBrokerReasoningEffort } from "./grokBrokerModelPolicy.js";
import { GROK_WORKER_SANDBOX_PROFILE, grokWorkerEventsPathFor, renderGrokWorkerSandboxProfile, grokWorkerSandboxProfileSha256 } from "./grokWorkerSandboxProfile.js";
import { parseOrganizationRuntimeConfig } from "./organizationRuntime.js";

export const GROK_BROKER_PROJECTION_VERSION = GROK_ENGINE_BROKER.projectionVersion;

/**
 * Everything a consumer (Spawnfile provisioning, Paideia's native adapter, the
 * root slot supervisor) needs to know about one brokered Grok agent's slot,
 * computed by Daimon from the same renderers and collectors the broker attests
 * against. It never reads credentials, runs a worker, or touches the realm.
 */
export type OrganizationGrokBrokerProjection = Readonly<{
  version: typeof GROK_BROKER_PROJECTION_VERSION;
  agentId: string;
  workspacePath: string;
  runtimeHomePath: string;
  workerUid: number;
  slot: number;
  profilePath: string;
  profileSha256: string;
  denyPaths: readonly string[];
  workerConfigSha256: string;
  systemPromptSha256: string;
  grokCliVersion: string;
  grokExecutableSha256: string;
  nativeAbiVersion: number;
  model: GrokBrokerModel;
  reasoningEffort: GrokBrokerReasoningEffort;
  limits: EngineBrokerTurnLimits;
  usageLedgerPath: string;
  /** The container seccomp profile the worker must run under (the pinned default-plus-userns profile bubblewrap needs). */
  seccompProfileSha256: string;
  attestation: Readonly<{ platform: "linux/landlock"; enforced: true; restrictNetwork: true; profileName: typeof GROK_WORKER_SANDBOX_PROFILE; sandboxRuntime: "bubblewrap"; eventsPath: string }>;
}>;

export type OrganizationGrokBrokerProjectionOptions = Readonly<{
  /** Deployment-assigned slot identity. */
  slot: number;
  workerUid: number;
  /** The worker's home; its `GROK_HOME` is `<workerHomePath>/.grok`. */
  workerHomePath: string;
  architecture: "arm64" | "x64";
  usageLedgerPath: string;
  limits: EngineBrokerTurnLimits;
  /** The wake-acceptance store, always denied like the Codex projection's. */
  acceptanceStorePath: string;
  /** Evaluator and host-bind paths the deployment must keep from the worker (R4). */
  denyPaths?: readonly string[];
  /** sha256 of the seccomp profile bytes the deployment runs the worker under. */
  seccompProfileSha256: string;
  /** When the caller already holds a rendered profile digest, it must equal Daimon's. */
  profileSha256?: string;
}>;

/**
 * Resolve the public Grok broker projection for one agent.
 *
 * Paths are taken as given, never resolved: the caller (Spawnfile provisioning)
 * must supply canonical, non-symlink paths — the fixed tmpfs/workspace roots it
 * creates — and its provisioning must verify they are not symlinks before a
 * slot is used; the broker's own attestation re-checks the worker home at
 * every turn.
 *
 * Deterministic and I/O-free on purpose: its digest
 * ({@link grokBrokerProjectionSha256}) is what the slot preflight receipt
 * binds, so the supervisor that writes the receipt and the evaluator that reads
 * it must compute byte-equal projections from the same inputs.
 *
 * The agent must be a Grok agent that *declares* its model and reasoning
 * effort; nothing is defaulted. The deny list is Daimon's own protected set for
 * this agent (realm, bootstrap, peers, acceptance store) plus the caller's
 * evaluator paths, sorted and deduplicated exactly as the profile renderer
 * does. A supplied `profileSha256` that differs is refused.
 */
export function resolveOrganizationGrokBrokerProjection(config: unknown, agentId: string, options: OrganizationGrokBrokerProjectionOptions): OrganizationGrokBrokerProjection {
  const parsed = parseOrganizationRuntimeConfig(config);
  const agent = parsed.agents.find((entry) => entry.id === agentId);
  if (agent === undefined || agent.engine.kind !== "grok") throw new Error("Grok broker projection requires a known Grok agent");
  if (agent.engine.model === undefined || agent.engine.reasoningEffort === undefined) throw new Error("Grok broker projection requires a declared model and reasoning effort");
  for (const [label, value] of [["workerHomePath", options.workerHomePath], ["acceptanceStorePath", options.acceptanceStorePath]] as const) {
    if (!path.posix.isAbsolute(value) || path.posix.normalize(value) !== value || value === "/" || value.endsWith("/")) throw new Error(`Grok broker projection requires a canonical absolute ${label}`);
  }
  if (!/^[a-f0-9]{64}$/u.test(options.seccompProfileSha256)) throw new Error("Grok broker projection requires a seccomp profile sha256");
  const model = agent.engine.model as GrokBrokerModel, reasoningEffort = agent.engine.reasoningEffort as GrokBrokerReasoningEffort;
  const denyPaths = [...new Set([...grokSandboxProtectedPaths(agent.id, parsed.agents, [options.acceptanceStorePath]), ...(options.denyPaths ?? [])])].sort();
  renderGrokWorkerSandboxProfile(denyPaths);
  const profileSha256 = grokWorkerSandboxProfileSha256(denyPaths);
  if (options.profileSha256 !== undefined && options.profileSha256 !== profileSha256) throw new Error("Grok broker projection profile digest mismatch");
  const workerConfigSha256 = grokBrokerWorkerConfigSha256({ model, reasoningEffort });
  if (workerConfigSha256 !== GROK_ENGINE_BROKER.worker.configSha256[model][reasoningEffort]) throw new Error("Grok broker projection worker config drifted from the manifest");
  if (createHash("sha256").update(DAIMON_GROK_SYSTEM_PROMPT).digest("hex") !== GROK_ENGINE_BROKER.worker.systemPromptSha256) throw new Error("Grok broker projection system prompt drifted from the manifest");
  const artifact = GROK_ENGINE_BROKER.grokCliArtifacts[options.architecture];
  if (artifact === undefined) throw new Error("Grok broker projection requires a pinned architecture");
  const profilePath = path.posix.join(options.workerHomePath, ".grok", "sandbox.toml");
  const projection: OrganizationGrokBrokerProjection = {
    version: GROK_BROKER_PROJECTION_VERSION, agentId, workspacePath: agent.workspacePath, runtimeHomePath: agent.runtimeHomePath,
    workerUid: options.workerUid, slot: options.slot, profilePath, profileSha256, denyPaths, workerConfigSha256,
    systemPromptSha256: GROK_ENGINE_BROKER.worker.systemPromptSha256, grokCliVersion: GROK_ENGINE_BROKER.grokCliVersion, grokExecutableSha256: artifact.sha256,
    nativeAbiVersion: GROK_ENGINE_BROKER.nativeAbiVersion, model, reasoningEffort, limits: parseEngineBrokerTurnLimits(options.limits), usageLedgerPath: options.usageLedgerPath, seccompProfileSha256: options.seccompProfileSha256,
    attestation: { platform: "linux/landlock", enforced: true, restrictNetwork: true, profileName: GROK_WORKER_SANDBOX_PROFILE, sandboxRuntime: "bubblewrap", eventsPath: grokWorkerEventsPathFor(profilePath) }
  };
  // The registration this projection implies must itself be a valid v2 service.json entry.
  grokBrokerServiceRegistrationFor(projection);
  return projection;
}

/** sha256 over the projection's canonical JSON; what a slot preflight receipt binds. */
export const grokBrokerProjectionSha256 = (projection: OrganizationGrokBrokerProjection): string =>
  createHash("sha256").update(canonicalJson(projection)).digest("hex");

/** The `service.json` v2 registration a deployment provisions for this projection, validated by the broker's own parser. */
export function grokBrokerServiceRegistrationFor(projection: OrganizationGrokBrokerProjection): Readonly<Record<string, unknown>> {
  const registration = {
    agentId: projection.agentId, slot: projection.slot, workerUid: projection.workerUid, workspace: projection.workspacePath,
    profilePath: projection.profilePath, eventsPath: projection.attestation.eventsPath, profileSha256: projection.profileSha256,
    usageLedgerPath: projection.usageLedgerPath, limits: projection.limits, model: { id: projection.model, reasoningEffort: projection.reasoningEffort }
  };
  parseEngineBrokerServiceConfig({ version: "noopolis.daimon.engine-broker-service.v2", credentialHome: GROK_ENGINE_BROKER.credentialHomePath, turnStore: GROK_ENGINE_BROKER.turnStorePath, registrations: [registration] });
  return registration;
}

/**
 * Refuses a provisioned registration that does not describe this projection:
 * any differing member — a weaker profile digest, another model, raised
 * limits, a different ledger — is a mismatch, never a merge.
 */
export function verifyGrokBrokerRegistrationMatchesProjection(registration: EngineBrokerServiceRegistration, projection: OrganizationGrokBrokerProjection): void {
  const expected = parseEngineBrokerServiceConfig({ version: "noopolis.daimon.engine-broker-service.v2", credentialHome: GROK_ENGINE_BROKER.credentialHomePath, turnStore: GROK_ENGINE_BROKER.turnStorePath, registrations: [grokBrokerServiceRegistrationFor(projection)] }).registrations[0]!;
  if (canonicalJson(expected) !== canonicalJson(registration)) throw new Error("Grok broker registration does not match its projection");
}

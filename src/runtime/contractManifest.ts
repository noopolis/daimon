import { canonicalJson } from "../contracts/canonicalJson.js";
import {
  AGY_SUBSCRIPTION_REALM,
  ENGINE_CREDENTIAL_MATERIAL,
  GROK_ENGINE_BROKER,
  GROK_SUBSCRIPTION_REALM,
  ORGANIZATION_RUNTIME_ACTIVITY_V2_VERSION,
  RUNTIME_CONTRACT_MANIFEST,
  RUNTIME_CONTRACT_MANIFEST_VERSION
} from "../contracts/runtimeContractManifest.js";

export {
  AGY_SUBSCRIPTION_REALM,
  canonicalJson,
  ENGINE_CREDENTIAL_MATERIAL,
  GROK_ENGINE_BROKER,
  GROK_SUBSCRIPTION_REALM,
  ORGANIZATION_RUNTIME_ACTIVITY_V2_VERSION,
  RUNTIME_CONTRACT_MANIFEST,
  RUNTIME_CONTRACT_MANIFEST_VERSION
};

export type RuntimeContractManifest = typeof RUNTIME_CONTRACT_MANIFEST;
export type EngineCredentialKind = keyof typeof ENGINE_CREDENTIAL_MATERIAL;
export type EngineCredentialSlot = (typeof ENGINE_CREDENTIAL_MATERIAL)[EngineCredentialKind]["sourceSlot"];

export const canonicalRuntimeContractManifest = (): string => canonicalJson(RUNTIME_CONTRACT_MANIFEST);

import {
  ENGINE_CREDENTIAL_MATERIAL,
  RUNTIME_CONTRACT_MANIFEST,
  RUNTIME_CONTRACT_MANIFEST_VERSION
} from "./contractManifest.js";

type Assert<T extends true> = T;
type IsEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ?
    ((<T>() => T extends B ? 1 : 2) extends (<T>() => T extends A ? 1 : 2) ? true : false) : false;

type ManifestVersion = Assert<IsEqual<typeof RUNTIME_CONTRACT_MANIFEST.version, typeof RUNTIME_CONTRACT_MANIFEST_VERSION>>;
type CodexCredentialSlot = Assert<IsEqual<typeof ENGINE_CREDENTIAL_MATERIAL.codex.sourceSlot, "codex-auth">>;

const manifestVersion: ManifestVersion = true;
const codexCredentialSlot: CodexCredentialSlot = true;
void [manifestVersion, codexCredentialSlot];

function manifestConstantsAreReadonly(): void {
  // @ts-expect-error The exported manifest remains deeply immutable.
  RUNTIME_CONTRACT_MANIFEST.supportedEngineKinds[0] = "codex";
  // @ts-expect-error Credential material remains deeply immutable.
  ENGINE_CREDENTIAL_MATERIAL.codex.sourceSlot = "codex-auth";
}
void manifestConstantsAreReadonly;

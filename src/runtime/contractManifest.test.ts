import assert from "node:assert/strict";
import test from "node:test";

import { AGY_SUBSCRIPTION_REALM, canonicalJson, canonicalRuntimeContractManifest, ENGINE_CREDENTIAL_MATERIAL, RUNTIME_CONTRACT_MANIFEST } from "./contractManifest.js";

test("runtime contract manifest is data-only and deterministic", () => {
  const first = canonicalRuntimeContractManifest();
  assert.equal(first, canonicalRuntimeContractManifest());
  assert.equal(first, canonicalJson(RUNTIME_CONTRACT_MANIFEST));
  assert.deepEqual(Object.keys(ENGINE_CREDENTIAL_MATERIAL), ["codex", "grok"]);
  assert.deepEqual(RUNTIME_CONTRACT_MANIFEST.supportedEngineKinds, ["agy", "codex", "grok"]);
  assert.equal(RUNTIME_CONTRACT_MANIFEST.agySubscriptionRealm, AGY_SUBSCRIPTION_REALM);
  assert.equal(AGY_SUBSCRIPTION_REALM.directoryMode, 0o700);
  assert.equal(AGY_SUBSCRIPTION_REALM.fileMode, 0o600);
  assert.doesNotMatch(first, /antigravity-oauth-token|agy-auth/);
  assert.doesNotMatch(first, /DBUS_SESSION_BUS_ADDRESS|gnome-keyring|dbus-daemon|argv|command|schedule|moltnet|credential value/i);
  for (const rule of Object.values(ENGINE_CREDENTIAL_MATERIAL)) {
    assert.equal(rule.directoryMode, 0o700);
    assert.equal(rule.fileMode, 0o600);
    assert.ok(!rule.sourceRelativePath.startsWith("/") && !rule.sourceRelativePath.includes(".."));
    assert.ok(!rule.destinationRelativePath.startsWith("/") && !rule.destinationRelativePath.includes(".."));
  }
});

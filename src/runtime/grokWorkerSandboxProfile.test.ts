import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { parseGrokWorkerSandboxProfile } from "./grokWorkerAttestation.js";
import { grokWorkerEventsPathFor, grokWorkerSandboxProfileSha256, renderGrokWorkerSandboxProfile } from "./grokWorkerSandboxProfile.js";

test("renders a non-empty deny list deterministically and round-trips through the attestation parser", () => {
  const profile = renderGrokWorkerSandboxProfile(["/run/training/inputs", "/run/paideia", "/run/paideia"]);
  assert.equal(profile, '[profiles.daimon-strict]\nextends = "strict"\nrestrict_network = true\ndeny = ["/run/paideia", "/run/training/inputs"]\n');
  assert.equal(renderGrokWorkerSandboxProfile(["/run/paideia", "/run/training/inputs"]), profile);
  const digest = createHash("sha256").update(profile).digest("hex");
  assert.equal(grokWorkerSandboxProfileSha256(["/run/training/inputs", "/run/paideia"]), digest);
  assert.deepEqual(parseGrokWorkerSandboxProfile(Buffer.from(profile), digest), ["/run/paideia", "/run/training/inputs"]);
  assert.equal(renderGrokWorkerSandboxProfile(), '[profiles.daimon-strict]\nextends = "strict"\nrestrict_network = true\ndeny = []\n');
});

test("refuses deny paths that are relative, non-canonical, root, globbed, or TOML-breaking", () => {
  for (const entry of ["run/paideia", "/run/../etc", "/run/paideia/", "/", "/run/*", '/run/"x', "/run/a\nb", "/run/a\\b", ""]) {
    assert.throws(() => renderGrokWorkerSandboxProfile([entry]), /deny path/u, JSON.stringify(entry));
  }
});

test("derives the Grok 1.0.34 sandbox events log from the profile location", () => {
  assert.equal(grokWorkerEventsPathFor("/var/lib/daimon-workers/2200/.grok/sandbox.toml"), "/var/lib/daimon-workers/2200/.grok/sessions/sandbox-events.jsonl");
});

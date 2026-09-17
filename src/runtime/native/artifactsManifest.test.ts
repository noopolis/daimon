import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { GROK_ENGINE_BROKER } from "../../contracts/runtimeContractManifest.js";

const sources = ["engineBrokerLauncher.c", "engineBrokerLauncher.h", "engineBrokerLauncherCore.inc", "engineBrokerLauncherServer.inc", "engineBrokerLauncherModes.inc", "engineBrokerLauncherMain.inc"];
const read = (name: string): Buffer => readFileSync(new URL(`./${name}`, import.meta.url));

test("the manifest pins the committed native artifacts, their provenance, and the current launcher source", () => {
  const source = createHash("sha256");
  for (const name of sources) source.update(read(name));
  assert.equal(GROK_ENGINE_BROKER.artifacts.sourceSha256, source.digest("hex"), "launcher source changed without rebuilding the native artifacts");
  for (const [architecture, pinned] of [["x64", GROK_ENGINE_BROKER.artifacts.x64Sha256], ["arm64", GROK_ENGINE_BROKER.artifacts.arm64Sha256]] as const) {
    const binary = read(`artifacts/daimon-engine-broker-${architecture}`);
    const provenance = JSON.parse(read(`artifacts/daimon-engine-broker-${architecture}.provenance.json`).toString("utf8")) as Record<string, unknown>;
    const digest = createHash("sha256").update(binary).digest("hex");
    assert.equal(digest, pinned, architecture);
    assert.equal(provenance.binary_sha256, `sha256:${digest}`, architecture);
    assert.equal(provenance.source_sha256, `sha256:${GROK_ENGINE_BROKER.artifacts.sourceSha256}`, architecture);
    assert.equal(provenance.install_path, GROK_ENGINE_BROKER.nativeExecutablePath, architecture);
  }
});

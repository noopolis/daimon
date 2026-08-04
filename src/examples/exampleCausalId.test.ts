import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createMemoryRuntime } from "@noopolis/mneme";

import { exampleCausalId } from "./exampleCausalId.js";

const exampleDirectory = path.dirname(fileURLToPath(import.meta.url));
const readmeExamples = [
  "pi-agent.ts",
  "pi-memory-org.ts",
  "jungian-play-org.ts",
  "jungian-triad-org.ts"
];

test("README-listed examples namespace every locally-authored wake id", async () => {
  for (const fileName of readmeExamples) {
    const source = await readFile(path.join(exampleDirectory, fileName), "utf8");
    const wakeIds = [...source.matchAll(
      /id:\s*([^\n]+),\n\s+kind:\s*"(?:manual|message|schedule)"/gu
    )].map((match) => match[1]?.trim());
    assert.ok(wakeIds.length > 0, `${fileName} must author at least one wake id`);
    assert.equal(
      wakeIds.every((expression) => expression?.startsWith("exampleCausalId(") === true),
      true,
      `${fileName} contains a wake id outside exampleCausalId`
    );
  }
});

test("the Pi memory example id passes Mneme preparation without a live agent", async () => {
  const runtimeHomePath = await mkdtemp(path.join(os.tmpdir(), "daimon-example-causal-"));
  try {
    const eventId = exampleCausalId("seed-atlas");
    const prepared = await createMemoryRuntime({ agentId: "atlas", runtimeHomePath }).prepareTurn({
      context: {},
      eventId,
      kind: "manual",
      text: "Private memory seed."
    });
    assert.equal(eventId, "daimon:seed-atlas");
    assert.equal(prepared.principal.agentId, "atlas");
  } finally {
    await rm(runtimeHomePath, { force: true, recursive: true });
  }
});

test("example causal ids reject already-namespaced and malformed input", () => {
  assert.throws(() => exampleCausalId("daimon:double"), /bounded local id/u);
  assert.throws(() => exampleCausalId("wake/other"), /bounded local id/u);
});

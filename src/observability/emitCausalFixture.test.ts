import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runCausalFixture } from "./emitCausalFixture.js";

const tempRoots: string[] = [];

const tempDir = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "noopolis-daimon-causal-fixture-"));
  tempRoots.push(directory);
  return directory;
};

test.afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("runCausalFixture stamps a turn.input.submitted -> turn.output.completed chain with an agent: principal", async () => {
  const runtimeHomePath = await tempDir();

  const { events, jsonlPath } = await runCausalFixture({ runtimeHomePath });
  const [inputEvent, outputEvent] = events;

  assert.equal(inputEvent.type, "turn.input.submitted");
  assert.equal(inputEvent.principal_id, "agent:fixture-agent");
  assert.equal(outputEvent.type, "turn.output.completed");
  assert.equal(outputEvent.principal_id, "agent:fixture-agent");
  assert.deepEqual(outputEvent.cause_event_ids, [inputEvent.event_id]);

  const raw = await readFile(jsonlPath, "utf8");
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  assert.equal(lines.length, 2);
});

test("runCausalFixture spoof mode embeds a forged identity claim in content but never in principal_id", async () => {
  const runtimeHomePath = await tempDir();

  const { events } = await runCausalFixture({ runtimeHomePath, spoof: true });
  const [inputEvent, outputEvent] = events;

  // The forged claim is present in the fixture's own record of what a
  // model/request tried to assert...
  const raw = await readFile(path.join(runtimeHomePath, "telemetry", "causal.jsonl"), "utf8");
  assert.ok(raw.includes("SPOOF") === false, "raw sha256-hashed jsonl should not leak the claim text verbatim");

  // ...but the stamped envelope must always carry the authenticated
  // principal, never the spoofed one.
  for (const event of [inputEvent, outputEvent]) {
    assert.equal(event.principal_id, "agent:fixture-agent");
    assert.notEqual(event.principal_id, "agent:attacker-agent");
  }
});

test("normal and spoof runs are deterministic and independent of each other", async () => {
  const normalRoot = await tempDir();
  const spoofRoot = await tempDir();

  const normal = await runCausalFixture({ runtimeHomePath: normalRoot });
  const spoof = await runCausalFixture({ runtimeHomePath: spoofRoot, spoof: true });

  assert.equal(normal.events[0].principal_id, spoof.events[0].principal_id);
  assert.notEqual(normal.events[0].payload.input_content_sha256, spoof.events[0].payload.input_content_sha256);
});

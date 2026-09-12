import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { WakeEvent } from "../core/types.js";
import { attentionTools, type AttentionRegistry, type AttentionTurn } from "./attention.js";
import { createOrganizationRuntimeHostForTest } from "./organizationRuntimeHost.js";
import { createOrganizationRuntimeControlHostWithCoreForTest } from "./organizationRuntimeControl.js";
import { parseOrganizationRuntimeWakeRequest } from "./organizationRuntime.js";

const tokenEnv = "DAIMON_ATTENTION_INTEGRATION_TOKEN";
const token = "attention-integration";
const pause = (ms = 5) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>) {
  for (let n = 0; n < 300; n++) { if (await check()) return; await pause(); }
  throw new Error("expected side effect did not appear");
}
const request = (id: string, text: string, kind = "message") => ({ token, agent_id: "alpha", delivery_id: id,
  event: { version: "noopolis.daimon.wake.v2", kind, text, occurred_at: "2026-09-12T11:30:00.000Z" } });

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-attention-validation-")); await chmod(root, 0o700);
  const previousToken = process.env[tokenEnv]; process.env[tokenEnv] = token;
  const config = { version: "noopolis.daimon.organization-runtime.v1", host: { bindHost: "127.0.0.1", port: 4318, controlTokenEnv: tokenEnv },
    agents: [{ id: "alpha", name: "Alpha", instructions: "Act", workspacePath: "/workspace/alpha", runtimeHomePath: "/homes/alpha", engine: { kind: "codex" }, attention: {} }] };
  let registry: AttentionRegistry;
  const calls: WakeEvent[] = [];
  let attempts = 0;
  let reject = false;
  let onTurn = async (_event: WakeEvent, turn: AttentionTurn) => {
    for (const message of turn.messages) await turn.disposition(message.delivery_id, "complete");
  };
  const make = () => {
    registry = new Map();
    // Keep the real host, request parser, store, dispatcher, and inbox tools.
    // Only cognition is substituted; no provider login or network is involved.
    const host = createOrganizationRuntimeHostForTest(config, async () => ({ id: "alpha",
      status: () => ({ agentId: "alpha", state: "idle" }), stop: async () => {},
      wake: async (event) => { calls.push(event); await onTurn(event, registry.get("alpha")!); return { agentId: "alpha", text: "done", durationMs: 1 }; }
    }));
    const wake = host.wake;
    host.wake = async (input) => {
      attempts++;
      if (reject) return { version: "noopolis.daimon.wake-result.v1", status: "rejected", agentId: "alpha", wakeId: input.event.id, code: "invalid_request" };
      return wake(input);
    };
    return createOrganizationRuntimeControlHostWithCoreForTest(config, host, { acceptanceStorePath: root, controlToken: token, attentionRegistryForTest: registry, storeOptions: process.platform === "linux" ? {} : { processIdentity: async () => ({ pid: 1, process_start: "test-start", boot_id: "test-boot", pid_namespace_dev: 1, pid_namespace_ino: 1 }), ownerLiveness: async () => true }, fuseEnvironment: { DAIMON_WAKE_FUSE: "off" } });
  };
  let control = make(); await control.start();
  return { root, calls, get attempts() { return attempts; }, get control() { return control; }, get registry() { return registry; },
    set onTurn(value: typeof onTurn) { onTurn = value; }, set reject(value: boolean) { reject = value; },
    async restart() { await control.stop(); control = make(); await control.start(); },
    async cleanup() { await control.stop(); await rm(root, { recursive: true, force: true }); if (previousToken === undefined) delete process.env[tokenEnv]; else process.env[tokenEnv] = previousToken; }
  };
}

test("a valid long scheduled delivery crosses the real host boundary and completes via its intact inbox", async () => {
  const f = await fixture();
  const text = "S".repeat(3540), deliveryId = `schedule:${"a".repeat(180)}:2026-09-12T13:30@GMT+02:00`;
  try {
    parseOrganizationRuntimeWakeRequest({ token, agentId: "alpha", event: { version: "noopolis.daimon.wake.v1", id: "valid-source", kind: "schedule", text, occurredAt: "2026-09-12T11:30:00.000Z" } });
    f.onTurn = async (event, turn) => {
      assert.match(event.text, /read it with daimon_inbox/);
      const tool = attentionTools("alpha", f.registry)[0]!;
      const result = await tool.execute("read", {}, undefined, undefined, {} as never);
      const details = result.details as { messages: Array<{ delivery_id: string; text: string }> };
      assert.equal(details.messages[0]!.text, text); assert.equal(details.messages[0]!.delivery_id, deliveryId);
      await turn.disposition(deliveryId, "complete");
    };
    const receipt = await f.control.accept(request(deliveryId, text, "schedule")); assert.equal(receipt.state, "accepted");
    await until(async () => (await f.control.activityV2(token))!.items[0]?.state === "completed");
    assert.equal(f.calls.length, 1);
    assert.equal((await f.control.availability(token))!.state, "running");
  } finally { await f.cleanup(); }
});

test("a busy inbox batches six large messages without losing payloads or failing the real validator", async () => {
  const f = await fixture(); let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const bodies = Array.from({ length: 6 }, (_, i) => `${i}:` + "R".repeat(1500));
  try {
    f.onTurn = async (event, turn) => {
      if (turn.messages[0]!.delivery_id === "hold") await held;
      else {
        assert.equal(turn.messages.length, 6); assert.match(event.text, /read it with daimon_inbox/);
        assert.deepEqual(turn.messages.map((message) => message.text), bodies);
      }
      for (const message of turn.messages) await turn.disposition(message.delivery_id, "complete");
    };
    await f.control.accept(request("hold", "wait")); await until(() => f.calls.length === 1);
    for (const [i, body] of bodies.entries()) await f.control.accept(request(`batch-${i}`, body));
    release();
    await until(async () => (await f.control.activityV2(token))!.items.filter((item) => item.state === "completed").length === 7);
    assert.equal(f.calls.length, 2);
  } finally { release(); await f.cleanup(); }
});

test("Unicode is counted in codepoints and a small or multibyte delivery stays inline", async () => {
  const f = await fixture();
  try {
    for (const text of ["small", "😀".repeat(1900)]) {
      f.onTurn = async (event, turn) => {
        assert.ok(event.text.includes(text)); assert.doesNotMatch(event.text, /selected payload exceeds/);
        await turn.disposition(turn.messages[0]!.delivery_id, "complete");
      };
      await f.control.accept(request(`inline-${f.calls.length}`, text));
      await until(async () => (await f.control.activityV2(token))!.items.every((item) => item.state === "completed"));
    }
    assert.equal(f.calls.length, 2);
  } finally { await f.cleanup(); }
});

for (const failure of ["rejected", "engine_failed"] as const) test(`${failure} remains visible after idle and restart, survives unrelated success, and clears on recovery`, async () => {
  const f = await fixture(); let fail = true;
  try {
    f.reject = failure === "rejected";
    f.onTurn = async (_event, turn) => {
      if (fail && turn.messages.some((message) => message.delivery_id === "broken")) throw new Error("provider unavailable Bearer secret-review-token");
      for (const message of turn.messages) await turn.disposition(message.delivery_id, "complete");
    };
    await f.control.accept(request("broken", "handle the delivery"));
    await until(async () => (await f.control.availability(token))!.state === "paused");
    const availability = (await f.control.availability(token))!;
    assert.match(availability.agents[0]!.error!, failure === "rejected" ? /invalid_request/ : /provider unavailable/);
    assert.doesNotMatch(JSON.stringify(availability), /secret-review-token/);
    const original = (await f.control.activityV2(token))!.items[0]!;
    assert.equal(original.state, "accepted"); assert.equal(original.deferred, true);
    assert.ok(original.execution_id);
    const attempts = f.attempts; await pause(40); assert.equal(f.attempts, attempts);
    await f.restart(); await pause(40); assert.equal(f.attempts, attempts);
    assert.equal((await f.control.availability(token))!.state, "paused");
    // Let a different delivery complete while the failed delivery still fails.
    f.reject = false;
    await f.control.accept(request("unrelated", "other work"));
    await until(async () => (await f.control.activityV2(token))!.items.some((item) => item.delivery_id === "unrelated" && item.state === "completed"));
    assert.equal((await f.control.availability(token))!.state, "paused");
    assert.equal((await f.control.activityV2(token))!.items.find((item) => item.delivery_id === "broken")!.execution_id, original.execution_id);
    // Durable diagnostics are redacted at rest, not only at the HTTP surface.
    for (const file of await readdir(f.root)) if (file.endsWith(".json")) assert.doesNotMatch(await readFile(path.join(f.root, file), "utf8"), /secret-review-token/);
    fail = false; await f.control.accept(request("retry", "new input"));
    await until(async () => (await f.control.activityV2(token))!.items.every((item) => item.state === "completed"));
    assert.equal((await f.control.availability(token))!.state, "running");
    assert.equal((await f.control.availability(token))!.agents[0]!.error, undefined);
  } finally { await f.cleanup(); }
});

test("an agent can explicitly defer recovered work without leaving a runtime failure alarm", async () => {
  const f = await fixture();
  try {
    f.reject = true;
    await f.control.accept(request("defer-later", "work"));
    await until(async () => (await f.control.availability(token))!.state === "paused");
    f.reject = false;
    f.onTurn = async (_event, turn) => {
      for (const message of turn.messages) await turn.disposition(message.delivery_id, message.delivery_id === "defer-later" ? "defer" : "complete");
    };
    await f.control.accept(request("fresh", "new input"));
    await until(async () => (await f.control.activityV2(token))!.items.some((item) => item.delivery_id === "fresh" && item.state === "completed"));
    const availability = (await f.control.availability(token))!;
    assert.equal(availability.state, "running"); assert.equal(availability.agents[0]!.error, undefined);
    const receipt = (await f.control.activityV2(token))!.items.find((item) => item.delivery_id === "defer-later")!;
    assert.equal(receipt.state, "accepted"); assert.equal(receipt.deferred, true); assert.equal(receipt.execution_id, undefined);
    await f.restart();
    assert.equal((await f.control.availability(token))!.state, "running");
  } finally { await f.cleanup(); }
});

import { strict as assert } from "node:assert";
import { chmod, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { AgentHandle, AgentStatus, WakeEvent, WakeResult } from "../core/types.js";
import { ORGANIZATION_RUNTIME_VERSION, type OrganizationRuntimeWakeRequest } from "./organizationRuntime.js";
import { createOrganizationRuntimeHostForTest } from "./organizationRuntimeHost.js";
import { prepareOrganizationRuntimePaths } from "./physicalReadiness.js";

const tokenEnv = "DAIMON_RUNTIME_HOST_TEST_TOKEN";

const config = (ids: readonly string[] = ["alpha", "beta"]) => ({
  version: ORGANIZATION_RUNTIME_VERSION,
  host: { bindHost: "127.0.0.1", port: 4318, controlTokenEnv: tokenEnv },
  agents: ids.map((id) => ({
    id,
    name: id,
    instructions: `Act as ${id}.`,
    workspacePath: `/runtime/workspaces/${id}`,
    runtimeHomePath: `/runtime/homes/${id}`,
    engine: { kind: "codex" as const }
  }))
});

const wake = (agentId: string, id: string, token = "test-token"): OrganizationRuntimeWakeRequest => ({
  token,
  agentId,
  event: { version: "noopolis.daimon.wake.v1", id, kind: "manual", text: id, occurredAt: "2026-08-17T00:00:00.000Z" }
});

class FakeHandle implements AgentHandle {
  readonly seen: string[] = [];
  readonly stopped: Promise<void>;
  private resolveStop!: () => void;
  private state: AgentStatus["state"] = "idle";
  private readonly waiting = new Map<string, () => void>();

  public constructor(private readonly hold = false) {
    this.stopped = new Promise((resolve) => { this.resolveStop = resolve; });
  }

  async wake(event: WakeEvent): Promise<WakeResult> {
    this.state = "running";
    this.seen.push(event.id);
    if (this.hold) await new Promise<void>((resolve) => this.waiting.set(event.id, resolve));
    this.state = "idle";
    return { agentId: this.id, text: `done:${event.id}`, durationMs: 1 };
  }

  get id(): string { return "fake"; }
  status(): AgentStatus { return { agentId: this.id, state: this.state }; }
  async stop(): Promise<void> {
    this.state = "stopped";
    for (const release of this.waiting.values()) release();
    this.resolveStop();
  }
  release(id: string): void { this.waiting.get(id)?.(); }
}

test("requires a non-blank control token before constructing any agent", async () => {
  delete process.env[tokenEnv];
  let calls = 0;
  const host = createOrganizationRuntimeHostForTest(config(), async () => {
    calls += 1;
    return new FakeHandle();
  });
  await assert.rejects(host.start(), /missing or blank/);
  assert.equal(calls, 0);
  assert.deepEqual((await host.health()).agents.map((agent) => agent.state), ["stopped", "stopped"]);
});

test("caller-root preflight rejects missing, unsafe, linked, and overlapping roots before agents", async () => {
  process.env[tokenEnv] = "test-token";
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-host-roots-"));
  const workspace = path.join(root, "workspace");
  const home = path.join(root, "home");
  const candidate = config(["alpha"]);
  candidate.agents[0]!.workspacePath = workspace;
  candidate.agents[0]!.runtimeHomePath = home;
  let calls = 0;
  const host = (): ReturnType<typeof createOrganizationRuntimeHostForTest> => createOrganizationRuntimeHostForTest(
    candidate,
    async () => { calls += 1; return new FakeHandle(); },
    () => prepareOrganizationRuntimePaths(candidate.agents)
  );
  try {
    await mkdir(home, { mode: 0o700 });
    await assert.rejects(host().start(), /ENOENT/);
    assert.equal(calls, 0);
    await mkdir(workspace, { mode: 0o700 });
    await chmod(home, 0o755);
    await assert.rejects(host().start(), /mode 0700/);
    assert.equal(calls, 0);
    await chmod(home, 0o700);
    const linked = path.join(root, "linked");
    await symlink(workspace, linked);
    candidate.agents[0]!.workspacePath = linked;
    await assert.rejects(host().start(), /symlink/);
    assert.equal(calls, 0);
    candidate.agents[0]!.workspacePath = workspace;
    candidate.agents[0]!.runtimeHomePath = workspace;
    assert.throws(() => host(), /must not overlap/);
    assert.equal(calls, 0);
  } finally {
    delete process.env[tokenEnv];
    await rm(root, { recursive: true, force: true });
  }
});

test("validates malformed wakes before activity and authenticates before stopped-state routing", async () => {
  process.env[tokenEnv] = "test-token";
  const host = createOrganizationRuntimeHostForTest(config(["alpha"]), async () => new FakeHandle());
  const invalid = await host.wake({ token: "test-token", agentId: "alpha", event: { id: "bad" } } as never);
  assert.deepEqual(invalid, {
    version: "noopolis.daimon.wake-result.v1", status: "rejected", agentId: "", wakeId: "", code: "invalid_request"
  });
  assert.equal((await host.activity({ limit: 10 })).items.length, 0);
  assert.equal((await host.wake(wake("alpha", "unstarted", "wrong"))).status, "rejected");
  assert.equal((await host.wake(wake("not-present", "unstarted"))).status, "stopped");
  assert.equal((await host.wake(wake("alpha", "unstarted"))).status, "stopped");
  delete process.env[tokenEnv];
});

test("rolls back every constructed agent when atomic startup fails", async () => {
  process.env[tokenEnv] = "test-token";
  const started: FakeHandle[] = [];
  const host = createOrganizationRuntimeHostForTest(config(), async (agent) => {
    if (agent.id === "beta") throw new Error("cannot start beta");
    const handle = new FakeHandle();
    started.push(handle);
    return handle;
  });
  await assert.rejects(host.start(), /cannot start beta/);
  await Promise.all(started.map((handle) => handle.stopped));
  assert.equal((await host.health()).state, "stopped");
  delete process.env[tokenEnv];
});

test("serializes one agent while allowing other agents to run independently", async () => {
  process.env[tokenEnv] = "test-token";
  const handles = new Map<string, FakeHandle>();
  const host = createOrganizationRuntimeHostForTest(config(), async (agent) => {
    const handle = new FakeHandle(true);
    handles.set(agent.id, handle);
    return handle;
  });
  await host.start();
  const alphaOne = host.wake(wake("alpha", "alpha-1"));
  const alphaTwo = host.wake(wake("alpha", "alpha-2"));
  const betaOne = host.wake(wake("beta", "beta-1"));
  await waitFor(() => handles.get("alpha")?.seen.length === 1 && handles.get("beta")?.seen.length === 1);
  assert.deepEqual(handles.get("alpha")?.seen, ["alpha-1"]);
  assert.deepEqual(handles.get("beta")?.seen, ["beta-1"]);
  handles.get("beta")?.release("beta-1");
  handles.get("alpha")?.release("alpha-1");
  await waitFor(() => handles.get("alpha")?.seen.length === 2);
  handles.get("alpha")?.release("alpha-2");
  assert.deepEqual((await alphaOne).status, "completed");
  assert.deepEqual((await alphaTwo).status, "completed");
  assert.deepEqual((await betaOne).status, "completed");
  await host.stop();
  delete process.env[tokenEnv];
});

test("authenticates targeted wakes and exposes bounded activity", async () => {
  process.env[tokenEnv] = "test-token";
  const host = createOrganizationRuntimeHostForTest(config(["alpha"]), async () => new FakeHandle());
  await host.start();
  assert.deepEqual(await host.wake(wake("alpha", "bad", "wrong")), {
    version: "noopolis.daimon.wake-result.v1", status: "rejected", agentId: "alpha", wakeId: "bad", code: "unauthorized"
  });
  assert.equal((await host.wake(wake("none", "unknown"))).status, "rejected");
  assert.equal((await host.wake(wake("alpha", "good"))).status, "completed");
  const page = await host.activity({ agentId: "alpha", limit: 2 });
  assert.equal(page.items.length, 2);
  await assert.rejects(host.activity({ limit: 0 }), /between 1 and 100/);
  await assert.rejects(host.activity({ cursor: "99999999999999999", limit: 1 }), /cursor is invalid/);
  await host.stop();
  delete process.env[tokenEnv];
});

test("stop rejects queued work, aborts active work, and is idempotent", async () => {
  process.env[tokenEnv] = "test-token";
  const handle = new FakeHandle(true);
  const host = createOrganizationRuntimeHostForTest(config(["alpha"]), async () => handle);
  await host.start();
  const active = host.wake(wake("alpha", "active"));
  const queued = host.wake(wake("alpha", "queued"));
  await waitFor(() => handle.seen.length === 1);
  const [first, second] = await Promise.all([host.stop(), host.stop()]);
  assert.strictEqual(first, second);
  assert.equal((await active).status, "stopped");
  assert.equal((await queued).status, "stopped");
  assert.equal((await host.wake(wake("alpha", "later"))).status, "stopped");
  delete process.env[tokenEnv];
});

test("caps queued wakes and retains a bounded, monotonic activity ledger", async () => {
  process.env[tokenEnv] = "test-token";
  const handle = new FakeHandle(true);
  const host = createOrganizationRuntimeHostForTest(config(["alpha"]), async () => handle);
  await host.start();
  const active = host.wake(wake("alpha", "active"));
  await waitFor(() => handle.seen.length === 1);
  const queued = Array.from({ length: 64 }, (_, index) => host.wake(wake("alpha", `queued-${index}`)));
  const overflow = await host.wake(wake("alpha", "overflow"));
  assert.equal(overflow.status, "rejected");
  if (overflow.status === "rejected") assert.equal(overflow.code, "queue_full");
  await host.stop();
  await active;
  await Promise.all(queued);
  const first = await host.activity({ limit: 100 });
  assert.ok(first.items.length <= 100);
  const next = first.nextCursor;
  if (next !== undefined) assert.ok(Number(next) > 0);
  delete process.env[tokenEnv];
});

test("does not claim shutdown after a child cleanup failure", async () => {
  process.env[tokenEnv] = "test-token";
  const handle = new FakeHandle();
  handle.stop = async () => { throw new Error("stubborn child"); };
  const host = createOrganizationRuntimeHostForTest(config(["alpha"]), async () => handle);
  await host.start();
  const first = host.stop();
  const second = host.stop();
  assert.strictEqual(first, second);
  await assert.rejects(first, /shutdown cleanup failed/);
  assert.equal((await host.health()).state, "stopping");
  delete process.env[tokenEnv];
});

test("retries a retained startup-cleanup handle until shutdown is truthful", async () => {
  process.env[tokenEnv] = "test-token";
  const handle = new FakeHandle();
  let stops = 0;
  handle.stop = async () => {
    stops += 1;
    if (stops === 1) throw new Error("first cleanup failed");
    handle.release("anything");
  };
  const host = createOrganizationRuntimeHostForTest(config(), async (agent) => {
    if (agent.id === "beta") throw new Error("second start failed");
    return handle;
  });
  await assert.rejects(host.start(), /startup cleanup failed/);
  assert.equal((await host.health()).state, "stopping");
  await host.stop();
  assert.equal(stops, 2);
  assert.equal((await host.health()).state, "stopped");
  delete process.env[tokenEnv];
});

test("cleanup failure still settles active and queued wakes exactly once", async () => {
  process.env[tokenEnv] = "test-token";
  const handle = new FakeHandle(true);
  handle.stop = async () => { throw new Error("child would not stop"); };
  const host = createOrganizationRuntimeHostForTest(config(["alpha"]), async () => handle);
  await host.start();
  const active = host.wake(wake("alpha", "active"));
  const queued = host.wake(wake("alpha", "queued"));
  await waitFor(() => handle.seen.length === 1);
  await assert.rejects(host.stop(), /shutdown cleanup failed/);
  assert.deepEqual(await active, {
    version: "noopolis.daimon.wake-result.v1", status: "stopped", agentId: "alpha", wakeId: "active", code: "active_wake_aborted"
  });
  assert.deepEqual(await queued, {
    version: "noopolis.daimon.wake-result.v1", status: "stopped", agentId: "alpha", wakeId: "queued", code: "queued_wake_stopped"
  });
  delete process.env[tokenEnv];
});

test("surfaces startup cleanup failure without becoming ready", async () => {
  process.env[tokenEnv] = "test-token";
  const host = createOrganizationRuntimeHostForTest(config(), async (agent) => {
    if (agent.id === "beta") throw new Error("second start failed");
    const handle = new FakeHandle();
    handle.stop = async () => { throw new Error("first child stayed alive"); };
    return handle;
  });
  await assert.rejects(host.start(), /startup cleanup failed/);
  assert.equal((await host.health()).state, "stopping");
  delete process.env[tokenEnv];
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("timed out waiting for fake engine");
}

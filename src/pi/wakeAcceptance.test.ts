import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { WakeEvent } from "../core/types.js";
import { resolveRunId } from "../observability/causalEvents.js";
import {
  WAKE_ACCEPTANCE_COMPLETED_TOMBSTONES,
  WAKE_ACCEPTANCE_FIELD_BYTES_MAX,
  WAKE_ACCEPTANCE_FILE_BYTES_MAX,
  WAKE_ACCEPTANCE_VERSION,
  wakeAcceptanceIdentity,
  wakeAcceptanceDigest,
  type WakeAcceptanceRecord,
  type WakeAcceptanceStoreState
} from "./wakeAcceptanceSchema.js";
import { WakeAcceptanceStore } from "./wakeAcceptance.js";
import { WakeAcceptanceFs } from "./wakeAcceptanceFs.js";
type WakeAdmission = Awaited<ReturnType<WakeAcceptanceStore["begin"]>>;
type WakeRunAdmission = Extract<WakeAdmission, { mode: "run" }>;
const UTF8 = "utf8";
const tempRoots: string[] = [];
test.beforeEach(() => {
  process.env.NOOPOLIS_RUN_ID = "run-test-wake-acceptance";
});
test.afterEach(async () => {
  delete process.env.NOOPOLIS_RUN_ID;
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});
const tempDir = async (): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "noopolis-b34-"));
  tempRoots.push(root);
  return root;
};
const withRunId = async <T>(runId: string, block: () => Promise<T>): Promise<T> => {
  const previous = process.env.NOOPOLIS_RUN_ID;
  process.env.NOOPOLIS_RUN_ID = runId;
  try {
    return await block();
  } finally {
    if (previous === undefined) {
      delete process.env.NOOPOLIS_RUN_ID;
    } else {
      process.env.NOOPOLIS_RUN_ID = previous;
    }
  }
};
const baseEvent = (id: string, text = `payload-${id}`, extra: Partial<WakeEvent> = {}): WakeEvent =>
  ({
    id,
    kind: "message",
    from: "sender-1",
    text,
    context: { networkId: "net", roomId: "room", teamId: "team" },
    delivery: { eventId: id, sender: "sender-1", target: "agent-1", contextId: `context-${id}` },
    ...extra
  });
const stateFile = (runtimeHomePath: string): string =>
  new WakeAcceptanceStore(runtimeHomePath, "agent-1").getAcceptanceFilePath();
const readStore = async (runtimeHomePath: string): Promise<WakeAcceptanceStoreState> => {
  const body = await readFile(stateFile(runtimeHomePath), UTF8);
  return JSON.parse(body) as WakeAcceptanceStoreState;
};
const writeStoreState = async (runtimeHomePath: string, records: WakeAcceptanceRecord[]): Promise<void> => {
  const value = {
    version: WAKE_ACCEPTANCE_VERSION,
    run_id: resolveRunId(),
    agent_id: "agent-1",
    next_sequence: records.at(-1)?.sequence ?? 0,
    records
  };
  await mkdir(path.dirname(stateFile(runtimeHomePath)), { mode: 0o700, recursive: true });
  await writeFile(stateFile(runtimeHomePath), JSON.stringify(value), UTF8);
  await chmod(stateFile(runtimeHomePath), 0o600);
};
const rejectWithCode = async (value: Promise<unknown>, code: string): Promise<void> => {
  await assert.rejects(value, (error: unknown) => {
    const candidate = error as Error & { code?: string };
    return candidate instanceof Error && candidate.code === code;
  });
};
const hashSha256 = (value: string): string => createHash("sha256").update(value, UTF8).digest("hex");
const runAdmission = async (store: WakeAcceptanceStore, event: WakeEvent): Promise<WakeRunAdmission> => {
  const result = await store.begin(event);
  if (result.mode !== "run") {
    throw new Error("expected run admission");
  }
  return result;
};
const makeAttemptRecord = (
  runtimeHomePath: string,
  id: string,
  sequence: number,
  state: "accepted" | "invoking" | "completed" | "incomplete"
): WakeAcceptanceRecord => {
  const attempt = new WakeAcceptanceStore(runtimeHomePath, "agent-1").candidateFromDelivery(baseEvent(id));
  return {
    body_sha256: attempt.bodySha256,
    context_id: attempt.contextId,
    digest: attempt.digest,
    event_id: attempt.eventId,
    identity: attempt.identity,
    kind: attempt.kind,
    sender: attempt.sender,
    state,
    sequence,
    target: attempt.target
  };
};
const buildNearCapacityRecords = async (runtimeHomePath: string): Promise<WakeAcceptanceRecord[]> => {
  const records: WakeAcceptanceRecord[] = [];
  let sequence = 1;
  while (true) {
    const attempt = makeAttemptRecord(runtimeHomePath, `near-${sequence}`, sequence, "accepted");
    const snapshot = {
      version: WAKE_ACCEPTANCE_VERSION,
      run_id: resolveRunId(),
      agent_id: "agent-1",
      next_sequence: sequence,
      records: [...records, attempt]
    };
    if (Buffer.byteLength(JSON.stringify(snapshot), UTF8) > WAKE_ACCEPTANCE_FILE_BYTES_MAX) {
      break;
    }
    records.push(attempt);
    sequence += 1;
  }
  return records;
};
test("captures run+agent and rejects drift and malformed version", async () => {
  const runtime = path.join(await tempDir(), "runtime");
  const store = new WakeAcceptanceStore(runtime, "agent-1");
  await withRunId("run-a", async () => {
    const opened = await runAdmission(store, baseEvent("capture"));
    assert.equal(opened.mode, "run");
    const accepting = await store.markInvoking(opened.capability);
    await store.markCompleted(accepting);
  });
  await withRunId("run-b", async () => await rejectWithCode(new WakeAcceptanceStore(runtime, "agent-1").begin(baseEvent("capture")), "wake_acceptance_store_corrupt"));
  await rejectWithCode(new WakeAcceptanceStore(runtime, "agent-2").begin(baseEvent("capture")), "wake_delivery_invalid");
  await withRunId("run-a", async () => {
    await writeFile(stateFile(runtime), JSON.stringify({
      version: "invalid",
      run_id: "run-a",
      agent_id: "agent-1",
      next_sequence: 0,
      records: []
    }), UTF8);
    await rejectWithCode(new WakeAcceptanceStore(runtime, "agent-1").begin(baseEvent("capture-bad-version")), "wake_acceptance_store_corrupt");
  });
});
test("validates strict delivery authority and persists only full hashes", async () => {
  const runtime = path.join(await tempDir(), "runtime");
  const store = new WakeAcceptanceStore(runtime, "agent-1");
  await rejectWithCode(store.begin({ ...baseEvent("kind-manual"), kind: "manual" }), "wake_delivery_invalid");
  await rejectWithCode(store.begin({ ...baseEvent("missing"), delivery: undefined }), "wake_delivery_invalid");
  await rejectWithCode(store.begin({ ...baseEvent("id-mismatch"), delivery: { eventId: "other", sender: "sender-1", target: "agent-1", contextId: "context-id-mismatch" } }), "wake_delivery_invalid");
  await rejectWithCode(store.begin({
    ...baseEvent("target-mismatch"),
    delivery: { eventId: "target-mismatch", sender: "sender-1", target: "other-agent", contextId: "context-target" }
  }), "wake_delivery_invalid");
  await rejectWithCode(store.begin({
    ...baseEvent("from-mismatch"),
    from: "intruder", delivery: { eventId: "from-mismatch", sender: "sender-1", target: "agent-1", contextId: "context-from" }
  }), "wake_delivery_invalid");
  const oversized = "x".repeat(WAKE_ACCEPTANCE_FIELD_BYTES_MAX + 1);
  await rejectWithCode(store.begin({
    ...baseEvent("sender-overflow"),
    delivery: { eventId: "sender-overflow", sender: oversized, target: "agent-1", contextId: "context" }
  }), "wake_delivery_invalid");
  const long = `ok-${"🧪".repeat(1024)}`;
  const longRun = await runAdmission(store, baseEvent("long-body", long));
  assert.equal(longRun.mode, "run");
  const invoking = await store.markInvoking(longRun.capability);
  await store.markCompleted(invoking);
  const finalState = await readStore(runtime);
  const record = finalState.records.find((entry) => entry.event_id === "long-body");
  assert.equal(record?.body_sha256, hashSha256(long));
  const raw = await readFile(stateFile(runtime), UTF8);
  assert.equal(raw.includes(long), false);
});
test("recomputes candidate identity and digest before transitions", async () => {
  const runtime = path.join(await tempDir(), "runtime");
  const store = new WakeAcceptanceStore(runtime, "agent-1");
  const accepted = await runAdmission(store, baseEvent("check"));
  assert.equal(accepted.mode, "run");
  const candidate = store.candidateFromDelivery(baseEvent("check"));
  const expectedIdentity = wakeAcceptanceIdentity({ runId: resolveRunId(), agentId: "agent-1", eventId: "check" });
  assert.equal(candidate.identity, expectedIdentity);
  assert.equal(candidate.digest, wakeAcceptanceDigest({ bodySha256: candidate.bodySha256, contextId: candidate.contextId, eventId: candidate.eventId, kind: candidate.kind, sender: candidate.sender, target: candidate.target }));
  await store.markInvoking(accepted.capability).then(async (invoking) => {
    await store.markCompleted(invoking);
  });
  const stable = await readStore(runtime);
  const corruptIdentity = {
    ...stable,
    records: [
      {
        ...stable.records[0],
        identity: hashSha256("tampered")
      }
    ]
  };
  await writeFile(stateFile(runtime), JSON.stringify(corruptIdentity), UTF8);
  await rejectWithCode(new WakeAcceptanceStore(runtime, "agent-1").begin(baseEvent("check")), "wake_acceptance_store_corrupt");
  const corruptDigest = {
    ...stable,
    records: [
      {
        ...stable.records[0],
        digest: hashSha256("tampered")
      }
    ]
  };
  await writeFile(stateFile(runtime), JSON.stringify(corruptDigest), UTF8);
  await rejectWithCode(new WakeAcceptanceStore(runtime, "agent-1").begin(baseEvent("check")), "wake_acceptance_store_corrupt");
});
test("rejects malformed snapshots and non-monotonic state", async () => {
  const runtime = path.join(await tempDir(), "runtime");
  const store = new WakeAcceptanceStore(runtime, "agent-1");
  await mkdir(path.dirname(stateFile(runtime)), { recursive: true });
  await writeFile(stateFile(runtime), "{", UTF8);
  await rejectWithCode(store.begin(baseEvent("malformed-json")), "wake_acceptance_store_corrupt");
  await writeFile(stateFile(runtime), JSON.stringify({
    version: WAKE_ACCEPTANCE_VERSION,
    run_id: resolveRunId(),
    agent_id: "agent-1",
    next_sequence: 0,
    records: [],
    unexpected: true
  }), UTF8);
  await rejectWithCode(store.begin(baseEvent("extra-key")), "wake_acceptance_store_corrupt");
  const duplicates = [
    makeAttemptRecord(runtime, "dup", 1, "accepted"),
    { ...makeAttemptRecord(runtime, "dup", 2, "accepted") }
  ];
  await writeStoreState(runtime, duplicates);
  await rejectWithCode(store.begin(baseEvent("dup")), "wake_acceptance_store_corrupt");
  const badSequence = {
    version: WAKE_ACCEPTANCE_VERSION,
    run_id: resolveRunId(),
    agent_id: "agent-1",
    next_sequence: 2,
    records: [
      { ...makeAttemptRecord(runtime, "seq", 5, "accepted") }
    ]
  };
  await writeFile(stateFile(runtime), JSON.stringify(badSequence), UTF8);
  await chmod(stateFile(runtime), 0o600);
  await rejectWithCode(store.begin(baseEvent("sequence")), "wake_acceptance_store_corrupt");

  const badKindRecord = { ...makeAttemptRecord(runtime, "bad-kind", 1, "accepted"), kind: "manual" };
  const badKind = {
    version: WAKE_ACCEPTANCE_VERSION,
    run_id: resolveRunId(),
    agent_id: "agent-1",
    next_sequence: 1,
    records: [
      { ...badKindRecord, digest: wakeAcceptanceDigest({ bodySha256: badKindRecord.body_sha256, contextId: badKindRecord.context_id, eventId: badKindRecord.event_id, kind: badKindRecord.kind, sender: badKindRecord.sender, target: badKindRecord.target }) }
    ]
  };
  await writeFile(stateFile(runtime), JSON.stringify(badKind), UTF8);
  await rejectWithCode(store.begin(baseEvent("bad-kind")), "wake_acceptance_store_corrupt");

  const foreignTargetRecord = { ...makeAttemptRecord(runtime, "bad-target", 1, "accepted"), target: "agent-2" };
  const foreignTarget = {
    version: WAKE_ACCEPTANCE_VERSION,
    run_id: resolveRunId(),
    agent_id: "agent-1",
    next_sequence: 1,
    records: [
      { ...foreignTargetRecord, digest: wakeAcceptanceDigest({ bodySha256: foreignTargetRecord.body_sha256, contextId: foreignTargetRecord.context_id, eventId: foreignTargetRecord.event_id, kind: foreignTargetRecord.kind, sender: foreignTargetRecord.sender, target: foreignTargetRecord.target }) }
    ]
  };
  await writeFile(stateFile(runtime), JSON.stringify(foreignTarget), UTF8);
  await rejectWithCode(store.begin(baseEvent("bad-target")), "wake_acceptance_store_corrupt");
});
test("replay and non-terminal duplicates fail closed", async () => {
  const runtime = path.join(await tempDir(), "runtime");
  const store = new WakeAcceptanceStore(runtime, "agent-1");
  const firstCompleted = await runAdmission(store, baseEvent("completed"));
  const completedInvoking = await store.markInvoking(firstCompleted.capability);
  await store.markCompleted(completedInvoking);
  assert.equal((await store.begin(baseEvent("completed"))).mode, "replay");
  const firstAccepted = await runAdmission(store, baseEvent("accepted"));
  await rejectWithCode(store.begin(baseEvent("accepted")), "wake_delivery_incomplete");
  await store.markIncomplete(firstAccepted.capability);
  await rejectWithCode(store.begin(baseEvent("accepted")), "wake_delivery_incomplete");
  const firstInvoking = await runAdmission(store, baseEvent("invoking"));
  await store.markInvoking(firstInvoking.capability);
  await rejectWithCode(store.begin(baseEvent("invoking")), "wake_delivery_incomplete");
  const firstIncomplete = await runAdmission(store, baseEvent("incomplete"));
  await store.markIncomplete(firstIncomplete.capability);
  await rejectWithCode(store.begin(baseEvent("incomplete")), "wake_delivery_incomplete");
  await runAdmission(store, baseEvent("conflict"));
  await rejectWithCode(store.begin(baseEvent("conflict", "changed-body")), "wake_delivery_conflict");
});
test("forged, foreign, reused, and wrong-phase capabilities are closed", async () => {
  const runtime = path.join(await tempDir(), "runtime");
  let releases = 0;
  const owner = new WakeAcceptanceStore(runtime, "agent-1", new WakeAcceptanceFs(runtime, { hooks: { preClaimRelease: () => { releases += 1; } } }));
  const foreign = new WakeAcceptanceStore(path.join(await tempDir(), "foreign-runtime"), "agent-2");
  const opened = await runAdmission(owner, baseEvent("capability"));
  assert.equal(releases, 1);
  const invoking = await owner.markInvoking(opened.capability);
  const forged = structuredClone(opened.capability);
  await assert.rejects(owner.markInvoking(forged), (error: unknown) => {
    const candidate = error as Error & { code?: string };
    return candidate.code === "wake_acceptance_store_corrupt";
  });
  await assert.rejects(foreign.markInvoking(opened.capability), (error: unknown) => {
    const candidate = error as Error & { code?: string };
    return candidate.code === "wake_acceptance_store_corrupt";
  });
  const otherAccepted = await runAdmission(foreign, baseEvent("other", "payload-other", {
    delivery: {
      eventId: "other",
      sender: "sender-1",
      target: "agent-2",
      contextId: "context-other"
    }
  }));
  const foreignInvoking = await foreign.markInvoking(otherAccepted.capability);
  await assert.rejects(owner.markCompleted(foreignInvoking), (error: unknown) => {
    const candidate = error as Error & { code?: string };
    return candidate.code === "wake_acceptance_store_corrupt";
  });
  await assert.rejects(owner.markIncomplete(opened.capability), (error: unknown) => {
    const candidate = error as Error & { code?: string };
    return candidate.code === "wake_acceptance_store_corrupt";
  });
  const accepted = await runAdmission(owner, baseEvent("final"));
  const invokingSecond = await owner.markInvoking(accepted.capability);
  await owner.markCompleted(invokingSecond);
  const acceptedAgain = await owner.begin(baseEvent("final"));
  assert.equal(acceptedAgain.mode, "replay");
});
test("retains newest 512 completed plus active records", async () => {
  const runtime = path.join(await tempDir(), "runtime");
  const store = new WakeAcceptanceStore(runtime, "agent-1");
  await writeStoreState(runtime, Array.from({ length: WAKE_ACCEPTANCE_COMPLETED_TOMBSTONES }, (_, index) =>
    makeAttemptRecord(runtime, `completed-${index}`, index + 1, "completed")
  ));
  const active = await runAdmission(store, baseEvent("active"));
  await store.markCompleted(await store.markInvoking(active.capability));
  const final = await readStore(runtime);
  assert.equal(final.records.length, WAKE_ACCEPTANCE_COMPLETED_TOMBSTONES);
  assert.equal(final.records.some((record) => record.event_id === "active"), true);
  assert.equal(final.records.some((record) => record.event_id === "completed-0"), false);
  assert.equal(final.records.filter((record) => record.state === "completed").length, WAKE_ACCEPTANCE_COMPLETED_TOMBSTONES);
  assert.equal(final.next_sequence, final.records.at(-1)!.sequence);
});
test("rejects byte-capacity overflow before mutation", async () => {
  const runtime = path.join(await tempDir(), "runtime");
  const store = new WakeAcceptanceStore(runtime, "agent-1");
  const near = await buildNearCapacityRecords(runtime);
  const before = JSON.stringify({
    version: WAKE_ACCEPTANCE_VERSION,
    run_id: resolveRunId(),
    agent_id: "agent-1",
    next_sequence: near.at(-1)?.sequence ?? 0,
    records: near
  });
  await writeStoreState(runtime, near);
  await rejectWithCode(store.begin(baseEvent("overflow")), "wake_acceptance_store_corrupt");
  const after = await readFile(stateFile(runtime), UTF8);
  assert.equal(after, before);
});
test("rejects MAX_SAFE sequence overflow before mutation", async () => {
  const runtime = path.join(await tempDir(), "runtime");
  const seed: WakeAcceptanceStoreState = {
    version: WAKE_ACCEPTANCE_VERSION,
    run_id: resolveRunId(),
    agent_id: "agent-1",
    next_sequence: Number.MAX_SAFE_INTEGER,
    records: []
  };
  await mkdir(path.dirname(stateFile(runtime)), { recursive: true });
  await writeFile(stateFile(runtime), JSON.stringify(seed), UTF8);
  await chmod(stateFile(runtime), 0o600);
  await rejectWithCode(new WakeAcceptanceStore(runtime, "agent-1").begin(baseEvent("overflow-seq")), "wake_acceptance_store_corrupt");
  const restored = await readStore(runtime);
  assert.equal(restored.next_sequence, Number.MAX_SAFE_INTEGER);
});

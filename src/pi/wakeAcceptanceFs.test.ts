import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { PathLike } from "node:fs";

import type { WakeEvent } from "../core/types.js";
import { resolveRunId } from "../observability/causalEvents.js";
import { WakeAcceptanceFs } from "./wakeAcceptanceFs.js";
import { WakeAcceptanceStore } from "./wakeAcceptance.js";
import { WAKE_ACCEPTANCE_VERSION, parseWakeAcceptanceState, type WakeAcceptanceRecord } from "./wakeAcceptanceSchema.js";

const UTF8 = "utf8"; const tempRoots: string[] = [];
test.beforeEach(() => {
  process.env.NOOPOLIS_RUN_ID = "run-test-wake-acceptance-fs";
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
const baseEvent = (id: string): WakeEvent => ({
  id,
  kind: "message",
  from: "sender-1",
  text: `payload-${id}`,
  context: {
    networkId: "net",
    roomId: "room",
    teamId: "team"
  },
  delivery: {
    eventId: id,
    sender: "sender-1",
    target: "agent-1",
    contextId: `context-${id}`
  }
});

const rejectWithCode = async (value: Promise<unknown>, code: string): Promise<void> => {
  await assert.rejects(value, (error: unknown) => {
    const candidate = error as Error & { code?: string };
    return candidate instanceof Error && candidate.code === code && candidate.message === code;
  });
};

const exists = async (target: string): Promise<boolean> => {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
};

test("runtime and state directories use exact and safe permissions", async () => {
  const root = await tempDir();

  const absent = path.join(root, "runtime-missing");
  const absentFs = new WakeAcceptanceFs(absent);
  await absentFs.assertRuntimeDirectory();
  assert.equal((await lstat(absent)).mode & 0o777, 0o700);

  const parent = path.join(root, "runtime-0755");
  await mkdir(parent, { mode: 0o755 });
  const runtimeFs = new WakeAcceptanceFs(parent);
  await runtimeFs.assertRuntimeDirectory();
  assert.equal((await lstat(parent)).mode & 0o777, 0o755);

  const groupWritable = path.join(root, "runtime-group-writable");
  await mkdir(groupWritable, { mode: 0o770 });
  await chmod(groupWritable, 0o770);
  await assert.rejects(
    new WakeAcceptanceFs(groupWritable).assertRuntimeDirectory(),
    (error: unknown) => (error as Error & { code?: string }).code === "wake_acceptance_store_corrupt"
  );

  const worldWritable = path.join(root, "runtime-world-writable");
  await mkdir(worldWritable, { mode: 0o777 });
  await chmod(worldWritable, 0o777);
  await assert.rejects(
    new WakeAcceptanceFs(worldWritable).assertRuntimeDirectory(),
    (error: unknown) => (error as Error & { code?: string }).code === "wake_acceptance_store_corrupt"
  );

  const insecure = path.join(root, "runtime-non-directory");
  await writeFile(insecure, "nope", UTF8);
  await assert.rejects(new WakeAcceptanceFs(insecure).assertRuntimeDirectory());

  const target = path.join(root, "runtime-target");
  await mkdir(target, { recursive: true });
  const link = path.join(root, "runtime-link");
  await symlink(target, link);
  await assert.rejects(new WakeAcceptanceFs(link).assertRuntimeDirectory());

  await runtimeFs.assertStoreDirectory();
  assert.equal((await lstat(runtimeFs.stateDirectoryPath)).mode & 0o777, 0o700);
});

test("durability artifacts are exact modes and no raw payload persists", async () => {
  const root = await tempDir();
  const runtime = path.join(root, "runtime");
  let capturedTempMode: number | undefined;
  let capturedLockMode: number | undefined;
  const fs = new WakeAcceptanceFs(runtime, {
    hooks: {
      preClaimRelease: async () => {
        capturedLockMode = (await lstat(fs.lockPath)).mode & 0o777;
      },
      preWrite: (tempPath) => {
        return (async () => {
          capturedTempMode = (await lstat(tempPath)).mode & 0o777;
        })();
      }
    }
  });

  const store = new WakeAcceptanceStore(runtime, "agent-1", fs);
  const admission = await store.begin(baseEvent("modes"));
  assert.equal(admission.mode, "run");

  const stateBefore = (await lstat(fs.stateFilePath)).mode & 0o777;
  assert.equal(stateBefore, 0o600);
  assert.equal(capturedLockMode, 0o600);
  assert.equal(capturedTempMode, 0o600);

  const invoking = await store.markInvoking(admission.capability);
  await store.markCompleted(invoking);

  assert.equal(await exists(fs.lockPath), false);
  const raw = await import("node:fs/promises").then((mod) => mod.readFile(fs.stateFilePath, UTF8));
  assert.equal(raw.includes("payload-modes"), false);
});

test("pre-claim acquisition failure emits fixed corrupt and retains no lock", async () => {
  const runtime = path.join(await tempDir(), "pre-acquire");
  const fs = new WakeAcceptanceFs(runtime, {
    hooks: {
      preClaimAcquire: () => {
        throw new Error("acquire-blocked");
      }
    }
  });

  await rejectWithCode(new WakeAcceptanceStore(runtime, "agent-1", fs).begin(baseEvent("pre-claim")), "wake_acceptance_store_corrupt");
  assert.equal(await exists(fs.lockPath), false);
});

test("release hook failure preserves non-releasable lock", async () => {
  const runtime = path.join(await tempDir(), "pre-release");
  const fs = new WakeAcceptanceFs(runtime, {
    hooks: {
      preClose: () => {
        throw new Error("pre-close");
      },
      preClaimRelease: () => {
        throw new Error("release-blocked");
      }
    }
  });

  await rejectWithCode(new WakeAcceptanceStore(runtime, "agent-1", fs).begin(baseEvent("pre-release")), "wake_acceptance_store_corrupt");
  assert.equal((await lstat(fs.lockPath)).mode & 0o777, 0o600);
});

test("write fault boundaries retain claim only when post-rename ambiguity exists", async () => {
  const runtimeWrite = path.join(await tempDir(), "write-boundary");
  await rejectWithCode(
    new WakeAcceptanceStore(runtimeWrite, "agent-1", new WakeAcceptanceFs(runtimeWrite, {
      hooks: {
        preWrite: () => {
          throw new Error("write");
        }
      }
    })).begin(baseEvent("pre-write")),
    "wake_acceptance_store_corrupt"
  );
  assert.equal(await exists(new WakeAcceptanceFs(runtimeWrite).lockPath), false);

  const runtimeSync = path.join(await tempDir(), "sync-boundary");
  await rejectWithCode(
    new WakeAcceptanceStore(runtimeSync, "agent-1", new WakeAcceptanceFs(runtimeSync, {
      hooks: {
        preSync: () => {
          throw new Error("sync");
        }
      }
    })).begin(baseEvent("pre-sync")),
    "wake_acceptance_store_corrupt"
  );
  assert.equal(await exists(new WakeAcceptanceFs(runtimeSync).lockPath), false);

  const runtimeClose = path.join(await tempDir(), "close-boundary");
  await rejectWithCode(
    new WakeAcceptanceStore(runtimeClose, "agent-1", new WakeAcceptanceFs(runtimeClose, {
      hooks: {
        preClose: () => {
          throw new Error("close");
        }
      }
    })).begin(baseEvent("pre-close")),
    "wake_acceptance_store_corrupt"
  );
  assert.equal(await exists(new WakeAcceptanceFs(runtimeClose).lockPath), false);

  const runtimeRename = path.join(await tempDir(), "directory-sync-boundary");
  await rejectWithCode(
    new WakeAcceptanceStore(runtimeRename, "agent-1", new WakeAcceptanceFs(runtimeRename, {
      hooks: {
        preDirectorySync: () => {
          throw new Error("rename-directory-sync");
        }
      }
    })).begin(baseEvent("dir-sync")),
    "wake_acceptance_store_corrupt"
  );
  assert.equal(await exists(new WakeAcceptanceFs(runtimeRename).lockPath), true);
});

test("final lstat and malformed final target are handled before rename", async () => {
  const runtime = path.join(await tempDir(), "final-lstat");
  const fs = new WakeAcceptanceFs(runtime);
  await fs.assertStoreDirectory();
  await symlink(path.join(runtime, "target"), fs.stateFilePath);

  await rejectWithCode(new WakeAcceptanceStore(runtime, "agent-1", fs).begin(baseEvent("final-lstat")), "wake_acceptance_store_corrupt");
  assert.equal(await exists(fs.lockPath), false);
});

test("cleanup removes only exact UUID-owned state temps", async () => {
  const runtime = path.join(await tempDir(), "cleanup");
  const fs = new WakeAcceptanceFs(runtime);
  await fs.assertStoreDirectory();
  const owned = `${fs.stateFilePath}.${randomUUID()}.tmp`;
  const foreign = `${fs.stateFilePath}.foreign`;
  await writeFile(owned, "owned", UTF8); await writeFile(foreign, "foreign", UTF8);
  await chmod(owned, 0o600); await chmod(foreign, 0o600);
  await fs.cleanupTemps();
  assert.equal(await exists(owned), false);
  assert.equal(await exists(foreign), true);
  assert.equal(await exists(fs.lockPath), false);
  const unsafe = `${fs.stateFilePath}.${randomUUID()}.tmp`;
  await writeFile(unsafe, "unsafe", UTF8); await chmod(unsafe, 0o644);
  await rejectWithCode(fs.cleanupTemps(), "wake_acceptance_store_corrupt"); assert.equal(await exists(unsafe), true);
  await unlink(unsafe); await symlink(foreign, unsafe);
  await rejectWithCode(fs.cleanupTemps(), "wake_acceptance_store_corrupt"); assert.equal(await exists(unsafe), true);
});

test("malformed and near-miss temp namespaces retain their bytes and claim", async () => {
  const names = ["not-a-uuid", "00000000-0000-1000-8000-000000000000", "00000000-0000-4000-7000-000000000000"];
  for (const [index, name] of names.entries()) {
    const runtime = path.join(await tempDir(), `malformed-temp-${index}`); const fs = new WakeAcceptanceFs(runtime);
    await fs.assertStoreDirectory(); const temp = `${fs.stateFilePath}.${name}.tmp`; const secret = `secret-${name}`;
    await writeFile(temp, secret, UTF8); await chmod(temp, 0o600);
    await assert.rejects(new WakeAcceptanceStore(runtime, "agent-1", fs).begin(baseEvent(`malformed-temp-${index}`)), (error: unknown) => {
      const candidate = error as Error & { code?: string }; return candidate.code === "wake_acceptance_store_corrupt" && !candidate.message.includes(temp) && !candidate.message.includes(secret);
    });
    assert.equal(await readFile(temp, UTF8), secret); assert.equal(await exists(fs.stateFilePath), false); assert.equal(await exists(fs.lockPath), true);
  }
});

test("lock files map to the expected corruptability buckets", async () => {
  const runtime = path.join(await tempDir(), "locks");
  const fs = new WakeAcceptanceFs(runtime);
  await fs.assertStoreDirectory();

  await writeFile(fs.lockPath, "owned", UTF8);
  await chmod(fs.lockPath, 0o600);
  await rejectWithCode(new WakeAcceptanceStore(runtime, "agent-1", fs).begin(baseEvent("owned-lock")), "wake_delivery_incomplete");

  await unlink(fs.lockPath);
  await symlink(path.join(runtime, "missing"), fs.lockPath);
  await rejectWithCode(new WakeAcceptanceStore(runtime, "agent-1", fs).begin(baseEvent("bad-link")), "wake_acceptance_store_corrupt");

  const lstatRace = new WakeAcceptanceFs(runtime, {
    dependencies: {
      ...fs.deps,
      lstat: async (_target: PathLike) => {
        const error = new Error("missing") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
    }
  });
  await writeFile(lstatRace.lockPath, "owned", UTF8);
  await chmod(lstatRace.lockPath, 0o600);
  await rejectWithCode(new WakeAcceptanceStore(runtime, "agent-1", lstatRace).begin(baseEvent("race-lock")), "wake_acceptance_store_corrupt");
});

test("claims are exclusive, and every hook exposes only its fixed error", async () => {
  const runtime = path.join(await tempDir(), "exclusive");
  const owner = new WakeAcceptanceFs(runtime);
  await owner.acquireClaim();
  await rejectWithCode(new WakeAcceptanceFs(runtime).acquireClaim(), "wake_delivery_incomplete");
  assert.equal(await exists(owner.lockPath), true);
  await owner.releaseClaim();
  const sentinels = ["preWrite", "preSync", "preClose", "preRename", "preDirectorySync", "preClaimAcquire", "preClaimRelease"] as const;
  for (const sentinel of sentinels) {
    const fault = `secret-${sentinel}-${runtime}`;
    const hooks = { [sentinel]: () => { throw new Error(fault); } };
    const fs = new WakeAcceptanceFs(path.join(runtime, sentinel), { hooks });
    const action = sentinel === "preClaimAcquire" ? fs.acquireClaim()
      : sentinel === "preClaimRelease" ? (await fs.acquireClaim(), fs.releaseClaim())
      : fs.writeStateText("{}");
    await rejectWithCode(action, "wake_acceptance_store_corrupt");
    assert.equal(await exists(fs.lockPath), sentinel === "preClaimRelease");
  }
});

test("atomic write uses the UUID temp path and preserves claim on ambiguous durability failures", async () => {
  const runtime = path.join(await tempDir(), "atomic");
  const trace: string[] = [];
  const fs = new WakeAcceptanceFs(runtime, {
    randomUUID: () => "00000000-0000-4000-8000-000000000000",
    hooks: {
      preWrite: (temp) => { trace.push(`write:${path.basename(temp)}`); },
      preSync: () => { trace.push("sync"); }, preClose: () => { trace.push("close"); },
      preRename: () => { trace.push("rename"); }, preDirectorySync: () => { trace.push("directory-sync"); }
    }
  });
  await fs.assertStoreDirectory();
  await fs.writeStateText("{}");
  assert.deepEqual(trace, ["write:state.v1.json.00000000-0000-4000-8000-000000000000.tmp", "sync", "close", "rename", "directory-sync"]);
  const retained = new WakeAcceptanceFs(path.join(runtime, "ambiguous"), { hooks: { preDirectorySync: () => { throw new Error("secret-directory-sync"); } } });
  await retained.acquireClaim();
  await rejectWithCode(retained.writeStateText("{}"), "wake_acceptance_store_corrupt");
  assert.equal(await exists(retained.lockPath), true);
});

test("opened claim handles are closed best-effort and ambiguous faults retain the lock", async () => {
  for (const failure of ["chmod", "sync", "close"] as const) {
    const runtime = path.join(await tempDir(), failure); let closes = 0; const base = new WakeAcceptanceFs(runtime);
    const fs = new WakeAcceptanceFs(runtime, { dependencies: { ...base.deps, open: async (...args) => {
      const handle = await base.deps.open(...args); const close = handle.close.bind(handle); const fake = handle as unknown as { chmod: () => Promise<void>; sync: () => Promise<void>; close: () => Promise<void> };
      fake.close = async () => { closes += 1; if (failure === "close") throw new Error("secret-close"); await close(); };
      if (failure !== "close") fake[failure] = async () => { throw new Error(`secret-${failure}`); }; return handle;
    } } });
    await rejectWithCode(fs.acquireClaim(), "wake_acceptance_store_corrupt"); assert.equal(closes, failure === "close" ? 2 : 1); assert.equal(await exists(fs.lockPath), true);
  }
  const runtime = path.join(await tempDir(), "directory-sync"); const fs = new WakeAcceptanceFs(runtime, { dependencies: { syncDirectory: async () => { throw new Error("secret-directory-sync"); } } });
  await rejectWithCode(fs.acquireClaim(), "wake_acceptance_store_corrupt"); assert.equal(await exists(fs.lockPath), true);
});

test("invalid transition paths preserve immutable parse behavior", async () => {
  const runtime = path.join(await tempDir(), "state-parse");
  const store = new WakeAcceptanceStore(runtime, "agent-1");
  const accepted = await store.begin(baseEvent("phase"));
  if (accepted.mode !== "run") {
    throw new Error("expected run admission");
  }
  await assert.rejects(store.markCompleted(accepted.capability), (error: unknown) => {
    const candidate = error as Error & { code?: string };
    return candidate.code === "wake_acceptance_store_corrupt";
  });

  const invoking = await store.markInvoking(accepted.capability);
  await store.markCompleted(invoking);
  await assert.rejects(store.markInvoking(accepted.capability), (error: unknown) => {
    const candidate = error as Error & { code?: string };
    return candidate.code === "wake_acceptance_store_corrupt";
  });
  await assert.rejects(store.markIncomplete(invoking), (error: unknown) => {
    const candidate = error as Error & { code?: string };
    return candidate.code === "wake_acceptance_store_corrupt";
  });

  const sample = {
    version: WAKE_ACCEPTANCE_VERSION,
    run_id: resolveRunId(),
    agent_id: "agent-1",
    next_sequence: 1,
    records: [
      {
        event_id: "phase",
        sequence: 1,
        context_id: store.candidateFromDelivery(baseEvent("phase")).contextId,
        kind: store.candidateFromDelivery(baseEvent("phase")).kind,
        body_sha256: store.candidateFromDelivery(baseEvent("phase")).bodySha256,
        digest: store.candidateFromDelivery(baseEvent("phase")).digest,
        sender: store.candidateFromDelivery(baseEvent("phase")).sender,
        target: store.candidateFromDelivery(baseEvent("phase")).target,
        identity: store.candidateFromDelivery(baseEvent("phase")).identity,
        state: "accepted" as WakeAcceptanceRecord["state"]
      }
    ]
  } satisfies { version: string; run_id: string; agent_id: string; next_sequence: number; records: WakeAcceptanceRecord[] };
  const parsed = parseWakeAcceptanceState(sample, {
    runId: resolveRunId(),
    agentId: "agent-1"
  });
  const clone = structuredClone(sample);
  assert.deepEqual(parsed.version, WAKE_ACCEPTANCE_VERSION);
  assert.deepEqual(sample, clone);
});

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { assertGrokWorkerTmpEntries, verifyGrokWorkerTmp } from "./grokWorkerTmpAttestation.js";

const worker = 2200;
const dir = (mode: number, uid: number, gid: number, kind: "dir" | "link" | "file" = "dir") => ({
  uid, gid, mode: (kind === "dir" ? 0o040000 : kind === "link" ? 0o120000 : 0o100000) | mode,
  isDirectory: () => kind === "dir", isSymbolicLink: () => kind === "link"
});
type Entry = ReturnType<typeof dir>;
const good = (): { privateTmp: Entry | undefined; shared: (Entry | undefined)[] } => ({ privateTmp: dir(0o700, worker, worker), shared: [dir(0o1774, 0, 2000), dir(0o1774, 0, 2000)] });

test("accepts private worker temp and shared temp roots the worker cannot open or write", () => {
  assert.doesNotThrow(() => assertGrokWorkerTmpEntries(good(), worker));
  assert.doesNotThrow(() => assertGrokWorkerTmpEntries({ ...good(), shared: [dir(0o1770, 0, 2000), dir(0o700, 0, 0)] }, worker));
});

test("refuses shared /tmp or /var/tmp a worker could traverse, write, or own through its group", () => {
  const refusals: Record<string, { privateTmp: Entry | undefined; shared: (Entry | undefined)[] }> = {
    "shared 1777 (default /tmp)": { ...good(), shared: [dir(0o1777, 0, 0), dir(0o1774, 0, 2000)] },
    "shared other search": { ...good(), shared: [dir(0o1774, 0, 2000), dir(0o1775, 0, 2000)] },
    "shared other write": { ...good(), shared: [dir(0o1776, 0, 2000), dir(0o1774, 0, 2000)] },
    "shared owned by a worker group": { ...good(), shared: [dir(0o1774, 0, worker), dir(0o1774, 0, 2000)] },
    "shared owned by the org user": { ...good(), shared: [dir(0o1774, 2000, 2000), dir(0o1774, 0, 2000)] },
    "shared missing": { ...good(), shared: [undefined, dir(0o1774, 0, 2000)] },
    "shared symlink": { ...good(), shared: [dir(0o777, 0, 0, "link"), dir(0o1774, 0, 2000)] },
    "private missing": { ...good(), privateTmp: undefined },
    "private owned by another worker": { ...good(), privateTmp: dir(0o700, worker + 1, worker + 1) },
    "private group readable": { ...good(), privateTmp: dir(0o750, worker, worker) },
    "private symlink": { ...good(), privateTmp: dir(0o700, worker, worker, "link") },
    "private is a file": { ...good(), privateTmp: dir(0o600, worker, worker, "file") }
  };
  for (const [label, entries] of Object.entries(refusals)) assert.throws(() => assertGrokWorkerTmpEntries(entries, worker), /temp isolation attestation unavailable/u, label);
});

test("checks the real private temp directory under the worker home and the given shared roots", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-grok-tmp-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const uid = process.getuid?.() ?? 0;
  const home = path.join(root, "home"), shared = path.join(root, "shared");
  await mkdir(path.join(home, "tmp"), { recursive: true }); await mkdir(shared);
  await chmod(path.join(home, "tmp"), 0o700);
  // A shared root owned by the test user is refused (not root-owned) — as is a symlinked private temp.
  await assert.rejects(verifyGrokWorkerTmp(home, uid, [shared]), /temp isolation attestation unavailable/u);
  await rm(path.join(home, "tmp"), { recursive: true }); await symlink(shared, path.join(home, "tmp"));
  await assert.rejects(verifyGrokWorkerTmp(home, uid, []), /temp isolation attestation unavailable/u);
  await rm(path.join(home, "tmp")); await mkdir(path.join(home, "tmp"), { mode: 0o700 });
  await verifyGrokWorkerTmp(home, uid, []);
});

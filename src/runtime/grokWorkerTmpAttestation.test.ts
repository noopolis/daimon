import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { assertGrokWorkerTmpEntries, verifyGrokWorkerTmp, type GrokWorkerTmpOptions } from "./grokWorkerTmpAttestation.js";

const worker = 2200, sibling = 2201;
type Entry = Readonly<{ uid: number; gid: number; mode: number; isDirectory(): boolean }>;
const dir = (mode: number, uid: number, gid: number): Entry => ({ uid, gid, mode: 0o040000 | mode, isDirectory: () => true });
const file = (mode: number, uid: number, gid: number): Entry => ({ uid, gid, mode: 0o100000 | mode, isDirectory: () => false });
type Entries = { privateTmps: { uid: number; entry: Entry | undefined }[]; shared: (Entry | undefined)[] };
const good = (): Entries => ({ privateTmps: [{ uid: worker, entry: dir(0o700, worker, worker) }, { uid: sibling, entry: dir(0o700, sibling, sibling) }], shared: [dir(0o1774, 0, 2000), dir(0o1774, 0, 2000)] });
const withShared = (shared: Entry | undefined): Entries => ({ ...good(), shared: [shared, dir(0o1774, 0, 2000)] });
const withOwn = (entry: Entry | undefined, uid = worker): Entries => ({ ...good(), privateTmps: [{ uid, entry }, good().privateTmps[1]!] });
const withSibling = (entry: Entry | undefined): Entries => ({ ...good(), privateTmps: [good().privateTmps[0]!, { uid: sibling, entry }] });
const refused = /temp isolation attestation unavailable/u;

test("accepts private worker temps and shared temp roots the workers cannot open or write", () => {
  assert.doesNotThrow(() => assertGrokWorkerTmpEntries(good()));
  // Per contract the shared group only has to be below the worker range: the broker group 2100 is fine.
  assert.doesNotThrow(() => assertGrokWorkerTmpEntries(withShared(dir(0o1774, 0, 2100))));
  assert.doesNotThrow(() => assertGrokWorkerTmpEntries(withShared(dir(0o1770, 0, 2000))));
});

test("refuses shared temp roots that are missing, not directories, not root-owned, worker-grouped, or open to others", () => {
  const cases: Record<string, Entries> = {
    "missing": withShared(undefined),
    "regular file": withShared(file(0o1774, 0, 2000)),
    "owned by the org user": withShared(dir(0o1774, 2000, 2000)),
    "group 2200 (a worker group)": withShared(dir(0o1774, 0, 2200)),
    "other search (1775)": withShared(dir(0o1775, 0, 2000)),
    "other write (1776)": withShared(dir(0o1776, 0, 2000)),
    "default /tmp (1777)": withShared(dir(0o1777, 0, 0)),
    "no shared roots at all": { ...good(), shared: [] }
  };
  for (const [label, entries] of Object.entries(cases)) assert.throws(() => assertGrokWorkerTmpEntries(entries), refused, label);
});

test("refuses a private temp that is missing, not a directory, owned by someone else, or has any group or other bit", () => {
  const cases: Record<string, Entries> = {
    "missing": withOwn(undefined),
    "regular file": withOwn(file(0o600, worker, worker)),
    "owned by another worker": withOwn(dir(0o700, sibling, sibling)),
    "group read (0740)": withOwn(dir(0o740, worker, worker)),
    "other execute (0701)": withOwn(dir(0o701, worker, worker)),
    "other write (0702)": withOwn(dir(0o702, worker, worker)),
    "other read (0704)": withOwn(dir(0o704, worker, worker)),
    "worker uid below the worker range": withOwn(dir(0o700, 2100, 2100), 2100),
    "no workers at all": { ...good(), privateTmps: [] }
  };
  for (const [label, entries] of Object.entries(cases)) assert.throws(() => assertGrokWorkerTmpEntries(entries), refused, label);
});

test("a misprovisioned sibling worker's temp refuses the current worker's turn", () => {
  assert.throws(() => assertGrokWorkerTmpEntries(withSibling(dir(0o777, sibling, sibling))), refused);
  assert.throws(() => assertGrokWorkerTmpEntries(withSibling(dir(0o770, sibling, sibling))), refused);
  assert.throws(() => assertGrokWorkerTmpEntries(withSibling(undefined)), refused);
});

test("on a real filesystem: sibling 0777 temp, symlinked temps and symlinked shared roots are refused", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-grok-tmp-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const uid = process.getuid?.() ?? 0;
  const own = path.join(root, "own"), other = path.join(root, "other"), shared = path.join(root, "shared"), elsewhere = path.join(root, "elsewhere");
  for (const directory of [path.join(own, "tmp"), path.join(other, "tmp"), shared, elsewhere]) { await mkdir(directory, { recursive: true }); await chmod(directory, 0o700); }
  // Seams: this test runs unprivileged, so the owner and worker-range floor are the test user.
  const options: GrokWorkerTmpOptions = { sharedRoots: [shared], sharedOwnerUid: uid, firstWorkerUid: uid };
  const workers = [{ home: own, uid }, { home: other, uid }];
  await verifyGrokWorkerTmp(workers, options);

  await chmod(path.join(other, "tmp"), 0o777);
  await assert.rejects(verifyGrokWorkerTmp(workers, options), refused, "sibling 0777");
  await chmod(path.join(other, "tmp"), 0o700);

  await rm(path.join(own, "tmp"), { recursive: true }); await symlink(elsewhere, path.join(own, "tmp"));
  await assert.rejects(verifyGrokWorkerTmp(workers, options), refused, "private temp symlink to a valid directory");
  await rm(path.join(own, "tmp")); await mkdir(path.join(own, "tmp"), { mode: 0o700 });

  const linkedShared = path.join(root, "linked-shared"); await symlink(elsewhere, linkedShared);
  await assert.rejects(verifyGrokWorkerTmp(workers, { ...options, sharedRoots: [linkedShared] }), refused, "shared root symlink to a valid directory");
  const regular = path.join(root, "regular"); await writeFile(regular, ""); await chmod(regular, 0o600);
  await assert.rejects(verifyGrokWorkerTmp(workers, { ...options, sharedRoots: [regular] }), refused, "shared root regular file");
  await assert.rejects(verifyGrokWorkerTmp(workers, { ...options, sharedRoots: [] }), refused, "empty shared roots");
  await verifyGrokWorkerTmp(workers, options);
});

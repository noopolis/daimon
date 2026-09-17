import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertGrokWorkerDenyPathPlacement,
  assertGrokWorkerDenyPathShape,
  assertGrokWorkerDenyPathsPlaceable,
  GROK_WORKER_BASE_PROFILE_GRANTS,
  grokWorkerCanSearch,
  grokWorkerDenyPathChain,
  GrokWorkerDenyPlacementError,
  type GrokWorkerDenyPathEntry,
  type GrokWorkerDenyPathStep
} from "./grokWorkerDenyPlacement.js";
import { renderGrokWorkerSandboxProfile } from "./grokWorkerSandboxProfile.js";

const entry = (uid: number, gid: number, mode: number, kind: "dir" | "file" | "link" = "dir"): GrokWorkerDenyPathEntry =>
  ({ uid, gid, mode, isDirectory: () => kind === "dir", isSymbolicLink: () => kind === "link" });
const worker = { uid: 2200, gid: 2200 };
const steps = (denyPath: string, entries: readonly (GrokWorkerDenyPathEntry | string)[]): GrokWorkerDenyPathStep[] =>
  grokWorkerDenyPathChain(denyPath).map((target, index) => {
    const value = entries[index];
    return typeof value === "string" ? { path: target, code: value } : { path: target, entry: value };
  });

test("search permission follows owner, then group, then other — as the worker's cleared-group process does", () => {
  assert.equal(grokWorkerCanSearch(entry(2200, 2200, 0o700), worker), true);
  assert.equal(grokWorkerCanSearch(entry(2200, 2200, 0o677), worker), false, "owner bits win even when group and other would allow");
  assert.equal(grokWorkerCanSearch(entry(2000, 2200, 0o710), worker), true);
  assert.equal(grokWorkerCanSearch(entry(2000, 2000, 0o700), worker), false);
  assert.equal(grokWorkerCanSearch(entry(0, 0, 0o711), worker), true);
  assert.equal(grokWorkerCanSearch(entry(0, 0, 0o755), worker), true);
  assert.equal(grokWorkerCanSearch(entry(0, 2000, 0o750), worker), false);
});

test("refuses a deny entry at or above any Grok 1.0.34 base-profile grant", () => {
  for (const grant of GROK_WORKER_BASE_PROFILE_GRANTS) {
    assert.throws(() => assertGrokWorkerDenyPathShape(grant), GrokWorkerDenyPlacementError, grant);
  }
  assert.throws(() => assertGrokWorkerDenyPathShape("/var"), /base profile grant \/var/u);
  assert.throws(() => renderGrokWorkerSandboxProfile(["/run"]), /base profile grant \/run/u);
  assert.throws(() => renderGrokWorkerSandboxProfile(["/var/lib/spawnfile/daimon/usage", "/tmp"]), /base profile grant \/tmp/u);
  // Strictly below every grant is exactly what Grok accepts.
  assertGrokWorkerDenyPathShape("/tmp/sub");
  assertGrokWorkerDenyPathShape("/var/lib/spawnfile/daimon/usage");
});

test("refuses the wake-acceptance shape: a deny entry under a parent the worker cannot search", () => {
  // `<instance-root>/state` is `2000:2000 0700`; the store beneath it is what production used to deny.
  const denyPath = "/var/lib/spawnfile/instances/daimon/org/state/wake-acceptance";
  assert.throws(
    () => assertGrokWorkerDenyPathPlacement(denyPath, steps(denyPath, [
      entry(0, 0, 0o755), entry(0, 0, 0o755), entry(0, 0, 0o755), entry(0, 0, 0o711), entry(0, 0, 0o711),
      entry(0, 0, 0o711), entry(2000, 2000, 0o711), entry(2000, 2000, 0o700), entry(2000, 2000, 0o700)
    ]), worker),
    (error: Error) => error instanceof GrokWorkerDenyPlacementError
      && /cannot search \/var\/lib\/spawnfile\/instances\/daimon\/org\/state \(700 2000:2000\); deny that directory itself instead/u.test(error.message)
  );
  // The lift production now emits: the private directory itself, whose own parent is traversable.
  const lifted = "/var/lib/spawnfile/instances/daimon/org/state";
  assertGrokWorkerDenyPathPlacement(lifted, steps(lifted, [
    entry(0, 0, 0o755), entry(0, 0, 0o755), entry(0, 0, 0o755), entry(0, 0, 0o711), entry(0, 0, 0o711),
    entry(0, 0, 0o711), entry(2000, 2000, 0o711), entry(2000, 2000, 0o700)
  ]), worker);
});

test("refuses a missing target, a symlink and a non-directory ancestor; leaves an undecidable EACCES alone", () => {
  const denyPath = "/run/training/slot/state";
  assert.throws(() => assertGrokWorkerDenyPathPlacement(denyPath, steps(denyPath, [
    entry(0, 0, 0o755), entry(0, 0, 0o755), entry(0, 0, 0o755), entry(0, 0, 0o755), "ENOENT"
  ]), worker), /does not exist; bubblewrap would have to create it as the worker uid/u);
  assert.throws(() => assertGrokWorkerDenyPathPlacement(denyPath, steps(denyPath, [
    entry(0, 0, 0o755), entry(0, 0, 0o755), entry(0, 0, 0o755), entry(0, 0, 0o755), entry(0, 0, 0o777, "link")
  ]), worker), /is a symlink; bubblewrap refuses to bind over one/u);
  assert.throws(() => assertGrokWorkerDenyPathPlacement(denyPath, steps(denyPath, [
    entry(0, 0, 0o755), entry(0, 0, 0o755), entry(0, 0, 0o644, "file"), entry(0, 0, 0o755), entry(0, 0, 0o700)
  ]), worker), /is not a directory/u);
  assert.throws(() => assertGrokWorkerDenyPathPlacement(denyPath, steps(denyPath, [
    entry(0, 0, 0o755), entry(0, 0, 0o755), entry(0, 0, 0o755), entry(0, 0, 0o755), "EPERM"
  ]), worker), /could not be read \(EPERM\)/u);
  // The broker (uid 2100) cannot descend into a `2000:<worker> 0710` runtime home the worker itself can
  // search, so an EACCES *below a worker-searchable ancestor* is undecided here, never a refusal.
  assertGrokWorkerDenyPathPlacement(denyPath, steps(denyPath, [
    entry(0, 0, 0o755), entry(0, 0, 0o755), entry(0, 0, 0o755), entry(2000, 2200, 0o710), "EACCES"
  ]), worker);
});

test("walks the real filesystem and names the ancestor that stops a deny entry", async () => {
  // realpath: macOS `/var` is a symlink, and a symlinked ancestor is refused on purpose — Daimon's
  // registered paths are canonical, and bubblewrap must bind over the inode the deny entry names.
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "grok-deny-")));
  const state = path.join(root, "state");
  // This process stands in for root provisioning: it can stat every component, and judges searchability
  // for the worker from the modes it reads. Here the worker is this uid, so only `state` blocks it.
  const self = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };
  try {
    mkdirSync(path.join(state, "wake-acceptance"), { recursive: true });
    writeFileSync(path.join(state, "wake-acceptance", "store.jsonl"), "{}\n");
    chmodSync(state, 0o600);
    await assert.rejects(
      assertGrokWorkerDenyPathsPlaceable([path.join(state, "wake-acceptance")], self),
      (error: Error) => error instanceof GrokWorkerDenyPlacementError
        && error.message.includes(`cannot search ${state}`) && error.message.includes("deny that directory itself instead")
    );
    // The lift: the unsearchable directory itself is placeable, and masks strictly more.
    await assertGrokWorkerDenyPathsPlaceable([state], self);
    await assert.rejects(assertGrokWorkerDenyPathsPlaceable([path.join(root, "absent")], self), /does not exist/u);
    symlinkSync(state, path.join(root, "link"));
    await assert.rejects(assertGrokWorkerDenyPathsPlaceable([path.join(root, "link")], self), /is a symlink/u);
    await assert.rejects(assertGrokWorkerDenyPathsPlaceable(["relative/path"], self), /not an absolute path/u);
  } finally {
    chmodSync(state, 0o700);
    rmSync(root, { force: true, recursive: true });
  }
});

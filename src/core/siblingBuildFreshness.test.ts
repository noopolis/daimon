import assert from "node:assert/strict";
import { test } from "node:test";

import { checkSiblingBuildFreshness } from "./siblingBuildFreshness.js";

const base = {
  packageName: "@noopolis/mneme",
  packageDirectory: "/workspace/ecosystem/mneme",
  hasSourceDirectory: true
};

test("published packages pass without a freshness comparison", () => {
  assert.deepEqual(checkSiblingBuildFreshness({ ...base, hasSourceDirectory: false, sourceFiles: [], outputFiles: [] }), {
    packageName: "@noopolis/mneme", linked: false, sourcesScanned: 0, outputsScanned: 0, ok: true
  });
});

test("linked packages reject vacuous source and output scans", () => {
  const noSources = checkSiblingBuildFreshness({ ...base, sourceFiles: [], outputFiles: [{ path: "index.js", mtimeMs: 1 }] });
  const noOutputs = checkSiblingBuildFreshness({ ...base, sourceFiles: [{ path: "index.ts", mtimeMs: 1 }], outputFiles: [] });
  assert.deepEqual(noSources, { packageName: base.packageName, linked: true, sourcesScanned: 0, outputsScanned: 1, ok: false, message: noSources.message });
  assert.equal(noSources.ok, false);
  assert.match(noSources.message!, /zero source/);
  assert.equal(noOutputs.ok, false);
  assert.equal(noOutputs.sourcesScanned, 1);
  assert.equal(noOutputs.outputsScanned, 0);
  assert.match(noOutputs.message!, /no emitted JavaScript/);
});

test("linked and fresh packages report both scan counts", () => {
  assert.deepEqual(checkSiblingBuildFreshness({ ...base, sourceFiles: [{ path: "index.ts", mtimeMs: 1 }], outputFiles: [{ path: "index.js", mtimeMs: 1 }] }), {
    packageName: base.packageName, linked: true, sourcesScanned: 1, outputsScanned: 1, ok: true
  });
});

test("linked packages reject stale source against the oldest output", () => {
  const result = checkSiblingBuildFreshness({
    ...base,
    sourceFiles: [{ path: "fresh.ts", mtimeMs: 20 }, { path: "old.ts", mtimeMs: 1 }],
    outputFiles: [{ path: "fresh.js", mtimeMs: 30 }, { path: "old.js", mtimeMs: 10 }]
  });
  assert.equal(result.ok, false);
  assert.match(result.message!, /fresh\.ts \(20\).*old\.js \(10\)/);
});

test("linked packages pass when every source is no newer than every oldest output", () => {
  const result = checkSiblingBuildFreshness({
    ...base,
    sourceFiles: [{ path: "index.ts", mtimeMs: 10 }, { path: "index.test.ts", mtimeMs: 1000 }, { path: "types.d.ts", mtimeMs: 1000 }],
    outputFiles: [{ path: "index.js", mtimeMs: 10 }, { path: "other.js", mtimeMs: 20 }, { path: "index.d.ts", mtimeMs: 0 }]
  });
  assert.equal(result.ok, true);
});

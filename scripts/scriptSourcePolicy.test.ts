import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const maintainedRoots = ["scripts", "src/runtime/native"];

const maintainedJavaScriptSources = async (roots: string[]): Promise<string[]> => {
  const results: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.name.endsWith(".mjs")) {
        results.push(entryPath);
      }
    }
  };
  await Promise.all(roots.map(walk));
  return results.sort();
};

test("maintained scripts contain no JavaScript source files", async () => {
  assert.deepEqual(await maintainedJavaScriptSources(maintainedRoots), []);
});

test("script source policy detects a maintained JavaScript regression", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-script-policy-"));
  try {
    const scripts = path.join(root, "scripts");
    await mkdir(scripts);
    await writeFile(path.join(scripts, "regression.mjs"), "export {};\n");
    assert.deepEqual(await maintainedJavaScriptSources([scripts]), [path.join(scripts, "regression.mjs")]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

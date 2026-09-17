import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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

// Raw control bytes make review tooling classify a source file as binary and skip it.
// Escape them (`\u0000`) instead; tab, newline and carriage return are the only exceptions.
const RAW_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const textSourcesWithRawControlBytes = async (roots: string[]): Promise<string[]> => {
  const results: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) { if (entry.name !== "artifacts" && entry.name !== "node_modules") await walk(entryPath); continue; }
      if (!/\.(?:ts|mts|mjs|js|json|jsonl|md|c|h|inc|toml|sh|yml|yaml)$/u.test(entry.name)) continue;
      if (RAW_CONTROL.test(await readFile(entryPath, "latin1"))) results.push(entryPath);
    }
  };
  await Promise.all(roots.map(walk));
  return results.sort();
};

test("maintained text sources contain no raw control bytes", async () => {
  assert.deepEqual(await textSourcesWithRawControlBytes(["src", "scripts", "docs"]), []);
});

test("raw control byte policy detects a regression", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-control-policy-"));
  try {
    await writeFile(path.join(root, "regex.ts"), `export const r = /[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}]/u;\n`);
    await writeFile(path.join(root, "clean.ts"), "export const r = /[\\u0000-\\u001f]/u;\n");
    assert.deepEqual(await textSourcesWithRawControlBytes([root]), [path.join(root, "regex.ts")]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

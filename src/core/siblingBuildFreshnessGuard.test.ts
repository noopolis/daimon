import assert from "node:assert/strict";
import { readFile, realpath, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { checkSiblingBuildFreshness, type SiblingBuildFacts, type SiblingFileFact } from "./siblingBuildFreshness.js";

async function packageFacts(packageName: string): Promise<SiblingBuildFacts> {
  let packageDirectory = await realpath(path.join(fileURLToPath(new URL("../../", import.meta.url)), "node_modules", packageName));
  let packageJsonPath: string | undefined;
  while (packageDirectory !== path.dirname(packageDirectory)) {
    try {
      await stat(path.join(packageDirectory, "package.json"));
      packageJsonPath = path.join(packageDirectory, "package.json");
      break;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      packageDirectory = path.dirname(packageDirectory);
    }
  }
  assert.ok(packageJsonPath, `could not locate package.json for ${packageName}`);
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as { name?: unknown };
  assert.equal(packageJson.name, packageName, `resolved package root ${packageDirectory} is not ${packageName}`);
  const sourceDirectory = path.join(packageDirectory, "src");
  const outputDirectory = path.join(packageDirectory, "dist");
  const hasSourceDirectory = await exists(sourceDirectory);
  return {
    packageName,
    packageDirectory,
    hasSourceDirectory,
    sourceFiles: hasSourceDirectory ? await files(sourceDirectory, true) : [],
    outputFiles: await files(outputDirectory, false)
  };
}

async function exists(filePath: string): Promise<boolean> {
  try { await stat(filePath); return true; } catch { return false; }
}

async function files(directory: string, source: boolean): Promise<SiblingFileFact[]> {
  if (!await exists(directory)) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry) => {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return files(filePath, source);
    if (!entry.isFile() || (source ? !entry.name.endsWith(".ts") : !entry.name.endsWith(".js"))) return [];
    return [{ path: filePath, mtimeMs: (await stat(filePath)).mtimeMs }];
  }))).flat();
}

test("linked Mneme build is present and fresh", async () => {
  const facts = await packageFacts("@noopolis/mneme");
  const result = checkSiblingBuildFreshness(facts);
  assert.equal(result.packageName, "@noopolis/mneme");
  assert.equal(result.ok, true, result.message);
  if (result.linked) {
    assert.ok(result.sourcesScanned > 0);
    assert.ok(result.outputsScanned > 0);
  } else {
    console.log(`sibling freshness: ${facts.packageName} passed as published (no linked source checkout)`);
  }
  console.log(`sibling freshness: ${facts.packageName} linked=${result.linked} sources=${result.sourcesScanned} outputs=${result.outputsScanned} ok=${result.ok}`);
});

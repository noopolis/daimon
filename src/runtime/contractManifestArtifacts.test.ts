import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { canonicalRuntimeContractManifest } from "./contractManifest.js";

const exec = promisify(execFile);
const manifestPath = path.resolve("dist/runtime/contract-manifest.json");
const digestPath = path.resolve("dist/runtime/contract-manifest.sha256");
const emitterPath = path.resolve("scripts/emitRuntimeContractManifest.mjs");

const npm = async (...args: string[]): Promise<string> => {
  const result = await exec("npm", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: path.resolve(".runtime/npm-cache") },
    maxBuffer: 10 * 1024 * 1024
  });
  return result.stdout;
};

test("build emits canonical manifest artifacts, detects drift, and packs both files", async () => {
  await npm("run", "build");
  const canonical = canonicalRuntimeContractManifest();
  const manifest = await readFile(manifestPath);
  assert.deepEqual(manifest, Buffer.from(`${canonical}\n`, "utf8"));

  const hash = createHash("sha256").update(manifest).digest("hex");
  const digest = Buffer.from(`sha256:${hash}\n`, "ascii");
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.deepEqual(await readFile(digestPath), digest);
  const verify = (): ReturnType<typeof exec> => exec(process.execPath, ["--import", "tsx", emitterPath, "--check"], { cwd: process.cwd() });
  await verify();

  try {
    await writeFile(manifestPath, "{}", "utf8");
    await assert.rejects(
      verify(),
      /emitted runtime contract artifacts drift from source constants/
    );
    await writeFile(manifestPath, manifest);
    await writeFile(digestPath, "sha256:0000000000000000000000000000000000000000000000000000000000000000\n", "ascii");
    await assert.rejects(
      verify(),
      /emitted runtime contract artifacts drift from source constants/
    );
  } finally {
    await npm("run", "build");
  }
  assert.deepEqual(await readFile(manifestPath), manifest);
  assert.deepEqual(await readFile(digestPath), digest);

  const packed = JSON.parse(await npm("pack", "--dry-run", "--ignore-scripts", "--json")) as Array<{ files: Array<{ path: string }> }>;
  const paths = packed[0]?.files.map((entry) => entry.path);
  assert.ok(paths?.includes("dist/runtime/contract-manifest.json"));
  assert.ok(paths?.includes("dist/runtime/contract-manifest.sha256"));
});

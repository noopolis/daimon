import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve("dist");
const files = [];
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(file); else files.push(file);
  }
}
await walk(root);
assert.equal(files.some((file) => /testRuntime(?:Subprocess|MoltnetActions)/u.test(file)), false, "production dist contains explicit-test runtime modules");
for (const file of files.filter((value) => /\.(?:js|d\.ts|map)$/u.test(value))) {
  const bytes = await readFile(file, "utf8");
  assert.doesNotMatch(bytes, /DAIMON_EXPLICIT_TEST_RUNTIME|cognition_actions|mcp_config_path|testRuntimeSubprocess|testRuntimeMoltnetActions|testRuntimeMcpActions/u, `production closure reaches test runtime: ${file}`);
}
console.log(`production closure verified (${files.length} files)`);

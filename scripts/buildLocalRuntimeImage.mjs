import { mkdtemp, cp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const daimonRoot = path.resolve(import.meta.dirname, "..");
const mnemeRoot = path.resolve(daimonRoot, "../mneme");
const imageTag = process.env.DAIMON_RUNTIME_IMAGE_TAG ?? "noopolis/spawnfile-runtime-daimon:0.1.2-b35-source";
const piVersion = process.env.PI_VERSION ?? "0.79.10";
const contractPath = path.join(daimonRoot, "scripts/sourceRuntimeImageContract.json");
const canonical = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
};

const run = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: "inherit", ...options });
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (code === 0) resolve();
    else reject(new Error(`${command} exited with ${code ?? `signal ${signal}`}`));
  });
});
const capture = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (code === 0) resolve({ stderr, stdout });
    else reject(new Error(`${command} exited with ${code ?? `signal ${signal}`}: ${stderr.trim()}`));
  });
});

const packAs = async (packageRoot, filename, destination) => {
  const packageJson = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  const packedName = `${packageJson.name.replace("@", "").replace("/", "-")}-${packageJson.version}.tgz`;
  await run("npm", ["pack", "--pack-destination", destination], { cwd: packageRoot });
  await cp(path.join(destination, packedName), path.join(destination, filename));
  await rm(path.join(destination, packedName));
};

const context = await mkdtemp(path.join(os.tmpdir(), "daimon-runtime-context-"));
try {
  // Mneme must be packed first because Daimon's prepack builds against it.
  await packAs(mnemeRoot, "mneme.tgz", context);
  await packAs(daimonRoot, "daimon.tgz", context);
  await cp(path.join(daimonRoot, "Dockerfile.runtime"), path.join(context, "Dockerfile.runtime"));
  await cp(path.join(daimonRoot, "scripts/verifyRuntimeImage.mjs"), path.join(context, "verifyRuntimeImage.mjs"));

  await run("docker", [
    "build",
    "--file", "Dockerfile.runtime",
    "--target", "local-runtime",
    "--tag", imageTag,
    "--build-arg", `PI_VERSION=${piVersion}`,
    context
  ], { cwd: context });
  const inspected = await capture("docker", ["image", "inspect", "--format={{.Id}}", imageTag]);
  const imageId = inspected.stdout.trim();
  if (!/^sha256:[a-f0-9]{64}$/u.test(imageId) || inspected.stderr.trim() !== "") {
    throw new TypeError("built Daimon runtime image has no immutable image id");
  }

  const verifierTag = `${imageTag}-verify`;
  await run("docker", [
    "build",
    "--file", "Dockerfile.runtime",
    "--target", "local-verify",
    "--tag", verifierTag,
    "--build-arg", `PI_VERSION=${piVersion}`,
    context
  ], { cwd: context });
  const verified = await capture("docker", [
    "run", "--rm",
    "-e", "RUNTIME_ROOT=/opt/spawnfile/runtime-installs/daimon",
    "-e", `RUNTIME_IMAGE_ID=${imageId}`,
    "-e", `RUNTIME_IMAGE_REFERENCE=${imageTag}`,
    verifierTag
  ]);
  let receipt;
  try { receipt = JSON.parse(verified.stdout); } catch {
    throw new TypeError("Daimon runtime verifier did not emit one JSON receipt");
  }
  const contract = JSON.parse(await readFile(contractPath, "utf8"));
  if (verified.stderr.trim() !== "" || canonical(receipt) !== canonical(contract)) {
    throw new TypeError(`Daimon source runtime image contract drift\n${JSON.stringify(receipt, null, 2)}`);
  }

  console.log(`Built image: ${imageTag}`);
  console.log(`Image ID: ${imageId}`);
  console.log(`Runtime tree: ${receipt.image.runtime_tree_digest}`);
  console.log(`Tool contract: ${receipt.tool_contract.digest}`);
  console.log(`SPAWNFILE_DAIMON_RUNTIME_IMAGE=${imageTag}`);
} finally {
  await rm(context, { recursive: true, force: true });
}

import { mkdtemp, cp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const daimonRoot = path.resolve(import.meta.dirname, "..");
const mnemeRoot = path.resolve(daimonRoot, "../mneme");
const imageTag = process.env.DAIMON_RUNTIME_IMAGE_TAG ?? "noopolis/spawnfile-runtime-daimon:0.1.2-local";
const piVersion = process.env.PI_VERSION ?? "0.79.10";

const run = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: "inherit", ...options });
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (code === 0) resolve();
    else reject(new Error(`${command} exited with ${code ?? `signal ${signal}`}`));
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

  await run("docker", [
    "build",
    "--file", "Dockerfile.runtime",
    "--target", "local-runtime",
    "--tag", imageTag,
    "--build-arg", `PI_VERSION=${piVersion}`,
    context
  ], { cwd: context });

  const verifierTag = `${imageTag}-verify`;
  await run("docker", [
    "build",
    "--file", "Dockerfile.runtime",
    "--target", "local-verify",
    "--tag", verifierTag,
    "--build-arg", `PI_VERSION=${piVersion}`,
    context
  ], { cwd: context });
  await run("docker", ["run", "--rm", "-e", "RUNTIME_ROOT=/opt/spawnfile/runtime-installs/daimon", verifierTag]);

  console.log(`Built image: ${imageTag}`);
  console.log(`SPAWNFILE_DAIMON_RUNTIME_IMAGE=${imageTag}`);
} finally {
  await rm(context, { recursive: true, force: true });
}

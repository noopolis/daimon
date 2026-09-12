import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { canonicalJson } from "../src/contracts/canonicalJson.ts";
import { RUNTIME_CONTRACT_MANIFEST } from "../src/contracts/runtimeContractManifest.ts";

const runtimeDist = fileURLToPath(new URL("../dist/runtime/", import.meta.url));
const manifestName = "contract-manifest.json";
const digestName = "contract-manifest.sha256";

type ContractManifestArtifacts = Readonly<{
  digest: Buffer;
  manifest: Buffer;
}>;

export const contractManifestArtifacts = (): ContractManifestArtifacts => {
  const canonical = canonicalJson(RUNTIME_CONTRACT_MANIFEST);
  const parsed = JSON.parse(canonical) as unknown;
  if (canonicalJson(parsed) !== canonical) throw new Error("contract manifest failed canonical round trip");
  const manifest = Buffer.from(`${canonical}\n`, "utf8");
  const hash = createHash("sha256").update(manifest).digest("hex");
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("contract manifest digest is not lowercase sha256");
  return Object.freeze({ manifest, digest: Buffer.from(`sha256:${hash}\n`, "ascii") });
};

const assertRuntimeDist = async (outputDirectory: string): Promise<void> => {
  const entry = await stat(outputDirectory);
  if (!entry.isDirectory()) throw new Error("compiled runtime output is not a directory");
};

export const emitContractManifestArtifacts = async (outputDirectory = runtimeDist): Promise<void> => {
  await assertRuntimeDist(outputDirectory);
  const artifacts = contractManifestArtifacts();
  await writeFile(path.join(outputDirectory, manifestName), artifacts.manifest, { flag: "w" });
  await writeFile(path.join(outputDirectory, digestName), artifacts.digest, { flag: "w" });
};

export const verifyContractManifestArtifacts = async (outputDirectory = runtimeDist): Promise<void> => {
  await assertRuntimeDist(outputDirectory);
  const expected = contractManifestArtifacts();
  const [manifest, digest] = await Promise.all([
    readFile(path.join(outputDirectory, manifestName)),
    readFile(path.join(outputDirectory, digestName)),
  ]);
  if (!manifest.equals(expected.manifest) || !digest.equals(expected.digest)) {
    throw new Error("emitted runtime contract artifacts drift from source constants");
  }
};

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  if (args.length === 0) return emitContractManifestArtifacts();
  if (args.length === 1 && args[0] === "--check") return verifyContractManifestArtifacts();
  throw new Error("usage: emitRuntimeContractManifest.ts [--check]");
};

const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(path.resolve(invoked)).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "contract artifact generation failed"}\n`);
    process.exitCode = 1;
  });
}

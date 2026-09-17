import { chmod, copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

await import('./verifyArtifacts.ts');
const root = path.dirname(fileURLToPath(import.meta.url));
// The broker artifacts are prebuilt, provenance-verified Linux executables checked into
// this repository, so staging one is a packaging step and not a host capability: the
// published tarball must carry `dist/runtime/native/daimon-engine-broker` on every packing
// host, because the runtime image installs that tarball with no lifecycle script that could
// stage it later. `DAIMON_ENGINE_BROKER_ARCH` selects the packaged Linux target when it is
// not the host's own architecture.
const architecture = process.env.DAIMON_ENGINE_BROKER_ARCH?.trim() || process.arch;
if (!['x64', 'arm64'].includes(architecture)) {
  if (process.env.DAIMON_REQUIRE_ENGINE_BROKER === '1') throw new Error('native engine broker is Linux x64/arm64 only');
  process.exit(0);
}
const destination = path.resolve(root, '../../../dist/runtime/native/daimon-engine-broker');
await mkdir(path.dirname(destination), { recursive: true });
await copyFile(path.join(root, 'artifacts', `daimon-engine-broker-${architecture}`), destination);
await chmod(destination, 0o755);

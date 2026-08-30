import { chmod, copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

await import('./verifyArtifacts.mjs');
const root = path.dirname(fileURLToPath(import.meta.url));
const architecture = process.arch;
if (!['x64', 'arm64'].includes(architecture) || process.platform !== 'linux') {
  if (process.env.DAIMON_REQUIRE_ENGINE_BROKER === '1') throw new Error('native engine broker is Linux x64/arm64 only');
  process.exit(0);
}
const destination = path.resolve(root, '../../../dist/runtime/native/daimon-engine-broker');
await mkdir(path.dirname(destination), { recursive: true });
await copyFile(path.join(root, 'artifacts', `daimon-engine-broker-${architecture}`), destination);
await chmod(destination, 0o755);

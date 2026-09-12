import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const sourceFiles = ['engineBrokerLauncher.c', 'engineBrokerLauncher.h', 'engineBrokerLauncherCore.inc', 'engineBrokerLauncherServer.inc', 'engineBrokerLauncherModes.inc', 'engineBrokerLauncherMain.inc'];
const sourceHash = createHash('sha256');
for (const file of sourceFiles) sourceHash.update(await readFile(path.join(root, file)));
const sourceSha256 = `sha256:${sourceHash.digest('hex')}`;
type NativeArchitecture = 'x64' | 'arm64';
type Provenance = {
  architecture: NativeArchitecture;
  binary_sha256: string;
  install_path: string;
  source_sha256: string;
  version: 'daimon.engine-broker-native-build.v1';
};
const isProvenance = (value: unknown): value is Provenance => (
  value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
  && (value as { version?: unknown }).version === 'daimon.engine-broker-native-build.v1'
  && typeof (value as { architecture?: unknown }).architecture === 'string'
  && typeof (value as { source_sha256?: unknown }).source_sha256 === 'string'
  && typeof (value as { binary_sha256?: unknown }).binary_sha256 === 'string'
  && typeof (value as { install_path?: unknown }).install_path === 'string'
);

for (const architecture of ['x64', 'arm64'] as const) {
  const binary = path.join(root, 'artifacts', `daimon-engine-broker-${architecture}`), stat = await lstat(binary);
  if (!stat.isFile() || (stat.mode & 0o111) === 0) throw new Error('native broker artifact is not executable');
  const bytes = await readFile(binary);
  const provenance = JSON.parse(await readFile(`${binary}.provenance.json`, 'utf8')) as unknown;
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (!isProvenance(provenance) || provenance.architecture !== architecture || provenance.source_sha256 !== sourceSha256 || provenance.binary_sha256 !== digest || provenance.install_path !== '/opt/daimon/bin/daimon-engine-broker') throw new Error('native broker provenance mismatch');
}
console.log('native engine broker artifacts verified');

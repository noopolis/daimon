import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const sourceFiles = ['engineBrokerLauncher.c', 'engineBrokerLauncher.h', 'engineBrokerLauncherCore.inc', 'engineBrokerLauncherServer.inc', 'engineBrokerLauncherModes.inc', 'engineBrokerLauncherMain.inc'];
const sourceHash = createHash('sha256');
for (const file of sourceFiles) sourceHash.update(await readFile(path.join(root, file)));
const sourceSha256 = `sha256:${sourceHash.digest('hex')}`;
for (const architecture of ['x64', 'arm64']) {
  const binary = path.join(root, 'artifacts', `daimon-engine-broker-${architecture}`), stat = await lstat(binary);
  if (!stat.isFile() || (stat.mode & 0o111) === 0) throw new Error('native broker artifact is not executable');
  const bytes = await readFile(binary), provenance = JSON.parse(await readFile(`${binary}.provenance.json`, 'utf8'));
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (provenance.version !== 'daimon.engine-broker-native-build.v1' || provenance.architecture !== architecture || provenance.source_sha256 !== sourceSha256 || provenance.binary_sha256 !== digest || provenance.install_path !== '/opt/daimon/bin/daimon-engine-broker') throw new Error('native broker provenance mismatch');
}
console.log('native engine broker artifacts verified');

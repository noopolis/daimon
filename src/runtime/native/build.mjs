import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const artifacts = path.join(root, 'artifacts');
const builder = 'gcc:14-bookworm@sha256:5e927c284bf55a7dc796262e311a0703344f62f41f5621eb56843111b1d37e15';
const sourceFiles = ['engineBrokerLauncher.c', 'engineBrokerLauncher.h', 'engineBrokerLauncherCore.inc', 'engineBrokerLauncherServer.inc', 'engineBrokerLauncherModes.inc', 'engineBrokerLauncherMain.inc'];
const sourceHash = createHash('sha256');
for (const file of sourceFiles) sourceHash.update(readFileSync(path.join(root, file)));
const sourceSha256 = `sha256:${sourceHash.digest('hex')}`;
mkdirSync(artifacts, { recursive: true });
for (const [architecture, platform] of [['x64', 'amd64'], ['arm64', 'arm64']]) {
  const nonce = randomUUID(), image = `daimon-engine-broker:${nonce}`, container = `daimon-engine-broker-${nonce}`;
  try {
    execFileSync('docker', ['build', '--network=none', '--platform', `linux/${platform}`, '-t', image, root], { stdio: 'inherit' });
    execFileSync('docker', ['create', '--name', container, image], { stdio: 'ignore' });
    const output = path.join(artifacts, `daimon-engine-broker-${architecture}`);
    execFileSync('docker', ['cp', `${container}:/daimon-engine-broker`, output]); chmodSync(output, 0o755);
    const binarySha256 = `sha256:${createHash('sha256').update(readFileSync(output)).digest('hex')}`;
    writeFileSync(`${output}.provenance.json`, `${JSON.stringify({ version: 'daimon.engine-broker-native-build.v1', architecture, target: `linux/${platform}`, builder_image: builder, compiler: 'gcc-14', source_sha256: sourceSha256, binary_sha256: binarySha256, install_path: '/opt/daimon/bin/daimon-engine-broker' })}\n`);
  } finally {
    try { execFileSync('docker', ['rm', container], { stdio: 'ignore' }); } catch {}
    try { execFileSync('docker', ['image', 'rm', image], { stdio: 'ignore' }); } catch {}
  }
}

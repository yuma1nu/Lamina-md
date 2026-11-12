// Portable npm for development hosts that provide Node without npm.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const response = await fetch('https://registry.npmjs.org/npm/12.2.2');
if (!response.ok) throw new Error(`npm metadata: HTTP ${response.status}`);
const metadata = await response.json();
const archiveResponse = await fetch(metadata.dist.tarball);
if (!archiveResponse.ok) throw new Error(`npm archive: HTTP ${archiveResponse.status}`);
const archive = Buffer.from(await archiveResponse.arrayBuffer());
const integrity = `sha512-${createHash('sha512').update(archive).digest('base64')}`;
if (integrity !== metadata.dist.integrity) throw new Error('npm archive integrity mismatch');
await mkdir(new URL('../.tools/npm/', import.meta.url), { recursive: true });
await writeFile(new URL('../.tools/npm.tgz', import.meta.url), archive);
const result = spawnSync('tar', ['-xzf', '.tools/npm.tgz', '-C', '.tools/npm', '--strip-components=1'], { cwd: root, stdio: 'inherit' });
if (result.error || result.status !== 0) throw result.error ?? new Error('Cannot extract npm');
console.log(`Portable npm ${metadata.version}: node .tools/npm/bin/npm-cli.js`);

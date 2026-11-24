import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const args of [
  ['node_modules/typescript/bin/tsc', '--noEmit'],
  ['node_modules/vite/bin/vite.js', 'build', '--configLoader', 'runner'],
]) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
  if (process.exitCode) break;
}
if (!process.exitCode) {
  // Vite copies app/public to dist; keep only catalog-listed learning packs in the release output.
  const packDir = path.join(root, 'dist/packs');
  const catalog = JSON.parse(await fs.readFile(path.join(packDir, 'catalog.json'), 'utf8'));
  const publishedFiles = new Set(catalog.packs.map(pack => pack.file));
  for (const name of await fs.readdir(packDir)) {
    if (name.endsWith('.zip') && !publishedFiles.has(name)) await fs.rm(path.join(packDir, name));
  }
}
if (process.exitCode) process.exit(process.exitCode);

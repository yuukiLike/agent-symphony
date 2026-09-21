import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

for (const directory of ['src', 'bin', 'scripts', 'adapters', 'public', 'test']) {
  for (const file of await readdir(directory)) {
    if (!/\.(mjs|js)$/.test(file)) continue;
    const result = spawnSync(process.execPath, ['--check', join(directory, file)], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
console.log('JavaScript syntax checked.');

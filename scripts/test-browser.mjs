import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const env = { ...process.env };
if (!env.PLAYWRIGHT_BROWSERS_PATH && existsSync('.tools/browsers')) env.PLAYWRIGHT_BROWSERS_PATH = resolve('.tools/browsers');
const result = spawnSync(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', ...process.argv.slice(2)], { env, stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);

import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
for (const directory of ['extensions', 'public/extensions']) for (const entry of readdirSync(directory)) if (/\.(mjs|js)$/.test(entry)) execFileSync(process.execPath, ['--check', directory + '/' + entry]);
execFileSync(process.execPath, ['--check', 'core/extensions-contracts.js']);

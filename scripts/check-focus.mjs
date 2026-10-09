import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

function check(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) check(file);
    else if (/\.(?:js|mjs)$/.test(file)) execFileSync(process.execPath, ['--check', file]);
  }
}
for (const directory of ['core', 'focus', 'public/calendar', 'public/focus', 'public/components']) check(directory);
for (const file of ['public/task-client.js', 'scripts/benchmark-focus.mjs']) execFileSync(process.execPath, ['--check', file]);

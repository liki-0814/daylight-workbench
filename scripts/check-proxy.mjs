import { readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
async function check(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await check(file);
    else if (/\.(mjs|js)$/.test(file)) execFileSync(process.execPath, ['--check', file]);
  }
}
await check('proxy');
await check('cli');
await check('public/components');
execFileSync(process.execPath, ['--check', 'public/proxy.js']);

await check('public/proxy');

execFileSync(process.execPath, ['--check', 'public/model-routes.js']);

execFileSync(process.execPath, ['--check', 'public/cli-config.js']);

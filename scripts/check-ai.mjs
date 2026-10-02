import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
function walk(dir) { for (const f of readdirSync(dir, { withFileTypes: true })) { const p = `${dir}/${f.name}`; if (f.isDirectory()) walk(p); else if (p.endsWith('.mjs')) execFileSync(process.execPath, ['--check', p]); } }
walk('ai');
execFileSync(process.execPath, ['--check', 'scripts/build-runtime.mjs']);
for (const file of ['public/ai.js', 'public/ai-settings.js', 'public/components/ai-message.js']) execFileSync(process.execPath, ['--check', file]);

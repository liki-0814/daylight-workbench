import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { comparePng, decodePng, encodePng } from '../e2e/png.mjs';
import { contrastRatio, parseHex } from '../e2e/a11y.mjs';
import { scanDirectory, tokenPairs } from '../e2e/static-scan.mjs';
import { checkBaseline } from '../e2e/harness.mjs';
import cases from '../e2e/cases/index.mjs';

const solid = (width, height, [r, g, b, a = 255]) => { const data = Buffer.alloc(width * height * 4); for (let i = 0; i < data.length; i += 4) { data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a; } return { width, height, data }; };

test('PNG encode/decode round trips and comparison honours threshold and ratio', () => {
  const base = solid(40, 25, [247, 248, 245]), png = encodePng(base);
  assert.deepEqual(decodePng(png), base);
  assert.equal(comparePng(png, png).same, true);
  const subtle = solid(40, 25, [247, 248, 245]); subtle.data[0] = 247 - 20; // 20/255 = 0.078 < 0.1
  assert.equal(comparePng(png, encodePng(subtle)).diffPixels, 0);
  const changed = solid(40, 25, [247, 248, 245]); changed.data[0] = 0; // one pixel of 1000 = 0.001 > 0.0001
  const result = comparePng(png, encodePng(changed));
  assert.equal(result.same, false); assert.equal(result.diffPixels, 1); assert.ok(result.diff);
  assert.equal(comparePng(png, encodePng(changed), { maxDiffRatio: 0.01 }).same, true);
  const resized = comparePng(png, encodePng(solid(41, 25, [247, 248, 245])));
  assert.equal(resized.same, false); assert.match(resized.reason, /尺寸不同/);
  assert.throws(() => decodePng(Buffer.from('not a png at all, definitely not a png file')), /PNG/);
});

test('baselines change only with --update-baseline and a reason, which is recorded', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'baseline-test-')), baselineDir = path.join(dir, 'b'), outDir = path.join(dir, 'o');
  const a = encodePng(solid(10, 10, [10, 20, 30])), b = encodePng(solid(10, 10, [200, 20, 30]));
  assert.equal((await checkBaseline({ name: 'x', buffer: a, baselineDir, outDir })).status, 'missing');
  await assert.rejects(checkBaseline({ name: 'x', buffer: a, update: true, baselineDir, outDir }), /--reason/);
  assert.equal((await checkBaseline({ name: 'x', buffer: a, update: true, reason: '首次建立', baselineDir, outDir })).status, 'updated');
  assert.equal((await checkBaseline({ name: 'x', buffer: a, baselineDir, outDir })).status, 'same');
  const different = await checkBaseline({ name: 'x', buffer: b, baselineDir, outDir });
  assert.equal(different.status, 'different');
  assert.ok((await fs.stat(path.join(outDir, 'x.diff.png'))).size > 0);
  assert.match(await fs.readFile(path.join(baselineDir, 'CHANGES.md'), 'utf8'), /`x`：首次建立/);
  await fs.rm(dir, { recursive: true, force: true });
});

test('contrast helper matches known WCAG values', () => {
  assert.equal(contrastRatio([0, 0, 0], [255, 255, 255]).toFixed(1), '21.0');
  assert.ok(contrastRatio(parseHex('#768078'), parseHex('#f7f8f5')) < 4.5);
});

test('L0 static scan flags P0 motifs and the public/ tree has none', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scan-test-'));
  await fs.writeFile(path.join(dir, 'a.css'), '.dot{border-radius:50%;background:#c0392b}\n.t{font-size:9px}\n.x{outline:none}\n');
  await fs.writeFile(path.join(dir, 'a.js'), "const t = '樱花';\n");
  const scan = scanDirectory(dir);
  assert.deepEqual(scan.findings.map(item => item.rule).sort(), ['A11Y-outline-none', 'AES-jp-motif', 'AES-red-disc', 'TYP-tiny']);
  assert.equal(scan.byLevel.P0, 2);
  await fs.rm(dir, { recursive: true, force: true });
  const real = scanDirectory(path.resolve(import.meta.dirname, '../public'));
  assert.ok(real.filesScanned > 5);
  assert.equal(real.byLevel.P0, 0, JSON.stringify(real.findings.filter(item => item.level === 'P0')));
});

test('token pairing: dark block (when present) may only override tokens defined in :root', async () => {
  assert.deepEqual(tokenPairs(':root{--a:1}'), { hasDark: false, missingInDark: [], missingInRoot: [] });
  assert.deepEqual(tokenPairs(':root{--a:1;--b:2}\n@media (prefers-color-scheme: dark){ :root{--a:3;--c:4} }'), { hasDark: true, missingInDark: ['--b'], missingInRoot: ['--c'] });
  for (const file of ['design-system.css', 'style.css']) {
    const css = await fs.readFile(path.resolve(import.meta.dirname, '../public', file), 'utf8').catch(() => '');
    assert.deepEqual(tokenPairs(css).missingInRoot, [], file + ' 的深色块引用了未在 :root 定义的令牌');
  }
});

test('E2E case catalogue is well-formed: unique IDs, priorities, known defects carry a reason', () => {
  const ids = cases.map(item => item.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const item of cases) { assert.match(item.id, /^(ext|shell)-[a-z0-9]+-\d+$|^shell-pr\d+-\d+$/); assert.ok(['P0', 'P1'].includes(item.priority)); assert.equal(typeof item.run, 'function'); if (item.expectedFail) assert.ok(item.expectedFail.length > 10); }
});

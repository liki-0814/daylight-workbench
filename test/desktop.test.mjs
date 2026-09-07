import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { migrateLegacyData } from '../storage.mjs';
import { initialState } from '../public/model.js';
import { getTrayState } from '../desktop/tray-model.mjs';

test('desktop migration preserves tasks, token and original files, and never overwrites new data', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'daylight-migration-'));
  const source = path.join(root, 'old'), dest = path.join(root, 'new');
  try {
    await mkdir(source);
    const original = { version: 7, state: initialState() };
    original.state.tasks[0].notes = '保留已有任务记录';
    await writeFile(path.join(source, 'state.json'), JSON.stringify(original));
    await writeFile(path.join(source, 'agent-token'), 'test-token');
    assert.equal(await migrateLegacyData(dest, source), true);
    assert.equal(JSON.parse(await readFile(path.join(dest, 'state.json'))).state.tasks[0].notes, '保留已有任务记录');
    assert.equal(await readFile(path.join(dest, 'agent-token'), 'utf8'), 'test-token');
    original.version = 8;
    await writeFile(path.join(dest, 'state.json'), JSON.stringify(original));
    assert.equal(await migrateLegacyData(dest, source), false);
    assert.equal(JSON.parse(await readFile(path.join(dest, 'state.json'))).version, 8);
    assert.equal(JSON.parse(await readFile(path.join(source, 'state.json'))).version, 7);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('menu bar tracks pending count, today order and next-day separation', () => {
  const state = initialState();
  state.plans['2026-09-07'] = ['task-7', 'task-1'];
  state.tasks[0].status = 'done';
  state.tasks[6].status = 'active';
  const tray = getTrayState(state, '2026-09-07');
  assert.equal(tray.title, '待办 7');
  assert.deepEqual(tray.today.map(t => t.id), ['task-7']);
  assert.equal(tray.other.length, 6);
  assert.equal(tray.active.id, 'task-7');
  assert.equal(getTrayState(state, '2026-09-08').today.length, 0);
});

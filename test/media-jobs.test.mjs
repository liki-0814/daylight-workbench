import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMediaJobs } from '../proxy/shared/media-jobs.js';

const DAY = 24 * 60 * 60 * 1000;
// writeJson replaces the file by rename, so a new inode means the file was rewritten.
const identity = async file => { const info = await stat(file); return `${info.ino}:${info.mtimeMs}`; };

test('polling a job never rewrites media-jobs.json unless a job expired or data changed', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'daylight-media-jobs-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let clock = Date.parse('2026-10-29T00:00:00Z');
  const jobs = createMediaJobs(dir, { now: () => clock });

  assert.equal(await jobs.get('vid_missing'), undefined);
  await assert.rejects(() => stat(jobs.file), { code: 'ENOENT' });

  const open = await jobs.create({ provider: 'grok', account: 'a', model: 'm' });
  const done = await jobs.create({ provider: 'grok', account: 'a', model: 'm', status: 'succeeded' });
  const created = await identity(jobs.file);
  for (let i = 0; i < 5; i++) {
    assert.equal((await jobs.get(open.id)).status, 'in_progress');
    assert.equal(await jobs.get('vid_missing'), undefined);
  }
  assert.equal(await identity(jobs.file), created, 'unchanged polls must not write');

  assert.deepEqual(await jobs.save({ ...open }), open);
  assert.equal(await identity(jobs.file), created, 'saving identical data must not write');
  await jobs.remove('vid_missing');
  assert.equal(await identity(jobs.file), created, 'removing nothing must not write');

  clock += DAY - 1000;
  assert.equal((await jobs.get(open.id)).status, 'in_progress');
  assert.equal(await identity(jobs.file), created, 'not yet expired');

  clock += 2000;
  const expired = await jobs.get(open.id);
  assert.equal(expired.status, 'expired');
  assert.equal(expired.updatedAt, new Date(clock).toISOString());
  const afterExpiry = await identity(jobs.file);
  assert.notEqual(afterExpiry, created, 'expiry is persisted');
  assert.equal(JSON.parse(await readFile(jobs.file, 'utf8')).find(row => row.id === open.id).status, 'expired');
  assert.equal((await jobs.get(done.id)).status, 'succeeded');
  for (let i = 0; i < 3; i++) await jobs.get(open.id);
  assert.equal(await identity(jobs.file), afterExpiry, 'an already expired job is not rewritten on later polls');

  await jobs.save({ ...done, status: 'failed' });
  const saved = await identity(jobs.file);
  assert.notEqual(saved, afterExpiry);
  assert.equal(JSON.parse(await readFile(jobs.file, 'utf8')).find(row => row.id === done.id).status, 'failed');
  assert.equal((await jobs.remove(done.id)).id, done.id);
  assert.notEqual(await identity(jobs.file), saved);
});

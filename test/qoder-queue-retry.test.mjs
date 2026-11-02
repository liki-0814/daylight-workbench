import test from 'node:test';
import assert from 'node:assert/strict';
import {QueueRetry} from '../proxy/qoder/queue-retry.js';
import {DEFAULT_QUEUE_RETRY, queueRetryDelay} from '../proxy/qoder/models.js';

test('concurrent overload retries are spaced per account/model and other models remain independent', async () => {
  let now = 1000;
  const waits = [];
  const queue = new QueueRetry({now: () => now, wait: (ms, _, {signal}) => new Promise((resolve, reject) => {
    waits.push({ms, resolve});
    signal?.addEventListener('abort', () => reject(signal.reason), {once:true});
  })});
  const first = queue.delay('account\0dsf', 3000);
  const second = queue.delay('account\0dsf', 3000);
  const other = queue.delay('account\0other', 3000);
  const otherAccount = queue.delay('other\0dsf', 3000);
  assert.deepEqual(waits.map(w => w.ms), [3000, 6000, 3000, 3000]);
  now = 7000;
  waits.forEach(w => w.resolve());
  await Promise.all([first, second, other, otherAccount]);
  assert.equal(queue.slots.size, 0);
});

test('cancelling a queued retry prevents dispatch and releases the last reservation', async () => {
  const queue = new QueueRetry();
  const controller = new AbortController();
  let dispatched = false;
  const pending = queue.delay('account\0dsf', 30000, controller.signal).then(() => { dispatched = true; });
  controller.abort();
  await assert.rejects(pending, {name:'AbortError'});
  assert.equal(dispatched, false);
  assert.equal(queue.slots.size, 0);
  await assert.rejects(queue.delay('account\0dsf', 30000, controller.signal), {name:'AbortError'});
  assert.equal(queue.slots.size, 0);
});

test('default overload recovery spans longer bursts with bounded jitter and delay', () => {
  assert.equal(DEFAULT_QUEUE_RETRY.maxRetries, 4);
  assert.equal(queueRetryDelay(1, DEFAULT_QUEUE_RETRY, () => 0), 3000);
  assert.equal(queueRetryDelay(1, DEFAULT_QUEUE_RETRY, () => 1), 3750);
  assert.equal(queueRetryDelay(4, DEFAULT_QUEUE_RETRY, () => 1), 30000);
  assert.equal(queueRetryDelay(5, DEFAULT_QUEUE_RETRY, () => 1), 30000);
});

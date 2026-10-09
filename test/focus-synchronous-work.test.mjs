import test from 'node:test';
import assert from 'node:assert/strict';
import { createSynchronousWorkMeter } from '../focus/synchronous-work.mjs';

test('consecutive compute and encoding add across microtasks until an event-loop boundary', async () => {
  let time = 0, boundary;
  const completed = [];
  const meter = createSynchronousWorkMeter({ now: () => time, scheduleBoundary: callback => { boundary = callback; return 1; }, cancelBoundary() {}, onBlock: ms => completed.push(ms) });
  const request = meter.startScope();
  meter.measure(() => { time += 300; });
  await Promise.resolve(); // A promise continuation does not yield the main thread.
  meter.add(300); // Store encoding reports before awaiting filesystem I/O.
  assert.equal(request.maxMs, 600);
  boundary();
  assert.deepEqual(completed, [600]);
  const next = meter.startScope();
  time += 5000; // I/O waiting contributes no synchronous work.
  meter.measure(() => { time += 250; });
  assert.equal(next.maxMs, 250);
  assert.equal(request.maxMs, 600);
  assert.equal(request.finish(), 600);
  assert.equal(next.finish(), 250);
  meter.close();
  assert.deepEqual(completed, [600, 250]);
});

test('nested measurement and encoding callbacks are counted once, including thrown work', () => {
  let time = 0;
  const meter = createSynchronousWorkMeter({ now: () => time, scheduleBoundary: () => 1, cancelBoundary() {} });
  const scope = meter.startScope();
  meter.measure(() => { time += 100; meter.measure(() => { time += 100; }); meter.add(100); });
  assert.equal(scope.maxMs, 200);
  assert.throws(() => meter.measure(() => { time += 50; throw new Error('failed compute'); }), /failed compute/);
  assert.equal(scope.finish(), 250);
  meter.close();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { durationText } from '../public/focus/presentation.js';
test('duration preserves positive subsecond records while zero stays zero', () => {
  assert.equal(durationText(0), '0 秒'); assert.equal(durationText(1), '不到 1 秒'); assert.equal(durationText(999), '不到 1 秒'); assert.equal(durationText(1000), '1 秒'); assert.equal(durationText(60000), '1 分钟'); assert.equal(durationText(3720000), '1 小时 2 分钟');
});

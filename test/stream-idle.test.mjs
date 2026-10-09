import test from 'node:test';
import assert from 'node:assert/strict';
import { readWithIdle } from '../proxy/shared/protocol.js';

function hangingReader() {
  return new ReadableStream({ start() {} }).getReader();
}

test('an abandoned upstream read does not become an unhandled rejection', async () => {
  const errors = [];
  const onRejection = error => errors.push(error);
  process.on('unhandledRejection', onRejection);
  try {
    const reader = hangingReader();
    const read = readWithIdle(reader, 30, '上游响应空闲超时');
    read.cancel();
    await new Promise(resolve => setTimeout(resolve, 70));
    assert.equal(errors.length, 0);
    await reader.cancel().catch(() => {});
  } finally {
    process.off('unhandledRejection', onRejection);
  }
});

test('waiting on an idle upstream read still fails', async () => {
  const reader = hangingReader();
  await assert.rejects(readWithIdle(reader, 20, '上游响应空闲超时'), error => error.code === 'idle_timeout');
  await reader.cancel().catch(() => {});
});

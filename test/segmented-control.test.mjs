import test from 'node:test';
import assert from 'node:assert/strict';
import { segmentedControl } from '../public/components/segmented-control.js';

const options = [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }];

test('segmented control defaults to radiogroup/radio (backward compatible)', () => {
  const html = segmentedControl({ id: 's', label: '选择', value: 'a', options });
  assert.match(html, /role="radiogroup"/);
  assert.equal(html.match(/role="radio"/g).length, 2);
  assert.match(html, /aria-checked="true"/);
  assert.doesNotMatch(html, /aria-selected|role="tab/);
});

test('segmented control tabs mode uses tablist/tab with aria-selected (E-15)', () => {
  const html = segmentedControl({ id: 's', label: '分类', value: 'b', options, mode: 'tabs' });
  assert.match(html, /role="tablist"/);
  assert.equal(html.match(/role="tab"/g).length, 2);
  const selected = html.match(/<button[^>]*aria-selected="true"[^>]*>/)[0];
  assert.match(selected, /data-segment-value="b"/);
  assert.doesNotMatch(html, /aria-checked|role="radio/);
  assert.equal(html.match(/aria-selected="true"/g).length, 1);
  assert.equal(html.match(/tabindex="0"/g).length, 1);
});

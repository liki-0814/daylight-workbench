import test from 'node:test';
import assert from 'node:assert/strict';
import { mediaRowsHtml } from '../public/components/media-models.js';

test('media rows share model toggles and disabled grouping without chat parameters', () => {
  assert.equal(mediaRowsHtml([]), '');
  const html = mediaRowsHtml([{ id: 'grok-imagine-image-2.0', displayName: 'grok-imagine-image-2.0', output: 'image', status: 'ready' }, { id: 'grok-imagine-video-1.5', output: 'video', status: 'ready', enabled: false }]);
  assert.match(html, /grok-imagine-image-2\.0/);
  assert.match(html, /图像/);
  assert.match(html, /视频/);
  assert.match(html, /已登录可用/);
  assert.match(html, /type="checkbox"/);
  assert.match(html, /aria-label="启用 grok-imagine-image-2.0"/);
  assert.match(html, /未启用模型/);
  assert.match(html, /proxy-disabled-models/);
  assert.doesNotMatch(html, /推理|Fast|上下文/);
});

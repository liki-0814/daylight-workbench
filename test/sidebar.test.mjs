import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState } from '../public/model.js';
import { sidebarContent } from '../public/components/sidebar.js';

test('sidebar footer only shows settings, not workspace or save-status labels', () => {
  for (const view of ['today', 'proxy', 'settings']) {
    for (const busy of [false, true]) {
      const html = sidebarContent({ state: initialState(), view, busy });
      const footer = html.match(/<div class="sidebar-footer">([\s\S]*?)<\/div>/)?.[1];
      assert.ok(footer, `${view}: footer exists`);
      assert.match(footer, /^<button data-view="settings"[^>]*>设置 [\s\S]*<\/button>$/);
      assert.doesNotMatch(html, /本地工作空间|更改已保存到本机|正在保存…|local-badge/);
      if (view === 'settings') assert.match(footer, /aria-current="page"/);
      assert.match(html, /data-action="new"/);
      assert.match(html, /data-view="proxy"/);
    }
  }
});

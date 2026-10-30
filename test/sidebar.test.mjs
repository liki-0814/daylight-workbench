import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState } from '../public/model.js';
import { sidebarContent } from '../public/components/sidebar.js';

test('sidebar shows eight page tabs, without project lists or save-status labels', () => {
  for (const view of ['today', 'proxy', 'settings']) {
    for (const busy of [false, true]) {
      const html = sidebarContent({ state: initialState(), view, busy });
      assert.equal((html.match(/data-view=/g)||[]).length,8);
      assert.match(html, /data-view="extensions"/);
      assert.doesNotMatch(html, /本地工作空间|更改已保存到本机|正在保存…|local-badge|project-full|project-nav/);
      assert.match(html,/data-view="settings"/);
      assert.match(html,/data-view="update"/);
      assert.ok(html.indexOf('data-view="update"') < html.indexOf('data-view="settings"'), 'update comes before settings');
      assert.doesNotMatch(html, /data-app-update/);
      if (view === 'settings') assert.match(html,/data-view="settings" aria-current="page"/);
      assert.doesNotMatch(html, /data-view="update" aria-current/);
      assert.match(html, /data-action="new"/);
      assert.match(html, /data-view="proxy"/);
    }
  }
  assert.match(sidebarContent({ state: initialState(), view: 'all', updateAvailable: true }), /data-view="update"[^>]*>[\s\S]*data-app-update>有更新[\s\S]*data-view="settings"/);
  assert.doesNotMatch(sidebarContent({ state: initialState(), view: 'all', updateAvailable: true }).split('data-view="settings"')[1], /data-app-update/);
  assert.match(sidebarContent({ state: initialState(), view: 'update' }), /data-view="update" aria-current="page"/);
});

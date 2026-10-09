import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState } from '../public/model.js';
import { sidebarContent } from '../public/components/sidebar.js';

test('sidebar shows six page tabs, without project lists or save-status labels', () => {
  for (const view of ['today', 'proxy', 'settings']) {
    for (const busy of [false, true]) {
      const html = sidebarContent({ state: initialState(), view, busy });
      assert.equal((html.match(/data-view=/g)||[]).length,6);
      assert.doesNotMatch(html, /本地工作空间|更改已保存到本机|正在保存…|local-badge|project-full|project-nav/);
      assert.match(html,/data-view="settings"/);
      if (view === 'settings') assert.match(html,/data-view="settings" aria-current="page"/);
      assert.match(html, /data-action="new"/);
      assert.match(html, /data-view="proxy"/);
    }
  }
});

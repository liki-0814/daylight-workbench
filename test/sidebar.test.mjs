import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState } from '../public/model.js';
import { sidebarContent, revealNavigationItem } from '../public/components/sidebar.js';
import { icon } from '../public/components/icons.js';

test('sidebar shows seven page tabs, without focus statistics, project lists or save-status labels', () => {
  for (const view of ['today', 'proxy', 'settings']) {
    for (const busy of [false, true]) {
      const html = sidebarContent({ state: initialState(), view, busy });
      const item = id => html.match(new RegExp(`<button class="nav-item[^>]*data-view="${id}"[^>]*>[\\s\\S]*?</button>`))?.[0] || '';
      assert.equal((html.match(/data-view=/g)||[]).length,7);
      assert.doesNotMatch(html, /data-view="focus"|专注统计/);
      assert.match(html, /data-view="extensions"/);
      assert(item('proxy').includes(icon('grid')));
      assert(item('extensions').includes(icon('plug')));
      assert(!item('extensions').includes(icon('grid')));
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

test('sidebar focus reveals partially visible navigation without smooth scrolling', () => {
  let options;
  const item = { scrollIntoView(value) { options = value; } };
  const target = { closest(selector) { return selector === '.page-navigation .nav-item' ? item : null; } };
  revealNavigationItem(target);
  assert.deepEqual(options, { block:'nearest', inline:'nearest', behavior:'instant' });
  revealNavigationItem({ closest() { return null; } });
});

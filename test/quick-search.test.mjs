import test from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeURL, resolveQuickInput } from '../public/quick-search.js';

test('URL detection accepts schemes, hosts and local addresses', () => {
  for (const value of ['https://example.com/a?b=1', 'example.com', 'www.example.com', 'github.com/user/repo', 'localhost:5173', '127.0.0.1:4318', 'example.cn', 'daylight.app']) {
    assert.equal(looksLikeURL(value), true, value);
  }
  for (const value of ['', 'hello world', 'test.mjs', 'v1.2', '中文 搜索', 'notes.txt', 'just text']) {
    assert.equal(looksLikeURL(value), false, value);
  }
});

test('quick input resolves to Google search or a direct URL', () => {
  assert.deepEqual(resolveQuickInput('  '), { kind: 'search', url: '', query: '' });
  const search = resolveQuickInput('Daylight 任务');
  assert.equal(search.kind, 'search');
  assert.equal(search.url, `https://www.google.com/search?q=${encodeURIComponent('Daylight 任务')}&cs=0`);
  assert.equal(resolveQuickInput('test.mjs').kind, 'search');
  assert.deepEqual(resolveQuickInput('https://example.com'), { kind: 'url', url: 'https://example.com', query: 'https://example.com' });
  assert.deepEqual(resolveQuickInput('github.com/user/repo'), { kind: 'url', url: 'https://github.com/user/repo', query: 'github.com/user/repo' });
  assert.deepEqual(resolveQuickInput('localhost:3000'), { kind: 'url', url: 'http://localhost:3000', query: 'localhost:3000' });
  assert.deepEqual(resolveQuickInput('127.0.0.1:4318'), { kind: 'url', url: 'http://127.0.0.1:4318', query: '127.0.0.1:4318' });
});

test('Google searches request light appearance without changing queries or direct URLs', () => {
  for (const query of ['github', 'macOS 玻璃', 'C++ &cs=1 #theme ?x=a+b/100%']) {
    const { kind, url } = resolveQuickInput(query);
    const target = new URL(url);
    assert.equal(kind, 'search');
    assert.equal(target.origin, 'https://www.google.com');
    assert.equal(target.searchParams.get('q'), query);
    assert.deepEqual(target.searchParams.getAll('cs'), ['0']);
    assert.deepEqual([...target.searchParams.keys()], ['q', 'cs']);
    assert.equal(target.hash, '');
  }
  for (const url of ['https://example.com/?theme=dark', 'https://www.google.com/search?q=github&cs=1']) {
    assert.deepEqual(resolveQuickInput(url), { kind: 'url', url, query: url });
  }
});

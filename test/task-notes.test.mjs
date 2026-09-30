import test from 'node:test';
import assert from 'node:assert/strict';
import { notesHTML, linkURL } from '../public/components/task-notes.js';
test('named links retain URL in href while only label is visible', () => {
  const html = notesHTML('问题：\n[查看异常](https://example.com/doc?q=1&x=2)\n继续处理');
  assert.match(html, /href="https:\/\/example.com\/doc\?q=1&amp;x=2"/);
  assert.match(html, />查看异常<\/a>/);
  assert.equal(html.replace(/<[^>]+>/g, ''), '问题：\n查看异常\n继续处理');
});
test('ordinary notes remain text and unsafe content cannot create HTML', () => {
  assert.equal(notesHTML('<script>alert(1)</script>\n**原文**'), '&lt;script&gt;alert(1)&lt;/script&gt;\n**原文**');
  for (const url of ['javascript:alert(1)','data:text/html,test','/local']) assert.equal(linkURL(url), null);
  assert.doesNotMatch(notesHTML('[危险](javascript:alert(1))'), /<a/);
});
test('supports URL parentheses, escaped labels and multiple links', () => {
  const html = notesHTML('[问题\\[一\\]](https://example.com/a(b)) 和 [文档](http://localhost:3000/doc)');
  assert.match(html, /href="https:\/\/example.com\/a\(b\)"/);
  assert.match(html, />问题\[一\]<\/a>/);
  assert.equal((html.match(/<a /g) || []).length, 2);
});

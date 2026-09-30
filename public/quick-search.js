// Pure input resolution for the quick search palette; no DOM access so tests and the page share it.
const schemePattern = /^https?:\/\/\S+$/i;
const wwwPattern = /^www\.[^\s/]+/i;
const localHostPattern = /^localhost(?::\d{2,5})?[/?#]?\S*$/i;
const ipv4Pattern = /^\d{1,3}(?:\.\d{1,3}){3}(?::\d{2,5})?[/?#]?\S*$/;
const hostPattern = /^((?:[\w-]+\.)+[\w-]+)(?::\d{2,5})?([/?#]\S*)?$/;
const genericTlds = new Set([
  'com', 'org', 'net', 'edu', 'gov', 'int', 'mil', 'info', 'biz', 'name',
  'dev', 'app', 'xyz', 'top', 'site', 'online', 'store', 'shop', 'blog',
  'tech', 'cloud', 'host', 'link', 'live', 'wiki', 'one', 'run', 'art', 'icu', 'vip',
]);

export function looksLikeURL(value) {
  const text = String(value ?? '').trim();
  if (!text || /\s/.test(text)) return false;
  if (schemePattern.test(text) || wwwPattern.test(text) || localHostPattern.test(text) || ipv4Pattern.test(text)) return true;
  const match = hostPattern.exec(text);
  if (!match) return false;
  const labels = match[1].split('.');
  if (labels.some(label => label.length === 0 || label.length > 63)) return false;
  const tld = labels.at(-1).toLowerCase();
  return tld.length === 2 || genericTlds.has(tld);
}

export function resolveQuickInput(value) {
  const text = String(value ?? '').trim();
  if (!text) return { kind: 'search', url: '', query: '' };
  // A plain /search link can render dark even when Chrome's own search is light.
  // Request Google's light scheme without changing browser/account preferences.
  if (!looksLikeURL(text)) return { kind: 'search', url: `https://www.google.com/search?q=${encodeURIComponent(text)}&cs=0`, query: text };
  const scheme = schemePattern.test(text) ? '' : (localHostPattern.test(text) || ipv4Pattern.test(text)) ? 'http://' : 'https://';
  return { kind: 'url', url: scheme + text, query: text };
}

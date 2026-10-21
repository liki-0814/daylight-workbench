const owner = 'liki-0814';
const repo = 'daylight-workbench';

export function latestReleaseURL() {
  return `https://api.github.com/repos/${owner}/${repo}/releases/latest`;
}

export function parseVersion(value) {
  const match = String(value ?? '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  return match ? match.slice(1).map(Number) : null;
}

export function compareVersions(current, latest) {
  const left = parseVersion(current), right = parseVersion(latest);
  if (!left || !right) return null;
  for (let index = 0; index < 3; index += 1) if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  return 0;
}

// Release links stay on this repository's GitHub Releases. Other hosts are dropped.
// Parsed without the URL constructor: the native JavaScriptCore has no URL global.
function releaseLink(value) {
  if (typeof value !== 'string' || value.length > 2000 || /[\u0000-\u0020\\]/.test(value)) return null;
  const match = /^https:\/\/([^/?#@]+)(\/[^?#]*)(?:[?#].*)?$/.exec(value);
  if (!match || match[1].toLowerCase() !== 'github.com') return null;
  const path = match[2];
  let decoded = path;
  try { decoded = decodeURIComponent(path); } catch { return null; }
  const unsafe = item => item.split('/').some(part => part === '.' || part === '..');
  const prefix = `/${owner}/${repo}/releases/`;
  if (unsafe(path) || unsafe(decoded) || !path.startsWith(prefix) || !decoded.startsWith(prefix)) return null;
  return value;
}

function notesOf(body) {
  const text = String(body ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > 280 ? `${text.slice(0, 279)}…` : text;
}

function assetOf(assets) {
  const files = (Array.isArray(assets) ? assets : []).flatMap(item => {
    const url = releaseLink(item?.browser_download_url);
    if (!url || typeof item.name !== 'string' || !item.name.endsWith('.dmg')) return [];
    return [{ name: item.name, url, size: Number.isInteger(item.size) ? item.size : null, arm64: item.name.includes('arm64') }];
  });
  const chosen = files.find(file => file.arm64) || files[0];
  if (!chosen) return null;
  const { name, url, size } = chosen;
  return { name, url, ...(size == null ? {} : { size }) };
}

export function interpretRelease(current, httpStatus, body) {
  const version = String(current ?? '');
  if (httpStatus === 404) return { current: version, status: 'none', latest: null };
  if (httpStatus === 401) return { current: version, status: 'unavailable', latest: null, error: 'GitHub 拒绝了未登录的发布读取' };
  if (httpStatus === 403 || httpStatus === 429) return { current: version, status: 'unavailable', latest: null, error: 'GitHub 发布接口暂时受限，请稍后再试' };
  if (httpStatus !== 200 || !body || typeof body !== 'object' || Array.isArray(body)) return { current: version, status: 'unavailable', latest: null, error: '暂时无法读取 GitHub 发布' };
  if (body.draft === true || body.prerelease === true) return { current: version, status: 'none', latest: null };
  const tag = typeof body.tag_name === 'string' ? body.tag_name.trim().replace(/^v/, '') : '';
  const htmlUrl = releaseLink(body.html_url);
  const latest = {
    version: tag,
    name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : tag,
    publishedAt: typeof body.published_at === 'string' ? body.published_at : null,
    ...(htmlUrl ? { htmlUrl } : {}),
    notes: notesOf(body.body),
    asset: assetOf(body.assets),
  };
  const order = compareVersions(version, tag);
  if (order == null) return { current: version, status: 'unrecognized', latest, error: '发布版本号无法与当前版本比较' };
  return { current: version, status: order < 0 ? 'available' : 'current', latest };
}

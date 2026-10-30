const owner = 'liki-0814';
const repo = 'daylight-workbench';
const maxBodyLength = 20000;
const maxPackageBytes = 1024 * 1024 * 1024;
export const manifestAssetName = 'latest-mac.json';
export const signatureAssetName = `${manifestAssetName}.sig`;
export const manifestSchema = 1;
const downloadPrefix = `https://github.com/${owner}/${repo}/releases/download/`;

export function latestReleaseURL() {
  return `https://api.github.com/repos/${owner}/${repo}/releases/latest`;
}

export function parseVersion(value) {
  const match = String(value ?? '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  return match ? match.slice(1).map(Number) : null;
}

// The running app may be a prerelease build (for example 0.7.0-beta.1): SemVer ordering applies, so a
// prerelease is older than the same x.y.z release. Everything that names a release, tag, manifest or
// download (parseVersion above) stays strictly x.y.z: prereleases are never published as updates.
export function parseRunningVersion(value) {
  const match = String(value ?? '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/);
  if (!match) return null;
  const pre = match[4] == null ? [] : match[4].split('.');
  if (pre.some(item => /^\d+$/.test(item) && item.length > 1 && item.startsWith('0'))) return null;
  return { core: match.slice(1, 4).map(Number), pre };
}

function comparePrerelease(left, right) {
  if (!left.length || !right.length) return left.length === right.length ? 0 : left.length ? -1 : 1;
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const a = left[index], b = right[index];
    if (a === b) continue;
    const aNumber = /^\d+$/.test(a), bNumber = /^\d+$/.test(b);
    if (aNumber && bNumber) return a.length !== b.length ? (a.length < b.length ? -1 : 1) : (a < b ? -1 : 1);
    if (aNumber !== bNumber) return aNumber ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return left.length === right.length ? 0 : left.length < right.length ? -1 : 1;
}

export function compareVersions(current, latest) {
  const left = parseRunningVersion(current), right = parseRunningVersion(latest);
  if (!left || !right) return null;
  for (let index = 0; index < 3; index += 1) if (left.core[index] !== right.core[index]) return left.core[index] < right.core[index] ? -1 : 1;
  return comparePrerelease(left.pre, right.pre);
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

function bodyOf(body) {
  const text = String(body ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
  return text.length > maxBodyLength ? `${text.slice(0, maxBodyLength - 1)}…` : text;
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

export function packageAssetName(version) {
  return `Daylight-${String(version).replace(/^v/, '')}-arm64.zip`;
}

// Everything the updater downloads must be an asset of this repository's release for exactly that tag.
export function assetURL(version, name) {
  const parts = parseVersion(version);
  if (!parts || typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(name)) return null;
  return `${downloadPrefix}v${parts.join('.')}/${name}`;
}

export function isTrustedAssetURL(value, version, name) {
  const expected = assetURL(version, name);
  return expected != null && value === expected;
}

// Release assets are served from GitHub's own storage hosts after a redirect; nothing else is followed.
export function isTrustedRedirectHost(host) {
  const name = String(host ?? '').toLowerCase();
  return name === 'github.com' || name === 'objects.githubusercontent.com' || name === 'release-assets.githubusercontent.com' || name === 'github-releases.githubusercontent.com';
}

export function normalizeDigest(value) {
  const match = /^(?:sha256:)?([0-9a-fA-F]{64})$/.exec(String(value ?? '').trim());
  return match ? match[1].toLowerCase() : null;
}

export function digestsMatch(left, right) {
  const a = normalizeDigest(left), b = normalizeDigest(right);
  return a != null && a === b;
}

function updateAssetOf(assets, version) {
  const list = Array.isArray(assets) ? assets : [];
  const pick = name => {
    const item = list.find(entry => entry && entry.name === name && isTrustedAssetURL(entry.browser_download_url, version, name));
    if (!item) return null;
    const digest = normalizeDigest(item.digest);
    return { name, url: item.browser_download_url, ...(Number.isInteger(item.size) && item.size > 0 ? { size: item.size } : {}), ...(digest ? { digest } : {}) };
  };
  const zip = pick(packageAssetName(version)), manifest = pick(manifestAssetName), signature = pick(signatureAssetName);
  return zip && manifest && signature ? { zip, manifest, signature } : null;
}

const manifestFailure = (code, message) => ({ ok: false, code, message });

// The manifest is the signed document. Its fields are validated before any file is downloaded.
export function parseUpdateManifest(text, expectedVersion) {
  let data;
  try { data = JSON.parse(String(text)); } catch { return manifestFailure('manifest-malformed', '更新清单不是有效的 JSON'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return manifestFailure('manifest-malformed', '更新清单格式不正确');
  if (data.schema !== manifestSchema) return manifestFailure('manifest-schema', '更新清单版本不受支持');
  const parts = parseVersion(data.version);
  if (!parts || typeof data.version !== 'string' || data.version !== parts.join('.')) return manifestFailure('manifest-malformed', '更新清单的版本号无效');
  if (expectedVersion != null && data.version !== String(expectedVersion).replace(/^v/, '')) return manifestFailure('manifest-version', '更新清单与发布版本不一致');
  if (!isTrustedAssetURL(data.url, data.version, packageAssetName(data.version))) return manifestFailure('manifest-url', '更新包地址不在本项目的发布里');
  if (!Number.isInteger(data.size) || data.size < 1 || data.size > maxPackageBytes) return manifestFailure('manifest-malformed', '更新清单的文件大小无效');
  if (typeof data.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(data.sha256)) return manifestFailure('manifest-malformed', '更新清单的校验值无效');
  if (typeof data.minOS !== 'string' || !/^\d+(?:\.\d+){0,2}$/.test(data.minOS)) return manifestFailure('manifest-malformed', '更新清单的最低系统版本无效');
  if (typeof data.date !== 'string' || Number.isNaN(Date.parse(data.date))) return manifestFailure('manifest-malformed', '更新清单的日期无效');
  if (typeof data.downgradeable !== 'boolean') return manifestFailure('manifest-malformed', '更新清单缺少降级标记');
  const { schema, version, url, size, sha256, minOS, date, downgradeable } = data;
  return { ok: true, manifest: { schema, version, url, size, sha256, minOS, date, downgradeable } };
}

function osParts(value) {
  const parts = String(value ?? '').split('.').map(Number);
  return parts.some(part => !Number.isInteger(part) || part < 0) ? null : [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

export function osAtLeast(os, minimum) {
  const left = osParts(os), right = osParts(minimum);
  if (!left || !right) return false;
  for (let index = 0; index < 3; index += 1) if (left[index] !== right[index]) return left[index] > right[index];
  return true;
}

// Decides whether a verified manifest may replace the running version. `release` is the GitHub
// asset record of the zip, whose digest (when GitHub supplies one) must agree with the manifest.
export function decideUpdate({ current, manifest, release, os, allowDowngrade = false }) {
  const order = parseVersion(manifest?.version) ? compareVersions(current, manifest.version) : null;
  if (order == null) return { ok: false, code: 'version-unrecognized', message: '版本号无法比较' };
  if (order === 0) return { ok: false, code: 'same-version', message: '已是该版本' };
  if (order > 0 && !(manifest.downgradeable === true && allowDowngrade === true)) return { ok: false, code: 'downgrade-refused', message: '更新清单的版本低于当前版本，已拒绝降级' };
  if (os != null && !osAtLeast(os, manifest.minOS)) return { ok: false, code: 'os-too-old', message: `需要 macOS ${manifest.minOS} 或更高版本` };
  if (release?.digest && !digestsMatch(release.digest, manifest.sha256)) return { ok: false, code: 'digest-mismatch', message: 'GitHub 记录的校验值与更新清单不一致' };
  if (release?.size != null && release.size !== manifest.size) return { ok: false, code: 'size-mismatch', message: 'GitHub 记录的文件大小与更新清单不一致' };
  return { ok: true, code: 'ok', message: '' };
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
    body: bodyOf(body.body),
    asset: assetOf(body.assets),
    update: updateAssetOf(body.assets, tag),
  };
  const order = parseVersion(tag) ? compareVersions(version, tag) : null;
  if (order == null) return { current: version, status: 'unrecognized', latest, error: '发布版本号无法与当前版本比较' };
  return { current: version, status: order < 0 ? 'available' : 'current', latest };
}

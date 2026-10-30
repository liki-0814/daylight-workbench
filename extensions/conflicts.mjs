import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { error, stat } from './files.mjs';

// E-11: a Skill binding "conflict" is a client location (<client skills dir>/<name>) that holds something
// other than a correct link to the shared Skill. Three owner decisions exist:
//   compare      read-only, bounded, redacted file diff (never follows links, never echoes credentials)
//   adoptShared  replace the client entry by the link (the old entry is journaled so operation.restore brings it back)
//   keepLocal    remember the decision in bindings.json `conflictResolutions` until the local content changes
// bindings.json keeps schemaVersion 1; the optional top-level array is preserved by older builds:
//   conflictResolutions: [{ skillId, clientId, target, fingerprint }]
const LIMITS = { entries: 500, depth: 6, textBytes: 65536, hashBytes: 5_000_000, lines: 2000, diffLines: 400, payloadLines: 3000 };
const SKIPPED = new Set(['.git', 'node_modules']);
const SENSITIVE_NAME = /^\.env(\..*)?$|^\.(npmrc|netrc|pypirc)$|\.(pem|key|p12|pfx|jks|keystore)$|^id_(rsa|dsa|ecdsa|ed25519)|credential|secret|token|passw(or)?d/i;
const SECRET_LINE = [
  /(?:api[_-]?key|secret|token|passw(?:or)?d|authorization|credential|private[_-]?key|access[_-]?key)["']?\s*[:=]\s*\S/i,
  /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,})/,
  /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/i, /-----BEGIN [A-Z ]*PRIVATE KEY/,
];
export const REDACTED_LINE = '[已隐藏：疑似凭据]';
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0 && value.length < 4096 && !/[\0\r\n]/.test(value);
const sha = data => createHash('sha256').update(data).digest('hex');

export function normalizeResolutions(manifest) {
  const list = manifest.conflictResolutions;
  if (list === undefined) return manifest;
  const bad = () => error('接入记录中的冲突处理记录格式错误，接入写入已暂停');
  if (!Array.isArray(list) || list.length > 1000) throw bad();
  for (const item of list) {
    if (!plain(item) || Object.keys(item).sort().join() !== 'clientId,fingerprint,skillId,target' || !Object.values(item).every(text) || !/^skill_[a-f0-9]{24}$/.test(item.skillId) || !path.isAbsolute(item.target) || !/^[a-f0-9]{64}$/.test(item.fingerprint)) throw bad();
  }
  return manifest;
}
const same = (item, skillId, clientId, target) => item.skillId === skillId && item.clientId === clientId && item.target === target;
export const findResolution = (manifest, skillId, clientId, target) => manifest?.conflictResolutions?.find(item => same(item, skillId, clientId, target)) || null;
// Mutates a cloned manifest. `fingerprint` null clears the record. Returns true when anything changed.
export function setResolution(manifest, { skillId, clientId, target }, fingerprint) {
  const list = (manifest.conflictResolutions || []).filter(item => !same(item, skillId, clientId, target));
  const had = list.length !== (manifest.conflictResolutions || []).length;
  if (fingerprint) list.push({ skillId, clientId, target, fingerprint });
  if (!list.length) { delete manifest.conflictResolutions; return had; }
  manifest.conflictResolutions = list;
  return true;
}
export function dropResolutions(manifest, skillId) {
  if (!manifest.conflictResolutions) return false;
  const list = manifest.conflictResolutions.filter(item => item.skillId !== skillId);
  if (list.length === manifest.conflictResolutions.length) return false;
  if (list.length) manifest.conflictResolutions = list; else delete manifest.conflictResolutions;
  return true;
}

// Bounded, link-safe listing: relative path -> { kind: file|link|special, size, abs }.
async function listTree(root, rootInfo) {
  const entries = new Map(); let truncated = false, skipped = 0;
  if (!rootInfo.isDirectory()) { entries.set('SKILL.md', { kind: rootInfo.isFile() ? 'file' : rootInfo.isSymbolicLink() ? 'link' : 'special', size: rootInfo.size, abs: root }); return { entries, truncated, skipped, single: true }; }
  async function walk(dir, prefix, depth) {
    for (const name of (await fs.readdir(dir)).sort()) {
      const abs = path.join(dir, name), rel = prefix ? prefix + '/' + name : name, info = await stat(abs);
      if (!info) continue;
      if (SKIPPED.has(name)) { skipped++; continue; }
      if (entries.size >= LIMITS.entries) { truncated = true; return; }
      if (info.isDirectory()) { if (depth + 1 >= LIMITS.depth) { truncated = true; continue; } await walk(abs, rel, depth + 1); }
      else entries.set(rel, { kind: info.isFile() ? 'file' : info.isSymbolicLink() ? 'link' : 'special', size: info.size, abs });
    }
  }
  await walk(root, '', 0);
  return { entries, truncated, skipped, single: false };
}

// Content identity of whatever sits at the client location. Links are never followed.
export async function fingerprintEntry(target) {
  const info = await stat(target);
  if (!info) return null;
  if (info.isSymbolicLink()) return sha(JSON.stringify(['link', await fs.readlink(target)]));
  const { entries } = await listTree(target, info), parts = [];
  let bytes = 0;
  for (const [rel, entry] of entries) {
    if (entry.kind === 'link') parts.push([rel, 'link', await fs.readlink(entry.abs).catch(() => null)]);
    else if (entry.kind === 'file') { bytes += entry.size; parts.push([rel, 'file', entry.size, bytes <= LIMITS.hashBytes * 4 ? sha(await fs.readFile(entry.abs)) : null]); }
    else parts.push([rel, entry.kind]);
  }
  return sha(JSON.stringify(['entry', info.isDirectory() ? 'directory' : 'file', parts]));
}

const kindOf = info => !info ? 'missing' : info.isSymbolicLink() ? 'link' : info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'special';
async function readBounded(file, limit) {
  const handle = await fs.open(file, 'r');
  try { const buffer = Buffer.alloc(limit + 1), { bytesRead } = await handle.read(buffer, 0, limit + 1, 0); return buffer.subarray(0, bytesRead); } finally { await handle.close(); }
}
const redactLine = line => SECRET_LINE.some(pattern => pattern.test(line)) ? REDACTED_LINE : line;
// Line diff from shared (left) to local (right) with 2 lines of context. LCS over the part between common prefix/suffix.
function diffLines(a, b) {
  let start = 0; while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length; while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const midA = a.slice(start, endA), midB = b.slice(start, endB), n = midA.length, m = midB.length, ops = [];
  for (let i = 0; i < start; i++) ops.push(['same', a[i]]);
  const table = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) table[i][j] = midA[i] === midB[j] ? Math.min(65535, table[i + 1][j + 1] + 1) : Math.max(table[i + 1][j], table[i][j + 1]);
  let i = 0, j = 0;
  while (i < n && j < m) { if (midA[i] === midB[j]) { ops.push(['same', midA[i]]); i++; j++; } else if (table[i + 1][j] >= table[i][j + 1]) ops.push(['shared', midA[i++]]); else ops.push(['local', midB[j++]]); }
  while (i < n) ops.push(['shared', midA[i++]]); while (j < m) ops.push(['local', midB[j++]]);
  for (let k = endA; k < a.length; k++) ops.push(['same', a[k]]);
  // Group into hunks.
  const hunks = []; let sharedLine = 1, localLine = 1, current = null, quiet = 0; const pending = [];
  for (const [op, line] of ops) {
    if (op === 'same') {
      if (current) { current.lines.push({ op, text: redactLine(line) }); if (++quiet >= 2) { current = null; quiet = 0; } else {} }
      else { pending.push({ op, text: redactLine(line), sharedLine, localLine }); if (pending.length > 2) pending.shift(); }
      sharedLine++; localLine++;
    } else {
      if (!current) { const first = pending[0]; current = { sharedStart: first ? first.sharedLine : sharedLine, localStart: first ? first.localLine : localLine, lines: pending.splice(0).map(({ op: o, text: t }) => ({ op: o, text: t })) }; hunks.push(current); }
      quiet = 0; current.lines.push({ op, text: redactLine(line) });
      if (op === 'shared') sharedLine++; else localLine++;
    }
  }
  return hunks;
}

export async function compareEntries({ sharedSource, localTarget }) {
  const sharedInfo = await stat(sharedSource), localInfo = await stat(localTarget);
  if (!sharedInfo || !sharedInfo.isDirectory()) throw error('共享 Skill 的主来源不可读，不能对比', 409, 'EXTENSIONS_OBJECT_MISSING');
  const localKind = kindOf(localInfo);
  const result = { localKind, files: [], summary: { same: 0, different: 0, onlyShared: 0, onlyLocal: 0, typeDiffers: 0, unknown: 0, withheld: 0, redactedLines: 0 }, truncated: false, ignored: 0 };
  if (!localInfo) return { ...result, compared: false, reason: 'missing' };
  if (localInfo.isSymbolicLink()) return { ...result, compared: false, reason: 'link', localLink: await fs.readlink(localTarget), note: '软件位置是指向别处的链接；对比不会跟随链接读取其内容。' };
  if (localKind === 'special') return { ...result, compared: false, reason: 'special' };
  const shared = await listTree(sharedSource, sharedInfo), local = await listTree(localTarget, localInfo);
  result.truncated = shared.truncated || local.truncated; result.ignored = shared.skipped + local.skipped; result.compared = true;
  let budget = LIMITS.payloadLines;
  const names = [...new Set([...shared.entries.keys(), ...local.entries.keys()])].sort();
  for (const name of names) {
    const left = shared.entries.get(name), right = local.entries.get(name);
    const file = { path: name };
    if (local.single && right) file.note = '软件位置是单个文件，按 SKILL.md 对比。';
    if (!left || !right) { file.status = left ? 'onlyShared' : 'onlyLocal'; file.size = (left || right).size; file.kind = (left || right).kind; }
    else if (left.kind !== right.kind) { file.status = 'typeDiffers'; file.sharedKind = left.kind; file.localKind = right.kind; }
    else if (left.kind !== 'file') { file.status = left.kind === 'link' && (await fs.readlink(left.abs).catch(() => 1)) === (await fs.readlink(right.abs).catch(() => 2)) ? 'same' : 'different'; file.kind = left.kind; }
    else {
      file.sharedSize = left.size; file.localSize = right.size;
      if (SENSITIVE_NAME.test(path.basename(name))) {
        file.withheld = 'sensitive';
        file.status = left.size > LIMITS.hashBytes || right.size > LIMITS.hashBytes ? 'unknown' : sha(await fs.readFile(left.abs)) === sha(await fs.readFile(right.abs)) ? 'same' : 'different';
      } else if (left.size > LIMITS.hashBytes || right.size > LIMITS.hashBytes) { file.withheld = 'tooLarge'; file.status = left.size === right.size ? 'unknown' : 'different'; }
      else {
        const [a, b] = [await readBounded(left.abs, LIMITS.hashBytes), await readBounded(right.abs, LIMITS.hashBytes)];
        file.status = a.equals(b) ? 'same' : 'different';
        const binary = a.subarray(0, 8192).includes(0) || b.subarray(0, 8192).includes(0);
        if (file.status === 'different') {
          if (binary) file.withheld = 'binary';
          else if (left.size > LIMITS.textBytes || right.size > LIMITS.textBytes) file.withheld = 'tooLarge';
          else {
            const linesA = a.toString('utf8').split('\n'), linesB = b.toString('utf8').split('\n');
            if (linesA.length > LIMITS.lines || linesB.length > LIMITS.lines) file.withheld = 'tooLarge';
            else {
              let hunks = diffLines(linesA, linesB), count = 0; const kept = [];
              for (const hunk of hunks) { if (count + hunk.lines.length > LIMITS.diffLines || budget < hunk.lines.length) { file.diffTruncated = true; result.truncated = true; break; } count += hunk.lines.length; budget -= hunk.lines.length; kept.push(hunk); }
              file.diff = kept;
              file.redactedLines = kept.reduce((total, hunk) => total + hunk.lines.filter(line => line.text === REDACTED_LINE).length, 0);
              result.summary.redactedLines += file.redactedLines;
            }
          }
        }
      }
    }
    if (file.withheld) result.summary.withheld++;
    result.summary[file.status]++; result.files.push(file);
  }
  result.identical = result.compared && !result.truncated && result.files.every(file => file.status === 'same');
  return result;
}

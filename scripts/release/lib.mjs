// Release-side helpers for the in-app updater. The signing key never leaves the machine that builds releases.
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { parseUpdateManifest, packageAssetName, assetURL, parseVersion } from '../../core/app-update.js';

// DER prefix of an Ed25519 SubjectPublicKeyInfo; the raw 32-byte key follows.
const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');

export function publicKeyFromBase64(text) {
  const raw = Buffer.from(String(text).trim(), 'base64');
  if (raw.length !== 32) throw new Error('Ed25519 公钥必须是 32 字节的 base64');
  return createPublicKey({ key: Buffer.concat([spkiPrefix, raw]), format: 'der', type: 'spki' });
}

export function rawPublicKeyBase64(privatePem) {
  const der = createPublicKey(createPrivateKey(privatePem)).export({ format: 'der', type: 'spki' });
  return der.subarray(spkiPrefix.length).toString('base64');
}

export const signBytes = (privatePem, bytes) => sign(null, Buffer.from(bytes), createPrivateKey(privatePem)).toString('base64');

export function verifyBytes(publicKeyBase64, bytes, signatureBase64) {
  try {
    const signature = Buffer.from(String(signatureBase64).trim(), 'base64');
    if (signature.length !== 64) return false;
    return verify(null, Buffer.from(bytes), publicKeyFromBase64(publicKeyBase64), signature);
  } catch { return false; }
}

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file).on('data', chunk => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
  });
}

// The manifest text is what gets signed: key order and whitespace are part of the signed bytes.
export function buildManifest({ version, size, sha256, minOS = '13.0', date = new Date().toISOString(), downgradeable = false }) {
  const parts = parseVersion(version);
  if (!parts) throw new Error(`版本号无效：${version}`);
  const normal = parts.join('.');
  const text = `${JSON.stringify({ schema: 1, version: normal, url: assetURL(normal, packageAssetName(normal)), size, sha256, minOS, date, downgradeable }, null, 2)}\n`;
  const parsed = parseUpdateManifest(text, normal);
  if (!parsed.ok) throw new Error(parsed.message);
  return text;
}

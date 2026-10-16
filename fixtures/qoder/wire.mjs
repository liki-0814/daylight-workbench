// Synthetic upstream decoders for wire assertions; never shipped with the App.
import { createDecipheriv } from 'node:crypto';

export function decodeBody(encoded) {
  const edge = Math.floor(encoded.length / 3);
  const swapped = edge ? encoded.slice(-edge) + encoded.slice(edge, -edge) + encoded.slice(0, edge) : encoded;
  const alphabet = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!$';
  const standard = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
  const base64 = [...swapped].map(char => {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error('Invalid Qoder wire character');
    return standard[index];
  }).join('');
  return JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
}

export function aesDecryptInfo(infoB64, temporaryKey) {
  const key = Buffer.from(temporaryKey, 'utf8');
  const decipher = createDecipheriv('aes-128-cbc', key, key);
  return Buffer.concat([decipher.update(Buffer.from(infoB64, 'base64')), decipher.final()]).toString('utf8');
}

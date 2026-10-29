import { BlockList, isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import { fail } from './media.js';

// Reference images are fetched by the local proxy on behalf of the caller, so the target must be a public internet host.
const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['::', 96], ['100::', 64], ['2001::', 32], ['2001:db8::', 32], ['2002::', 16], ['64:ff9b::', 96],
  ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
]) blocked.addSubnet(address, prefix, 'ipv6');

const MESSAGE = '参考图地址必须是公网 https 地址，不能指向本机或内网';

function ipv6Groups(address) {
  // URL normalises dotted tails such as ::ffff:127.0.0.1 into hexadecimal groups.
  const text = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const [head, tail] = text.split('::');
  const left = head ? head.split(':') : [], right = tail ? tail.split(':') : [];
  const missing = tail === undefined ? 0 : 8 - left.length - right.length;
  return [...left, ...Array(missing).fill('0'), ...right].map(group => parseInt(group, 16));
}

export function isPublicAddress(value) {
  const address = String(value).replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  if (family !== 6) return false;
  const groups = ipv6Groups(address);
  if (groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xffff) {
    return !blocked.check(`${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`, 'ipv4');
  }
  return !blocked.check(address, 'ipv6');
}

export async function assertPublicImageUrl(url, { lookup = dnsLookup, signal } = {}) {
  let parsed;
  try { parsed = new URL(url); } catch { fail('图片地址无效'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) fail(MESSAGE);
  const host = parsed.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost')) fail(MESSAGE);
  if (isIP(host)) {
    if (!isPublicAddress(host)) fail(MESSAGE);
    return;
  }
  let addresses;
  try {
    signal?.throwIfAborted();
    const pending = Promise.resolve(lookup(host, { all: true, verbatim: true }));
    addresses = signal ? await Promise.race([pending, new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))]) : await pending;
  } catch (error) {
    if (signal?.aborted) throw error;
    fail('参考图地址无法解析');
  }
  const list = (Array.isArray(addresses) ? addresses : [addresses]).map(item => item?.address ?? item);
  // One private answer is enough to reject: the fetch may connect to any of them.
  if (!list.length || !list.every(isPublicAddress)) fail(MESSAGE);
}

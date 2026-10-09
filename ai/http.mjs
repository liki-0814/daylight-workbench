import { timingSafeEqual } from 'node:crypto';
export const httpError = (message, status = 400, details = {}) => Object.assign(new Error(message), { status, ...details });
export function equal(a, b) { return typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
export async function body(req) { let b = ''; for await (const part of req) { b += part; if (Buffer.byteLength(b) > 1_000_000) throw httpError('请求内容过长'); } return b ? JSON.parse(b) : {}; }
export const send = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };

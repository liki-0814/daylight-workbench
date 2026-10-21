import { timingSafeEqual } from 'node:crypto';
export const httpError = (message, status = 400, details = {}) => Object.assign(new Error(message), { status, ...details });
export function equal(a, b) { return typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
export async function body(req, limit = 1_000_000) { const chunks = []; let size = 0; for await (const part of req) { size += part.length; if (size > limit) throw httpError('请求内容过长'); chunks.push(part); } return size ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; }
export const send = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };

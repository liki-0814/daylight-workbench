import { applyAction } from '../agent-api.mjs';
import { localDate, validate } from '../public/model.js';
import { isCivilDate } from './date.js';

// Keep JSON.stringify ordering compatible with receipts produced before this refactor.
export const fingerprintText = raw => JSON.stringify(JSON.parse(raw));

// Pure decision: transports own locking, SHA-256 and durable atomic persistence.
export function prepareTaskWrite(record, input, fingerprint, { busy = false, previous } = {}) {
  const reject = (code, error, extra = {}) => ({ code, value: { error, ...extra } });
  if (!input || typeof input.requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(input.requestId) || !Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) return reject(400, '需要合法的 requestId 和 expectedVersion');
  const receipt = (record.receipts || []).find(r => r.requestId === input.requestId);
  if (receipt) {
    if (receipt.fingerprint !== fingerprint) return reject(409, 'requestId 已用于不同的请求');
    return { code: 200, value: { version: record.version, state: record.state, replayed: true, appliedVersion: receipt.appliedVersion } };
  }
  if (busy || input.expectedVersion !== record.version) return reject(409, '数据版本已变化，请重新读取并核对操作', { version: record.version });
  const day = input.day ?? localDate();
  if (!isCivilDate(day)) return reject(400, 'day 必须是有效的 YYYY-MM-DD 日期');
  try {
    let state;
    if (input.action?.type === 'undo') {
      if (previous === undefined) return { needsPrevious: true };
      if (!previous) return reject(400, '没有可撤销的上一版数据');
      if (previous.version !== record.version - 1) return reject(400, '上一版数据不匹配');
      state = validate(previous.state);
    } else state = applyAction(record.state, input.action, day);
    const appliedVersion = record.version + 1;
    return { code: 200, state, receipt: { requestId: input.requestId, fingerprint, appliedVersion },
      value: { version: appliedVersion, state, replayed: false, appliedVersion } };
  } catch (error) { return reject(error.status || 400, error.message, error.code ? { code: error.code } : {}); }
}

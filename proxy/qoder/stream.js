import { OpenAiChatStreamParser, SseParser } from '../shared/llm/index.js';
import { tryParseJson } from '../shared/utils.js';

export const FRAME_ERROR = 'invalid_upstream_frame';
export const QUEUE_CODE = '10605';
export const RETRYABLE_UPSTREAM_CODES = new Set([QUEUE_CODE, '10500']);

function excerpt(data) {
  return data.length <= 512 ? data : `${data.slice(0, 512)}… (truncated from ${data.length} chars)`;
}
function isTelemetry(frame) {
  return typeof frame.firstTokenDuration === 'number' || typeof frame.totalDuration === 'number' || typeof frame.serverDuration === 'number' || Array.isArray(frame.stackTrace);
}
function errorMetadata(json) {
  if(!json||typeof json!=='object')return {};
  const nested=tryParseJson(typeof json.message==='string'?json.message:'')||json.error;
  const status=json.status??json.status_code??json.httpStatus??json.http_status;
  const code=json.error?.code??json.code;
  return {...(Number.isInteger(status)&&status>=400&&status<600?{upstreamErrorStatus:status}:{}),
    ...(typeof code==='string'&&/^[a-zA-Z0-9_.-]{1,80}$/.test(code)?{upstreamErrorCode:code}:{}),...errorMetadata(typeof nested==='object'?nested:undefined)};
}
function businessError(json) {
  if (typeof json !== 'object' || json === null) return;
  const { code, message } = json;
  if (typeof code !== 'string' || typeof message !== 'string') return;
  const nested=businessError(tryParseJson(message));return {...(nested ?? {code,message}),...errorMetadata(json)};
}
function wrapperError(json) {
  if (json.success === false) return json.message ?? json.errorMsg ?? json.msg ?? 'upstream error';
  if (typeof json.code === 'number' && json.code >= 400) return json.message ?? json.errorMsg ?? json.msg ?? `upstream error ${json.code}`;
  if (json.error != null) return typeof json.error === 'string' ? json.error : json.error.message ?? json.message ?? 'upstream error';
}

// Unwrap Qoder's SSE envelope, then use the common Chat stream parser.
export class QoderDeframer {
  sse = new SseParser();
  chat = new OpenAiChatStreamParser();
  frameIndex = 0;
  acceptedFrames = 0;
  push(text) {
    return this.sse.push(text).flatMap(frame => this.handleFrame(frame.event, frame.data));
  }
  flush() {
    const events = this.sse.flush().flatMap(frame => this.handleFrame(frame.event, frame.data));
    if (!this.chat.finished) events.push({ type: 'error', code: 'incomplete_stream', message: '上游连接提前结束' });
    return events;
  }
  handleFrame(event, data) {
    this.frameIndex++;
    if (event === 'finish') return this.chat.flush('stop');
    const trimmed = data.trim();
    if (trimmed === '') return [];
    if (trimmed === '[DONE]') return this.chat.flush('stop');
    const json = tryParseJson(trimmed);
    if (!json) return this.unrecognized('data is not valid JSON', trimmed);
    if (isTelemetry(json)) return [];
    if (json.body !== undefined) {
      if (typeof json.body !== 'string') return this.unrecognized('wrapper body is not a string', trimmed);
      const err = wrapperError(json);
      if (err) return [{ type: 'error', message: err, ...errorMetadata(json) }];
      const inner = json.body.trim();
      if (inner === '' || inner === '[DONE]') return this.chat.flush('stop');
      const innerJson = tryParseJson(inner);
      if (!innerJson) return this.unrecognized('wrapper body is not valid JSON', inner);
      const innerError = innerJson.choices === undefined ? businessError(innerJson) : undefined;
      if (innerError) return [{ type: 'error', ...innerError }];
      this.acceptedFrames++;
      return this.chat.push(innerJson);
    }
    if (json.choices !== undefined || json.error !== undefined) {
      const err = wrapperError(json);
      if (err && json.choices === undefined) return [{ type: 'error', message: err, ...errorMetadata(json) }];
      this.acceptedFrames++;
      return this.chat.push(json);
    }
    const err = wrapperError(json);
    if (err) return [{ type: 'error', message: err, ...errorMetadata(json) }];
    const bare = businessError(json);
    if (bare) return [{ type: 'error', ...bare }];
    return this.unrecognized('frame is neither a wrapper nor a chunk', trimmed);
  }
  unrecognized(reason, data) {
    const where = `frame ${this.frameIndex}, ${this.acceptedFrames} accepted`;
    return [{ type: 'error', message: `unrecognized Qoder frame (${where}): ${reason} — ${excerpt(data)}`, code: FRAME_ERROR }];
  }
}

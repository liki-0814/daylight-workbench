import { OpenAiChatStreamParser, SseParser } from "./llm/index.js";
import { asFiniteNumber, tryParseJson } from "./utils.js";
export const FRAME_ERROR = "invalid_upstream_frame";
export const QUEUE_CODE = "10605";
export const RETRYABLE_UPSTREAM_CODES = new Set([
    QUEUE_CODE,
    "10500"
]);
const EXCERPT_LIMIT = 512;
function excerpt(data) {
    if (data.length <= EXCERPT_LIMIT) return data;
    return `${data.slice(0, EXCERPT_LIMIT)}… (truncated from ${data.length} chars)`;
}
function isTelemetry(json) {
    const frame = json;
    return typeof frame.firstTokenDuration === "number" || typeof frame.totalDuration === "number" || typeof frame.serverDuration === "number" || Array.isArray(frame.stackTrace);
}
function businessError(json) {
    if (typeof json !== "object" || json === null) return undefined;
    const { code, message } = json;
    if (typeof code !== "string" || typeof message !== "string") return undefined;
    return businessError(tryParseJson(message)) ?? {
        code,
        message
    };
}
function truncateQw(s, maxLen) {
    return s.length <= maxLen ? s : `${s.slice(0, maxLen)}...`;
}
function qwBusinessError(json) {
    if (typeof json !== "object" || json === null) return undefined;
    const { code, message } = json;
    if (typeof code === "number" && code !== 0) {
        return {
            message: typeof message === "string" ? message : `upstream error ${code}`,
            code: String(code)
        };
    }
    if (typeof code === "string" && code !== "" && typeof message === "string") {
        return {
            message,
            code
        };
    }
    return undefined;
}
function wrapperError(json) {
    if (json.success === false) {
        return json.message ?? json.errorMsg ?? json.msg ?? "upstream error";
    }
    if (typeof json.code === "number" && json.code >= 400) {
        return json.message ?? json.errorMsg ?? json.msg ?? `upstream error ${json.code}`;
    }
    if (json.error != null) {
        if (typeof json.error === "string") return json.error;
        const e = json.error;
        return e.message ?? json.message ?? "upstream error";
    }
    return undefined;
}
export class QoderDeframer {
    deframeExtras;
    sse = new SseParser();
    chat = new OpenAiChatStreamParser();
    frameIndex = 0;
    acceptedFrames = 0;
    constructor(deframeExtras = false){
        this.deframeExtras = deframeExtras;
    }
    push(text) {
        const events = [];
        for (const frame of this.sse.push(text)){
            events.push(...this.handleFrame(frame.event, frame.data));
        }
        return events;
    }
    flush() {
        const events = [];
        for (const frame of this.sse.flush()){
            events.push(...this.handleFrame(frame.event, frame.data));
        }
        if (!this.chat.finished) events.push({ type: "error", code: "incomplete_stream", message: "上游连接提前结束" });
        return events;
    }
    handleFrame(event, data) {
        this.frameIndex += 1;
        if (event === "finish") {
            return this.chat.flush("stop");
        }
        const trimmed = data.trim();
        if (trimmed === "") return [];
        if (trimmed === "[DONE]") return this.chat.flush("stop");
        if (this.deframeExtras && trimmed.startsWith("[NOTIFICATIONS]")) return [];
        const json = tryParseJson(trimmed);
        if (!json) return this.unrecognized("data is not valid JSON", trimmed);
        if (isTelemetry(json)) return [];
        if (json.body !== undefined) {
            if (typeof json.body !== "string") return this.unrecognized("wrapper body is not a string", trimmed);
            if (this.deframeExtras) {
                const status = asFiniteNumber(json.statusCodeValue) ?? asFiniteNumber(json.status_code);
                if (status !== undefined && status !== 200) {
                    const bodyCode = tryParseJson(json.body)?.code;
                    const code = typeof bodyCode === "number" || typeof bodyCode === "string" && bodyCode !== "" ? String(bodyCode) : String(status);
                    return [
                        {
                            type: "error",
                            message: `upstream gateway error HTTP ${status}: ${truncateQw(json.body, 200)}`,
                            code
                        }
                    ];
                }
            }
            const err = wrapperError(json);
            if (err) return [
                {
                    type: "error",
                    message: err
                }
            ];
            const inner = json.body.trim();
            if (this.deframeExtras && inner.startsWith("[NOTIFICATIONS]")) return [];
            if (this.deframeExtras && (inner.startsWith("id:") || inner.startsWith("event:"))) return [];
            if (this.deframeExtras && inner === "") return [];
            if (inner === "" || inner === "[DONE]") return this.chat.flush("stop");
            const innerJson = tryParseJson(inner);
            if (!innerJson) return this.unrecognized("wrapper body is not valid JSON", inner);
            const innerError = innerJson.choices === undefined ? this.deframeExtras ? businessError(innerJson) ?? qwBusinessError(innerJson) : businessError(innerJson) : undefined;
            if (innerError) {
                return [
                    {
                        type: "error",
                        message: innerError.message,
                        code: innerError.code
                    }
                ];
            }
            this.acceptedFrames += 1;
            return this.chat.push(innerJson);
        }
        if (json.choices !== undefined || json.error !== undefined) {
            const err = wrapperError(json);
            if (err && json.choices === undefined) return [
                {
                    type: "error",
                    message: err
                }
            ];
            this.acceptedFrames += 1;
            return this.chat.push(json);
        }
        if (this.deframeExtras) {
            const qwErr = businessError(json) ?? qwBusinessError(json);
            if (qwErr) return [
                {
                    type: "error",
                    message: qwErr.message,
                    code: qwErr.code
                }
            ];
        }
        const err = wrapperError(json);
        if (err) return [
            {
                type: "error",
                message: err
            }
        ];
        const bare = this.deframeExtras ? businessError(json) ?? qwBusinessError(json) : businessError(json);
        if (bare) return [
            {
                type: "error",
                message: bare.message,
                code: bare.code
            }
        ];
        if (this.deframeExtras) {
            if (json.usage === undefined) return [];
            this.acceptedFrames += 1;
            return this.chat.push(json);
        }
        return this.unrecognized("frame is neither a wrapper nor a chunk", trimmed);
    }
    unrecognized(reason, data) {
        const where = `frame ${this.frameIndex}, ${this.acceptedFrames} accepted`;
        return [
            {
                type: "error",
                message: `unrecognized Qoder frame (${where}): ${reason} — ${excerpt(data)}`,
                code: FRAME_ERROR
            }
        ];
    }
}

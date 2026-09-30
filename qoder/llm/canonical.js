export const REASONING_EFFORTS = [
    "none",
    "low",
    "medium",
    "high",
    "xhigh",
    "max"
];
export function normalizeEffort(value) {
    if (value == null) return undefined;
    const v = value.trim().toLowerCase();
    if (v === "disabled" || v === "off") return "none";
    return REASONING_EFFORTS.includes(v) ? v : undefined;
}
export function resolveFinishReason(reported, hasToolCalls) {
    if (hasToolCalls && (reported === undefined || reported === "stop")) return "tool_calls";
    return reported ?? "stop";
}
export class LLMError extends Error {
    name = "LLMError";
    code;
    constructor(message, code){
        super(message);
        this.code = code;
    }
}

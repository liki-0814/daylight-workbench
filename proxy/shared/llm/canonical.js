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
// Canonical requests carry instructions separately from user/assistant/tool history.
// OpenAI system and developer roles are instruction aliases at this boundary.
export function normalizeInstructions(messages, instructions) {
    const texts = instructions ? [instructions] : [];
    const history = [];
    for (const message of messages) {
        if (message.role === "system" || message.role === "developer") {
            const content = message.content;
            texts.push(typeof content === "string" ? content : content.map(p => p.type === "text" ? p.text : "").join("\n"));
        } else {
            history.push(message);
        }
    }
    return { system: texts.filter(Boolean).join("\n\n") || undefined, messages: history };
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

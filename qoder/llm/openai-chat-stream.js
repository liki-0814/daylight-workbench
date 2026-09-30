import { parseUsage } from "./usage.js";
function mapFinishReason(raw) {
    switch(raw){
        case "stop":
            return "stop";
        case "length":
            return "length";
        case "tool_calls":
        case "function_call":
            return "tool_calls";
        case "content_filter":
            return "content_filter";
        case null:
        case undefined:
        case "":
            return undefined;
        default:
            return "stop";
    }
}
export class OpenAiChatStreamParser {
    finished = false;
    push(chunk) {
        const events = [];
        if (chunk.error != null) {
            const message = typeof chunk.error === "string" ? chunk.error : chunk.error.message ?? "upstream error";
            const code = typeof chunk.error === "string" ? undefined : chunk.error.code?.toString();
            events.push({
                type: "error",
                message,
                code
            });
            return events;
        }
        const usage = parseUsage(chunk.usage);
        const choice = chunk.choices?.[0];
        const delta = choice?.delta ?? choice?.message;
        if (delta) {
            const reasoning = delta.reasoning_content ?? delta.reasoning;
            if (reasoning) events.push({
                type: "reasoning",
                delta: reasoning
            });
            if (delta.content) events.push({
                type: "text",
                delta: delta.content
            });
            if (delta.tool_calls) {
                for (const tc of delta.tool_calls){
                    events.push({
                        type: "tool_call",
                        index: tc.index ?? 0,
                        id: tc.id || undefined,
                        name: tc.function?.name || undefined,
                        argumentsDelta: tc.function?.arguments ?? ""
                    });
                }
            }
        }
        if (usage) events.push({
            type: "usage",
            usage
        });
        const finish = mapFinishReason(choice?.finish_reason);
        if (finish && !this.finished) {
            this.finished = true;
            events.push({
                type: "finish",
                reason: finish
            });
        }
        return events;
    }
    flush(reason = "stop") {
        if (this.finished) return [];
        this.finished = true;
        return [
            {
                type: "finish",
                reason
            }
        ];
    }
}

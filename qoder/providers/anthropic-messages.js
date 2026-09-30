import { additionalOptions } from "./request-options.js";
import { messagesUsage, mergeUsage } from "../llm/usage.js";
import { ResponseAssembler, ToolCallAccumulator, normalizeEffort, resolveFinishReason } from "../llm/index.js";
import { createId, deriveConversationId, sseEvent } from "./shared.js";
function decodeSystem(system) {
    if (!system) return undefined;
    if (typeof system === "string") return system;
    return system.map((b)=>b.text).filter(Boolean).join("\n\n");
}
function decodeEffort(req) {
    const explicit = normalizeEffort(req.output_config?.effort);
    if (explicit) return explicit;
    return req.thinking?.type === "disabled" ? "none" : undefined;
}
export function decodeMessagesRequest(req) {
    const messages = [];
    for (const m of req.messages){
        if (typeof m.content === "string") {
            messages.push({
                role: m.role,
                content: m.content
            });
            continue;
        }
        const parts = [];
        const toolCalls = [];
        let reasoning;
        const thinkingBlocks = [];
        for (const block of m.content){
            switch(block.type){
                case "text":
                    if (block.text) parts.push({
                        type: "text",
                        text: block.text
                    });
                    break;
                case "thinking":
                    thinkingBlocks.push({ text: block.thinking || "", signature: block.signature });
                    if (block.thinking) reasoning = (reasoning ?? "") + block.thinking;
                    break;
                case "image":
                    if (block.source?.url) parts.push({
                        type: "image",
                        url: block.source.url
                    });
                    else if (block.source?.data) parts.push({
                        type: "image",
                        url: `data:${block.source.media_type ?? "image/png"};base64,${block.source.data}`
                    });
                    break;
                case "tool_use":
                    toolCalls.push({
                        id: block.id ?? createId("toolu"),
                        name: block.name ?? "",
                        arguments: JSON.stringify(block.input ?? {})
                    });
                    break;
                case "tool_result":
                    {
                        const text = typeof block.content === "string" ? block.content : (block.content ?? []).map((c)=>c.type === "text" ? c.text ?? "" : JSON.stringify(c)).join("\n");
                        messages.push({
                            role: "tool",
                            content: text,
                            toolCallId: block.tool_use_id
                        });
                        break;
                    }
            }
        }
        if (m.role === "assistant") {
            const msg = {
                role: "assistant",
                content: parts.length ? parts : ""
            };
            if (toolCalls.length) msg.toolCalls = toolCalls;
            if (reasoning) msg.reasoning = reasoning;
            if (thinkingBlocks.length) msg.thinkingBlocks = thinkingBlocks;
            if (parts.length || toolCalls.length || reasoning) messages.push(msg);
        } else if (parts.length) {
            messages.push({
                role: "user",
                content: parts
            });
        }
    }
    const tools = req.tools?.map((t)=>({
            name: t.name,
            description: t.description,
            parameters: t.input_schema ?? {
                type: "object",
                properties: {}
            }
        }));
    const system = decodeSystem(req.system);
    return {
        model: req.model,
        system,
        messages,
        tools,
        options: {
            ...additionalOptions(req, "messages"),
            maxTokens: req.max_tokens,
            reasoningEffort: decodeEffort(req)
        },
        stream: req.stream ?? false,
        conversationId: deriveConversationId(system, messages)
    };
}
function stopReason(reason) {
    switch(reason){
        case "length":
            return "max_tokens";
        case "tool_calls":
            return "tool_use";
        default:
            return "end_turn";
    }
}
export async function* renderMessagesStream(events, model) {
    const id = createId("msg");
    yield sseEvent("message_start", {
        type: "message_start",
        message: {
            id,
            type: "message",
            role: "assistant",
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: {}
        }
    });
    let blockIndex = -1;
    let openKind = null;
    const tools = new ToolCallAccumulator();
    let finish;
    let usage;
    function* close() {
        if (openKind !== null) {
            yield sseEvent("content_block_stop", {
                type: "content_block_stop",
                index: blockIndex
            });
            openKind = null;
        }
    }
    function* openText(kind) {
        blockIndex++;
        openKind = kind;
        const contentBlock = kind === "text" ? {
            type: "text",
            text: ""
        } : {
            type: "thinking",
            thinking: ""
        };
        yield sseEvent("content_block_start", {
            type: "content_block_start",
            index: blockIndex,
            content_block: contentBlock
        });
    }
    for await (const e of events){
        if (e.type === "text") {
            if (openKind !== "text") {
                yield* close();
                yield* openText("text");
            }
            yield sseEvent("content_block_delta", {
                type: "content_block_delta",
                index: blockIndex,
                delta: {
                    type: "text_delta",
                    text: e.delta
                }
            });
        } else if (e.type === "reasoning") {
            if (openKind !== "thinking") {
                yield* close();
                yield* openText("thinking");
            }
            yield sseEvent("content_block_delta", {
                type: "content_block_delta",
                index: blockIndex,
                delta: {
                    type: "thinking_delta",
                    thinking: e.delta
                }
            });
        } else if (e.type === "reasoning_signature") {
            if (openKind === "thinking") {
                yield sseEvent("content_block_delta", { type: "content_block_delta", index: blockIndex, delta: { type: "signature_delta", signature: e.signature } });
                yield* close();
            }
        } else if (e.type === "tool_call") {
            tools.add(e.index, e.id, e.name, e.argumentsDelta);
        } else if (e.type === "usage") {
            usage = mergeUsage(usage, e.usage);
        } else if (e.type === "finish") {
            finish ??= e.reason;
        } else if (e.type === "error") {
            yield* close();
            yield sseEvent("error", {
                type: "error",
                error: {
                    type: "api_error",
                    message: e.message
                }
            });
            return;
        }
    }
    yield* close();
    const toolCalls = tools.build();
    for (const tc of toolCalls){
        blockIndex++;
        yield sseEvent("content_block_start", {
            type: "content_block_start",
            index: blockIndex,
            content_block: {
                type: "tool_use",
                id: tc.id,
                name: tc.name,
                input: {}
            }
        });
        if (tc.arguments) {
            yield sseEvent("content_block_delta", {
                type: "content_block_delta",
                index: blockIndex,
                delta: {
                    type: "input_json_delta",
                    partial_json: tc.arguments
                }
            });
        }
        yield sseEvent("content_block_stop", {
            type: "content_block_stop",
            index: blockIndex
        });
    }
    yield sseEvent("message_delta", {
        type: "message_delta",
        delta: {
            stop_reason: stopReason(resolveFinishReason(finish, toolCalls.length > 0)),
            stop_sequence: null
        },
        usage: messagesUsage(usage)
    });
    yield sseEvent("message_stop", {
        type: "message_stop"
    });
}
export async function renderMessagesResponse(events, model) {
    const asm = new ResponseAssembler(model);
    for await (const e of events)asm.push(e);
    const res = asm.build();
    const content = [];
    for (const block of res.thinkingBlocks || []) content.push({
        type: "thinking", thinking: block.text, ...(block.signature ? { signature: block.signature } : {})
    });
    if (res.content) content.push({
        type: "text",
        text: res.content
    });
    for (const tc of res.toolCalls){
        let input = {};
        try {
            input = tc.arguments ? JSON.parse(tc.arguments) : {};
        } catch  {
            input = {};
        }
        content.push({
            type: "tool_use",
            id: tc.id,
            name: tc.name,
            input
        });
    }
    return {
        id: createId("msg"),
        type: "message",
        role: "assistant",
        model,
        content,
        stop_reason: stopReason(res.finishReason),
        stop_sequence: null,
        usage: messagesUsage(res.usage)
    };
}

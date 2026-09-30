import { additionalOptions } from "./request-options.js";
import { chatUsage, mergeUsage } from "../llm/usage.js";
import { ResponseAssembler, normalizeEffort, resolveFinishReason } from "../llm/index.js";
import { createId, created, deriveConversationId, sseData } from "./shared.js";
function decodeContent(content) {
    if (content === null || content === undefined) return "";
    if (typeof content === "string") return content;
    const parts = [];
    for (const p of content){
        if (p.type === "text" && typeof p.text === "string") {
            parts.push({
                type: "text",
                text: p.text
            });
        } else if (p.type === "image_url") {
            const url = typeof p.image_url === "string" ? p.image_url : p.image_url?.url;
            if (url) parts.push({
                type: "image",
                url
            });
        }
    }
    return parts;
}
export function decodeChatRequest(req) {
    const systemTexts = [];
    const messages = [];
    for (const m of req.messages){
        if (m.role === "system" || m.role === "developer") {
            const c = decodeContent(m.content);
            systemTexts.push(typeof c === "string" ? c : c.map((p)=>p.type === "text" ? p.text : "").join("\n"));
            continue;
        }
        const message = {
            role: m.role,
            content: decodeContent(m.content)
        };
        if (m.role === "assistant" && m.tool_calls?.length) {
            message.toolCalls = m.tool_calls.map((tc)=>({
                    id: tc.id,
                    name: tc.function.name,
                    arguments: tc.function.arguments
                }));
        }
        if (m.reasoning_content) message.reasoning = m.reasoning_content;
        if (m.role === "tool") {
            if (m.tool_call_id) message.toolCallId = m.tool_call_id;
            if (m.name) message.name = m.name;
        }
        messages.push(message);
    }
    const tools = req.tools?.filter((t)=>t.type === "function").map((t)=>({
            name: t.function.name,
            description: t.function.description,
            parameters: t.function.parameters ?? {
                type: "object",
                properties: {}
            }
        }));
    const system = systemTexts.filter(Boolean).join("\n\n") || undefined;
    return {
        model: req.model,
        system,
        messages,
        tools,
        options: {
            ...additionalOptions(req, "chat"),
            maxTokens: req.max_completion_tokens ?? req.max_tokens,
            reasoningEffort: normalizeEffort(req.reasoning_effort),
            contextLength: req.context_length
        },
        stream: req.stream ?? false,
        conversationId: req.user ?? deriveConversationId(system, messages)
    };
}
function finishToOpenAi(reason) {
    return reason === "error" ? "stop" : reason;
}
export async function* renderChatStream(events, model) {
    let usage;
    const id = createId("chatcmpl");
    const ts = created();
    const base = {
        id,
        object: "chat.completion.chunk",
        created: ts,
        model
    };
    yield sseData({
        ...base,
        choices: [
            {
                index: 0,
                delta: {
                    role: "assistant"
                },
                finish_reason: null
            }
        ]
    });
    let reported;
    let sawToolCall = false;
    for await (const e of events){
        switch(e.type){
            case "text":
                yield sseData({
                    ...base,
                    choices: [
                        {
                            index: 0,
                            delta: {
                                content: e.delta
                            },
                            finish_reason: null
                        }
                    ]
                });
                break;
            case "reasoning":
                yield sseData({
                    ...base,
                    choices: [
                        {
                            index: 0,
                            delta: {
                                reasoning_content: e.delta
                            },
                            finish_reason: null
                        }
                    ]
                });
                break;
            case "tool_call":
                sawToolCall = true;
                yield sseData({
                    ...base,
                    choices: [
                        {
                            index: 0,
                            delta: {
                                tool_calls: [
                                    {
                                        index: e.index,
                                        ...e.id ? {
                                            id: e.id
                                        } : {},
                                        type: "function",
                                        function: {
                                            ...e.name ? {
                                                name: e.name
                                            } : {},
                                            arguments: e.argumentsDelta
                                        }
                                    }
                                ]
                            },
                            finish_reason: null
                        }
                    ]
                });
                break;
            case "usage":
                usage = mergeUsage(usage, e.usage);
                yield sseData({
                    ...base,
                    choices: [],
                    usage: chatUsage(usage)
                });
                break;
            case "finish":
                reported ??= e.reason;
                break;
            case "error":
                yield sseData({
                    error: {
                        message: e.message,
                        code: e.code,
                        type: "upstream_error"
                    }
                });
                yield "data: [DONE]\n\n";
                return;
        }
    }
    const finishReason = finishToOpenAi(resolveFinishReason(reported, sawToolCall));
    yield sseData({
        ...base,
        choices: [
            {
                index: 0,
                delta: {},
                finish_reason: finishReason
            }
        ]
    });
    yield "data: [DONE]\n\n";
}
export async function renderChatResponse(events, model) {
    const asm = new ResponseAssembler(model);
    for await (const e of events)asm.push(e);
    const res = asm.build();
    const message = {
        role: "assistant",
        content: res.content || null
    };
    if (res.reasoning) message.reasoning_content = res.reasoning;
    if (res.toolCalls.length) {
        message.tool_calls = res.toolCalls.map((tc)=>({
                id: tc.id,
                type: "function",
                function: {
                    name: tc.name,
                    arguments: tc.arguments
                }
            }));
    }
    return {
        id: createId("chatcmpl"),
        object: "chat.completion",
        created: created(),
        model,
        choices: [
            {
                index: 0,
                message,
                finish_reason: finishToOpenAi(res.finishReason)
            }
        ],
        usage: chatUsage(res.usage)
    };
}

import { uuid } from "../shared/utils.js";
import "../shared/llm/index.js";
export const INFERENCE_PATH = "/algo/api/v2/service/pro/sse/agent_chat_generation";
export const INFERENCE_QUERY = "FetchKeys=llm_model_result&AgentId=agent_common&Encode=1";
const DEFAULT_MAX_TOKENS = 32768;
const QWENWORK_DEFAULT_MAX_TOKENS = 128000;
const QWENWORK_DEFAULT_CONTEXT_LENGTH = 1_000_000;
const QWENWORK_DEFAULT_EFFORT = "high";
const IMAGE_OMITTED_TEXT = "(image omitted: model does not support images)";
const NO_RESULT_TEXT = "No result provided";
function contentToNative(content) {
    if (typeof content === "string") return content;
    return content.map((part)=>part.type === "text" ? {
            type: "text",
            text: part.text
        } : {
            type: "image_url",
            image_url: {
                url: part.url
            }
        });
}
function reasoningItem(reasoning) {
    return {
        type: "reasoning",
        summary: [
            {
                type: "summary_text",
                text: reasoning
            }
        ]
    };
}
export function compileMessages(messages) {
    return messages.map((m)=>{
        const out = {
            role: m.role,
            content: contentToNative(m.content)
        };
        if (m.role === "assistant" && m.toolCalls?.length) {
            out.tool_calls = m.toolCalls.map((tc)=>({
                    id: tc.id,
                    type: "function",
                    function: {
                        name: tc.name,
                        arguments: tc.arguments
                    }
                }));
        }
        if (m.role === "tool") {
            if (m.toolCallId) out.tool_call_id = m.toolCallId;
            if (m.name) out.name = m.name;
        }
        if (m.reasoning) {
            out.reasoning_content = m.reasoning;
            out.reasoning_item = reasoningItem(m.reasoning);
        }
        return out;
    });
}
function compileTools(tools) {
    if (!tools?.length) return undefined;
    return tools.map((t)=>({
            type: "function",
            function: {
                name: t.name,
                description: t.description ?? "",
                parameters: t.parameters ?? {
                    type: "object",
                    properties: {}
                }
            }
        }));
}
function messageText(content) {
    if (typeof content === "string") return content;
    return content.filter((p)=>p.type === "text").map((p)=>p.text).join("\n");
}
function latestUserText(messages) {
    for(let i = messages.length - 1; i >= 0; i--){
        const m = messages[i];
        if (m.role !== "user") continue;
        return messageText(m.content);
    }
    return "";
}
function currentTurnText(req) {
    const user = latestUserText(req.messages);
    if (user) return user;
    for(let i = req.messages.length - 1; i >= 0; i--){
        const t = messageText(req.messages[i].content);
        if (t) return t;
    }
    return req.system ?? "";
}
function compileParameters(req) {
    const params = {
        max_tokens: req.options.maxTokens ?? DEFAULT_MAX_TOKENS
    };
    if (typeof req.options.contextLength === "number") {
        params.context_length = req.options.contextLength;
    }
    if (req.options.reasoningEffort) {
        params.reasoning_effort = req.options.reasoningEffort;
    }
    return params;
}
export function compileNativeBody(req, ctx) {
    if (ctx.profile?.envelope === "qwenwork") {
        return compileQwenWorkBody(req, ctx);
    }
    return compileQoderBody(req, ctx);
}
function compileQoderBody(req, ctx) {
    const { model, session } = ctx;
    const text = currentTurnText(req);
    const tools = compileTools(req.tools);
    const nativeMessages = compileMessages(req.messages);
    const hasUserTurn = req.messages.some((m)=>m.role === "user");
    if (!hasUserTurn && text) {
        nativeMessages.push({
            role: "user",
            content: text
        });
    }
    const body = {
        session_id: session.sessionId,
        request_id: uuid(),
        request_set_id: session.requestSetId,
        chat_record_id: uuid(),
        stream: true,
        chat_task: "FREE_INPUT",
        chat_context: {
            chatPrompt: "",
            text,
            extra: {
                context: [],
                modelConfig: {
                    is_reasoning: model.isReasoning,
                    key: model.id
                },
                originalContent: text
            },
            features: [],
            imageUrls: null
        },
        is_reply: true,
        is_retry: false,
        source: 1,
        version: "3",
        session_type: "qodercli",
        parameters: compileParameters(req),
        aliyun_user_type: "",
        messages: nativeMessages,
        agent_id: "agent_common",
        task_id: "common",
        model_config: {
            key: model.id,
            display_name: model.displayName,
            model: "",
            format: "openai",
            is_vl: model.isVL,
            is_reasoning: model.isReasoning,
            api_key: "",
            url: "",
            source: model.source ?? "system",
            max_input_tokens: model.maxInputTokens ?? 0
        },
        business: {
            product: "cli",
            version: ctx.clientVersion,
            type: "agent",
            id: session.businessId,
            name: ctx.taskName ?? "chat",
            begin_at: ctx.beginAt ?? Date.now(),
            stage: session.stage,
            ...ctx.fast ? {
                feature_switches: {
                    highspeed: "true"
                }
            } : {}
        }
    };
    if (req.system) body.system = req.system;
    if (tools) body.tools = tools;
    if (ctx.interrupt) body.interrupt = true;
    return body;
}
function compileQwenWorkParameters(req, model, hasTools) {
    const params = {
        max_tokens: req.options.maxTokens ?? model.maxOutputTokens ?? QWENWORK_DEFAULT_MAX_TOKENS,
        reasoning_effort: req.options.reasoningEffort ?? model.defaultEffort ?? QWENWORK_DEFAULT_EFFORT,
        context_length: req.options.contextLength ?? QWENWORK_DEFAULT_CONTEXT_LENGTH
    };
    if (hasTools) params.tool_choice = "auto";
    return params;
}
function toQwenWorkMessage(m) {
    const out = {
        role: m.role,
        content: contentToNative(m.content)
    };
    if (m.role === "assistant" && m.toolCalls?.length) {
        out.tool_calls = m.toolCalls.map((tc)=>({
                id: tc.id,
                type: "function",
                function: {
                    name: tc.name,
                    arguments: tc.arguments
                }
            }));
    }
    if (m.role === "tool") {
        if (m.toolCallId) out.tool_call_id = m.toolCallId;
        if (m.name) out.name = m.name;
    }
    if (m.reasoning) out.reasoning_content = m.reasoning;
    return out;
}
function withUserContentsDualWrite(messages) {
    return messages.map((m)=>{
        if (m.role === "user" && typeof m.content === "string" && m.contents === undefined) {
            return {
                ...m,
                contents: [
                    {
                        type: "text",
                        text: m.content
                    }
                ]
            };
        }
        return m;
    });
}
function compileQwenWorkBody(req, ctx) {
    const { model, session } = ctx;
    const sessionId = session.sessionId;
    const rawMessages = req.system ? [
        {
            role: "system",
            content: req.system
        },
        ...req.messages
    ] : req.messages;
    const cleaned = cleanMessages(rawMessages, model.isVL);
    const messages = withUserContentsDualWrite(cleaned.map(toQwenWorkMessage));
    const tools = compileTools(req.tools);
    const toolList = tools ?? [];
    const body = {
        request_id: uuid(),
        request_set_id: session.requestSetId,
        chat_record_id: sessionId,
        session_id: sessionId,
        stream: true,
        chat_task: "FREE_INPUT",
        chat_context: {
            chatPrompt: false,
            text: "",
            extra: {},
            features: [],
            imageUrls: []
        },
        is_reply: true,
        is_retry: false,
        source: 1,
        version: "3",
        agent_id: "agent_common",
        task_id: "common",
        session_type: "qoder_work",
        aliyun_user_type: "",
        model_config: {
            key: model.id,
            name: model.id,
            display_name: model.displayName,
            format: "openai",
            source: "system",
            api_key: "",
            url: "",
            is_vl: model.isVL,
            is_reasoning: model.isReasoning,
            max_output_tokens: model.maxOutputTokens ?? QWENWORK_DEFAULT_MAX_TOKENS
        },
        custom_model: null,
        system: "",
        messages,
        tools: toolList,
        parameters: compileQwenWorkParameters(req, model, toolList.length > 0),
        business: {
            version: "1",
            feature_switches: {}
        }
    };
    return body;
}
function hasTextContent(content) {
    if (typeof content === "string") return content.trim() !== "";
    return content.length > 0;
}
function isValidJsonOrEmpty(args) {
    const trimmed = args.trim();
    if (trimmed === "") return true;
    try {
        JSON.parse(trimmed);
        return true;
    } catch  {
        return false;
    }
}
function sanitizeMessageContent(content, supportsImages) {
    if (typeof content === "string") return content;
    const cleaned = [];
    let lastWasOmittedImage = false;
    for (const part of content){
        if (part.type === "image" && !supportsImages) {
            if (!lastWasOmittedImage) {
                cleaned.push({
                    type: "text",
                    text: IMAGE_OMITTED_TEXT
                });
                lastWasOmittedImage = true;
            }
            continue;
        }
        lastWasOmittedImage = false;
        cleaned.push(part);
    }
    return cleaned;
}
export function cleanMessages(rawMessages, supportsImages) {
    const cleaned = [];
    const droppedToolCallIds = new Set();
    for (const raw of rawMessages){
        let msg = raw;
        if (msg.role === "assistant") {
            const stopReason = msg.stop_reason;
            if (stopReason === "error" || stopReason === "aborted") {
                for (const tc of msg.toolCalls ?? [])if (tc.id) droppedToolCallIds.add(tc.id);
                continue;
            }
            const validToolCalls = (msg.toolCalls ?? []).filter((tc)=>{
                if (isValidJsonOrEmpty(tc.arguments)) return true;
                if (tc.id) droppedToolCallIds.add(tc.id);
                return false;
            });
            msg = {
                ...msg,
                toolCalls: validToolCalls.length > 0 ? validToolCalls : undefined
            };
            if (!hasTextContent(msg.content) && (msg.reasoning ?? "").trim() === "" && !msg.toolCalls) {
                continue;
            }
        }
        if (msg.role === "tool" && msg.toolCallId && droppedToolCallIds.has(msg.toolCallId)) {
            continue;
        }
        cleaned.push({
            ...msg,
            content: sanitizeMessageContent(msg.content, supportsImages)
        });
    }
    const finalMessages = [];
    for(let i = 0; i < cleaned.length; i += 1){
        const msg = cleaned[i];
        finalMessages.push(msg);
        if (msg.role === "assistant" && msg.toolCalls?.length) {
            for (const tc of msg.toolCalls){
                let hasToolResult = false;
                for(let j = i + 1; j < cleaned.length; j += 1){
                    const next = cleaned[j];
                    if (next.role === "tool" && next.toolCallId === tc.id) {
                        hasToolResult = true;
                        break;
                    }
                    if (next.role === "user") break;
                }
                if (!hasToolResult) {
                    finalMessages.push({
                        role: "tool",
                        toolCallId: tc.id,
                        content: NO_RESULT_TEXT
                    });
                }
            }
        }
    }
    return finalMessages;
}

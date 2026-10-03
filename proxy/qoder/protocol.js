import {uuid} from '../shared/utils.js';

export const INFERENCE_PATH = "/algo/api/v2/service/pro/sse/agent_chat_generation";
export const INFERENCE_QUERY = "FetchKeys=llm_model_result&AgentId=agent_common&Encode=1";
const DEFAULT_MAX_TOKENS = 32768;
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

const SESSION_TTL_MS = 30 * 60 * 1000;
function isToolContinuation(req) {
    const last = req.messages[req.messages.length - 1];
    return last?.role === "tool";
}
export class SessionStore {
    ttlMs;
    entries = new Map();
    constructor(ttlMs = SESSION_TTL_MS){
        this.ttlMs = ttlMs;
    }
    derive(req, now = Date.now(), namespace = "") {
        const sessionId = req.conversationId ?? "";
        const storeKey = sessionId === "" ? "" : `${namespace}${sessionId}`;
        const existing = this.entries.get(storeKey);
        const expired = existing !== undefined && now - existing.lastActivity > this.ttlMs;
        if (isToolContinuation(req) && existing !== undefined && !expired) {
            existing.stage = "processing";
            existing.lastActivity = now;
            return {
                sessionId,
                ...this.snapshot(existing)
            };
        }
        const fresh = {
            requestSetId: uuid(),
            businessId: uuid(),
            stage: "start",
            lastActivity: now
        };
        if (storeKey !== "") this.entries.set(storeKey, fresh);
        return {
            sessionId,
            ...this.snapshot(fresh)
        };
    }
    snapshot(e) {
        return {
            requestSetId: e.requestSetId,
            businessId: e.businessId,
            stage: e.stage
        };
    }
    sweep(now = Date.now()) {
        for (const [k, v] of this.entries){
            if (now - v.lastActivity > this.ttlMs) this.entries.delete(k);
        }
    }
}

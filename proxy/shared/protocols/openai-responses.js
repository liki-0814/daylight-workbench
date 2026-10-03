import { additionalOptions } from "./request-options.js";
import { responsesUsage, mergeUsage } from "../llm/usage.js";
import { ResponseAssembler, ToolCallAccumulator, normalizeEffort, normalizeInstructions } from "../llm/index.js";
import { createId, created, deriveConversationId, sseEvent } from "./shared.js";
function decodeParts(content) {
    if (content === undefined) return "";
    if (typeof content === "string") return content;
    const parts = [];
    for (const p of content){
        if ((p.type === "input_text" || p.type === "output_text" || p.type === "text") && p.text) {
            parts.push({
                type: "text",
                text: p.text
            });
        } else if (p.type === "input_image") {
            const url = typeof p.image_url === "string" ? p.image_url : p.image_url?.url;
            if (url) parts.push({
                type: "image",
                url
            });
        }
    }
    return parts;
}
export function decodeResponsesRequest(req) {
    const messages = [];
    if (typeof req.input === "string") {
        messages.push({
            role: "user",
            content: req.input
        });
    } else {
        for (const item of req.input){
            if (item.type === "reasoning") {
                continue;
            }
            if (item.type === "function_call_output") {
                messages.push({
                    role: "tool",
                    content: item.output ?? "",
                    toolCallId: item.call_id
                });
            } else if (item.type === "function_call") {
                // Responses emits one item per call; message protocols require
                // the whole parallel batch before any of its tool results.
                let turn = messages.at(-1);
                if (turn?.role !== "assistant" || !turn.toolCalls?.length) {
                    turn = { role: "assistant", content: "", toolCalls: [] };
                    messages.push(turn);
                }
                turn.toolCalls.push({
                    id: item.call_id ?? createId("call"),
                    name: item.name ?? "",
                    arguments: item.arguments ?? "{}"
                });
            } else {
                const role = item.role ?? "user";
                messages.push({
                    role,
                    content: decodeParts(item.content)
                });
            }
        }
    }
    const tools = req.tools?.filter((t)=>t.type === "function" && t.name).map((t)=>({
            name: t.name,
            description: t.description,
            parameters: t.parameters ?? {
                type: "object",
                properties: {}
            }
        }));
    const { system, messages: history } = normalizeInstructions(messages, req.instructions);
    return {
        model: req.model,
        system,
        messages: history,
        tools,
        options: {
            ...additionalOptions(req, "responses"),
            maxTokens: req.max_output_tokens,
            reasoningEffort: normalizeEffort(req.reasoning?.effort)
        },
        stream: req.stream ?? false,
        conversationId: deriveConversationId(system, history)
    };
}
function statusFromFinish(reason) {
    return reason === "length" ? "incomplete" : "completed";
}
function buildResponseObject(id, model, res, ids) {
    const output = [];
    if (res.reasoning) {
        output.push({
            type: "reasoning",
            id: ids?.reasoningId ?? createId("rs_daylight"),
            summary: [
                {
                    type: "summary_text",
                    text: res.reasoning
                }
            ]
        });
    }
    if (res.content) {
        output.push({
            type: "message",
            id: ids?.messageId ?? createId("msg"),
            role: "assistant",
            status: "completed",
            content: [
                {
                    type: "output_text",
                    text: res.content,
                    annotations: []
                }
            ]
        });
    }
    res.toolCalls.forEach((tc, i)=>{
        output.push({
            type: "function_call",
            id: ids?.functionCallIds?.[i] ?? createId("fc"),
            call_id: tc.id,
            name: tc.name,
            arguments: tc.arguments,
            status: "completed"
        });
    });
    return {
        id,
        object: "response",
        created_at: created(),
        model,
        status: statusFromFinish(res.finishReason),
        output,
        usage: responsesUsage(res.usage)
    };
}
export async function renderResponsesResponse(events, model) {
    const asm = new ResponseAssembler(model);
    for await (const e of events)asm.push(e);
    const res = asm.build();
    return buildResponseObject(createId("resp"), model, res);
}
export async function* renderResponsesStream(events, model) {
    const responseId = createId("resp");
    const asm = new ResponseAssembler(model);
    let seq = 0;
    const next = ()=>seq++;
    const ev = (o)=>sseEvent(o.type, o);
    const skeleton = {
        id: responseId,
        object: "response",
        created_at: created(),
        model,
        status: "in_progress",
        output: []
    };
    yield ev({
        type: "response.created",
        sequence_number: next(),
        response: skeleton
    });
    yield ev({
        type: "response.in_progress",
        sequence_number: next(),
        response: skeleton
    });
    let outputIndex = 0;
    const tools = new ToolCallAccumulator();
    let reasoningItemId = null;
    let reasoningIndex = -1;
    let reasoningText = "";
    let reasoningClosed = false;
    let textItemId = null;
    let textIndex = -1;
    const closeReasoning = function*() {
        if (reasoningItemId === null || reasoningClosed) return;
        yield ev({
            type: "response.reasoning_summary_text.done",
            sequence_number: next(),
            item_id: reasoningItemId,
            output_index: reasoningIndex,
            summary_index: 0,
            text: reasoningText
        });
        yield ev({
            type: "response.reasoning_summary_part.done",
            sequence_number: next(),
            item_id: reasoningItemId,
            output_index: reasoningIndex,
            summary_index: 0,
            part: {
                type: "summary_text",
                text: reasoningText
            }
        });
        yield ev({
            type: "response.output_item.done",
            sequence_number: next(),
            output_index: reasoningIndex,
            item: {
                type: "reasoning",
                id: reasoningItemId,
                summary: [
                    {
                        type: "summary_text",
                        text: reasoningText
                    }
                ]
            }
        });
        reasoningClosed = true;
    };
    for await (const e of events){
        asm.push(e);
        if (e.type === "reasoning") {
            if (e.delta === "" || reasoningClosed) continue;
            if (reasoningItemId === null) {
                reasoningItemId = createId("rs_daylight");
                reasoningIndex = outputIndex++;
                yield ev({
                    type: "response.output_item.added",
                    sequence_number: next(),
                    output_index: reasoningIndex,
                    item: {
                        type: "reasoning",
                        id: reasoningItemId,
                        summary: []
                    }
                });
                yield ev({
                    type: "response.reasoning_summary_part.added",
                    sequence_number: next(),
                    item_id: reasoningItemId,
                    output_index: reasoningIndex,
                    summary_index: 0,
                    part: {
                        type: "summary_text",
                        text: ""
                    }
                });
            }
            reasoningText += e.delta;
            yield ev({
                type: "response.reasoning_summary_text.delta",
                sequence_number: next(),
                item_id: reasoningItemId,
                output_index: reasoningIndex,
                summary_index: 0,
                delta: e.delta
            });
        } else if (e.type === "text") {
            if (e.delta === "") continue;
            yield* closeReasoning();
            if (textItemId === null) {
                textItemId = createId("msg");
                textIndex = outputIndex++;
                yield ev({
                    type: "response.output_item.added",
                    sequence_number: next(),
                    output_index: textIndex,
                    item: {
                        type: "message",
                        id: textItemId,
                        role: "assistant",
                        status: "in_progress",
                        content: []
                    }
                });
                yield ev({
                    type: "response.content_part.added",
                    sequence_number: next(),
                    item_id: textItemId,
                    output_index: textIndex,
                    content_index: 0,
                    part: {
                        type: "output_text",
                        text: "",
                        annotations: []
                    }
                });
            }
            yield ev({
                type: "response.output_text.delta",
                sequence_number: next(),
                item_id: textItemId,
                output_index: textIndex,
                content_index: 0,
                delta: e.delta
            });
        } else if (e.type === "tool_call") {
            tools.add(e.index, e.id, e.name, e.argumentsDelta);
        } else if (e.type === "error") {
            yield ev({
                type: "response.failed",
                sequence_number: next(),
                response: {
                    ...skeleton,
                    status: "failed",
                    error: {
                        message: e.message
                    }
                }
            });
            return;
        }
    }
    yield* closeReasoning();
    const res = asm.build();
    if (textItemId !== null) {
        yield ev({
            type: "response.output_text.done",
            sequence_number: next(),
            item_id: textItemId,
            output_index: textIndex,
            content_index: 0,
            text: res.content
        });
        yield ev({
            type: "response.content_part.done",
            sequence_number: next(),
            item_id: textItemId,
            output_index: textIndex,
            content_index: 0,
            part: {
                type: "output_text",
                text: res.content,
                annotations: []
            }
        });
        yield ev({
            type: "response.output_item.done",
            sequence_number: next(),
            output_index: textIndex,
            item: {
                type: "message",
                id: textItemId,
                role: "assistant",
                status: "completed",
                content: [
                    {
                        type: "output_text",
                        text: res.content,
                        annotations: []
                    }
                ]
            }
        });
    }
    const functionCallIds = [];
    for (const tc of tools.build()){
        const index = outputIndex++;
        const itemId = createId("fc");
        functionCallIds.push(itemId);
        yield ev({
            type: "response.output_item.added",
            sequence_number: next(),
            output_index: index,
            item: {
                type: "function_call",
                id: itemId,
                call_id: tc.id,
                name: tc.name,
                arguments: "",
                status: "in_progress"
            }
        });
        if (tc.arguments) {
            yield ev({
                type: "response.function_call_arguments.delta",
                sequence_number: next(),
                item_id: itemId,
                output_index: index,
                delta: tc.arguments
            });
        }
        yield ev({
            type: "response.function_call_arguments.done",
            sequence_number: next(),
            item_id: itemId,
            output_index: index,
            name: tc.name,
            arguments: tc.arguments
        });
        yield ev({
            type: "response.output_item.done",
            sequence_number: next(),
            output_index: index,
            item: {
                type: "function_call",
                id: itemId,
                call_id: tc.id,
                name: tc.name,
                arguments: tc.arguments,
                status: "completed"
            }
        });
    }
    const finalResponse = buildResponseObject(responseId, model, res, {
        reasoningId: reasoningItemId ?? undefined,
        messageId: textItemId ?? undefined,
        functionCallIds
    });
    yield ev({
        type: "response.completed",
        sequence_number: next(),
        response: finalResponse
    });
}

import { mergeUsage } from "./usage.js";
import { LLMError, resolveFinishReason } from "./canonical.js";
export class ToolCallAccumulator {
    calls = [];
    currentByIndex = new Map();
    add(index, id, name, argsDelta) {
        let pos = this.currentByIndex.get(index);
        const existing = pos !== undefined ? this.calls[pos] : undefined;
        const restart = existing !== undefined && (id !== undefined && existing.id !== undefined && id !== existing.id || name !== undefined && existing.name !== undefined && name !== existing.name);
        if (existing === undefined || restart) {
            pos = this.calls.push({
                id,
                name,
                args: ""
            }) - 1;
            this.currentByIndex.set(index, pos);
        }
        const slot = this.calls[this.currentByIndex.get(index)];
        if (id !== undefined) slot.id = id;
        if (name !== undefined) slot.name = name;
        slot.args += argsDelta;
    }
    build() {
        return this.calls.filter((s)=>s.name !== undefined).map((s, i)=>({
                id: s.id ?? `call_${i}`,
                name: s.name,
                arguments: s.args
            }));
    }
    get size() {
        return this.calls.length;
    }
}
export class ResponseAssembler {
    model;
    text = "";
    reasoning = "";
    thinkingBlocks = [];
    currentThought;
    tools = new ToolCallAccumulator();
    usage;
    finishReason;
    errored;
    constructor(model){
        this.model = model;
    }
    push(event) {
        switch(event.type){
            case "text":
                this.currentThought = undefined;
                this.text += event.delta;
                break;
            case "reasoning":
                this.reasoning += event.delta;
                if (!this.currentThought) { this.currentThought = { text: '' }; this.thinkingBlocks.push(this.currentThought); }
                this.currentThought.text += event.delta;
                break;
            case "reasoning_signature":
                if (this.currentThought) { this.currentThought.signature = (this.currentThought.signature || '') + event.signature; this.currentThought = undefined; }
                break;
            case "tool_call":
                this.currentThought = undefined;
                this.tools.add(event.index, event.id, event.name, event.argumentsDelta);
                break;
            case "usage":
                this.usage = mergeUsage(this.usage, event.usage);
                break;
            case "finish":
                this.finishReason ??= event.reason;
                break;
            case "error":
                this.errored = {
                    message: event.message,
                    code: event.code
                };
                break;
        }
    }
    build() {
        if (this.errored) throw new LLMError(this.errored.message, this.errored.code);
        const toolCalls = this.tools.build();
        return {
            model: this.model,
            content: this.text,
            reasoning: this.reasoning || undefined,
            thinkingBlocks: this.thinkingBlocks,
            toolCalls,
            finishReason: resolveFinishReason(this.finishReason, toolCalls.length > 0),
            usage: this.usage
        };
    }
}
export function assembleResponse(events, opts) {
    const asm = new ResponseAssembler(opts.model);
    for (const e of events)asm.push(e);
    return asm.build();
}

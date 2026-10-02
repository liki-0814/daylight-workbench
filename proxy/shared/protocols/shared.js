import { uuid } from "../utils.js";
export function createId(prefix) {
    return `${prefix}-${uuid().replace(/-/g, "")}`;
}
export function created() {
    return Math.floor(Date.now() / 1000);
}
export function sseData(obj) {
    return `data: ${JSON.stringify(obj)}\n\n`;
}
export function sseEvent(event, obj) {
    return `event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`;
}
function djb2(text) {
    let h = 5381;
    for(let i = 0; i < text.length; i++)h = (h << 5) + h + text.charCodeAt(i) | 0;
    return (h >>> 0).toString(16);
}
function messageText(m) {
    if (typeof m.content === "string") return m.content;
    return m.content.map((p)=>p.type === "text" ? p.text : `[img]`).join("");
}
export function deriveConversationId(system, messages) {
    const firstUser = messages.find((m)=>m.role === "user");
    const seed = `${system ?? ""}\u0000${firstUser ? messageText(firstUser) : ""}`;
    return `conv_${djb2(seed)}`;
}

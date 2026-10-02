import { createHash } from "node:crypto";
import { uuid } from "../shared/utils.js";
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
function deriveUUID(seed) {
    const digest = createHash("sha256").update(seed, "utf8").digest();
    const raw = Buffer.from(digest.subarray(0, 16));
    raw[6] = raw[6] & 0x0f | 0x40;
    raw[8] = raw[8] & 0x3f | 0x80;
    const hex = raw.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function contentJson(content) {
    return JSON.stringify(content);
}
export function deriveDeterministic(accountId, req) {
    const parts = [
        accountId
    ];
    for (const m of req.messages){
        if (m.role === "system") parts.push(contentJson(m.content));
    }
    if (req.system) parts.push(JSON.stringify(req.system));
    const firstUser = req.messages.find((m)=>m.role === "user");
    if (firstUser) parts.push(contentJson(firstUser.content));
    const id = deriveUUID(`qwenworkcn-session\x00${parts.join("")}`);
    return {
        sessionId: id,
        requestSetId: id,
        businessId: id,
        stage: "start"
    };
}

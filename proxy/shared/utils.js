export function uuid() {
    return crypto.randomUUID();
}
export function randomHex(bytes) {
    const buf = new Uint8Array(bytes);
    crypto.getRandomValues(buf);
    let out = "";
    for (const b of buf)out += b.toString(16).padStart(2, "0");
    return out;
}
export function nowSeconds() {
    return Math.floor(Date.now() / 1000);
}
export function nowMillis() {
    return Date.now();
}
export function redact(secret, keep = 4) {
    if (!secret) return "<none>";
    if (secret.length <= keep) return "*".repeat(secret.length);
    return secret.slice(0, keep) + "…" + "*".repeat(Math.min(6, secret.length - keep));
}
export function isRecord(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}
export function tryParseJson(text) {
    try {
        return JSON.parse(text);
    } catch  {
        return undefined;
    }
}
export function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
}
export function asFiniteNumber(v) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "") {
        const n = Number(v.trim());
        if (Number.isFinite(n)) return n;
    }
    return undefined;
}

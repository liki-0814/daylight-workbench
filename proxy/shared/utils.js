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
export function tryParseJson(text) {
    try {
        return JSON.parse(text);
    } catch  {
        return undefined;
    }
}

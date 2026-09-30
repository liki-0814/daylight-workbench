const STD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const QODER_ALPHABET = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
const STD_PAD = "=";
const QODER_PAD = "$";
const ENCODE_MAP = (()=>{
    const m = {};
    for(let i = 0; i < STD_ALPHABET.length; i++){
        m[STD_ALPHABET[i]] = QODER_ALPHABET[i];
    }
    m[STD_PAD] = QODER_PAD;
    return m;
})();
const DECODE_MAP = (()=>{
    const m = {};
    for(let i = 0; i < QODER_ALPHABET.length; i++){
        m[QODER_ALPHABET[i]] = STD_ALPHABET[i];
    }
    m[QODER_PAD] = STD_PAD;
    return m;
})();
function swapOuterThirds(s) {
    const len = s.length;
    const edge = Math.floor(len / 3);
    if (edge === 0) return s;
    return s.slice(len - edge) + s.slice(edge, len - edge) + s.slice(0, edge);
}
function remap(s, table) {
    let out = "";
    for(let i = 0; i < s.length; i++){
        const ch = s[i];
        const mapped = table[ch];
        if (mapped === undefined) {
            throw new EncodeError(`unmappable character at index ${i}: ${JSON.stringify(ch)}`);
        }
        out += mapped;
    }
    return out;
}
export class EncodeError extends Error {
    name = "EncodeError";
}
export function encodeBodyText(jsonText) {
    const b64 = Buffer.from(jsonText, "utf8").toString("base64");
    const mapped = remap(b64, ENCODE_MAP);
    return swapOuterThirds(mapped);
}
export function encodeBody(body) {
    return encodeBodyText(JSON.stringify(body));
}
export function decodeBodyText(encoded) {
    const unswapped = swapOuterThirds(encoded);
    const std = remap(unswapped, DECODE_MAP);
    return Buffer.from(std, "base64").toString("utf8");
}
export function decodeBody(encoded) {
    return JSON.parse(decodeBodyText(encoded));
}
export const __internal = {
    swapOuterThirds,
    STD_ALPHABET,
    QODER_ALPHABET,
    QODER_PAD
};

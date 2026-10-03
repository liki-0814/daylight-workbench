export function supportsEffort(model, effort) {
    return model.reasoningEfforts.includes(effort);
}
export function effortRejection(model, effort) {
    if (supportsEffort(model, effort)) return undefined;
    const available = model.reasoningEfforts.join(", ") || "none declared";
    return `model ${model.id} does not support reasoning effort "${effort}" (available: ${available})`;
}
export function contextWindowRejection(model, length) {
    if (model.contextWindows.some((w)=>w.length === length)) return undefined;
    const available = model.contextWindows.map((w)=>w.length).join(", ") || "none declared";
    return `model ${model.id} has no ${length} token context window (available: ${available})`;
}
export function defaultContextLength(model) {
    return model.contextWindows.find((w)=>w.isDefault)?.length;
}

export function parseModelRef(ref) {
    const trimmed = ref.trim();
    const match = /^(.*)\[([^\]]+)\]$/.exec(trimmed);
    const id = match?.[1]?.trim();
    if (!match || !id) return {
        id: trimmed
    };
    const raw = match[2].trim().toLowerCase();
    const scaled = /^(\d+(?:\.\d+)?)([km])?$/.exec(raw);
    if (!scaled) return {
        id,
        invalidWindow: raw
    };
    const unit = scaled[2];
    const magnitude = unit === "m" ? 1_000_000 : unit === "k" ? 1_000 : 1;
    const window = Number(scaled[1]) * magnitude;
    if (!Number.isSafeInteger(window) || window <= 0) return {
        id,
        invalidWindow: raw
    };
    return {
        id,
        window
    };
}

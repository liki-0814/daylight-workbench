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

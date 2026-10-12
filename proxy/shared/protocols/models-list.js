export function renderModel(model, createdAt = 0) {
    return {
        id: model.id,
        object: "model",
        created: createdAt,
        owned_by: model.provider || "qoder",
        display_name: model.displayName,
        source: model.source,
        capabilities: {
            ...model.capabilities,
            vision: model.isVL,
            reasoning: model.isReasoning,
            reasoning_efforts: model.reasoningEfforts,
            default_effort: model.defaultEffort,
            effort: model.effort,
            fast_available: model.supportsFast,
            fast: model.fast
        },
        context_windows: model.contextWindows.map((w)=>({
                length: w.length,
                is_default: w.isDefault
            })),
        context_window: model.contextWindow,
        max_input_tokens: model.maxInputTokens,
        max_output_tokens: model.maxOutputTokens,
        cost: model.cost,
        price_info: model.priceInfo,
        metadata: model.modelMetadata?{reference_id:model.modelMetadata.matchedId,data_version:model.modelMetadata.version,updated_at:model.modelMetadata.updatedAt}:undefined
    };
}
export function renderModelList(models) {
    return {
        object: "list",
        data: models.filter((m)=>m.enabled).map((m)=>renderModel(m))
    };
}

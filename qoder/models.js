import { REASONING_EFFORTS, normalizeEffort } from "./llm/index.js";
function firstDefined(...vals) {
    for (const v of vals)if (v !== undefined && v !== null) return v;
    return undefined;
}
function parseEfforts(raw) {
    const tc = raw.thinking_config;
    if (!tc) return {
        efforts: []
    };
    const found = new Set();
    if (tc.disabled) found.add("none");
    let defaultEffort;
    for (const [name, meta] of Object.entries(tc.enabled?.efforts ?? {})){
        const eff = normalizeEffort(name);
        if (!eff) continue;
        found.add(eff);
        if (meta?.is_default) defaultEffort = eff;
    }
    return {
        efforts: REASONING_EFFORTS.filter((e)=>found.has(e)),
        defaultEffort
    };
}
function parseContexts(raw) {
    const cfg = raw.context_config ?? raw.contextConfig;
    if (!cfg) return [];
    const entries = Array.isArray(cfg) ? cfg : Object.values(cfg);
    const windows = [];
    for (const c of entries){
        const length = firstDefined(c.token_count, c.length, c.context_length, c.contextLength, c.window);
        if (typeof length !== "number") continue;
        windows.push({
            length,
            isDefault: Boolean(firstDefined(c.is_default, c.isDefault, c.default))
        });
    }
    return windows.sort((a, b)=>a.length - b.length);
}
function parseSupportsFast(raw) {
    const fs = raw.feature_switches ?? raw.featureSwitches;
    if (!fs) return false;
    const hs = fs["highspeed"];
    return hs === true || hs === "true" || hs === "Fast";
}
function parsePromotion(raw) {
    const promo = raw.promotion;
    if (!promo || typeof promo !== "object") return {};
    const badge = promo.badge;
    const text = typeof badge?.zh === "string" && badge.zh || typeof badge?.en === "string" && badge.en || undefined;
    if (!text) return {};
    return {
        promotion: {
            badge: text,
            active: promo.active === true
        }
    };
}
export function parseModel(raw) {
    const enable = firstDefined(raw.enable, raw.enabled);
    if (enable === false) return undefined;
    const format = raw.format;
    if (format !== undefined && format !== "openai") return undefined;
    const id = firstDefined(raw.key, raw.model);
    if (!id) return undefined;
    const isReasoning = Boolean(firstDefined(raw.is_reasoning, raw.isReasoning));
    const { efforts, defaultEffort } = parseEfforts(raw);
    const contextWindows = parseContexts(raw);
    const declaredMax = firstDefined(raw.max_input_tokens, raw.maxInputTokens);
    const maxInputTokens = declaredMax && declaredMax > 0 ? declaredMax : contextWindows.length ? Math.max(...contextWindows.map((w)=>w.length)) : undefined;
    return {
        id,
        displayName: firstDefined(raw.display_name, raw.displayName, raw.name) ?? id,
        source: raw.source,
        isVL: Boolean(firstDefined(raw.is_vl, raw.isVl)),
        isReasoning,
        reasoningEfforts: efforts,
        defaultEffort,
        contextWindows,
        maxInputTokens,
        maxOutputTokens: firstDefined(raw.max_output_tokens, raw.maxOutputTokens),
        supportsFast: parseSupportsFast(raw),
        fast: false,
        isFree: raw.is_free,
        priceFactor: firstDefined(raw.price_factor, raw.priceFactor),
        ...parsePromotion(raw),
        enabled: true
    };
}
function extractPayload(body, scene = "assistant") {
    const b = body;
    if (!b) return {};
    const candidates = [
        b,
        b.data,
        b.payload,
        b.result
    ].filter((x)=>typeof x === "object" && x !== null);
    for (const c of candidates){
        if (Array.isArray(c[scene]) || scene === "assistant" && Array.isArray(c.chat)) {
            return {
                assistant: c[scene],
                chat: scene === "assistant" ? c.chat : undefined,
                byok_enterprise: c.byok_enterprise
            };
        }
    }
    return {};
}
export function parseModelList(body, scene = "assistant") {
    const payload = extractPayload(body, scene);
    const primary = (payload.assistant?.length ? payload.assistant : payload.chat) ?? [];
    const out = [];
    const seen = new Set();
    for (const raw of [
        ...primary,
        ...payload.byok_enterprise ?? []
    ]){
        // Team-provided models can also appear in the primary scene; keep organization models.
        if (raw.source === "byokTeams") continue;
        const model = parseModel(raw);
        if (!model || model.displayName.includes("专属") || seen.has(model.id)) continue;
        seen.add(model.id);
        out.push(model);
    }
    return out;
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
export async function fetchModels(http, session) {
    if (session.profile.catalog === "static") {
        return session.profile.staticModels ?? [];
    }
    const base = session.profile.hosts.inference;
    const url = new URL("/algo/api/v2/model/list", base).toString();
    const res = await http.signedGet(url, session);
    if (!res.ok) throw new Error(`model/list failed: ${res.status} ${await res.text()}`);
    const body = await res.json();
    return parseModelList(body, session.profile.catalogScene ?? "assistant");
}

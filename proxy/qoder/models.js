import {applyCapacitySettings} from '../shared/model-settings.js';
import {REASONING_EFFORTS, normalizeEffort, contextWindowRejection, effortRejection} from '../shared/llm/index.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

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

export async function fetchModels(http, session) {
    const url = http.algoUrl("/algo/api/v2/model/list");
    const res = await http.signedGet(url, session);
    if (!res.ok) throw new Error(`model/list failed: ${res.status} ${await res.text()}`);
    const body = await res.json();
    return parseModelList(body);
}

export const DEFAULT_QUEUE_RETRY = {
    enabled: true,
    maxRetries: 2,
    delayMs: 3_000
};
export const QUEUE_RETRY_BOUNDS = {
    maxRetries: {
        min: 1,
        max: 5
    },
    delayMs: {
        min: 100,
        max: 30_000
    }
};
export const QUEUE_RETRY_MAX_DELAY_MS = 30_000;
export function resolveQueueRetry(settings) {
    return {
        ...DEFAULT_QUEUE_RETRY,
        ...settings.queueRetry
    };
}
export function queueRetryRejection(policy) {
    for (const field of [
        "maxRetries",
        "delayMs"
    ]){
        const { min, max } = QUEUE_RETRY_BOUNDS[field];
        const value = policy[field];
        if (!Number.isInteger(value) || value < min || value > max) {
            return `queue retry ${field} ${value} is out of range — expected an integer between ${min} and ${max}`;
        }
    }
    return undefined;
}
export function queueRetryDelay(failedAttempt, policy) {
    return Math.min(policy.delayMs * 2 ** (failedAttempt - 1), QUEUE_RETRY_MAX_DELAY_MS);
}
function empty() {
    return {
        disabled: [],
        context: {},
        fast: {},
        effort: {}
    };
}
function settingsPath(accountFile) {
    return path.join(path.dirname(accountFile), "settings.json");
}
export async function loadSettings(accountFile) {
    try {
        const text = await fs.readFile(settingsPath(accountFile), "utf8");
        const parsed = JSON.parse(text);
        return {
            disabled: parsed.disabled ?? [],
            context: parsed.context ?? {},
            fast: parsed.fast ?? {},
            effort: parsed.effort ?? {},
            capacities: parsed.capacities ?? {},
            ...parsed.queueRetry ? {
                queueRetry: parsed.queueRetry
            } : {}
        };
    } catch (error) {
        if (error.code !== "ENOENT") throw new Error("模型设置无法读取，原文件已保留");
        return empty();
    }
}
export async function saveSettings(accountFile, settings) {
    const file = settingsPath(accountFile);
    await fs.mkdir(path.dirname(file), {
        recursive: true
    });
    const staging = `${file}.${process.pid}.tmp`;
    await fs.writeFile(staging, JSON.stringify(settings, null, 2), {
        mode: 0o600
    });
    await fs.rename(staging, file);
}
export function applySettings(models, settings) {
    const disabled = new Set(settings.disabled);
    return applyCapacitySettings(models,settings).map((m)=>{
        const overrideCtx = settings.context[m.id];
        const contextWindows = overrideCtx !== undefined ? m.contextWindows.map((w)=>({
                ...w,
                isDefault: w.length === overrideCtx
            })) : m.contextWindows;
        return {
            ...m,
            enabled: !disabled.has(m.id),
            fast: settings.fast[m.id] ?? false,
            effort: settings.effort[m.id] ?? m.effort,
            contextWindows
        };
    });
}
export const EFFORT_AUTO = "auto";
export function applyModelsCommand(sub, args, settings, catalog) {
    const next = {
        capacities: {...settings.capacities},
        disabled: [
            ...settings.disabled
        ],
        context: {
            ...settings.context
        },
        fast: {
            ...settings.fast
        },
        effort: {
            ...settings.effort
        },
        ...settings.queueRetry ? {
            queueRetry: {
                ...settings.queueRetry
            }
        } : {}
    };
    const requireModel = (id)=>{
        if (!id) throw new Error(`usage: models ${sub} <model-id> …`);
        const model = catalog.find((m)=>m.id === id);
        if (!model) throw new Error(`unknown model: ${id}`);
        return model;
    };
    switch(sub){
        case "enable":
        case "disable":
            {
                const { id } = requireModel(args[0]);
                next.disabled = next.disabled.filter((d)=>d !== id);
                if (sub === "disable") next.disabled.push(id);
                return {
                    settings: next,
                    message: `${sub}d ${id}`
                };
            }
        case "context":
            {
                const model = requireModel(args[0]);
                const length = Number(args[1]);
                if (!Number.isFinite(length)) {
                    throw new Error("usage: models context <model-id> <length>");
                }
                const rejection = contextWindowRejection(model, length);
                if (rejection) throw new Error(rejection);
                next.context[model.id] = length;
                return {
                    settings: next,
                    message: `context window for ${model.id} = ${length}`
                };
            }
        case "fast":
            {
                const onoff = args[1];
                if (onoff !== "on" && onoff !== "off") {
                    throw new Error("usage: models fast <model-id> on|off");
                }
                const { id } = requireModel(args[0]);
                next.fast[id] = onoff === "on";
                return {
                    settings: next,
                    message: `fast for ${id} = ${onoff}`
                };
            }
        case "effort":
            {
                const level = args[1];
                if (!args[0] || !level) {
                    throw new Error(`usage: models effort <model-id> <${REASONING_EFFORTS.join("|")}|${EFFORT_AUTO}>`);
                }
                if (level.toLowerCase() === EFFORT_AUTO) {
                    const { id } = requireModel(args[0]);
                    delete next.effort[id];
                    return {
                        settings: next,
                        message: `effort for ${id} cleared — the model's own default applies`
                    };
                }
                const effort = normalizeEffort(level);
                if (!effort) {
                    throw new Error(`unknown effort "${level}" (expected ${REASONING_EFFORTS.join(", ")} or ${EFFORT_AUTO})`);
                }
                const model = requireModel(args[0]);
                const rejection = effortRejection(model, effort);
                if (rejection) throw new Error(rejection);
                next.effort[model.id] = effort;
                return {
                    settings: next,
                    message: `effort for ${model.id} = ${effort}`
                };
            }
        case "queue-retry":
            {
                const field = args[0];
                const next2 = {
                    ...next.queueRetry ?? {}
                };
                if (field === "on" || field === "off") {
                    next2.enabled = field === "on";
                    next.queueRetry = next2;
                    return {
                        settings: next,
                        message: `queue retry ${field === "on" ? "enabled" : "disabled"}`
                    };
                }
                const key = field === "max" ? "maxRetries" : field === "delay" ? "delayMs" : undefined;
                const value = Number(args[1]);
                if (key === undefined || !Number.isInteger(value)) {
                    throw new Error("usage: models queue-retry on|off | max <1-5> | delay <100-30000>");
                }
                const candidate = {
                    ...DEFAULT_QUEUE_RETRY,
                    ...next2,
                    [key]: value
                };
                const rejection = queueRetryRejection(candidate);
                if (rejection) throw new Error(rejection);
                next2[key] = value;
                next.queueRetry = next2;
                return {
                    settings: next,
                    message: `queue retry ${key} = ${value}`
                };
            }
        default:
            throw new Error(`unknown subcommand: models ${sub}`);
    }
}

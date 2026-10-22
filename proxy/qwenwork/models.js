import {positiveCapacity, booleanCapability, reasoningCapabilities} from '../../core/model-capabilities.js';

const HARNESS = {oc: 'opencode', qc: 'qwencode', cc: 'qoder-cli', qo: 'qoder-cli', opencode: 'opencode', qwencode: 'qwencode', 'qoder-cli': 'qoder-cli'};
const HARNESS_PROTOCOLS = {
  'qoder-cli': ['openai', 'anthropic'],
  opencode: ['openai', 'openai_responses', 'anthropic'],
  qwencode: ['openai'],
};
const API_NAME = {
  openai: 'openai', 'openai/chat-completions': 'openai',
  openai_responses: 'openai_responses', 'openai/responses': 'openai_responses',
  anthropic: 'anthropic', 'anthropic/messages': 'anthropic',
};
const PROTOCOL = {openai: 'chat', openai_responses: 'responses', anthropic: 'messages'};

const text = value => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const positive = value => positiveCapacity(typeof value === 'string' ? Number(value) : value);

function resolveHarness(value) {
  if (value === null) return 'qoder-cli';
  const code = text(value);
  return code && HARNESS[code] || 'opencode';
}

function contextWindowOf(raw, limits = {}) {
  const declared = positive(limits.contextWindow ?? limits.context_window);
  if (declared) return declared;
  const config = raw.context_config || raw.contextConfig;
  if (config && typeof config === 'object') {
    for (const tier of Object.values(config)) {
      if (tier && typeof tier === 'object' && (tier.is_default === true || tier.isDefault === true)) {
        const count = positive(tier.token_count ?? tier.tokenCount);
        if (count) return count;
      }
    }
  }
  return positive(raw.default_context_window ?? raw.max_input_tokens ?? raw.maxInputTokens);
}

function displayName(raw, key) {
  const localized = raw.i18n?.display_name || raw.i18n?.displayName;
  if (localized && typeof localized === 'object') return text(localized.zh) || text(localized.en) || key;
  return text(raw.display_name) || text(raw.displayName) || text(raw.name) || key;
}

function reasoningOf(raw) {
  const thinking = raw.thinking_config || raw.thinkingConfig;
  const declared = thinking?.efforts || thinking?.supported_efforts || thinking?.levels || raw.reasoning_efforts || raw.reasoningEfforts;
  const supported = booleanCapability(raw.is_reasoning ?? raw.isReasoning ?? thinking?.enabled);
  return reasoningCapabilities(supported, Array.isArray(declared) ? declared : undefined);
}

function declaredRoutes(raw) {
  const routes = raw.execution?.routes;
  return routes && typeof routes === 'object' && !Array.isArray(routes) ? routes : undefined;
}

function routeFromExecution(raw) {
  const routes = declaredRoutes(raw);
  if (!routes) return undefined;
  const preferred = resolveHarness(raw.execution.preferredHarness || raw.execution.preferred_harness || raw.harness);
  const enabled = Object.entries(routes).flatMap(([name, route]) => {
    if (!route || typeof route !== 'object' || route.enabled === false) return [];
    const harness = HARNESS[name];
    const apiName = API_NAME[text(route.apiProtocol || route.api_protocol || route.protocol) || ''];
    const modelId = text(route.modelId || route.model_id || route.model);
    if (!harness || !apiName || !modelId || !HARNESS_PROTOCOLS[harness].includes(apiName)) return [];
    return [{harness, apiName, modelId, limits: route.limits || {}}];
  });
  return enabled.find(route => route.harness === preferred) || enabled[0];
}

export function adaptMode(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const key = text(raw.key);
  if (!key || raw.enable === false || raw.enabled === false) return undefined;
  const declared = declaredRoutes(raw);
  const selected = declared ? routeFromExecution(raw) : undefined;
  // A catalog that names its routes is authoritative. Disabled or unsupported
  // routes are omitted instead of being replaced by the mode key.
  if (declared && !selected) return undefined;
  const harness = selected?.harness || resolveHarness(raw.harness);
  const apiName = selected?.apiName || (harness === 'qoder-cli' ? 'openai' : API_NAME[text(raw.format) || ''] || 'openai');
  if (!HARNESS_PROTOCOLS[harness].includes(apiName)) return undefined;
  const modelId = selected?.modelId || text(raw.model_id) || text(raw.modelId) || key;
  const limits = selected?.limits || {};
  const protocol = PROTOCOL[apiName];
  const vision = booleanCapability(raw.is_vl ?? raw.isVl ?? raw.vision);
  return {
    id: key,
    upstreamId: modelId,
    displayName: displayName(raw, key),
    provider: 'qwenwork',
    source: 'qwenwork',
    enabled: true,
    nativeProtocols: [protocol],
    pi: protocol === 'messages' ? {} : {'anthropic-messages': '此千问办公模型未提供原生 Messages，Pi 的 thinking 预算与缓存字段需使用 Responses 或 Chat Completions'},
    contextWindow: contextWindowOf(raw, limits),
    maxOutputTokens: positive(limits.maxOutputTokens ?? limits.max_output_tokens ?? raw.max_output_tokens ?? raw.maxOutputTokens),
    contextWindows: [],
    ...reasoningOf(raw),
    isVL: vision,
    capabilities: {nativeChat: protocol === 'chat', ...(booleanCapability(raw.tools ?? raw.tool_call ?? raw.supports_tools) !== undefined ? {tools: booleanCapability(raw.tools ?? raw.tool_call ?? raw.supports_tools)} : {})},
  };
}

export function adaptChatModes(payload, scene = 'qwork') {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw Object.assign(new Error('千问办公模型目录格式无效'), {status: 502});
  const scenes = payload.scenes && typeof payload.scenes === 'object' ? payload.scenes : undefined;
  const primary = Array.isArray(payload.catalog) ? payload.catalog : Array.isArray(scenes?.[scene]) ? scenes[scene] : undefined;
  if (!primary) throw Object.assign(new Error('千问办公模型目录缺少 catalog'), {status: 502});
  const extra = scene === 'qwork' && Array.isArray(scenes?.byok_enterprise) ? scenes.byok_enterprise : [];
  const models = [];
  const seen = new Set();
  for (const raw of [...primary, ...extra]) {
    const model = adaptMode(raw);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  return models;
}

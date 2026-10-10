import {booleanCapability,reasoningCapabilities} from '../../core/model-capabilities.js';
// Grok Responses catalog capabilities; hidden/non-Responses models stay excluded.
export function parseModels(data){
        if (!Array.isArray(data.data)) throw new Error('invalid model catalog');
        return data.data.filter(m => m.api_backend === 'responses' && !m.hidden).map(m => ({
          id: m.id, provider: 'grok', source: 'grok', displayName: m.name || m.id, enabled: true,
          contextWindows: [], contextWindow: m.context_window, maxOutputTokens: m.max_completion_tokens ?? undefined,
          isVL: booleanCapability(m.supports_image_in),
          ...reasoningCapabilities(m.supports_reasoning ?? (m.supports_reasoning_effort===true?true:undefined),(m.reasoning_efforts || []).map(e => e.value ?? e.id)), defaultEffort: m.reasoning_effort,
          capabilities: { tools: true, structuredOutput: true, parallelTools: true, nativeResponses: true, nativeSearch: booleanCapability(m.supports_backend_search), vision: booleanCapability(m.supports_image_in), statefulResponses: false, output_limit_excludes_reasoning: true },
        }));
}

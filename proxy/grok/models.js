// Grok Responses catalog capabilities; hidden/non-Responses models stay excluded.
export function parseModels(data){
        if (!Array.isArray(data.data)) throw new Error('invalid model catalog');
        return data.data.filter(m => m.api_backend === 'responses' && !m.hidden).map(m => ({
          id: m.id, provider: 'grok', source: 'grok', displayName: m.name || m.id, enabled: true,
          contextWindows: [], contextWindow: m.context_window, maxOutputTokens: m.max_completion_tokens ?? undefined,
          isVL: true, isReasoning: !!m.supports_reasoning_effort,
          reasoningEfforts: (m.reasoning_efforts || []).map(e => e.value ?? e.id), defaultEffort: m.reasoning_effort,
          capabilities: { tools: true, structuredOutput: true, parallelTools: true, nativeResponses: true, nativeSearch: !!m.supports_backend_search, vision: true, statefulResponses: false, output_limit_excludes_reasoning: true },
        }));
}

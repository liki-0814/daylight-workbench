import {reasoningEfforts} from './protocol.js';

// CLI aliases identify models; upstream catalog supplies capacities and effort routes.
export function parseModels(discovered,catalog){
      let models = discovered.map(({ id, displayName }) => {
        const tiered = id.replace(/-(low|medium|high)$/, '-tiered');
        const upstreamId = tiered !== id && catalog.models?.[tiered] ? tiered : id === 'gemini-3.1-pro-high' && catalog.models?.['gemini-pro-agent'] ? 'gemini-pro-agent' : id;
        const m = catalog.models?.[upstreamId] || catalog.models?.[id] || {};
        const model = { id, provider: 'agy', displayName, enabled: true, source: 'agy', isVL: !!m.supportsImages, isReasoning: !!m.supportsThinking, reasoningEfforts: [], contextWindows: [], maxInputTokens: m.maxTokens, maxOutputTokens: m.maxOutputTokens, quota: m.quotaInfo, thinkingBudget: m.thinkingBudget, upstreamId };
        model.reasoningEfforts = reasoningEfforts(model);
        return model;
      });
      // Merge Gemini presets by base ID, independent of model version.
      const groups = new Map();
      for (const model of models) {
        const match = /^(gemini-.+)-(low|medium|high|xhigh|max)$/.exec(model.id);
        if (!match || !model.isReasoning) continue;
        const group = groups.get(match[1]) || [];
        group.push({ ...model, level: match[2] }); groups.set(match[1], group);
      }
      for (const [id, variants] of groups) {
        if (variants.length < 2) continue;
        const levels = ['low', 'medium', 'high', 'xhigh', 'max'].filter(level => variants.some(m => m.level === level));
        const defaultEffort = levels.includes('medium') ? 'medium' : levels.includes('high') ? 'high' : levels[0];
        const template = variants.find(m => m.level === defaultEffort);
        const variantIds = variants.map(m => m.id);
        const effortRoutes = Object.fromEntries(variants.map(m => [m.level, { upstreamId: m.upstreamId, thinkingBudget: m.thinkingBudget }]));
        const unified = { ...template, id, displayName: template.displayName.replace(/\s*\((?:low|medium|high|xhigh|max)\)\s*$/i, ''), defaultEffort, variantIds, effortRoutes, reasoningEfforts: levels };
        const first = models.findIndex(m => variantIds.includes(m.id));
        models = models.filter(m => !variantIds.includes(m.id)); models.splice(first, 0, unified);
      }
 return models;
}

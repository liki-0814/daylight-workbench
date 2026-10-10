import {booleanCapability,mergeModelCapabilities} from '../../core/model-capabilities.js';
import {reasoningEfforts} from './protocol.js';

// CLI aliases identify models; upstream catalog supplies capacities and effort routes.
export function parseModels(discovered,catalog){
      const preferredIds = new Set((catalog.agentModelSorts || []).flatMap(sort => (sort.groups || []).flatMap(group => group.modelIds || [])));
      const label = value => String(value || '').trim().toLowerCase();
      const aliases = new Map();
      for (const id of preferredIds) {
        const name = label(catalog.models?.[id]?.displayName);
        if (name) aliases.set(name, [...(aliases.get(name) || []), id]);
      }
      let models = discovered.map(({ id, displayName }) => {
        const matches = aliases.get(label(displayName)) || [];
        const upstreamId = !preferredIds.has(id) && matches.length === 1 ? matches[0] : id;
        const tiered = upstreamId.replace(/-(low|medium|high|xhigh|max)$/, '-tiered');
        const catalogId = catalog.models?.[upstreamId] ? upstreamId : catalog.models?.[tiered] ? tiered : upstreamId;
        const m = catalog.models?.[catalogId] || {};
        const model = { id, provider: 'agy', displayName, enabled: true, source: 'agy', isVL: booleanCapability(m.supportsImages), isReasoning: booleanCapability(m.supportsThinking), reasoningEfforts: [], contextWindows: [], maxInputTokens: m.maxTokens, maxOutputTokens: m.maxOutputTokens, quota: m.quotaInfo, thinkingBudget: m.thinkingBudget, catalogId, upstreamId };
        model.reasoningEfforts = reasoningEfforts(model);
        return model;
      });
      // Merge reasoning presets from every AGY family by base ID.
      const groups = new Map();
      for (const model of models) {
        const match = /^(.+)-(low|medium|high|xhigh|max)$/.exec(model.id);
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
        const effortRoutes = Object.fromEntries(variants.map(m => [m.level, { upstreamId: m.upstreamId, catalogId: m.catalogId, thinkingBudget: m.thinkingBudget }]));
        const unified = { ...template, ...mergeModelCapabilities(variants), id, displayName: template.displayName.replace(/\s*\((?:low|medium|high|xhigh|max)\)\s*$/i, ''), defaultEffort, variantIds, effortRoutes, reasoningEfforts: levels };
        const first = models.findIndex(m => variantIds.includes(m.id));
        models = models.filter(m => !variantIds.includes(m.id)); models.splice(first, 0, unified);
      }
 return models;
}

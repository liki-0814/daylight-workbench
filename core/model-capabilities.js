// Pure capability rules shared by provider adapters, routing and UI.
export const positiveCapacity=value=>Number.isSafeInteger(value)&&value>0?value:undefined;
export const booleanCapability=value=>typeof value==='boolean'?value:undefined;
export function reasoningCapabilities(supported,efforts=[],thinkingType){
 const levels=Array.isArray(efforts)?[...new Set(efforts.filter(e=>typeof e==='string'))]:[];
 const isReasoning=booleanCapability(supported)??(thinkingType==='only'||levels.some(e=>!['none','off'].includes(e))?true:undefined);
 return {isReasoning,reasoningEfforts:isReasoning===false?[]:levels};
}
export function capacityLimit(model,field){
 return field==='contextWindow'?positiveCapacity(model.contextLimit)??positiveCapacity(Math.max(0,...(model.contextWindows||[]).map(w=>w.length)))??positiveCapacity(model.contextWindow)??positiveCapacity(model.maxInputTokens):positiveCapacity(model.outputLimit)??positiveCapacity(model.maxOutputTokens);
}
export function mergeModelCapabilities(models){
 const merged={};
 for(const field of ['contextWindow','maxInputTokens','maxOutputTokens','defaultMaxTokens','contextLimit','outputLimit'])merged[field]=models.every(m=>positiveCapacity(m[field]))?Math.min(...models.map(m=>m[field])):undefined;
 for(const field of ['isVL','isReasoning','supportsFast'])merged[field]=models.every(m=>typeof m[field]==='boolean')?models.every(m=>m[field]):undefined;
 merged.reasoningEfforts=models.every(m=>Array.isArray(m.reasoningEfforts))?models[0].reasoningEfforts.filter(e=>models.every(m=>m.reasoningEfforts.includes(e))):undefined;
 return merged;
}

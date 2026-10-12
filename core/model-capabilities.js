// Pure capability rules shared by provider adapters, routing and UI.
export const positiveCapacity=value=>Number.isSafeInteger(value)&&value>0?value:undefined;
export const booleanCapability=value=>typeof value==='boolean'?value:undefined;
export function reasoningCapabilities(supported,efforts,thinkingType){
 const levels=Array.isArray(efforts)?[...new Set(efforts.filter(e=>typeof e==='string'))]:[];
 // Declared levels prove support; otherwise explicit refusal wins over a control/default.
 const isReasoning=levels.some(e=>!['none','off'].includes(e))?true:booleanCapability(supported)??(thinkingType==='only'||thinkingType==='enabled'?true:thinkingType==='disabled'?false:undefined);
 return {isReasoning,reasoningEfforts:isReasoning===false?[]:thinkingType==='only'?levels.filter(e=>!['none','off'].includes(e)):levels,reasoningEffortsProvided:Array.isArray(efforts),...(thinkingType?{thinkingType}:{})};
}
// Upstream -> reference -> manual. Refusal stops fallback; empty levels do not.
export function resolveReasoningCapabilities(...declarations){
 let supported,thinkingType,levels,selected;
 for(const declaration of declarations.filter(Boolean)){
  supported??=booleanCapability(declaration.isReasoning);thinkingType??=declaration.thinkingType;
  if(declaration.isReasoning===false){levels=declaration.reasoningEfforts;selected=declaration;break;}
  if(declaration.reasoningEfforts?.some(level=>!['none','off'].includes(level))){levels=declaration.reasoningEfforts;selected=declaration;break;}
  if(!selected&&Array.isArray(declaration.reasoningEfforts)){levels=declaration.reasoningEfforts;selected=declaration;}
 }
 const off=declarations[0]?.reasoningEfforts?.filter(level=>['none','off'].includes(level))||[];
 const result=reasoningCapabilities(supported,levels?[...off,...levels]:levels,thinkingType);
 result.reasoningEffortsProvided=selected?.reasoningEffortsProvided??Array.isArray(levels);
 const defaultEffort=declarations.find(declaration=>result.reasoningEfforts.includes(declaration?.defaultEffort))?.defaultEffort;
 return {...result,...(result.isReasoning===false?{defaultEffort:null}:defaultEffort?{defaultEffort}:{})};
}
export function reasoningCapabilityLabel(model){
 const levels=model.reasoningEfforts||[];
 if(levels.some(level=>!['none','off'].includes(level)))return levels.join(' · ');
 if(model.isReasoning===true)return '支持思考（强度未提供）'+(levels.some(level=>['none','off'].includes(level))?' · 可关闭思考':'');
 return model.isReasoning===false?'不支持思考':'未提供';
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

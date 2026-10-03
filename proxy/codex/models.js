// Merge public app-server models with local model metadata.
export function parseModels(catalog){
 return catalog.models.filter(m=>!m.hidden).map(m=>{
      const c=catalog.meta.models?.find(x=>x.slug===m.model)||{};
      return {id:m.model,provider:'codex',source:'codex',displayName:m.displayName||m.model,enabled:true,contextWindows:[],contextWindow:c.context_window,maxOutputTokens:c.max_output_tokens,
        isVL:m.inputModalities?.includes('image')||false,isReasoning:true,reasoningEfforts:(m.supportedReasoningEfforts||[]).map(e=>e.reasoningEffort).filter(e=>e!=='ultra'),defaultEffort:m.defaultReasoningEffort,
        serviceTiers:m.serviceTiers||[],capabilities:{nativeResponses:true,service_tiers:m.serviceTiers||[],tools:true}};
    });
}

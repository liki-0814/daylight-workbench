// Shared source identity and presentation. Each page keeps its own ordering.
export const proxySources=Object.freeze([
 {id:'qoder',name:'Qoder',label:'Qoder',kind:'provider',mark:'Q',tone:'codex',piOrder:4},
 {id:'agy',name:'AGY',label:'AGY',kind:'provider',mark:'A',tone:'kimi',piOrder:5},
 {id:'grok',name:'Grok',label:'Grok',kind:'provider',mark:'G',tone:'grok',piOrder:3},
 {id:'codex',name:'Codex',label:'Codex',kind:'provider',mark:'C',tone:'codex',piOrder:0},
 {id:'kimi',name:'Kimi',label:'Kimi',kind:'provider',mark:'K',tone:'kimi',piOrder:2},
 {id:'copilot',name:'GitHub Copilot',label:'Copilot',kind:'provider',mark:'C',tone:'codex',piOrder:1},
 {id:'custom',name:'自定义',label:'自定义',kind:'source',mark:'M',tone:'custom',piOrder:6},
].map(Object.freeze));
export const proxySourceNames=Object.freeze(Object.fromEntries(proxySources.map(({id,name})=>[id,name])));
export const proxySourceTabs=proxySources.map(({id,label:name,kind})=>({id,name,kind}));
export const piSourceTypes=[{id:'all',name:'全部模型',mark:'',tone:''},...[...proxySources].sort((a,b)=>a.piOrder-b.piOrder).map(({id,label:name,mark,tone})=>({id,name,mark,tone}))];

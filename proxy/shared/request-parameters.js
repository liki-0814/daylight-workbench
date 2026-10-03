// Pure request rules shared by providers. Protocols still own wire field names.
const kimiModels=new Set(['kimi-for-coding','kimi-for-coding-highspeed','k3','k3-256k']);
export function omitKimiTemperature(input,model,observe=()=>{}) {
 if(kimiModels.has(model)&&Object.hasOwn(input,'temperature')){
  observe({requestedTemperature:input.temperature,effectiveTemperature:'omitted'});
  delete input.temperature;
 }
}
export function isOfficialKimiUrl(baseUrl){return baseUrl.replace(/\/$/,'')==='https://api.kimi.com/coding/v1';}
export const validOutputBudget=(value,max)=>Number.isInteger(value)&&value>0&&(!max||value<=max);
export const validSampling=(value,max)=>Number.isFinite(value)&&value>=0&&value<=max;
export const validEffort=(value,allowed)=>allowed.includes(value);
export function outputBudget(raw,fallback){return raw.max_output_tokens??raw.max_completion_tokens??raw.max_tokens??fallback;}
export function reasoningEffort(raw,fallback){return raw.reasoning_effort??raw.reasoning?.effort??raw.output_config?.effort??fallback;}
export const conflictingChatBudgets=raw=>raw.max_tokens!==undefined&&raw.max_completion_tokens!==undefined&&raw.max_tokens!==raw.max_completion_tokens;

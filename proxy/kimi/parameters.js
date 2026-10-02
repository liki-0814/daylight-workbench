// These official model IDs were verified with OAuth: omitted temperature succeeds,
// while 0.7 returns "only 1 is allowed". Keep defaults owned by the upstream.
const models=new Set(['kimi-for-coding','kimi-for-coding-highspeed','k3','k3-256k']);
export function omitKimiTemperature(input,model,observe=()=>{}) {
 if(models.has(model)&&Object.hasOwn(input,'temperature')){
  observe({requestedTemperature:input.temperature,effectiveTemperature:'omitted'});
  delete input.temperature;
 }
}
export function isOfficialKimiUrl(baseUrl){return baseUrl.replace(/\/$/,'')==='https://api.kimi.com/coding/v1';}

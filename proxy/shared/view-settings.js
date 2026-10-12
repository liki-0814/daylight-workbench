import {readJson,writeJson,serial} from './store.js';
import {fail} from '../gateway.js';

const validSources=value=>Array.isArray(value)&&value.length<=64&&value.every(id=>typeof id==='string'&&/^[a-z][a-z0-9-]{0,63}$/.test(id))&&new Set(value).size===value.length;
const validVersion=value=>Number.isSafeInteger(value)&&value>=0;

// Display preferences are independent of credentials, enabled sources and runtime settings.
// Remember exclusions so a future source is visible without migrating a whitelist.
export function createViewSettings(file){
 const mutate=serial();
 async function read(){
  const value=await readJson(file,{version:0,hiddenSources:[]});
  if(!validVersion(value?.version)||!validSources(value?.hiddenSources))fail('来源显示配置无效，原文件已保留',502);
  return value;
 }
 function save(input){return mutate(async()=>{
  if(!input||Object.keys(input).some(key=>!['version','hiddenSources'].includes(key))||!validVersion(input.version)||!validSources(input.hiddenSources))fail('来源显示设置格式无效');
  const previous=await read();if(input.version!==previous.version)fail('来源显示设置已在其他窗口更新，请重新读取后保存',409);
  if(previous.version===Number.MAX_SAFE_INTEGER)fail('来源显示配置版本无效，原文件已保留',502);
  const next={version:previous.version+1,hiddenSources:[...input.hiddenSources]};await writeJson(file,next);return next;
 });}
 return{read,save};
}

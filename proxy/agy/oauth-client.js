import {readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// OAuth parameters stay in a private local file, never in source or build assets.
export async function loadOAuthClient(method,{file=process.env.DAYLIGHT_AGY_OAUTH_CLIENTS_FILE||path.join(os.homedir(),'.config/daylight/agy-oauth-clients.json'),readFileImpl=readFile}={}){
 if(!['consumer','gcp'].includes(method))return null;
 try{
  const clients=JSON.parse(await readFileImpl(file,'utf8')),client=clients?.[method];
  if(!client||['client_id','client_secret'].some(key=>typeof client[key]!=='string'||!client[key]||client[key].length>16384||/[\r\n]/.test(client[key])))throw Error();
  return{client_id:client.client_id,client_secret:client.client_secret};
 }catch{throw Object.assign(Error('AGY OAuth 客户端配置缺失或无效；请配置本机 OAuth 参数，原登录已保留。'),{code:'EAGY_OAUTH_CLIENT_CONFIG'});}
}

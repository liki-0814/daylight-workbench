import {readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {discoverOAuthClient,clientCandidates} from './client-discovery.js';

// An explicit configuration wins; otherwise discover the installed public client.
export async function loadOAuthClient(method,{file,readFileImpl=readFile,discoverClientImpl=discoverOAuthClient,env=process.env,home=os.homedir(),autoDiscover=true}={}){
 if(!['consumer','gcp'].includes(method))return null;
 const explicit=!!file||!!env.DAYLIGHT_AGY_OAUTH_CLIENTS_FILE;
 file=file||env.DAYLIGHT_AGY_OAUTH_CLIENTS_FILE||path.join(home,'.config/daylight/agy-oauth-clients.json');
 try{
  const clients=JSON.parse(await readFileImpl(file,'utf8')),client=clients?.[method];
  if(!client||['client_id','client_secret'].some(key=>typeof client[key]!=='string'||!client[key]||client[key].length>16384||/[\r\n]/.test(client[key])))throw Error();
  return{client_id:client.client_id,client_secret:client.client_secret};
 }catch(error){
  if(autoDiscover&&!explicit&&error.code==='ENOENT'){
   const client=await discoverClientImpl(method,{candidates:clientCandidates({env,home})});if(client)return client;
  }
  throw Object.assign(Error(explicit?'AGY OAuth 客户端配置缺失或无效；请检查指定配置文件，原登录已保留。':'未检测到可用的 AGY OAuth 客户端；请安装官方 Antigravity / agy，或配置本机 OAuth 参数，原登录已保留。'),{code:'EAGY_OAUTH_CLIENT_CONFIG'});
 }
}

import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {RPC,executable} from '../../ai/adapters/process.mjs';
import {readJson} from '../shared/store.js';
import {CatalogCache} from '../shared/catalog-cache.js';

export class CodexAuth {
 constructor({home=process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),rpcFactory=()=>new RPC(executable('codex'),['app-server','--listen','stdio://'],os.homedir())}={}){
  Object.assign(this,{home,rpcFactory});this.catalog=new CatalogCache();
 }
 async read(){
  const a=await readJson(path.join(this.home,'auth.json'),null);
  if(a?.auth_mode!=='chatgpt'||!a.tokens?.access_token||!a.tokens?.account_id)throw Object.assign(new Error('请先在本机 Codex 登录 ChatGPT，再刷新登录'),{status:401});
  let exp=0;try{exp=JSON.parse(Buffer.from(a.tokens.access_token.split('.')[1],'base64url')).exp*1000;}catch{}
  this.identity=createHash('sha256').update(a.tokens.account_id).digest('hex');
  return{token:a.tokens.access_token,account:a.tokens.account_id,exp,identity:this.identity};
 }
 async rpc(operation){const rpc=this.rpcFactory();try{await rpc.initialize();await rpc.call('account/read',{refreshToken:true});return await operation(rpc);}finally{rpc.close();}}
 async quota(){await this.read();return this.rpc(rpc=>rpc.call('account/rateLimits/read',{}));}
 async discover(refresh=false){
  const credential=await this.read();
  return this.catalog.get({identity:credential.identity,refresh,valid:credential.exp>Date.now()+60000,load:()=>this.rpc(async rpc=>{
   const models=[];let cursor;
   do{const r=await rpc.call('model/list',{limit:100,...(cursor?{cursor}:{})});models.push(...r.data);cursor=r.nextCursor;}while(cursor);
   const current=await this.read();if(current.identity!==credential.identity)throw Object.assign(new Error('Codex 账号已切换，请重新请求'),{status:401});
   return{credential:current,models,meta:await readJson(path.join(this.home,'models_cache.json'),{models:[]})};
  })});
 }
 close(){this.catalog.invalidate();}
}

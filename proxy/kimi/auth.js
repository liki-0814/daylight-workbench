import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {DeviceOAuthAccount,oauthError} from '../shared/oauth-account.js';
import {readJson,writeJson,serial} from '../shared/store.js';
export const authError=oauthError;
export class KimiAuth extends DeviceOAuthAccount {
 constructor({dataDir,...options}={}){super({id:'kimi',name:'Kimi Code',...options});this.file=path.join(dataDir||path.join(os.homedir(),'Library/Application Support/Daylight'),'kimi-proxy/device.json');this.host=serial();}
 async headers(){return this.host(async()=>{let value=await readJson(this.file,null);if(!value){value={id:randomUUID()};await writeJson(this.file,value);}return{'X-Msh-Platform':'daylight','X-Msh-Version':'0.4.0','X-Msh-Device-Id':value.id,'User-Agent':'Daylight/0.4.0'};});}
 async flow(){return{clientId:'17e5f671-d194-4dfb-9706-5516cb48c098',deviceEndpoint:'https://auth.kimi.com/api/oauth/device_authorization',tokenEndpoint:'https://auth.kimi.com/api/oauth/token',domains:['kimi.com','kimi.ai']};}
 async profile(data,config,signal){const user=await this.request('https://api.kimi.com/coding/v1/me',{token:data.access_token,headers:await this.headers(),signal});if(!user.user_id)throw authError('Kimi 未返回有效账号');return{id:String(user.user_id),login:user.nickname||user.username||user.email||String(user.user_id)};}
 async credential(force=false){const session=await this.getSession(force);return{...session,expires_at:session.expiresAt/1000};}
}

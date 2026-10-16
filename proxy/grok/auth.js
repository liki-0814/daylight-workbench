import {DeviceOAuthAccount,oauthError,trustedURL} from '../shared/oauth-account.js';
import {verifyIdentity} from '../shared/oidc.js';
export const authError=()=>oauthError('请在 Daylight 中网页登录 Grok');
export class GrokAuth extends DeviceOAuthAccount {
 constructor(options={}){super({id:'grok',name:'Grok',...options});}
 async flow(){
  const metadata=await this.request('https://auth.x.ai/.well-known/openid-configuration');
  if(metadata.issuer!=='https://auth.x.ai')throw Error('Grok 返回了无效认证服务');
  return{clientId:'b1a00492-073a-47ea-816f-4c329264a828',scope:'openid profile email offline_access grok-cli:access api:access',domains:['x.ai'],deviceEndpoint:trustedURL(metadata.device_authorization_endpoint,['x.ai']),tokenEndpoint:trustedURL(metadata.token_endpoint,['x.ai']),metadata};
 }
 async profile(data,config,signal){
  const user=config.metadata.userinfo_endpoint?await this.request(trustedURL(config.metadata.userinfo_endpoint,['x.ai']),{token:data.access_token,signal}):await verifyIdentity(data.id_token,{issuer:'https://auth.x.ai',clientId:config.clientId,metadata:config.metadata,fetchImpl:this.fetchImpl,now:this.now()});
  if(!user.sub)throw authError();return{id:user.sub,login:user.email||user.name||user.preferred_username||user.sub};
 }
 async credential(force=false){const s=await this.getSession(force);return{token:s.access_token,expires:s.expiresAt,identity:s.identity,version:'1.0.41'};}
}

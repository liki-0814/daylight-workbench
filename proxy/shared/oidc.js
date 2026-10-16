import {createPublicKey,verify} from 'node:crypto';
import {oauthError,trustedURL} from './oauth-account.js';

// Validate signed identity before replacing an account. Access-token claims stay opaque.
export async function verifyIdentity(token,{issuer,clientId,nonce,subject,fetchImpl=fetch,now=Date.now(),metadata}){
 try{
  const parts=token.split('.');if(parts.length!==3)throw Error();
  const header=JSON.parse(Buffer.from(parts[0],'base64url')),claims=JSON.parse(Buffer.from(parts[1],'base64url'));
  if(!['RS256','ES256'].includes(header.alg)||typeof header.kid!=='string')throw Error();
  const request=async url=>{const r=await fetchImpl(url,{redirect:'error',signal:AbortSignal.timeout(15000)});if(!r.ok){await r.body?.cancel();throw Error();}return r.json();};
  const discovery=metadata||await request(issuer+'/.well-known/openid-configuration');
  if(discovery.issuer!==issuer)throw Error();
  const jwks=await request(trustedURL(discovery.jwks_uri,[new URL(issuer).hostname]));
  const jwk=jwks.keys?.find(k=>k.kid===header.kid&&(!k.alg||k.alg===header.alg)&&(!k.use||k.use==='sig'));if(!jwk)throw Error();
  if(header.alg==='RS256'&&jwk.kty!=='RSA'||header.alg==='ES256'&&(jwk.kty!=='EC'||jwk.crv!=='P-256'))throw Error();
  const key=createPublicKey({key:jwk,format:'jwk'}),options=header.alg==='ES256'?{key,dsaEncoding:'ieee-p1363'}:key;
  if(!verify('sha256',Buffer.from(parts[0]+'.'+parts[1]),options,Buffer.from(parts[2],'base64url')))throw Error();
  const audiences=Array.isArray(claims.aud)?claims.aud:[claims.aud];
  if(claims.iss!==issuer||!audiences.includes(clientId)||!Number.isFinite(claims.exp)||claims.exp*1000<=now||claims.nbf&&claims.nbf*1000>now+30000||typeof claims.sub!=='string'||!claims.sub||nonce!==undefined&&claims.nonce!==nonce||subject!==undefined&&claims.sub!==subject)throw Error();
  if(audiences.length>1&&claims.azp!==clientId)throw Error();
  return claims;
 }catch{throw oauthError('账号身份校验失败，请重新网页登录');}
}

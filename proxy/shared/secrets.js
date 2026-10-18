import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import fs from 'node:fs';
export class Secrets {
 constructor({spawnImpl=spawn,timeoutMs=30000,killGraceMs=500,helperName='DaylightCredentials'}={}){Object.assign(this,{spawnImpl,timeoutMs,killGraceMs,helperName});}
 async run(action,id,value){
  const bundled=fileURLToPath(new URL('../../'+this.helperName,import.meta.url));
  const dev=fileURLToPath(new URL('../../dist/native/Daylight.app/Contents/Resources/'+this.helperName,import.meta.url));
  const helper=fs.existsSync(bundled)?bundled:dev;
  return new Promise((resolve,reject)=>{const p=this.spawnImpl(helper,[],{stdio:['pipe','pipe','pipe']});let out='',error='',timedOut=false,killTimer;
   const timer=setTimeout(()=>{timedOut=true;p.kill('SIGTERM');killTimer=setTimeout(()=>p.kill('SIGKILL'),this.killGraceMs);},this.timeoutMs);
   const cleanup=()=>{clearTimeout(timer);clearTimeout(killTimer);};
   p.on('error',()=>{cleanup();reject(Object.assign(new Error('钥匙串组件不可用，请重新打包 App'),{code:'EKEYCHAIN_UNAVAILABLE'}));});p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>error+=b);p.stdin.on('error',()=>{});
   p.on('close',code=>{cleanup();
    if(timedOut)return reject(Object.assign(new Error('钥匙串操作超时，凭证助手已终止'),{code:'EKEYCHAIN_TIMEOUT'}));
    if(code!==0){const status=/^钥匙串操作失败：(-?\d+)$/.exec(error.trim())?.[1];
     if(status==='-25308'||status==='-25315')return reject(Object.assign(new Error('钥匙串凭证需要系统授权，自动读取已停止（未弹出授权窗口）'),{code:'EKEYCHAIN_INTERACTION_REQUIRED'}));
     if(status==='-25293')return reject(Object.assign(new Error('钥匙串认证失败，静默读取已停止（未弹出授权窗口）；这不代表上游账号已退出。'),{code:'EKEYCHAIN_AUTH_FAILED'}));
     return reject(Object.assign(new Error('钥匙串不可用或访问被拒绝，请检查系统钥匙串授权'),{code:'EKEYCHAIN_UNAVAILABLE'}));
    }
    try{resolve(JSON.parse(out));}catch{reject(new Error('钥匙串返回无效'));}
   });p.stdin.end(JSON.stringify({action,id,...(value!==undefined?{value}:{})}));});
 }
 async get(id){return(await this.run('get',id)).value;}
 set(id,value){return this.run('set',id,value);}
 delete(id){return this.run('delete',id);}
}

import {spawn,execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
const execute=promisify(execFile);
async function verifyHelper(helper,reference){
 try{
  await Promise.all([execute('codesign',['--verify','--strict',helper]),execute('codesign',['--verify','--strict',reference])]);
  const requirement=async file=>{const {stdout,stderr}=await execute('codesign',['-d','-r-',file]);return (stdout+stderr).split('\n').find(line=>line.startsWith('designated =>'));};
  const [actual,expected]=await Promise.all([requirement(helper),requirement(reference)]);
  if(!actual||actual!==expected)throw new Error('designated requirement mismatch');
 }catch(cause){throw Object.assign(new Error('旧版钥匙串组件签名或身份无效'),{code:'EKEYCHAIN_UNAVAILABLE',cause});}
}
export class Secrets {
 constructor({spawnImpl=spawn,timeoutMs=30000,killGraceMs=500,helperName='DaylightCredentials',interactiveTimeoutMs=180000,helperPath=null,currentHelperPath=null,referenceHelperPath=null,verifyHelper:verify=verifyHelper}={}){Object.assign(this,{spawnImpl,timeoutMs,killGraceMs,helperName,interactiveTimeoutMs,helperPath,currentHelperPath,referenceHelperPath,verifyHelper:verify});}
 currentHelper(){
  if(this.currentHelperPath)return this.currentHelperPath;
  const bundled=fileURLToPath(new URL('../../'+this.helperName,import.meta.url));
  const dev=fileURLToPath(new URL('../../dist/native/Daylight.app/Contents/Resources/'+this.helperName,import.meta.url));
  return fs.existsSync(bundled)?bundled:dev;
 }
 previous(dataDir){
  if(!dataDir)return undefined;
  const helperPath=path.join(dataDir,'updates/backup/Daylight.app/Contents/Resources',this.helperName);
  try{const stat=fs.lstatSync(helperPath);if(!stat.isFile()||stat.isSymbolicLink())return undefined;}catch{return undefined;}
  return new Secrets({spawnImpl:this.spawnImpl,timeoutMs:this.timeoutMs,killGraceMs:this.killGraceMs,helperName:this.helperName,interactiveTimeoutMs:this.interactiveTimeoutMs,helperPath,referenceHelperPath:this.currentHelper(),verifyHelper:this.verifyHelper});
 }
 async resolveHelper(){
  const helper=this.helperPath||this.currentHelper();
  if(this.referenceHelperPath){try{await (this.verification||=this.verifyHelper(helper,this.referenceHelperPath));}catch(error){this.verification=null;throw error;}}
  return helper;
 }
 async run(action,id,value,{interactive=false,signal,timeoutMs}={}){
  if(signal?.aborted)throw Object.assign(new Error('凭证操作已取消'),{code:'EKEYCHAIN_CANCELLED'});
  const helper=await this.resolveHelper();
  return new Promise((resolve,reject)=>{const p=this.spawnImpl(helper,[],{stdio:['pipe','pipe','pipe']});let out='',error='',timedOut=false,killTimer;
   const timer=setTimeout(()=>{timedOut=true;p.kill('SIGTERM');killTimer=setTimeout(()=>p.kill('SIGKILL'),this.killGraceMs);},timeoutMs??(interactive?this.interactiveTimeoutMs:this.timeoutMs));
   const abort=()=>{clearTimeout(timer);clearTimeout(killTimer);p.kill('SIGTERM');killTimer=setTimeout(()=>p.kill('SIGKILL'),this.killGraceMs);};
   signal?.addEventListener('abort',abort,{once:true});
   if(signal?.aborted)abort();
   const cleanup=()=>{clearTimeout(timer);clearTimeout(killTimer);signal?.removeEventListener('abort',abort);};
   p.on('error',()=>{cleanup();reject(Object.assign(new Error('钥匙串组件不可用，请重新打包 App'),{code:'EKEYCHAIN_UNAVAILABLE'}));});p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>error+=b);p.stdin.on('error',()=>{});
   p.on('close',code=>{cleanup();
    if(signal?.aborted)return reject(Object.assign(new Error('凭证操作已取消'),{code:'EKEYCHAIN_CANCELLED'}));
    if(timedOut)return reject(Object.assign(new Error('钥匙串操作超时，凭证助手已终止'),{code:'EKEYCHAIN_TIMEOUT'}));
    if(code!==0){const status=/^钥匙串操作失败：(-?\d+)$/.exec(error.trim())?.[1];
     if(status==='-128')return reject(Object.assign(new Error('已取消系统授权，可重新尝试'),{code:'EKEYCHAIN_CANCELLED'}));
     if(status==='-25308'||status==='-25315')return reject(Object.assign(new Error(interactive?'系统未能授权凭证访问，请解锁钥匙串后重试，或重新登录':'钥匙串凭证需要系统授权，自动读取已停止（未弹出授权窗口）'),{code:'EKEYCHAIN_INTERACTION_REQUIRED'}));
     if(status==='-25293')return reject(Object.assign(new Error(interactive?'钥匙串授权未完成，请重试修复访问或重新登录':'钥匙串认证失败，静默读取已停止（未弹出授权窗口）；这不代表上游账号已退出。'),{code:'EKEYCHAIN_AUTH_FAILED'}));
     return reject(Object.assign(new Error('钥匙串不可用或访问被拒绝，请检查系统钥匙串授权'),{code:'EKEYCHAIN_UNAVAILABLE'}));
    }
    try{resolve(JSON.parse(out));}catch{reject(new Error('钥匙串返回无效'));}
   });p.stdin.end(JSON.stringify({action,id,interactive:interactive?'allow':'fail',...(value!==undefined?{value}:{})}));});
 }
 async get(id,options){return(await this.run('get',id,undefined,options)).value;}
 set(id,value,options){return this.run('set',id,value,options);}
 delete(id,options){return this.run('delete',id,undefined,options);}
}

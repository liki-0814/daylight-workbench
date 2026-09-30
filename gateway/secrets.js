import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import fs from 'node:fs';
export class Secrets {
 async run(action,id,value){
  const bundled=fileURLToPath(new URL('../DaylightCredentials',import.meta.url));
  const dev=fileURLToPath(new URL('../dist/native/Daylight.app/Contents/Resources/DaylightCredentials',import.meta.url));
  const helper=fs.existsSync(bundled)?bundled:dev;
  return new Promise((resolve,reject)=>{const p=spawn(helper,[],{stdio:['pipe','pipe','pipe']});let out='';const timer=setTimeout(()=>p.kill(),30000);
   p.on('error',()=>{clearTimeout(timer);reject(new Error('钥匙串组件不可用，请重新打包 App'));});p.stdout.on('data',b=>out+=b);p.stderr.resume();p.stdin.on('error',()=>{});
   p.on('close',code=>{clearTimeout(timer);if(code!==0)reject(new Error('钥匙串不可用或访问被拒绝'));else{try{resolve(JSON.parse(out));}catch{reject(new Error('钥匙串返回无效'));}}});p.stdin.end(JSON.stringify({action,id,...(value!==undefined?{value}:{})}));});
 }
 async get(id){return(await this.run('get',id)).value;}
 set(id,value){return this.run('set',id,value);}
 delete(id){return this.run('delete',id);}
}

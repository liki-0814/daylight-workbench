import {open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

// Fingerprints identify the published installed-app consumer client, never an
// account token. Read its values from an installed official binary; do not ship
// client parameters or guess among other Google clients found in that binary.
// Reference: google-antigravity/antigravity-cli#54 and the installed agy client.
const consumer={client_id:'bf00c418024ba6bf606ccdc37120976e41bc429dd1d46ecf16a729aa532626ea',client_secret:'1d2f041093fd95aa8995a038c711d50a7960da09a505381c09a745d6ad0ecc60'};
const patterns={client_id:/[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com/g,client_secret:/GOCSPX-[A-Za-z0-9_-]{28}/g};
const cache=new Map();
export function clientCandidates({env=process.env,home=os.homedir()}={}){
 return [...new Set([
  ...String(env.PATH||'').split(path.delimiter).filter(Boolean).map(dir=>path.join(dir,'agy')),
  ...['.local/bin/agy','.antigravity/antigravity/bin/agy'].map(file=>path.join(home,file)),
  '/opt/homebrew/bin/agy','/usr/local/bin/agy',
  '/Applications/Antigravity.app/Contents/Resources/bin/language_server',
  path.join(home,'Applications/Antigravity.app/Contents/Resources/bin/language_server'),
 ])];
}
export async function scanClient(file,fingerprints=consumer){
 const handle=await open(file,'r');
 try{
  const stat=await handle.stat();if(!stat.isFile()||stat.size>256*1024*1024)return null;
  const key=JSON.stringify([file,stat.size,stat.mtimeMs,fingerprints]);
  if(cache.has(key))return{...cache.get(key)};
  let tail='',found={};const buffer=Buffer.alloc(1024*1024);
  while(true){
   const {bytesRead}=await handle.read(buffer,0,buffer.length,null);if(!bytesRead)break;
   const text=tail+buffer.subarray(0,bytesRead).toString('latin1');
   for(const [field,pattern] of Object.entries(patterns))if(!found[field])for(const match of text.matchAll(pattern)){
    if(createHash('sha256').update(match[0]).digest('hex')===fingerprints[field]){found[field]=match[0];break;}
   }
   if(found.client_id&&found.client_secret){cache.set(key,found);return{...found};}
   tail=text.slice(-256);
  }
  return null;
 }finally{await handle.close();}
}
export async function discoverOAuthClient(method,{candidates=clientCandidates(),scan=scanClient}={}){
 if(method!=='consumer')return null;
 for(const file of candidates)try{const client=await scan(file);if(client)return client;}catch{}
 return null;
}

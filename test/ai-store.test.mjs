import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {AIStore} from '../ai/store.mjs';

async function fixture(t){const dir=await mkdtemp(path.join(os.tmpdir(),'daylight-ai-store-'));t.after(()=>rm(dir,{recursive:true,force:true}));return new AIStore(dir);}
const conversation=()=>({id:'a1b2c3d4',title:'已保存对话',status:'idle',messages:[],updatedAt:'2026-01-01T00:00:00Z'});
test('failed AI updates restore the existing object and its disk record',async t=>{
 const store=await fixture(t),c=conversation();store.save(c);const previous=structuredClone(c),file=path.join(store.root,'conversations',c.id+'.json'),bytes=await readFile(file,'utf8');
 c.title='未保存标题';c.messages.push({role:'user',text:'未保存内容'});store.write=()=>{throw Object.assign(Error('fixture full disk'),{code:'ENOSPC'});};
 assert.throws(()=>store.save(c),{code:'EAI_STORAGE'});assert.deepEqual(c,previous);assert.equal(store.conversations.get(c.id),c);assert.equal(await readFile(file,'utf8'),bytes);
});
test('a failed new AI conversation is not published to the in-memory list',async t=>{
 const store=await fixture(t),c=conversation();store.write=()=>{throw Error('fixture write failure');};
 assert.throws(()=>store.save(c),{code:'EAI_STORAGE'});assert.equal(store.conversations.size,0);
});
test('failed serialization removes its temporary file and preserves the last committed record',async t=>{
 const store=await fixture(t),c=conversation();store.save(c);const before=await readdir(path.join(store.root,'conversations'));c.circular=c;
 assert.throws(()=>store.save(c),{code:'EAI_STORAGE'});assert.equal(c.circular,undefined);assert.deepEqual(await readdir(path.join(store.root,'conversations')),before);
});

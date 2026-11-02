import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createTaskWorkbench,closeWorkbench} from '../fixtures/workbench.mjs';

test('failed lazy AI initialization can retry after configuration is repaired',async t=>{
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'daylight-ai-retry-'));await mkdir(path.join(dataDir,'ai'));await writeFile(path.join(dataDir,'ai/settings.json'),'{invalid');
 const server=await createTaskWorkbench(dataDir,{aiAdapters:{}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{await closeWorkbench(server);await rm(dataDir,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${server.address().port}`,state=await(await fetch(base+'/api/state')).json();
 const read=()=>fetch(base+'/api/ai/settings',{headers:{'x-workbench-token':state.token}});
 assert.equal((await read()).status,500);
 await writeFile(path.join(dataDir,'ai/settings.json'),JSON.stringify({backend:'codex',codex:{path:'',model:'',effort:'',contextWindow:null},qoder:{path:'',model:'',effort:'',contextWindow:null}}));
 const response=await read();assert.equal(response.status,200);assert.equal((await response.json()).settings.backend,'codex');
});

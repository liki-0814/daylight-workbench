import {readdir,readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {browserRuntime,dependencyFiles} from './runtime-graph.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),publicDir=path.join(root,'public');
const {assets,files}=await browserRuntime(publicDir),reachable=new Set([...assets,...files]),failures=[];
async function visit(directory) {
  for (const item of await readdir(directory,{withFileTypes:true})) {
    const file=path.join(directory,item.name);
    if(item.isDirectory())await visit(file);
    else if(/\.(?:js|css)$/.test(file)&&!reachable.has(file))failures.push('无运行入口：'+path.relative(root,file));
  }
}
await visit(publicDir);
// Child-process and JavaScriptCore entry points are explicit, because they are
// launched by paths rather than imported by the HTTP server.
const backend=await dependencyFiles(root,['server.mjs','proxy/sidecar.mjs','ai/sidecar.mjs','ai/mcp-server.mjs','ai/adapters/pi-extension.mjs','native/core-entry.js'],'node');
const production=new Set([...reachable,...backend]);
async function checkBackend(directory){
  for(const item of await readdir(directory,{withFileTypes:true})){
    const file=path.join(directory,item.name);
    if(item.isDirectory())await checkBackend(file);
    else if(/\.(?:js|mjs)$/.test(file)&&!production.has(file))failures.push('无运行入口：'+path.relative(root,file));
  }
}
for(const folder of ['core','proxy','ai','cli','extensions','focus'])await checkBackend(path.join(root,folder));
const registry=JSON.parse(await readFile(path.join(root,'core/web-assets.json'),'utf8'));
for (const [url,file] of Object.entries(registry))if(!reachable.has(path.resolve(publicDir,file)))failures.push('资源清单中的失效入口：'+url);
for (const file of reachable)if(!Object.values(registry).some(value=>path.resolve(publicDir,value)===file))failures.push('资源未登记：'+path.relative(root,file));
if(failures.length){console.error(failures.join('\n'));process.exitCode=1;}
else console.log(`runtime: 前端 ${files.size}、后端 ${backend.size} 个依赖文件，资源清单一致，无孤立运行模块`);

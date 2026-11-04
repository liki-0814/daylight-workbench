// Keep source module locations intact (import.meta.url is part of the runtime
// contract), while using esbuild's dependency graph to remove unreachable files.
import { transform } from 'esbuild';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {browserRuntime,dependencyFiles,htmlEntries} from './runtime-graph.mjs';

// Browser windows, native JavaScriptCore and spawned helper processes have
// independent entry points. Dynamic MCP startup must be retained explicitly.
const nativeAssets = ['native-core.js'];
const nodeEntries = ['proxy/sidecar.mjs', 'ai/sidecar.mjs', 'ai/mcp-server.mjs', 'ai/adapters/pi-extension.mjs', 'agent-api.mjs', 'tray-model.mjs'];

async function minimizeWeb(publicDir, files) {
  const report = { files: [], beforeBytes: 0, afterBytes: 0 };
  // Keep shared task modules in source form for package inspection. Native
  // consumers use native-core.js; other web modules retain URLs and public
  // exports, so no caller or relative resource path changes.
  const nativeScripts = new Set(['model.js', 'task-view.js']);
  for (const file of files) {
    const relative = path.relative(publicDir, file);
    if (nativeScripts.has(relative) || !/\.(?:js|css)$/.test(file)) continue;
    const input = await readFile(file, 'utf8');
    const result = await transform(input, {
      loader: file.endsWith('.css') ? 'css' : 'js',
      target: 'safari16', minify: true, charset: 'utf8', legalComments: 'inline',
    });
    if (result.warnings.length) throw Error(result.warnings.map(w => w.text).join('\n'));
    await writeFile(file, result.code);
    report.files.push('public/' + relative);
    report.beforeBytes += Buffer.byteLength(input);
    report.afterBytes += Buffer.byteLength(result.code);
  }
  return report;
}

export async function trimRuntime(resources) {
  const publicDir=path.join(resources,'public');
  const {assets,files:web}=await browserRuntime(publicDir);
  for(const file of nativeAssets)assets.add(path.join(resources,file));
  const helpers=await dependencyFiles(resources,nodeEntries,'node');
  const keep=new Set([...assets,...web,...helpers]);
  // The compiled SDK emits a legal-comment companion next to its module.
  for (const file of helpers) {
    const notice = file + '.LEGAL.txt';
    try { await readFile(notice); keep.add(notice); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const removed=[];
  async function visit(directory) {
    for(const entry of await readdir(directory,{withFileTypes:true})) {
      const file=path.join(directory,entry.name);
      if(entry.isDirectory()) {await visit(file);if(!(await readdir(file)).length)await rm(file,{recursive:true});}
      else if(!keep.has(file)) {removed.push(path.relative(resources,file));await rm(file);}
    }
  }
  for(const folder of ['public','proxy','ai','cli','core','extensions']) await visit(path.join(resources,folder));
  const minified = await minimizeWeb(publicDir, web);
  return {entries:htmlEntries.map(file=>'public/'+file).concat(nodeEntries,nativeAssets),files:[...keep].map(file=>path.relative(resources,file)).sort(),removed:removed.sort(),minified};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const report=await trimRuntime(path.resolve(process.argv[2]));
  await writeFile(process.argv[3],JSON.stringify(report,null,2));
  console.log(`Runtime graph: ${report.files.length} reachable files; removed ${report.removed.length} unused files`);
}

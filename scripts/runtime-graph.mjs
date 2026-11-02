import {build} from 'esbuild';
import {readFile} from 'node:fs/promises';
import path from 'node:path';

export const htmlEntries = ['index.html', 'quick.html'];

export async function dependencyFiles(root, entries, platform) {
  const result = await build({absWorkingDir:root,entryPoints:entries,bundle:true,packages:'external',platform,format:'esm',write:false,metafile:true,outdir:'.graph',loader:{'.svg':'file'},logLevel:'silent'});
  if (result.warnings.length) throw Error(result.warnings.map(w=>w.text).join('\n'));
  return new Set(Object.keys(result.metafile.inputs).map(file=>path.resolve(root,file)));
}

// The checker and native packager use exactly the same browser entry points.
export async function browserRuntime(publicDir) {
  const assets = new Set(htmlEntries.map(file=>path.join(publicDir,file))), entries=[];
  for (const file of htmlEntries) {
    const html=await readFile(path.join(publicDir,file),'utf8');
    for (const match of html.matchAll(/(?:src|href)="\/([^"#?]+)"/g)) {
      const asset=path.join(publicDir,match[1]);assets.add(asset);
      if (/\.(?:js|mjs|css)$/.test(asset)) entries.push(match[1]);
    }
  }
  return {assets,files:await dependencyFiles(publicDir,entries,'browser')};
}

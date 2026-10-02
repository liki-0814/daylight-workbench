// Compile the npm dependency graph at the adapter boundary. Node and qodercli
// remain external runtimes; no node_modules tree or hand-maintained package list
// is shipped. esbuild resolves ESM/CJS exports and retains required code/assets.
import { build } from 'esbuild';
import { builtinModules } from 'node:module';
import { mkdir, readFile, readdir, copyFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const builtins = new Set(builtinModules.map(name => name.replace(/^node:/, '')));

export async function buildRuntime(resources, root = project) {
  const output = path.join(resources, 'ai/adapters/qoder.mjs');
  const result = await build({
    absWorkingDir: root,
    entryPoints: ['ai/adapters/qoder.mjs'],
    outfile: output,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    minify: true,
    sourcemap: false,
    legalComments: 'external',
    metafile: true,
    logLevel: 'silent',
    // Bundled CommonJS dependencies may require Node builtins inside an ESM file.
    banner: { js: 'import { createRequire as __daylightCreateRequire } from "node:module"; const require = __daylightCreateRequire(import.meta.url);' },
  });
  if (result.warnings.length) throw new Error(result.warnings.map(w => w.text).join('\n'));
  for (const artifact of Object.values(result.metafile.outputs)) {
    for (const dependency of artifact.imports) {
      if (dependency.external && !builtins.has(dependency.path.replace(/^node:/, ''))) {
        throw new Error(`Unbundled runtime dependency: ${dependency.path}`);
      }
    }
  }

  // Preserve complete licenses for every npm package used by this build, not just
  // comments surviving tree shaking. The metafile also supplies an auditable graph.
  const packages = new Map();
  for (const input of Object.keys(result.metafile.inputs)) {
    if (!input.includes('node_modules/')) continue;
    let directory = path.dirname(path.resolve(root, input));
    while (directory !== path.dirname(directory)) {
      let metadata;
      try { metadata = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (metadata?.name) {
        packages.set(directory, { name: metadata.name, version: metadata.version, license: metadata.license });
        break;
      }
      directory = path.dirname(directory);
    }
  }
  for (const [directory, metadata] of packages) {
    const destination = path.join(resources, 'licenses/npm', metadata.name.replaceAll('/', '__'));
    await mkdir(destination, { recursive: true });
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isFile() && /^(licen[sc]e|notice|copying)([._-]|$)/i.test(entry.name)) {
        await copyFile(path.join(directory, entry.name), path.join(destination, entry.name));
      }
    }
  }
  const code = await readFile(output);
  const report = {
    schemaVersion: 1,
    entry: 'ai/adapters/qoder.mjs',
    bytes: code.length,
    sha256: createHash('sha256').update(code).digest('hex'),
    packages: [...packages.values()].sort((a, b) => a.name.localeCompare(b.name)),
    inputs: Object.keys(result.metafile.inputs).sort(),
  };
  await writeFile(path.join(resources, 'runtime-build.json'), JSON.stringify(report, null, 2));
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error('Usage: node scripts/build-runtime.mjs <Resources directory>');
  const report = await buildRuntime(path.resolve(process.argv[2]));
  console.log(`Runtime bundle: ${report.bytes} bytes, ${report.packages.length} npm packages compiled; no node_modules shipped`);
}

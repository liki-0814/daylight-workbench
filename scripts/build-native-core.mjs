import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
export async function buildNativeCore(resources) {
  const result = await build({ absWorkingDir: root, entryPoints: ['native/core-entry.js'], bundle: true, format: 'iife', globalName: 'Daylight', platform: 'neutral', target: 'safari16', write: false,
    plugins: [{ name: 'native-uuid', setup(b) {
      b.onResolve({ filter: /^node:crypto$/ }, () => ({ path: 'uuid', namespace: 'native' }));
      b.onLoad({ filter: /.*/, namespace: 'native' }, () => ({ contents: 'export const randomUUID = () => globalThis.randomUUID();', loader: 'js' }));
    } }] });
  if (result.warnings.length) throw new Error(result.warnings.map(w => w.text).join('\n'));
  if (resources) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(resources, 'native-core.js'), result.outputFiles[0].text);
  }
  return result.outputFiles[0].text;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildNativeCore(process.argv[2]);

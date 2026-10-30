import { execFile } from 'node:child_process';

// 「在访达中显示」(api-contract §H1). The server always resolves the location itself; a path is never accepted from the caller.
// Standalone server: macOS `open -R` with an argument array (no shell).
// Native shell: the AI helper (ai/sidecar.mjs) is started with DAYLIGHT_REVEAL=native and uses nativeReveal(): it does not open anything but
// answers {ok:true, hostReveal:<absolute path>} to the shell, which strips the field and calls NSWorkspace.activateFileViewerSelecting
// (native/NativeReveal.swift, PR "native-reveal-find"; UNVERIFIED until compiled on a Mac). Without that shell, `open -R` still serves the app.
// `options` lets tests (and the native helper) inject `{supported, run(absolutePath)}`; run may return {hostReveal} to hand the path to the shell.
export function createReveal(options) {
  return options || { supported: process.platform === 'darwin', run: file => new Promise((resolve, reject) => execFile('open', ['-R', file], failure => failure ? reject(failure) : resolve())) };
}

export const revealCapability = 'POST /api/extensions/reveal {kind:"skill"|"mcpConfig"|"client", id?, clientId?} (Daylight UI only; not under /api/v1; present only where the server can open Finder)';

export const nativeReveal = () => ({ supported: true, run: async file => ({ hostReveal: file }) });
export const revealFromEnvironment = environment => environment.DAYLIGHT_REVEAL === 'native' ? nativeReveal() : undefined;

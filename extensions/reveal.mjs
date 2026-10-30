import { execFile } from 'node:child_process';

// 「在访达中显示」(api-contract §H1). Standalone server only: macOS `open -R` with an argument array (no shell).
// TODO(native-mac): inside the native shell prefer NSWorkspace.shared.activateFileViewerSelecting([url]) through the existing bridge.
// Not written or verified here (no Swift toolchain on the box); until then the standalone `open -R` path serves the app too. Verify on a Mac.
// `options` lets tests (and a future native bridge) inject `{supported, run(absolutePath)}`.
export function createReveal(options) {
  return options || { supported: process.platform === 'darwin', run: file => new Promise((resolve, reject) => execFile('open', ['-R', file], failure => failure ? reject(failure) : resolve())) };
}

export const revealCapability = 'POST /api/extensions/reveal {kind:"skill"|"mcpConfig"|"client", id?, clientId?} (Daylight UI only; not under /api/v1; present only where the server can open Finder)';

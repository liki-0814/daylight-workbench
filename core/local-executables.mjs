import path from 'node:path';
import os from 'node:os';

// Shared by AI adapters and extension discovery. Finder often supplies a minimal
// PATH; checking known CLI install roots does not execute any client process.
export function executableCandidates(name, { custom = '', environment = process.env, home = os.homedir() } = {}) {
  const candidates = custom ? [custom] : [
    ...(environment.PATH || '').split(path.delimiter).filter(Boolean).map(directory => path.join(directory, name)),
    ...['.npm-global/bin', '.local/bin', '.volta/bin'].map(directory => path.join(home, directory, name)),
    `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`,
  ];
  return [...new Set(candidates.filter(candidate => path.isAbsolute(candidate)))];
}

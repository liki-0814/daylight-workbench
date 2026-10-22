import path from 'node:path';
import { createWorkbench } from '../server.mjs';

// Task/Skill API tests do not discover real accounts, models or client files.
// Extra options (e.g. aiAdapters, extensionsOptions) are merged over the isolated defaults.
export const createTaskWorkbench = (dataDir, { proxyOptions, extensionsOptions, ...options } = {}) => createWorkbench({
  ...options,
  dataDir,
  proxyOptions: {
    provider: { listModels: async () => [], execute() { throw new Error('Task fixture must not infer'); } },
    includeGateway: false, includeAgy: false, includeGrok: false,
    pricingOptions: { enabled: false }, piOptions: { piDir: path.join(dataDir, 'pi') },
    ...proxyOptions,
  },
  extensionsOptions: { agentsRoot: path.join(dataDir, 'agents'), clientRoots: {}, home: dataDir, ...extensionsOptions },
});

export async function closeWorkbench(server) {
  if (!server) return;
  await server.closeProxy();
  if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
}

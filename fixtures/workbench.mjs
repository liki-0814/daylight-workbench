import path from 'node:path';
import { createWorkbench } from '../server.mjs';

// Task/Skill API tests do not discover real accounts, models or client files.
export const createTaskWorkbench = dataDir => createWorkbench({
  dataDir,
  proxyOptions: {
    provider: { listModels: async () => [], execute() { throw new Error('Task fixture must not infer'); } },
    includeGateway: false, includeAgy: false, includeGrok: false,
    pricingOptions: { enabled: false }, piOptions: { piDir: path.join(dataDir, 'pi') },
  },
  extensionsOptions: { agentsRoot: path.join(dataDir, 'agents'), clientRoots: {}, home: dataDir },
});

export async function closeWorkbench(server) {
  if (!server) return;
  await server.closeProxy();
  if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
}

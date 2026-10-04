import assets from './web-assets.json' with { type: 'json' };
import { operations } from '../agent-api.mjs';
import { taskQueryCapability } from '../public/task-view.js';

export const webAssets = assets;
const proxyPrefixes = ['/api/cli/', '/api/proxy/', '/api/qoder/', '/api/agy/', '/api/grok/', '/api/kimi-proxy/', '/api/codex-proxy/', '/api/custom-proxy/', '/api/proxy-tools/'];
const agentRoutes = {
  '/api/v1/state': ['GET', 'state'],
  '/api/v1/tasks': ['GET', 'tasks'],
  '/api/v1/capabilities': ['GET', 'capabilities'],
  '/api/v1/actions': ['POST', 'actions'],
};

// The transports enforce auth before dispatch, including unknown Agent routes.
export function resolveRoute(path, method) {
  if (path.startsWith('/api/ai/')) return { auth: 'web', handler: 'ai', target: path };
  if (proxyPrefixes.some(prefix => path.startsWith(prefix))) return { auth: 'web', handler: 'proxy', target: path };
  if (path.startsWith('/api/v1/')) {
    if (['/api/v1/ai/state', '/api/v1/ai/actions'].includes(path)) return { auth: 'agent', handler: 'ai', target: path.replace('/api/v1/ai/', '/api/ai/') };
    if (path.startsWith('/api/v1/proxy/')) return { auth: 'agent', handler: 'proxy', target: path.replace('/api/v1/proxy/', '/api/proxy-tools/') };
    const entry = agentRoutes[path];
    return { auth: 'agent', handler: entry?.[0] === method ? entry[1] : 'missing' };
  }
  if (path === '/api/state' && method === 'GET') return { auth: 'public', handler: 'webState' };
  if (path === '/api/state' && method === 'PUT') return { auth: 'webOrigin', handler: 'webWrite' };
  return { auth: 'public', handler: 'asset', file: method === 'GET' && Object.hasOwn(assets, path) ? assets[path] : null };
}

export function capabilities() {
  return { apiVersion: 1, operations, taskQuery: taskQueryCapability,
    aiConversations: { reads: 'GET /api/v1/ai/state', writes: 'POST /api/v1/ai/actions', operations: ['ai.conversation.delete'] },
    retention: 'last 100 successful request IDs', writes: 'POST /api/v1/actions {requestId, expectedVersion, day?, action}', reads: 'GET /api/v1/state' };
}

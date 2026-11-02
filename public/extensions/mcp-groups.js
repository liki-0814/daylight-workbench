const normalizedUrl = value => {
  if (!value) return '';
  try { return new URL(value).href; } catch { return value; }
};
const refs = value => Object.entries(value || {}).sort(([a], [b]) => a.localeCompare(b));
const connectionKey = server => JSON.stringify([
  server.transport,
  server.command || '',
  server.args || [],
  server.cwd || '',
  normalizedUrl(server.url),
  refs(server.envRefs),
  refs(server.headerRefs),
]);
const serverKey = server => server.serverKey || server.id;

export function groupMcpServers(servers, clients = []) {
  const groups = new Map(), occupied = new Map();
  for (const server of servers) {
    if (server.scope === 'client') occupied.set(server.clientId + '\0' + serverKey(server), server);
  }
  for (const server of servers) {
    const key = serverKey(server), valid = server.valid !== false && ['stdio', 'http'].includes(server.transport);
    const identity = valid ? connectionKey(server) : 'invalid:' + server.id;
    const mapKey = key + '\0' + identity;
    if (!groups.has(mapKey)) groups.set(mapKey, { id: server.id, key, name: server.name || key, transport: server.transport, shared: null, installations: [], members: [], bindings: [] });
    const group = groups.get(mapKey);
    group.members.push(server);
    if (server.scope === 'client') group.installations.push(server);
    else {
      group.shared = server;
      group.id = server.id;
      group.name = server.name || key;
      group.transport = server.transport;
    }
  }
  for (const group of groups.values()) {
    if (!group.shared) {
      group.bindings = group.installations.map(installation => ({ clientId: installation.clientId, state: 'connected', installation, conflictServer: null }));
      continue;
    }
    group.bindings = clients.filter(client => client.selected && client.mcpMode === 'native').map(client => {
      const installation = group.installations.find(server => server.clientId === client.id) || null;
      const conflictServer = installation ? null : occupied.get(client.id + '\0' + group.key) || null;
      return { clientId: client.id, state: installation ? 'connected' : conflictServer ? 'conflict' : 'not_connected', installation, conflictServer };
    });
  }
  return [...groups.values()];
}

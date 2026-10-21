export const aiBackends = [
  { id: 'codex', name: 'Codex', command: 'codex' },
  { id: 'qoder', name: 'Qoder', command: 'qodercli' },
  { id: 'pi', name: 'Pi', command: 'pi' },
];
export const backendName = id => aiBackends.find(item => item.id === id)?.name || id;

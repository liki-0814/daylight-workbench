// Chat catalogs omit media models. These parsers read the catalogs that do list them.
// A failed refresh keeps the last good list; the caller supplies a seed only when there is none.

export async function cachedIds(cache, { identity, refresh, load, fallback }) {
  try {
    const value = await cache.get({ identity, refresh: refresh === true, load: async () => ({ ids: await load() }) });
    return value.ids;
  } catch {
    if (cache.value?.identity === identity && Array.isArray(cache.value.ids) && cache.value.ids.length) return cache.value.ids;
    const ids = [...fallback];
    cache.seed({ identity, ids, at: Date.now() }, identity);
    return ids;
  }
}

export function parseOpenAIImageModels(source) {
  if (typeof source !== 'string' || !source.includes('ImageModel')) throw new Error('不是官方图像目录');
  const [literal, deprecated = ''] = source.split('Deprecated values:');
  const retired = new Set();
  for (const line of deprecated.split('\n')) {
    const bullet = /^\s*-\s+(.*?):\s*/.exec(line);
    if (!bullet) continue;
    for (const id of bullet[1].matchAll(/"([^"]+)"/g)) retired.add(id[1]);
  }
  const ids = [];
  for (const id of literal.matchAll(/"([^"]+)"/g)) {
    const name = id[1];
    if (retired.has(name) || name.startsWith('dall-e-') || ids.includes(name)) continue;
    ids.push(name);
  }
  if (!ids.length) throw new Error('官方图像目录为空');
  return ids;
}

export function parseXaiMediaModels(payload) {
  if (!payload || !Array.isArray(payload.data)) throw new Error('不是模型目录');
  const ids = [];
  for (const row of payload.data) {
    if (typeof row?.id !== 'string' || row.hidden === true || ids.includes(row.id)) continue;
    if (/^grok-imagine-(?:image|video)(?:-|$)/.test(row.id)) ids.push(row.id);
  }
  if (!ids.length) throw new Error('目录里没有图像或视频模型');
  return ids;
}

export function isAgyImageId(id) {
  return typeof id === 'string' && /(?:^|-)image(?:-|$)/.test(id);
}

function declaresImageOutput(model) {
  const outputs = model.outputModalities || model.supportedOutputModalities || model.responseModalities;
  return Array.isArray(outputs) && outputs.some(value => String(value).toUpperCase() === 'IMAGE');
}

export function isAgyMediaEntry(id, model) {
  return isAgyImageId(id) || Boolean(model && declaresImageOutput(model));
}

export function agyMediaEntries(catalog) {
  const models = catalog?.models;
  if (!models || typeof models !== 'object') return [];
  const rows = [];
  for (const [id, model] of Object.entries(models)) {
    if (!model || typeof model !== 'object' || typeof id !== 'string') continue;
    if (!isAgyMediaEntry(id, model)) continue;
    const displayName = typeof model.displayName === 'string' && model.displayName.trim() ? model.displayName.trim() : id;
    rows.push({ id, displayName });
  }
  return rows;
}

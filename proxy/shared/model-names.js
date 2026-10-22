import {createHash} from 'node:crypto';
import {parseModelRef} from './llm/models.js';

const tiers = {'旗舰': 'flagship', '高级': 'advanced', '基础': 'basic'};
const slug = name => name.normalize('NFKC').toLowerCase().trim().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '');

// Public names belong at the provider boundary. Native catalogs, settings and
// metadata bindings retain their original keys, including route-specific IDs.
export function namedModels(source, models) {
  const names = models.map(model => {
    const name = typeof model.displayName === 'string' && model.displayName.trim() || model.id;
    return tiers[name] ? `${source}-${tiers[name]}` : slug(name) || model.id;
  });
  return models.map((model, index) => {
    const name = names[index];
    const id = names.filter(other => other === name).length > 1
      ? `${name}-${createHash('sha256').update(model.id).digest('hex').slice(0, 8)}` : name;
    return {...model, id, upstreamId: model.upstreamId || model.id,
      aliases: [...new Set([...(model.aliases || []), ...(id !== model.id ? [model.id] : [])])]};
  });
}

export function withModelNames(source, provider) {
  const listModels = async (...args) => namedModels(source, await provider.listModels(...args));
  async function original(id) {
    const models = await provider.listModels();
    const names = namedModels(source, models);
    let index = names.findIndex(model => model.id === id);
    if (index < 0) index = names.findIndex(model => model.aliases.includes(id));
    return index < 0 ? undefined : {model: models[index], name: names[index]};
  }
  const execute = async (input, context) => {
    const ref = source === 'qoder' ? parseModelRef(input.raw.model) : {id: input.raw.model};
    const found = await original(ref.id);
    if (!found) return provider.execute(input, context);
    const suffix = source === 'qoder' ? input.raw.model.trim().slice(ref.id.length) : '';
    const result = await provider.execute({...input, raw: {...input.raw, model: found.model.id + suffix}}, context);
    return result.model === found.model.id ? {...result, model: found.name.id} : result;
  };
  const setModel = async input => {
    const found = await original(input.id);
    const result = await provider.setModel({...input, id: found?.model.id || input.id});
    return namedModels(source, result);
  };
  // Bind native methods to the native provider: its internal discovery and wire
  // validation must not accidentally consume the public renamed catalog.
  return new Proxy(provider, {get(target, key) {
    if (key === 'listModels') return listModels;
    if (key === 'execute') return execute;
    if (key === 'setModel' && typeof target.setModel === 'function') return setModel;
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  }});
}

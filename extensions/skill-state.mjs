import path from 'node:path';
import { error } from './files.mjs';

// bindings.json keeps schemaVersion 1. Skill enable state is an optional top-level map so older
// builds, which only read `bindings` and preserve unknown keys, keep working:
//   skillStates: { [skillId]: { disabled: boolean, rememberedBindings: [{ clientId, source, target, linkTarget }] } }
// An absent entry means "enabled, nothing remembered".
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0 && value.length < 4096 && !/[\0\r\n]/.test(value);
export function normalizeManifest(manifest) {
  const states = manifest.skillStates;
  if (states === undefined) return manifest;
  const bad = () => error('接入记录中的 Skill 启停记忆格式错误，接入写入已暂停');
  if (!plain(states) || Object.keys(states).length > 5000) throw bad();
  for (const [id, state] of Object.entries(states)) {
    if (!/^skill_[a-f0-9]{24}$/.test(id) || !plain(state) || Object.keys(state).some(key => !['disabled', 'rememberedBindings'].includes(key)) || typeof state.disabled !== 'boolean' || !Array.isArray(state.rememberedBindings) || state.rememberedBindings.length > 100) throw bad();
    for (const item of state.rememberedBindings) {
      if (!plain(item) || Object.keys(item).sort().join() !== 'clientId,linkTarget,source,target' || !Object.values(item).every(text) || !path.isAbsolute(item.source) || !path.isAbsolute(item.target)) throw bad();
    }
  }
  return manifest;
}
// Mutates a cloned manifest: store or clear one Skill's state. Returns true when anything changed.
export function setSkillState(manifest, id, state) {
  const keep = state && (state.disabled || state.rememberedBindings.length);
  const had = manifest.skillStates?.[id];
  if (!keep) {
    if (!had) return false;
    delete manifest.skillStates[id];
    if (!Object.keys(manifest.skillStates).length) delete manifest.skillStates;
    return true;
  }
  manifest.skillStates ||= {};
  manifest.skillStates[id] = { disabled: !!state.disabled, rememberedBindings: state.rememberedBindings };
  return true;
}

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installProjectSkill } from '../ai/project-skill.mjs';
function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-project-skill-'));
  t.after(() => fs.rmSync(cwd, {recursive:true, force:true}));
  return {cwd, backend:'pi', dataDir:cwd, endpoint:'http://127.0.0.1:4329'};
}
test('project skill installs into runtime cwd, updates config for this instance, and preserves extra files', t => {
  const input = fixture(t), target = installProjectSkill(input);
  assert.equal(target, path.join(input.cwd,'.agents/skills/daylight-workbench'));
  const config = () => JSON.parse(fs.readFileSync(path.join(target,'config.json')));
  assert.equal(config().data_dir,input.dataDir); assert.equal(config().url,input.endpoint);
  fs.writeFileSync(path.join(target,'custom.txt'),'keep');
  installProjectSkill({...input,endpoint:'http://127.0.0.1:4330'});
  assert.equal(config().url,'http://127.0.0.1:4330');
  assert.equal(fs.readFileSync(path.join(target,'custom.txt'),'utf8'),'keep');
  assert.equal(installProjectSkill({...input,backend:'qoder'}),path.join(input.cwd,'.qoder/skills/daylight-workbench'));
});
test('project skill never overwrites local changes or follows project directory links', t => {
  const input=fixture(t), target=installProjectSkill(input), file=path.join(target,'SKILL.md');
  fs.writeFileSync(file,'custom');
  assert.throws(()=>installProjectSkill(input),/本地修改/);
  assert.equal(fs.readFileSync(file,'utf8'),'custom');
  const other=fixture(t); fs.symlinkSync(input.cwd,path.join(other.cwd,'.agents'));
  assert.throws(()=>installProjectSkill(other),/真实目录/);
});
test('project skill rejects nested links without modifying their destination', t => {
  const input=fixture(t), target=installProjectSkill(input), external=fixture(t).cwd;
  fs.writeFileSync(path.join(external,'workbench.py'),'private');
  fs.rmSync(path.join(target,'scripts'),{recursive:true});fs.symlinkSync(external,path.join(target,'scripts'));
  assert.throws(()=>installProjectSkill(input),/真实目录/);
  assert.equal(fs.readFileSync(path.join(external,'workbench.py'),'utf8'),'private');
});

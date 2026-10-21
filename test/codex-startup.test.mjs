import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { run, startCodex } from '../ai/adapters/codex.mjs';

async function fixture(t, failures = 2, message = 'workspace routing discovery failed') {
  const cwd = await mkdtemp(path.join(tmpdir(), 'daylight-codex-start-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const bin = path.join(cwd, 'codex-cli'), log = path.join(cwd, 'calls.jsonl'), count = path.join(cwd, 'count');
  await writeFile(bin, `#!${process.execPath}
const fs=require('fs'),rl=require('readline').createInterface({input:process.stdin});
let n=0;try{n=Number(fs.readFileSync(${JSON.stringify(count)},'utf8'))}catch{}n++;fs.writeFileSync(${JSON.stringify(count)},String(n));
rl.on('line',line=>{const r=JSON.parse(line);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({boot:n,...r})+'\\n');if(!r.id)return;
if(r.method==='account/read'&&n<=${failures})return console.log(JSON.stringify({id:r.id,error:{message:${JSON.stringify(message)}}}));
console.log(JSON.stringify({id:r.id,result:r.method==='thread/start'?{thread:{id:'t'}}:r.method==='turn/start'?{turn:{id:'turn'}}:{}}));
if(r.method==='turn/start')console.log(JSON.stringify({method:'turn/completed',params:{turn:{status:'completed'}}}));});`);
  await chmod(bin, 0o700);
  return { cwd, bin, calls: async () => (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse) };
}
test('Codex retries fresh startup processes for routing failures before submitting a single image turn', async t => {
  const f = await fixture(t), images = [{ mimeType: 'image/png', data: 'aGVsbG8=' }];
  await run({ conversation: { config: { path: f.bin, model: 'm' } }, cwd: f.cwd, ephemeral: true, text: '识别', images, signal: new AbortController().signal, emit() {}, setSession() {}, ask: async () => '', approve: async () => false });
  const calls = await f.calls();
  assert.equal(calls.filter(call => call.method === 'initialize').length, 3);
  assert.equal(calls.filter(call => call.method === 'thread/start').length, 1);
  const turns = calls.filter(call => call.method === 'turn/start'); assert.equal(turns.length, 1); assert.equal(turns[0].boot, 3);
  assert.deepEqual(turns[0].params.input[1], { type: 'image', url: 'data:image/png;base64,aGVsbG8=' });
  assert(calls.filter(call => call.method === 'account/read').every(call => call.params.refreshToken === false));
});
test('Codex bounds routing retries and never retries unrelated authorization errors', async t => {
  for (const [message, boots] of [['workspace routing discovery failed', 3], ['Sign in required', 1]]) {
    const f = await fixture(t, 10, message);
    await assert.rejects(startCodex(f.bin, ['app-server'], f.cwd), new RegExp(message));
    const calls = await f.calls(); assert.equal(calls.filter(call => call.method === 'initialize').length, boots);
    assert.equal(calls.some(call => call.method === 'turn/start'), false);
  }
});

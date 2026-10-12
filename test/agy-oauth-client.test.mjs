import test from 'node:test';
import assert from 'node:assert/strict';
import {loadOAuthClient} from '../proxy/agy/oauth-client.js';
test('AGY loads OAuth parameters from the selected local configuration and excludes unrelated fields',async()=>{
 let read;
 const client=await loadOAuthClient('gcp',{file:'/private/local-config.json',readFileImpl:async file=>{read=file;return JSON.stringify({gcp:{client_id:'fixture-id',client_secret:'fixture-secret',extra:'ignored'}});}});
 assert.equal(read,'/private/local-config.json');assert.deepEqual(client,{client_id:'fixture-id',client_secret:'fixture-secret'});
});
test('unsupported AGY login methods do not read a credential file',async()=>{
 assert.equal(await loadOAuthClient('wif',{readFileImpl:async()=>{throw Error('must not read');}}),null);
});
test('missing or malformed OAuth configuration fails safely without leaking contents',async()=>{
 for(const readFileImpl of [async()=>{throw Error('private-content');},async()=>'{private-content',async()=>JSON.stringify({consumer:{client_id:'fixture',client_secret:''}})]){
  await assert.rejects(loadOAuthClient('consumer',{readFileImpl}),error=>error.code==='EAGY_OAUTH_CLIENT_CONFIG'&&!error.message.includes('private-content'));
 }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {getEventListeners} from 'node:events';
import {assertPublicImageUrl} from '../proxy/shared/remote-image.js';

test('successful and failed DNS lookups do not retain abort listeners',async()=>{
 const controller=new AbortController();
 for(let index=0;index<20;index++)await assertPublicImageUrl('https://fixture.test/a.png',{signal:controller.signal,lookup:async()=>[{address:'8.8.8.8'}]});
 assert.equal(getEventListeners(controller.signal,'abort').length,0);
 await assert.rejects(assertPublicImageUrl('https://fixture.test/a.png',{signal:controller.signal,lookup:async()=>{throw Error('fixture DNS failure');}}));
 assert.equal(getEventListeners(controller.signal,'abort').length,0);
});
test('cancellation during lookup rejects and detaches the abort listener',async()=>{
 const controller=new AbortController();
 const pending=assertPublicImageUrl('https://fixture.test/a.png',{signal:controller.signal,lookup:()=>new Promise(()=>{})});
 controller.abort();await assert.rejects(pending);assert.equal(getEventListeners(controller.signal,'abort').length,0);
});

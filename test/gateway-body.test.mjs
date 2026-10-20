import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {Readable} from 'node:stream';
import {createGateway,readBody} from '../proxy/gateway.js';
import {protocolFor} from '../proxy/shared/contracts.js';

const inferenceLimit=32_000_000;
const jsonBody=(bytes)=>Buffer.from('{"input":"'+'x'.repeat(bytes-12)+'"}');

test('body reader counts UTF-8 bytes, accepts the exact limit and preserves the management limit',async()=>{
 await assert.rejects(()=>readBody(Readable.from([jsonBody(4_000_001)])),{status:413});
 assert.equal((await readBody(Readable.from([jsonBody(inferenceLimit)]),inferenceLimit)).input.length,inferenceLimit-12);
 const unicode=Buffer.from(JSON.stringify({input:'中文'}));
 assert.deepEqual(await readBody(Readable.from([unicode.subarray(0,11),unicode.subarray(11)]),unicode.length),{input:'中文'});
 await assert.rejects(()=>readBody(Readable.from([unicode]),unicode.length-1),{status:413});
 await assert.rejects(()=>readBody(Readable.from([Buffer.from('{')])),{status:400});
});

test('gateway forwards large requests across protocols and returns usable 413 for declared and chunked bodies',async t=>{
 const active=new Set(),finishing=new Set(),forwarded=[],records=[];
 let port;
 const gateway=createGateway({
  getSettings:()=>({port,apiKey:'synthetic-test-key'}),
  router:{candidates:async()=>[{provider:'test',id:'test'}],success(){}},
  registry:{providers:{test:{}},execute:async(_source,request)=>{
   forwarded.push(request);
   return {kind:'response',protocol:request.protocol,response:Response.json({model:'test',content:[],output:[],choices:[]})};
  }},
  sourceState:{revision:()=>1},records:{append:async row=>{records.push(row);}},active,finishing,
 });
 const server=http.createServer(gateway);server.listen(0,'127.0.0.1');await once(server,'listening');port=server.address().port;
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await Promise.all(finishing);});
 const post=(route,body,chunked=false)=>new Promise((resolve,reject)=>{
  const req=http.request({hostname:'127.0.0.1',port,path:'/v1'+route,method:'POST',headers:{Authorization:'Bearer synthetic-test-key','Content-Type':'application/json',...(!chunked?{'Content-Length':body.length}:{})}},res=>{
   let text='';res.setEncoding('utf8');res.on('data',part=>{text+=part;});res.on('error',reject);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text)}));
  });
  req.on('error',reject);
  if(chunked){req.write(body.subarray(0,17));req.end(body.subarray(17));}else req.end(body);
 });
 const text='文'.repeat(1_400_000);
 for(const route of ['/responses','/chat/completions','/messages']){
  const payload={model:'test',...(route==='/responses'?{input:text}:{messages:[{role:'user',content:text}]})};
  assert.equal((await post(route,Buffer.from(JSON.stringify(payload)))).status,200);
  assert.deepEqual(forwarded.at(-1).raw,payload);assert.equal(forwarded.at(-1).protocol,protocolFor(route));
 }
 const count=forwarded.length,oversized=jsonBody(inferenceLimit+1);
 for(const chunked of [false,true]){
  const result=await post('/responses',oversized,chunked);
  assert.equal(result.status,413);assert.equal(result.body.error.type,'proxy_error');
  assert.match(result.body.error.message,/32 MB/);assert.match(result.body.error.message,/32000001/);
  assert.equal(forwarded.length,count);
 }
 assert.equal((await post('/responses',Buffer.from('{'))).status,400);
 assert.equal((await post('/responses',Buffer.from('{"model":"test","input":"still works"}'))).status,200);
 await Promise.all(finishing);
 assert.equal(active.size,0);assert.equal(finishing.size,0);
 assert.equal(records.filter(row=>row.status===413).length,2);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {relayResult} from '../proxy/shared/relay.js';
import {events} from '../proxy/shared/protocol.js';
import {RequestTrace} from '../proxy/shared/request-records.js';
import {createGateway} from '../proxy/gateway.js';
import {retryableRouteError} from '../proxy/shared/router.js';

const privateMessage='An assistant message with tool_calls must be followed by tool messages. PRIVATE PROMPT Bearer secret-key data:image/png;base64,PRIVATE';
const failure=()=>Response.json({error:{code:'invalid_request_error',param:'messages[4].role',message:privateMessage},request_id:'req-body'}, {status:400,headers:{'x-request-id':'req-upstream'}});
async function relayError(response) {
  const trace=new RequestTrace('/responses');
  try { await relayResult({response,model:'fixture',protocol:'chat'},{stream:true},'responses',{},undefined,i=>trace.observe(i)); }
  catch(error) {trace.fail(error);return{error,record:trace.finish(error.status, error.status)};}
  assert.fail('expected upstream rejection');
}

test('relay retains safe upstream diagnostics, classifies tool ordering and does not retain raw bodies',async()=>{
  const {error,record}=await relayError(failure());
  assert.equal(error.status,400);assert.equal(error.code,'invalid_request_error');
  assert.equal(record.error.param,'messages[4].role');
  assert.equal(record.error.reason,'tool_result_sequence');assert.equal(record.error.retryable,false);
  assert.equal(record.error.upstreamRequestId,'req-upstream');
  assert.match(error.message,/工具/);assert.match(error.message,/400/);
  assert.doesNotMatch(JSON.stringify({error:{...error,message:error.message},record}),/PRIVATE|secret-key|Bearer|data:image/);
});

test('bounded diagnostics tolerate non-JSON, oversized, broken and stalled upstream bodies',async()=>{
  let cancelled=0;
  const streams=[
    new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('x'.repeat(40000)));},cancel(){cancelled++;}}),
    new ReadableStream({pull(){throw Error('PRIVATE read error');}}),
    new ReadableStream({cancel(){cancelled++;return new Promise(()=>{});}}),
  ];
  for(const response of [new Response('<html>PRIVATE proxy error</html>',{status:502}),...streams.map(s=>new Response(s,{status:400}))]) {
    const {error,record}=await relayError(response);
    assert.ok([400,502].includes(error.status));
    assert.doesNotMatch(JSON.stringify({record,message:error.message}),/PRIVATE|xxxx|html/);
  }
  assert.equal(cancelled,2);
});

test('SSE errors share safe classification without confusing HTTP 200 and upstream failure',async()=>{
  const trace=new RequestTrace('/responses');trace.observe({upstreamStatus:200});
  const body={type:'response.failed',response:{error:{code:'context_length_exceeded',message:'PRIVATE too long',param:'input'},request_id:'req-sse'}};
  await assert.rejects(async()=>{
    for await(const e of events(new Response('data: '+JSON.stringify(body)+'\n\n'),'responses','fixture',i=>trace.observe(i)))void e;
  },e=>e.status===502&&e.code==='context_length_exceeded');
  const row=trace.finish(502,200);
  assert.equal(row.upstreamStatus,200);assert.equal(row.error.reason,'context_length');
  assert.equal(row.error.retryable,false);assert.equal(row.error.upstreamRequestId,'req-sse');
  assert.doesNotMatch(JSON.stringify(row),/PRIVATE/);
});

test('diagnostics classify safe errors, reject unsafe fields and preserve recoverable route failures',async()=>{
  for(const [code,message,reason] of [
    ['context_length_exceeded','PRIVATE','context_length'],
    ['invalid_image','PRIVATE','invalid_image'],
    ['unsupported_parameter','PRIVATE','unsupported_parameter'],
  ]) {
    const {error,record}=await relayError(Response.json({error:{code,message,param:'PRIVATE Bearer key'},request_id:'PRIVATE\nkey'},{status:500}));
    assert.equal(record.error.reason,reason);assert.equal(record.error.param,undefined);
    assert.equal(record.error.upstreamRequestId,undefined);assert.equal(retryableRouteError(error),false);
    assert.doesNotMatch(JSON.stringify(record),/PRIVATE|Bearer/);
  }
  for(const status of [401,403,404,408,429,500,503]) {
    const {error}=await relayError(new Response('unknown upstream error',{status}));
    assert.equal(retryableRouteError(error),true);
  }
  const {error}=await relayError(Response.json({error:{code:'PRIVATE KEY',message:'PRIVATE'}},{status:400}));
  assert.equal(error.code,undefined);assert.equal(retryableRouteError(error),false);
});

test('gateway returns the same safe diagnostic and trace ID that it records, without retrying 400',async t=>{
  const rows=[],active=new Set(),finishing=new Set();let executions=0,settings;
  const registry={providers:{fixture:{}},execute:async()=>{executions++;return{kind:'response',response:failure(),protocol:'chat',model:'fixture'};}};
  const gateway=createGateway({getSettings:()=>settings,registry,sourceState:{revision:()=> 'test'},records:{append:async r=>rows.push(r)},active,finishing,
    router:{candidates:async()=>[{provider:'fixture'},{provider:'fixture'}],success(){},failed(){assert.fail('400 must not fail over');}}});
  const server=http.createServer(gateway);server.listen(0,'127.0.0.1');await once(server,'listening');
  settings={port:server.address().port,apiKey:'fixture-secret'};
  t.after(()=>{server.closeAllConnections();return new Promise(r=>server.close(r));});
  const response=await fetch(`http://127.0.0.1:${settings.port}/v1/responses`,{method:'POST',headers:{Authorization:'Bearer '+settings.apiKey,'Content-Type':'application/json'},body:JSON.stringify({model:'fixture',input:'PRIVATE PROMPT',stream:true})});
  const body=await response.json();await Promise.all([...finishing]);
  assert.equal(response.status,400);assert.equal(executions,1);
  assert.equal(body.error.code,'invalid_request_error');assert.equal(body.error.param,'messages[4].role');
  assert.equal(body.error.request_id,rows[0].id);assert.equal(body.error.upstreamRequestId,'req-upstream');
  assert.equal(body.error.retryable,false);assert.match(body.error.message,/工具/);
  assert.doesNotMatch(JSON.stringify({body,rows}),/PRIVATE|secret-key|Bearer|data:image/);
  assert.equal(active.size,0);

  // Once SSE headers are sent, the error frame still correlates with the same trace.
  registry.execute=async()=>({kind:'response',protocol:'chat',model:'fixture',streaming:true,response:new Response([
    {choices:[{delta:{content:'started'}}]},
    {error:{code:'invalid_image',message:'PRIVATE image rejected',param:'messages'}},
  ].map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''),{headers:{'Content-Type':'text/event-stream','x-request-id':'req-stream'}})});
  const streaming=await fetch(`http://127.0.0.1:${settings.port}/v1/responses`,{method:'POST',headers:{Authorization:'Bearer '+settings.apiKey,'Content-Type':'application/json'},body:JSON.stringify({model:'fixture',input:'PRIVATE PROMPT',stream:true})});
  const wire=await streaming.text();await Promise.all([...finishing]);
  assert.equal(streaming.status,200);assert.match(wire,/response.output_text.delta/);
  const errorFrame=wire.split('\n\n').find(f=>f.startsWith('event: error'));
  const streamError=JSON.parse(errorFrame.split('\ndata: ')[1]).error;
  assert.equal(streamError.request_id,rows[1].id);assert.equal(streamError.upstreamRequestId,'req-stream');
  assert.equal(streamError.reason,'invalid_image');assert.equal(rows[1].httpStatus,200);assert.equal(rows[1].status,502);
  assert.equal(rows[1].error.code,'invalid_image');assert.doesNotMatch(JSON.stringify({wire,rows}),/PRIVATE/);
});

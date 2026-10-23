import test from 'node:test';
import assert from 'node:assert/strict';
import {convertRequest} from '../proxy/shared/protocol.js';
import {CopilotProvider} from '../proxy/copilot/provider.js';

const image = n => `data:image/png;base64,${Buffer.from(`image-${n}`).toString('base64')}`;
const call = id => ({type:'function_call',call_id:id,name:'read',arguments:'{}'});
const result = (id,images=[]) => ({type:'function_call_output',call_id:id,output:[
  {type:'input_text',text:`result ${id}`},...images.map(n=>({type:'input_image',image_url:image(n)})),
]});
const request = input => ({model:'fixture',stream:true,max_output_tokens:64,parallel_tool_calls:true,input});
const urls = messages => messages.flatMap(m=>Array.isArray(m.content)?m.content.filter(p=>p.type==='image_url').map(p=>p.image_url.url):[]);

test('four parallel image results stay contiguous before attributed images and survive continuation', () => {
  const raw=request([{role:'user',content:'read four images'},...['A','B','C','D'].map(call),
    ...['D','B','A','C'].map((id,i)=>result(id,[i])),
    {role:'assistant',content:'compared four images'},{role:'user',content:'continue'},
    call('E'),result('E',[4,5]),{role:'user',content:'retry with the same history'},
  ]), before=structuredClone(raw);
  const chat=convertRequest(raw,'responses','chat');
  assert.deepEqual(chat.messages.map(m=>m.role),['user','assistant','tool','tool','tool','tool','user','assistant','user','assistant','tool','user','user']);
  assert.deepEqual(chat.messages[1].tool_calls.map(c=>c.id),['A','B','C','D']);
  assert.deepEqual(chat.messages.slice(2,6).map(m=>m.tool_call_id),['D','B','A','C']);
  const attachments=chat.messages[6].content;
  assert.deepEqual(attachments.filter(p=>p.type==='text').map(p=>p.text),['Images from tool call D:','Images from tool call B:','Images from tool call A:','Images from tool call C:']);
  assert.deepEqual(urls(chat.messages),[0,1,2,3,4,5].map(image));
  assert.equal(chat.parallel_tool_calls,true);
  assert.deepEqual(convertRequest(raw,'responses','chat'),chat);
  assert.deepEqual(raw,before);
});

test('mixed text and image results preserve complete batches across Messages and Chat', () => {
  const raw=request([{role:'user',content:'compare'},call('A'),call('B'),call('C'),result('C',[0,1]),result('A'),result('B',[2])]);
  const messages=convertRequest(raw,'responses','messages');
  assert.deepEqual(messages.messages.map(m=>m.role),['user','assistant','user']);
  assert.deepEqual(messages.messages[2].content.map(b=>b.tool_use_id),['C','A','B']);
  const fromMessages=convertRequest(messages,'messages','chat');
  const direct=convertRequest(raw,'responses','chat');
  assert.deepEqual(fromMessages.messages,direct.messages);
  const back=convertRequest(messages,'messages','responses');
  const outputs=back.input.filter(m=>m.type==='function_call_output');
  assert.deepEqual(outputs.map(m=>m.call_id),['C','A','B']);
  assert.deepEqual(outputs[0].output,[{type:'input_text',text:'result C'},...[0,1].map(n=>({type:'input_image',detail:'auto',image_url:image(n)}))]);
  assert.equal(outputs[1].output,'result A');
  assert.deepEqual(outputs[2].output,[{type:'input_text',text:'result B'},{type:'input_image',detail:'auto',image_url:image(2)}]);
  assert.equal(fromMessages.parallel_tool_calls,true);
});

test('parallel text results do not create extra attachment messages', () => {
  const chat=convertRequest(request([call('A'),call('B'),result('B'),result('A')]),'responses','chat');
  assert.deepEqual(chat.messages.map(m=>m.role),['assistant','tool','tool']);
});

test('user image input is also retained across conversions',()=>{
  const raw=request([{role:'user',content:[{type:'input_text',text:'look'},{type:'input_image',image_url:image(0)}]}]);
  const chat=convertRequest(raw,'responses','chat');
  assert.deepEqual(urls(chat.messages),[image(0)]);
  const responses=convertRequest(chat,'chat','responses');
  assert.equal(responses.input[0].content[1].image_url,image(0));
});

test('image-only and empty results retain their IDs, placeholders and attachments',()=>{
  const raw=request([call('A'),call('B'),
    {type:'function_call_output',call_id:'B',output:[{type:'input_image',image_url:image(0)}]},
    {type:'function_call_output',call_id:'A',output:[]},
  ]);
  const chat=convertRequest(raw,'responses','chat');
  assert.deepEqual(chat.messages.slice(1,3).map(m=>[m.tool_call_id,m.content]),[['B','(see attached image)'],['A','(no tool output)']]);
  assert.deepEqual(urls(chat.messages),[image(0)]);
});

test('Copilot sends complete parallel image batches with agent and vision headers, and rejects broken history before fetch',async()=>{
  const provider=new CopilotProvider({dataDir:'/unused-fixture',auth:{epoch:1,credential:async()=>({identity:'fixture',token:'fixture',baseUrl:'https://fixture.invalid'})}});
  provider.listModels=async()=>[{id:'fixture',enabled:true,nativeProtocols:['chat'],reasoningEfforts:[]}];
  provider.catalogCache.value={identity:'fixture'};
  const sent=[];
  provider.fetchImpl=async(url,options)=>{
    const body=JSON.parse(options.body);sent.push({url,body,headers:options.headers});
    assert.deepEqual(body.messages.slice(1,5).map(m=>m.role),['tool','tool','tool','tool']);
    assert.equal(body.messages[0].tool_calls.length,4);
    assert.deepEqual(urls(body.messages),[0,1,2,3].map(image));
    return new Response('data: '+JSON.stringify({choices:[{delta:{content:'four images'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
  };
  const raw=request([...['A','B','C','D'].map(call),...['D','B','A','C'].map((id,i)=>result(id,[i]))]);
  const output=await provider.execute({raw,protocol:'responses'},{});
  assert.equal(output.response.status,200);await output.response.body.cancel();
  assert.equal(sent[0].headers['X-Initiator'],'agent');assert.equal(sent[0].headers['copilot-vision-request'],'true');
  assert.equal(sent[0].body.parallel_tool_calls,true);
  await assert.rejects(provider.execute({raw:request([call('A')]),protocol:'responses'},{}),e=>e.code==='invalid_tool_sequence');
  assert.equal(sent.length,1);provider.close();
});

test('Copilot native tool image results preserve payloads and agent/vision semantics',async()=>{
  const provider=new CopilotProvider({dataDir:'/unused-fixture',auth:{epoch:1,credential:async()=>({identity:'fixture',token:'fixture',baseUrl:'https://fixture.invalid'})}});
  provider.listModels=async()=>[{id:'fixture',enabled:true,nativeProtocols:['responses','messages'],reasoningEfforts:[]}];
  provider.catalogCache.value={identity:'fixture'};
  let calls=0;
  for(const protocol of ['responses','messages']) {
    const original=request([call('A'),call('B'),result('B',[0]),result('A',[1])]);
    const raw=protocol==='responses'?original:convertRequest(original,'responses','messages');
    provider.fetchImpl=async(_url,options)=>{
      calls++;assert.deepEqual(JSON.parse(options.body),raw);
      assert.equal(options.headers['X-Initiator'],'agent');assert.equal(options.headers['copilot-vision-request'],'true');
      return new Response('fixture');
    };
    const output=await provider.execute({raw,protocol},{});await output.response.body.cancel();
  }
  assert.equal(calls,2);provider.close();
});

test('conversion rejects incomplete, duplicate, orphaned and interrupted tool batches locally', () => {
  const cases=[
    [call('A')], [call('A'),call('A'),result('A')], [result('orphan')],
    [call('A'),result('A'),result('A')],
    [call('A'),call('B'),result('A'),{role:'user',content:'interrupted'},result('B')],
    [call('A'),result('wrong')],
  ];
  for(const input of cases)for(const target of ['chat','messages']) {
    assert.throws(()=>convertRequest(request(input),'responses',target),error=>error.status===400&&error.code==='invalid_tool_sequence'&&error.param==='input'&&error.retryable===false);
  }
  const badChat={model:'fixture',max_tokens:64,messages:[{role:'tool',tool_call_id:'missing',content:'orphan'}]};
  assert.throws(()=>convertRequest(badChat,'chat','responses'),e=>e.code==='invalid_tool_sequence'&&e.param==='messages');
  // Native protocols retain opaque state/continuation semantics.
  assert.deepEqual(convertRequest(request([result('upstream-state')]),'responses','responses'),request([result('upstream-state')]));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {once} from 'node:events';
import {createNetworkFetch,proxyOptions} from '../proxy/shared/network.js';
import {operationError} from '../proxy/shared/operation-error.js';

test('native system proxy works without shell variables and local management always bypasses it',async t=>{
 const upstream=http.createServer((req,res)=>res.end('authorized-service'));
 const proxy=http.createServer();let tunnels=0;
 upstream.listen(0,'127.0.0.1');proxy.listen(0,'127.0.0.1');
 await Promise.all([once(upstream,'listening'),once(proxy,'listening')]);
 proxy.on('connect',(req,socket,head)=>{
  tunnels++;assert.equal(req.url,'auth-provider.test:80');
  const remote=net.connect(upstream.address().port,'127.0.0.1',()=>{
   socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
   if(head.length)remote.write(head);socket.pipe(remote).pipe(socket);
  });
  socket.on('error',()=>remote.destroy());remote.on('error',()=>socket.destroy());socket.on('close',()=>remote.destroy());
 });
 const network=createNetworkFetch({env:{DAYLIGHT_SYSTEM_PROXY:JSON.stringify({httpProxy:`http://127.0.0.1:${proxy.address().port}`})}});
 t.after(async()=>{await network.close();upstream.closeAllConnections();upstream.close();proxy.close();});
 assert.equal(await(await network.fetch('http://auth-provider.test/oauth')).text(),'authorized-service');
 assert.equal(await(await network.fetch(`http://127.0.0.1:${upstream.address().port}/management`)).text(),'authorized-service');
 assert.equal(tunnels,1);
});

test('proxy configuration honors explicit environment overrides and tolerates absent native settings',()=>{
 const system=JSON.stringify({httpProxy:'http://system.test:8000',httpsProxy:'http://secure.test:8001',noProxy:'.local'});
 const options=proxyOptions({DAYLIGHT_SYSTEM_PROXY:system,HTTP_PROXY:'http://env.test:8002',https_proxy:'http://lower.test:8003',NO_PROXY:'internal.test'});
 assert.equal(options.httpProxy,'http://env.test:8002');assert.equal(options.httpsProxy,'http://lower.test:8003');
 assert.match(options.noProxy,/127.0.0.1/);assert.match(options.noProxy,/internal.test/);
 assert.equal(proxyOptions({DAYLIGHT_SYSTEM_PROXY:'invalid'}).httpProxy,'');
 assert.equal(proxyOptions({DAYLIGHT_SYSTEM_PROXY:system,HTTP_PROXY:'',HTTPS_PROXY:''}).httpsProxy,'');
});

test('authorization errors identify TLS, connectivity and keychain failures without exposing transport secrets',()=>{
 const privateMessage='https://example.test/token?code=private-code&access_token=private-token';
 for(const [code,pattern] of [['UNABLE_TO_GET_ISSUER_CERT_LOCALLY',/TLS 证书/],['ECONNREFUSED',/代理是否运行/],['UND_ERR_CONNECT_TIMEOUT',/超时/]]){
  const result=operationError(new TypeError(privateMessage,{cause:Object.assign(new Error(privateMessage),{code})}));
  assert.match(result,pattern);assert.doesNotMatch(result,/private-/);
 }
 assert.equal(operationError(Object.assign(new Error('钥匙串认证失败'),{code:'EKEYCHAIN_AUTH_FAILED'})),'钥匙串认证失败');
 assert.doesNotMatch(operationError(new Error(privateMessage)),/private-/);
});

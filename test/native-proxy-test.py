"""Actual packaged Swift -> local Node helper -> gateway, against a fake upstream."""
import http.server
import json
import os
import pathlib
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request

root = pathlib.Path(__file__).resolve().parent.parent
binary = pathlib.Path(os.environ.get('DAYLIGHT_NATIVE_TEST_BINARY', str(root / 'dist/native/Daylight.app/Contents/MacOS/Daylight')))

def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]

class Upstream(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_GET(self):
        payload = {'usageType': 'credits', 'orgResourcePackage': {'used': 38, 'remaining': 25962, 'cap': 26000, 'available': True}} if self.path.endswith('/quota/usage') else {'assistant': [{'key': 'test-model', 'format': 'openai'}]}
        data = json.dumps(payload).encode()
        self.send_response(200); self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)
    def do_POST(self):
        self.rfile.read(int(self.headers.get('Content-Length', '0')))
        first = ('data: ' + json.dumps({'body': json.dumps({'choices': [{'delta': {'reasoning_content': '思' * 20}}]})}) + '\n\n').encode()
        last = ('data: ' + json.dumps({'body': json.dumps({'choices': [{'delta': {'content': 'native-ok' + '中' * 80}}], 'usage': {'prompt_tokens': 10, 'completion_tokens': 50}})}) + '\n\nevent: finish\ndata: {}\n\n').encode()
        self.send_response(200); self.send_header('Content-Type', 'text/event-stream'); self.send_header('Content-Length', str(len(first) + len(last))); self.end_headers()
        self.wfile.write(first); self.wfile.flush(); time.sleep(.3); self.wfile.write(last)

upstream = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
threading.Thread(target=upstream.serve_forever, daemon=True).start()
with tempfile.TemporaryDirectory(prefix='daylight-native-proxy-') as tmp:
    directory = pathlib.Path(tmp); (directory / 'qoder').mkdir()
    (directory / 'qoder/account.json').write_text(json.dumps({'id': 'test', 'credential': {'uid': 'test', 'access': 'test-access', 'refresh': 'test-refresh', 'expires': int(time.time()*1000)+3600000, 'machineId': 'test', 'machineToken': 'test'}}))
    port, proxy_port = free_port(), free_port()
    base = f'http://127.0.0.1:{port}'
    process, token = None, ''
    env = {**os.environ, 'PORT': str(port), 'WORKBENCH_DATA_DIR': tmp, 'QODER_COMPAT_URL': f'http://127.0.0.1:{upstream.server_port}'}
    def request(route, body=None, headers=None):
        req = urllib.request.Request(base + route, data=None if body is None else json.dumps(body).encode(), headers=headers if headers is not None else {'x-workbench-token': token, 'Origin': base, 'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(req, timeout=40) as res:
                data = res.read(); return res.status, json.loads(data) if 'application/json' in res.headers['Content-Type'] else data
        except urllib.error.HTTPError as err:
            return err.code, json.loads(err.read())
    def boot():
        global process, token
        process = subprocess.Popen([str(binary), '--headless'], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        for _ in range(100):
            try:
                token = request('/api/state')[1]['token']
                status = request('/api/qoder/status')[1]
                if status.get('node'): return status
            except (OSError, urllib.error.URLError): pass
            time.sleep(.1)
        raise AssertionError('native helper not ready')
    def stop():
        if process and process.poll() is None:
            process.terminate(); process.wait(timeout=5)
        for _ in range(50):
            with socket.socket() as sock:
                if sock.connect_ex(('127.0.0.1', proxy_port)) != 0: return
            time.sleep(.1)
        raise AssertionError('gateway survived native parent exit')
    try:
        status = boot(); assert status['native'] and status['state'] == 'stopped'
        assert request('/api/qoder/status', headers={})[0] == 403
        assert request('/api/proxy/status')[1]['native']
        for route in ['/api/proxy/status', '/api/proxy/sources', '/api/proxy/requests', '/api/proxy/view']:
            assert request(route)[0] == 200
            assert request(route, headers={})[0] == 403
            assert request(route, headers={'x-workbench-token': token, 'Origin': 'https://example.com'})[0] == 403
        assert request('/components/proxy-diagnostics.js')[0] == 404
        assert request('/api/qoder/status', headers={'x-workbench-token': token, 'Origin': 'https://example.com'})[0] == 403
        assert request('/proxy.html')[0] == 200
        assert request('/api/qoder/credits', headers={})[0] == 403
        assert request('/api/qoder/credits')[1]['buckets'] == [{'id': 'organization', 'label': '团队资源包', 'used': 38, 'remaining': 25962, 'total': 26000}]
        assert request('/api/qoder/settings', {'port': proxy_port, 'autoStart': True})[0] == 200
        assert request('/api/qoder/service', {'enabled': True})[1]['state'] == 'running'
        before_settings = (directory / 'qoder/service.json').read_bytes()
        assert request('/api/proxy/view', {'version': 0, 'hiddenSources': ['agy', 'kimi']}) == (200, {'version': 1, 'hiddenSources': ['agy', 'kimi']})
        assert request('/api/proxy/status')[1]['state'] == 'running'
        assert (directory / 'qoder/service.json').read_bytes() == before_settings
        assert request('/api/proxy/view', {'version': 0, 'hiddenSources': []})[0] == 409
        assert request('/proxy/source-navigation.js')[0] == 200
        assert request('/api/qoder/runtime', {'nodePath': '/missing/node'})[0] == 409
        key = request('/api/qoder/key')[1]['apiKey']
        req = urllib.request.Request(f'http://127.0.0.1:{proxy_port}/v1/chat/completions', data=json.dumps({'model': 'test-model', 'messages': [{'role': 'user', 'content': 'hi'}], 'stream': True}).encode(), headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'})
        with urllib.request.urlopen(req) as res: assert 'native-ok' in res.read().decode()
        rows = request('/api/proxy/requests')[1]['records']
        assert rows[0]['outcome'] == 'completed' and rows[0]['httpStatus'] == 200
        measurement = rows[0]['generationSpeed']
        assert measurement['outputTokens'] == 50 and not measurement['estimated'] and measurement['timing'] == 'stream'
        assert measurement['tokensPerSecond'] > 0 and measurement['durationMs'] >= 250
        sources = request('/api/proxy/sources')[1]['sources']
        speeds = next(source for source in sources if source['id'] == 'qoder')['performance']
        assert len(speeds) == 1 and speeds[0]['model'] == 'test-model' and speeds[0]['samples'] == 1
        usage = next(source for source in sources if source['id'] == 'qoder')['modelUsage']
        assert usage == [{'model': 'test-model', 'requests': 1}]
        summary = request('/api/proxy/statistics')[1]
        assert summary['retention'] == 'permanent' and 'details' not in summary
        assert summary['summary']['requests'] == 1 and summary['summary']['totalTokens'] == 60
        assert '思' not in json.dumps(rows, ensure_ascii=False) and 'native-ok' not in json.dumps(rows)
        assert request('/api/qoder/test', {})[0] == 200
        stop(); boot()
        assert request('/api/proxy/view')[1] == {'version': 1, 'hiddenSources': ['agy', 'kimi']}
        for _ in range(50):
            if request('/api/qoder/status')[1]['state'] == 'running': break
            time.sleep(.1)
        assert request('/api/qoder/status')[1]['state'] == 'running'
        speeds = next(source for source in request('/api/proxy/sources')[1]['sources'] if source['id'] == 'qoder')['performance']
        assert len(speeds) == 1 and speeds[0]['samples'] == 1
        usage = next(source for source in request('/api/proxy/sources')[1]['sources'] if source['id'] == 'qoder')['modelUsage']
        assert usage == [{'model': 'test-model', 'requests': 1}], 'Manual tests must not affect frequency after restart'
        assert request('/api/proxy/statistics')[1]['summary']['requests'] == 1, 'Daily aggregates must survive restart without replay duplication'
        assert request('/api/qoder/service', {'enabled': False})[0] == 200
        assert request('/api/qoder/settings', {'port': proxy_port, 'autoStart': False})[0] == 200
        assert request('/api/qoder/runtime', {'nodePath': '/missing/node'})[0] == 400
        assert request('/api/state')[0] == 200
        assert request('/api/qoder/status')[1]['runtimeError']
        assert request('/api/qoder/runtime', {'nodePath': ''})[0] == 200
        assert request('/api/qoder/status')[1]['state'] == 'stopped'
        print('Native proxy PASS: Node discovery, lifecycle, auth, streaming, passive TPS with Chinese usage and restart persistence, auto-start, parent cleanup, missing-Node recovery, task isolation')
    finally:
        stop(); upstream.shutdown()

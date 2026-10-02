"""Packaged Swift -> authenticated Node helper -> isolated Pi configuration."""
import hashlib
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
binary = root / 'dist/native/Daylight.app/Contents/MacOS/Daylight'

class Upstream(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_GET(self):
        payload = {'assistant': []}
        data = json.dumps(payload).encode()
        self.send_response(200); self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)

upstream = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
threading.Thread(target=upstream.serve_forever, daemon=True).start()
with tempfile.TemporaryDirectory(prefix='daylight-native-cli-') as tmp:
    directory = pathlib.Path(tmp); (directory / 'qoder').mkdir()
    pi = directory / 'pi'; pi.mkdir()
    before_models = json.dumps({'providers': {'other': {'api': 'openai-completions', 'apiKey': 'test-other', 'models': [{'id': 'keep'}]}}}).encode()
    before_settings = json.dumps({'defaultProvider': 'other', 'defaultModel': 'keep', 'defaultThinkingLevel': 'high'}).encode()
    (pi / 'models.json').write_bytes(before_models); (pi / 'settings.json').write_bytes(before_settings)
    node = subprocess.check_output(['node', '-p', 'process.execPath'], text=True).strip()
    (directory / 'qoder/runtime.json').write_text(json.dumps({'nodePath': node}))
    (directory / 'qoder/account.json').write_text(json.dumps({'id': 'test', 'credential': {'uid': 'test', 'access': 'test-access', 'refresh': 'test-refresh', 'expires': int(time.time()*1000)+3600000, 'machineId': 'test', 'machineToken': 'test'}}))
    (directory / 'custom-proxy').mkdir()
    (directory / 'custom-proxy/sources.json').write_text(json.dumps([{'id': 'test', 'name': 'CLI Test', 'baseUrl': 'https://example.invalid/v1', 'protocol': 'messages', 'auth': 'none', 'enabled': True, 'models': [{'id': 'cli-model', 'upstreamId': 'upstream-model', 'enabled': True, 'contextWindow': 256000, 'maxOutputTokens': 32000}]}]))
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
    base = f'http://127.0.0.1:{port}'
    env = {**os.environ, 'PORT': str(port), 'WORKBENCH_DATA_DIR': tmp, 'HOME': tmp, 'PI_CODING_AGENT_DIR': str(pi), 'QODER_COMPAT_URL': f'http://127.0.0.1:{upstream.server_port}'}
    process, token = None, ''
    def request(route, body=None, headers=None):
        req = urllib.request.Request(base + route, data=None if body is None else json.dumps(body).encode(), headers=headers if headers is not None else {'x-workbench-token': token, 'Origin': base, 'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(req, timeout=45) as res:
                data = res.read(); return res.status, json.loads(data) if 'application/json' in res.headers['Content-Type'] else data
        except urllib.error.HTTPError as err:
            return err.code, json.loads(err.read())
    def boot():
        global process, token
        process = subprocess.Popen([str(binary), '--headless'], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        for _ in range(100):
            try:
                token = request('/api/state')[1]['token']
                if request('/api/qoder/status')[1].get('node'): return
            except (OSError, urllib.error.URLError): pass
            time.sleep(.1)
        raise AssertionError('native helper not ready')
    def stop():
        if process and process.poll() is None:
            process.terminate(); process.wait(timeout=5)
    try:
        boot()
        for asset in ['/cli-config.js', '/cli-config.css', '/components/action-links.js']:
            assert request(asset)[0] == 200
        assert request('/api/cli/pi/state', headers={})[0] == 403
        assert request('/api/cli/pi/state', headers={'x-workbench-token': token, 'Origin': 'https://example.com'})[0] == 403
        state = request('/api/cli/pi/state')[1]
        assert state['pi']['modelsPath'] == str(pi / 'models.json')
        assert state['models'][0]['id'] == 'cli-model'
        code, result = request('/api/cli/pi/configuration', {'expectedVersion': state['version'], 'modelOverrides': {'cli-model': {'contextWindow': 999999, 'maxTokens': 65432, 'reasoning': True, 'thinkingLevelMap': {'max': 'high'}}}})
        assert code == 200, result
        assert (pi / 'models.json').read_bytes() == before_models
        for index, api in enumerate(['openai-responses', 'openai-completions', 'anthropic-messages']):
            state = request('/api/cli/pi/state?api=' + api)[1]
            selected = {'api': api, 'defaultModel': 'cli-model'}
            code, plan = request('/api/cli/pi/prepare', selected); assert code == 200, plan
            assert plan['config']['providers']['daylight']['apiKey'] == '<本地代理 Key>'
            assert plan['config']['providers']['daylight']['models'][0]['api'] == api
            assert (pi / 'models.json').read_bytes() == before_models
            body = {**selected, 'expectedVersion': state['version'], 'requestId': f'native-import-{index}'}
            code, result = request('/api/cli/pi/apply', body); assert code == 200, result
            saved = json.loads((pi / 'models.json').read_text())
            assert saved['providers']['daylight']['models'][0]['api'] == api
            assert saved['providers']['daylight']['models'][0]['contextWindow'] == 999999
            assert saved['providers']['daylight']['models'][0]['maxTokens'] == 65432
            assert saved['providers']['daylight']['models'][0]['thinkingLevelMap']['max'] == 'high'
            assert saved['providers']['other']['models'][0]['id'] == 'keep'
            assert json.loads((pi / 'settings.json').read_text())['defaultModel'] == 'cli-model'
            assert request('/api/cli/pi/apply', body)[1]['replayed']
            assert (pi / 'models.json').stat().st_mode & 0o777 == 0o600
            if index == 0:
                assert request('/api/cli/pi/automatic', {**body, 'enabled': True, 'expectedVersion': request('/api/cli/pi/state')[1]['version'], 'requestId': 'native-auto'})[0] == 200
                stop(); boot()
                assert request('/api/cli/pi/state')[1]['automatic']['enabled']
            assert request('/api/cli/pi/restore', {})[0] == 200
            assert not request('/api/cli/pi/state')[1]['automatic']['enabled']
            assert (pi / 'models.json').read_bytes() == before_models
            assert (pi / 'settings.json').read_bytes() == before_settings
        print('Native CLI PASS: authentication, packaged assets, full catalog sync, all APIs, explicit default, idempotency, automatic switch/restart, exact restore')
    finally:
        stop(); upstream.shutdown()

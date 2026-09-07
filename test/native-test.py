"""Integration checks against the actual packaged native HTTP/JavaScriptCore runtime."""
import json
import os
import pathlib
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import uuid

root = pathlib.Path(__file__).resolve().parent.parent
binary = root / 'dist/native/Daylight.app/Contents/MacOS/Daylight'
with tempfile.TemporaryDirectory(prefix='daylight-native-test-') as tmp:
    directory = pathlib.Path(tmp)
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    url = f'http://127.0.0.1:{port}'
    process = None
    def request(path, body=None, method=None, headers=None):
        req = urllib.request.Request(url + path, data=None if body is None else (body if isinstance(body, bytes) else json.dumps(body).encode()), method=method, headers=headers or {})
        try:
            with urllib.request.urlopen(req, timeout=3) as response:
                data = response.read()
                return response.status, json.loads(data) if 'application/json' in response.headers['Content-Type'] else data
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read())
    def stop():
        if process and process.poll() is None:
            process.terminate(); process.wait(timeout=5)
    def boot():
        global process
        process = subprocess.Popen([str(binary), '--headless'], env={**os.environ, 'PORT': str(port), 'WORKBENCH_DATA_DIR': tmp}, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        for _ in range(200):
            if process.poll() is not None:
                raise AssertionError(process.stderr.read().decode())
            try:
                return request('/api/state')[1]
            except (OSError, urllib.error.URLError):
                time.sleep(0.1)
        raise AssertionError('server not ready')
    try:
        initial = boot()
        assert initial['state'] == {'schema': 1, 'projects': [], 'tasks': [], 'plans': {}}
        stop()
        fixture = subprocess.check_output(['node', '--input-type=module', '-e', "import {fixtureState} from './test/fixtures.mjs'; console.log(JSON.stringify({version:0,state:fixtureState()}))"], cwd=root)
        (directory / 'state.json').write_bytes(fixture)
        boot()
        token = (directory / 'agent-token').read_text().strip()
        headers = {'Authorization': 'Bearer ' + token}
        def post(action, version, request_id=None):
            return request('/api/v1/actions', {'expectedVersion': version, 'requestId': request_id or str(uuid.uuid4()), 'action': action}, headers=headers)
        assert (directory / 'agent-token').stat().st_mode & 0o777 == 0o600
        assert request('/api/v1/state')[0] == 401
        assert request('/api/v1/state', headers={**headers, 'Origin': 'https://example.com'})[0] == 401
        assert request('/api/v1/capabilities', headers=headers)[1]['apiVersion'] == 1
        assert request('/api/v1/actions', b'{broken', headers=headers)[0] == 400
        assert request('/skills/daylight-workbench/SKILL.md')[0] == 404
        assert request('/.local/agent-token')[0] == 404
        for path in ['/', '/app.js', '/components/select.js', '/components/select.css']:
            assert request(path)[0] == 200
        action = {'type': 'task.create', 'title': '原生运行时任务', 'projectId': 'project-a'}
        request_id = str(uuid.uuid4())
        status, created = post(action, 0, request_id)
        assert status == 200, created
        assert len(created['state']['tasks']) == 9 and created['version'] == 1
        assert post(action, 0, request_id)[1]['replayed']
        assert post(action, 0)[0] == 409
        assert post({'type': 'task.delete', 'id': 'task-1'}, 0, request_id)[0] == 409
        stop(); boot()
        assert post(action, 0, request_id)[1]['replayed']
        assert post({'type': 'batch', 'actions': [action, {'type': 'plan.add', 'id': 'missing'}]}, 1)[0] == 400
        assert request('/api/v1/state', headers=headers)[1]['version'] == 1
        assert len(post({'type': 'undo'}, 1)[1]['state']['tasks']) == 8
        batch = {'type': 'batch', 'actions': [
            {'type': 'project.create', 'id': 'p', 'name': '临时项目'},
            {'type': 'project.update', 'id': 'p', 'path': '/tmp/test'},
            {'type': 'task.create', 'id': 't', 'title': '临时任务', 'projectId': 'p'},
            {'type': 'task.update', 'id': 't', 'notes': '备注'},
            {'type': 'task.status', 'id': 't', 'status': 'active'},
            {'type': 'plan.set', 'ids': ['t', 'task-1']},
            {'type': 'plan.move', 'id': 't', 'direction': 1},
            {'type': 'plan.remove', 'id': 't'},
            {'type': 'task.status', 'id': 't', 'status': 'done'},
            {'type': 'task.delete', 'id': 't'},
            {'type': 'project.delete', 'id': 'p'}]}
        assert post(batch, 2)[0] == 200
        current = request('/api/state')[1]
        web_headers = {'Origin': url, 'X-Workbench-Token': current['token'], 'If-Match': str(current['version'])}
        assert request('/api/state', current['state'], 'PUT')[0] == 403
        assert request('/api/state', current['state'], 'PUT', {**web_headers, 'If-Match': '0'})[0] == 409
        assert request('/api/state', current['state'], 'PUT', web_headers)[0] == 200
        client = root / 'skills/daylight-workbench/scripts/workbench.py'
        result = subprocess.check_output(['python3', str(client), '--url', url, '--data-dir', tmp, 'state', '--view', 'all'])
        assert len(json.loads(result)['state']['tasks']) == 8
        # Existing Node receipts must still replay after switching to the native runtime.
        stop()
        seed = "import {createWorkbench} from './server.mjs'; const s=await createWorkbench({dataDir:process.env.WORKBENCH_DATA_DIR}); await new Promise(r=>s.listen(0,'127.0.0.1',r)); const fs=await import('node:fs/promises');const t=await fs.readFile(process.env.WORKBENCH_DATA_DIR+'/agent-token','utf8');const b=JSON.parse(process.env.TEST_REQUEST); const r=await fetch('http://127.0.0.1:'+s.address().port+'/api/v1/actions',{method:'POST',headers:{Authorization:'Bearer '+t},body:JSON.stringify(b)});if(!r.ok)throw Error(await r.text());await new Promise(r=>s.close(r));"
        node_body = {'expectedVersion': 4, 'requestId': str(uuid.uuid4()), 'action': {'type': 'task.create', 'title': '跨运行时重试'}}
        subprocess.run(['node', '--input-type=module', '-e', seed], cwd=root, env={**os.environ, 'WORKBENCH_DATA_DIR': tmp, 'TEST_REQUEST': json.dumps(node_body, ensure_ascii=False)}, check=True)
        boot()
        assert request('/api/v1/actions', node_body, headers=headers)[1]['replayed']
        stop()
        (directory / 'state.json').write_text('{broken')
        process = subprocess.Popen([str(binary), '--headless'], env={**os.environ, 'PORT': str(port), 'WORKBENCH_DATA_DIR': tmp}, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        assert process.wait(timeout=15) != 0
        assert (directory / 'state.json').read_text() == '{broken'
        print('PASS: native CRUD, batch atomicity, auth, web writes, restart, cross-runtime receipts, external skill, corruption protection')
    finally:
        stop()

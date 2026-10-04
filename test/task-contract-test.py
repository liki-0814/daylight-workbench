"""Run the same observable HTTP contract against Node and the actual native binary."""
import hashlib
import json
import os
import pathlib
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

root = pathlib.Path(__file__).resolve().parent.parent
cases = json.loads((root / 'test/task-contract.json').read_text())
legacy = {'expectedVersion': 0, 'requestId': 'legacy-receipt-000', 'action': {'type': 'task.create', 'title': '旧回执'}}
legacy_raw = json.dumps(legacy, ensure_ascii=False, separators=(',', ':'))

def normalized(value):
    if isinstance(value, dict):
        # Runtime-specific auth messages and clock values are intentionally excluded.
        return {k: normalized(v) for k, v in value.items() if k not in ('error', 'token', 'localDate', 'completedAt')}
    if isinstance(value, list):
        return [normalized(v) for v in value]
    return value

def run(command):
    with tempfile.TemporaryDirectory(prefix='daylight-contract-') as tmp:
        directory = pathlib.Path(tmp)
        seed = {'version': 0, 'state': {'schema': 1, 'projects': [], 'tasks': [], 'plans': {}}, 'receipts': [
            {'requestId': legacy['requestId'], 'fingerprint': hashlib.sha256(legacy_raw.encode()).hexdigest(), 'appliedVersion': 0}]}
        (directory / 'state.json').write_text(json.dumps(seed))
        (directory / 'agent-token').write_text('a' * 64)
        (directory / 'agent-token').chmod(0o600)
        # Task contracts must work without Node sidecars; their lifecycle has its own suite.
        (directory / 'qoder').mkdir()
        (directory / 'qoder/runtime.json').write_text(json.dumps({'nodePath':'/missing/contract-node'}))
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
        url, process = f'http://127.0.0.1:{port}', None
        def stop():
            if process and process.poll() is None:
                process.terminate(); process.wait(timeout=10)
        def request(case):
            headers = {} if case.get('auth') == 'none' else {'Authorization': 'Bearer ' + ('b' * 64 if case.get('auth') == 'wrong' else 'a' * 64)}
            headers.update(case.get('headers', {}))
            payload = case.get('body')
            data = case.get('raw', json.dumps(payload, ensure_ascii=False) if payload is not None else None)
            req = urllib.request.Request(url + case['path'], data=None if data is None else data.encode(), method=case.get('method', 'GET'), headers=headers)
            try:
                response = urllib.request.urlopen(req, timeout=5)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                content = response.read()
                return response.code, json.loads(content) if 'application/json' in response.headers.get('Content-Type', '') else len(content) > 0
        def boot():
            nonlocal process
            process = subprocess.Popen(command, cwd=root, env={**os.environ, 'PORT': str(port), 'WORKBENCH_DATA_DIR': tmp}, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            for _ in range(200):
                if process.poll() is not None: raise AssertionError(process.stderr.read().decode())
                try:
                    if request({'path': '/api/state'})[0] == 200: return
                except OSError: pass
                time.sleep(0.05)
            raise AssertionError('runtime did not start')
        results = []
        try:
            boot()
            for index, case in enumerate(cases):
                if case.get('restart'): stop(); boot()
                code, value = request(case)
                assert code == case['code'], (command[0], index, case['name'], code, value)
                for key, expected in case.get('expect', {}).items():
                    assert value.get(key) == expected, (case['name'], key, value)
                results.append((code, normalized(value)))
            assets = json.loads((root / 'core/web-assets.json').read_text())
            for path in assets:
                code, content = request({'path': path})
                assert code == 200 and content, (path, code)
            record = json.loads((directory / 'state.json').read_text())
            assert record['version'] == 5 and len(record['state']['projects']) == len(record['state']['tasks']) == 1
            assert record['state']['tasks'][0]['status'] == 'done'
            results.append(normalized(record))
            return results
        finally: stop()

node = run(['node', str(root / 'server.mjs')])
native = run([str(root / 'dist/native/Daylight.app/Contents/MacOS/Daylight'), '--headless'])
assert node == native, [(i, a, b) for i, (a, b) in enumerate(zip(node, native)) if a != b]
print(f'Node/native contract passed: {len(cases)} cases, restarts, legacy receipts, persisted state and all shared assets')

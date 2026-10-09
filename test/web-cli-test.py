"""Source Web entry -> installed CLI discovery. No App build or model inference."""
import datetime
import json
import os
import pathlib
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

root = pathlib.Path(__file__).resolve().parent.parent
report = {'testedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'entry': 'npm run web -- --no-open', 'buildRequired': False, 'results': [], 'inference': False, 'isolatedWrites': True}
with tempfile.TemporaryDirectory(prefix='daylight-web-cli-') as temporary:
    directory = pathlib.Path(temporary)
    agents = directory / 'agents'
    skill = agents / 'skills/web-fixture/SKILL.md'
    skill.parent.mkdir(parents=True)
    content = '---\nname: web-fixture\ndescription: Web source verification\n---\nFixture'
    skill.write_text(content)
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    base = f'http://127.0.0.1:{port}'
    environment = {**os.environ, 'PORT': str(port), 'WORKBENCH_DATA_DIR': str(directory / 'data'), 'WORKBENCH_AGENTS_ROOT': str(agents), 'WORKBENCH_EXTENSION_CLIENT_ROOTS': json.dumps({name: str(directory / name) for name in ['codex', 'qoder', 'pi']}), 'PI_CODING_AGENT_DIR': str(directory / 'pi')}
    process = subprocess.Popen(['npm', 'run', 'web', '--', '--no-open'], cwd=root, env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)

    def request(route, body=None, token=None):
        headers = {'X-Workbench-Token': token, 'Origin': base} if token else {}
        req = urllib.request.Request(base + route, data=json.dumps(body).encode() if body is not None else None, headers=headers)
        try:
            response = urllib.request.urlopen(req, timeout=60)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.code, json.load(response)

    try:
        for _ in range(200):
            if process.poll() is not None:
                raise AssertionError('Web process exited before readiness')
            try:
                status, state = request('/api/state')
                assert status == 200
                break
            except OSError:
                time.sleep(.05)
        else:
            raise AssertionError('Web readiness timed out')
        token = state['token']
        assert request('/api/ai/settings')[0] == 403
        status, sources = request('/api/extensions/state', token=token)
        assert status == 200 and len(sources['skills']) == 1, sources
        assert sources['skills'][0]['name'] == 'web-fixture'
        assert not (directory / 'data/ai').exists()
        report['extensionSource'] = 'passed: fixture read; AIStore remains lazy'
        for backend in ['codex', 'qoder']:
            status, result = request('/api/ai/discover', {'backend': backend, 'path': '', 'force': True}, token)
            assert status == 200 and result.get('models'), f'{backend} discovery failed: {result.get("error", status)}'
            report['results'].append({'backend': backend, 'status': 'passed', 'models': len(result['models']), 'skills': len(result.get('skills', []))})
            print(f'PASS: source Web {backend} discovery ({len(result["models"])} models)')
        assert request('/api/state')[1]['version'] == 0
        assert skill.read_text() == content
        assert not any((directory / name).exists() for name in ['codex', 'qoder', 'pi'])
        print('PASS: actual npm Web entry, independent task data, lazy extension source and no Daylight client-config writes')
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
        try:
            process.communicate(timeout=15)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.communicate(timeout=5)
if len(sys.argv) > 1:
    destination = pathlib.Path(sys.argv[1])
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')

"""The same extension contract against Node and the actual packaged Swift/helper runtime."""
import json
import os
import pathlib
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import uuid

root = pathlib.Path(__file__).resolve().parent.parent
binary = root / 'dist/native/Daylight.app/Contents/MacOS/Daylight'


def run(command):
    with tempfile.TemporaryDirectory(prefix='daylight-extension-contract-') as temporary:
        directory = pathlib.Path(temporary).resolve()
        agents = directory / 'agents'
        clients = {name: str(directory / name) for name in ['codex', 'qoder', 'pi']}
        data = directory / 'data'; data.mkdir(); (data / 'agent-token').write_text('a' * 64)
        (data / 'qoder').mkdir(); (data / 'qoder/runtime.json').write_text(json.dumps({'nodePath': shutil.which('node')}))
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
        base = f'http://127.0.0.1:{port}'
        environment = {**os.environ, 'PORT': str(port), 'WORKBENCH_DATA_DIR': str(data), 'WORKBENCH_AGENTS_ROOT': str(agents), 'WORKBENCH_EXTENSION_CLIENT_ROOTS': json.dumps(clients)}
        process = subprocess.Popen(command, cwd=root, env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        token = None

        def request(route, body=None, auth='agent', origin=True, method=None):
            headers = {'Authorization': 'Bearer ' + 'a' * 64} if auth == 'agent' else {'X-Workbench-Token': token} if auth == 'web' else {}
            if origin: headers['Origin'] = base
            req = urllib.request.Request(base + route, data=json.dumps(body).encode() if body is not None else None, method=method, headers=headers)
            try: response = urllib.request.urlopen(req, timeout=30)
            except urllib.error.HTTPError as error: response = error
            with response:
                return response.code, json.load(response) if 'application/json' in response.headers.get('Content-Type', '') else response.read()

        def apply(action, request_id=None):
            code, plan = request('/api/v1/extensions/prepare', {'action': action})
            assert code == 200, (code, plan)
            body = {'requestId': request_id or str(uuid.uuid4()), 'expectedVersion': plan['expectedVersion'], 'planId': plan['planId'], 'action': plan['normalizedAction']}
            code, value = request('/api/extensions/actions', body, auth='web')
            assert code == 200, (code, value)
            assert request('/api/v1/extensions/actions', body)[1] == value
            return value, body

        try:
            for _ in range(200):
                if process.poll() is not None: raise AssertionError(process.stderr.read().decode())
                try:
                    code, initial = request('/api/state', auth='none'); token = initial['token']; break
                except OSError: time.sleep(.05)
            assert token
            assert request('/api/extensions/state', auth='none')[0] == 403
            assert request('/api/v1/extensions/unknown', auth='none')[0] == 401
            assert request('/api/v1/extensions/unknown')[0] == 404
            assert request('/api/extensions/prepare', {'action': {}}, auth='web', origin=False)[0] == 403
            assert request('/api/extensions/state', {}, auth='web')[0] == 404
            code, state = request('/api/v1/extensions/state'); assert code == 200, state
            assert state['skills'] == [] and not agents.exists() and not (data / 'ai').exists()
            assert next(client for client in state['clients'] if client['id'] == 'codex')['root'] == clients['codex']
            assert request('/api/v1/capabilities')[1]['extensions']['clients'] == ['codex', 'qoder', 'pi']
            for asset in ['page.js', 'client.js', 'controller.js', 'review.js', 'extensions.css']:
                assert request('/extensions/' + asset, auth='none')[0] == 200
            content = '---\nname: contract-skill\ndescription: 合同测试\n---\nFixture'
            result, original = apply({'type': 'skill.create', 'directory': 'contract-skill', 'content': content})
            skill_id = result['changedIds'][0]
            assert (agents / 'skills/contract-skill/SKILL.md').read_text() == content
            assert request('/api/v1/extensions/objects/' + skill_id)[1]['content'] == content
            assert not pathlib.Path(clients['codex']).exists() and not pathlib.Path(clients['pi']).exists()
            apply({'type': 'binding.connect', 'id': skill_id, 'clientId': 'codex'})
            assert not pathlib.Path(clients['codex']).exists()
            apply({'type': 'binding.connect', 'id': skill_id, 'clientId': 'qoder'})
            link = pathlib.Path(clients['qoder']) / 'skills/contract-skill'
            assert link.is_symlink() and link.resolve() == agents / 'skills/contract-skill'
            apply({'type': 'binding.disconnect', 'id': skill_id, 'clientId': 'qoder'})
            relative = os.path.relpath(agents / 'skills/contract-skill', link.parent)
            link.symlink_to(relative)
            assert request('/api/v1/extensions/prepare', {'action': {'type': 'binding.disconnect', 'id': skill_id, 'clientId': 'qoder'}})[1]['conflicts']
            removed, _ = apply({'type': 'binding.disconnect', 'id': skill_id, 'clientId': 'qoder', 'includeExisting': True})
            assert not link.is_symlink() and (agents / 'skills/contract-skill/SKILL.md').read_text() == content
            apply({'type': 'operation.restore', 'operationId': removed['operationId']})
            assert os.readlink(link) == relative
            apply({'type': 'binding.adopt', 'id': skill_id, 'clientId': 'qoder'})
            archived, _ = apply({'type': 'skill.archive', 'id': skill_id})
            assert not link.is_symlink() and request('/api/v1/extensions/state')[1]['skills'] == []
            apply({'type': 'operation.restore', 'operationId': archived['operationId']})
            assert link.is_symlink()
            server = {'id': 'local-fixture', 'name': '本地 MCP', 'transport': 'stdio', 'command': shutil.which('node'), 'args': [str(root / 'fixtures/extensions/mcp-server.mjs'), str(directory / 'mcp-log')], 'envRefs': {}}
            apply({'type': 'mcp.save', 'server': server})
            apply({'type': 'mcp.generate', 'clientId': 'codex'})
            assert (agents / 'mcp/generated/codex/servers.toml').exists()
            assert not (pathlib.Path(clients['codex']) / 'config.toml').exists()
            detected, _ = apply({'type': 'mcp.probe', 'id': server['id']})
            for _ in range(200):
                code, probe = request('/api/v1/extensions/probes/' + detected['probeId'])
                assert code == 200, (code, probe)
                if probe.get('finishedAt'): break
                time.sleep(.05)
            assert probe['status'] == 'succeeded' and probe['toolCount'] == 2, probe
            assert (directory / 'mcp-log').read_text() == 'tools/list\ntools/list\n'
            assert request('/api/state', auth='none')[1]['version'] == 0
            assert request('/api/v1/focus/state')[1]['version'] == 0
            assert not (data / 'ai').exists(), 'extension browse/probe initialized AIStore'
            print('PASS: extension auth, lazy helper, packaged assets, primary directories, Skill links/existing-link removal/restore, MCP generation and real probe', command[0])
            return {'clients': [client['id'] for client in state['clients']], 'skillId': skill_id, 'probeTools': probe['toolCount']}
        finally:
            process.terminate(); process.wait(timeout=10); process.stderr.close()


assert run(['node', str(root / 'server.mjs')]) == run([str(binary), '--headless'])
print('PASS: identical Node/native extension contract')

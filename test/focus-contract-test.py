"""Actual Node/native focus contracts in disposable data directories; no GUI or user data."""
import datetime
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
cases = json.loads((root / 'test/focus-contract.json').read_text())
baseline = 1577872800000  # 2020-01-01 10:00 UTC; deliberately long before recovery.


def task_state(status='todo', completed=None):
    return {'schema': 1, 'projects': [{'id': 'project-a', 'name': '测试项目', 'path': '', 'color': 'green'}],
            'tasks': [] if status == 'deleted' else [{'id': 'task-a', 'title': '测试任务', 'projectId': 'project-a', 'notes': '', 'status': status, 'completedAt': completed}], 'plans': {}}


def focus_record():
    return {'schema': 1, 'version': 0, 'settings': {'workSeconds': 1500, 'shortBreakSeconds': 300, 'notificationsEnabled': True, 'soundEnabled': True, 'showTrayTimer': True, 'statisticsTimeZone': 'UTC'}, 'current': None, 'sessions': [], 'lastOutcome': None, 'receipts': []}


def current(started=baseline, paused=False):
    return {'id': 'session-fixture', 'phase': 'work', 'status': 'paused' if paused else 'running', 'clockIssue': None,
            'timeQuality': 'wall_clock', 'taskId': 'task-a', 'taskTitleSnapshot': '测试任务', 'projectIdSnapshot': 'project-a', 'projectNameSnapshot': '测试项目',
            'targetMs': 1500000, 'startedAt': started, 'deadlineAt': None if paused else started + 1500000,
            'remainingMs': 1200000 if paused else None, 'segments': [{'startAt': started, 'endAt': started + 300000 if paused else None}], 'pauseCount': 1 if paused else 0}


class Runtime:
    def __init__(self, command, task=None, focus=None):
        self.command = command
        self.temporary = tempfile.TemporaryDirectory(prefix='daylight-focus-contract-')
        self.directory = pathlib.Path(self.temporary.name)
        (self.directory / 'state.json').write_text(json.dumps({'version': 0, 'state': task or task_state()}))
        (self.directory / 'focus.json').write_text(json.dumps(focus or focus_record()))
        (self.directory / 'agent-token').write_text('a' * 64)
        (self.directory / 'agent-token').chmod(0o600)
        (self.directory / 'qoder').mkdir()
        (self.directory / 'qoder/runtime.json').write_text(json.dumps({'nodePath': '/missing/focus-contract-node'}))
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0)); self.port = sock.getsockname()[1]
        self.url = f'http://127.0.0.1:{self.port}'
        self.process = None

    def request(self, path, body=None, method=None, auth='agent', extra=None):
        headers = {'Authorization': 'Bearer ' + 'a' * 64} if auth == 'agent' else {'X-Workbench-Token': self.web_token, 'Origin': self.url} if auth == 'web' else {}
        headers.update(extra or {})
        data = None if body is None else body if isinstance(body, bytes) else json.dumps(body).encode()
        req = urllib.request.Request(self.url + path, data=data, method=method, headers=headers)
        try: response = urllib.request.urlopen(req, timeout=10)
        except urllib.error.HTTPError as error: response = error
        with response: return response.code, json.load(response)

    def boot(self):
        self.process = subprocess.Popen(self.command, cwd=root, env={**os.environ, 'PORT': str(self.port), 'WORKBENCH_DATA_DIR': str(self.directory)}, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        for _ in range(200):
            if self.process.poll() is not None: raise AssertionError(self.process.stderr.read().decode())
            try:
                code, value = self.request('/api/state', auth='none')
                if code == 200: self.web_token = value['token']; return
            except OSError: pass
            time.sleep(.05)
        raise AssertionError('runtime did not start')

    def stop(self):
        if self.process and self.process.poll() is None: self.process.terminate(); self.process.wait(timeout=10)
        if self.process: self.process.stderr.close()

    def close(self):
        self.stop(); self.temporary.cleanup()

    def action(self, action, version, task_version=None, request_id=None, auth='agent'):
        body = {'requestId': request_id or str(uuid.uuid4()), 'expectedVersion': version, 'action': action}
        if task_version is not None: body['expectedTaskVersion'] = task_version
        return self.request('/api/focus/actions' if auth == 'web' else '/api/v1/focus/actions', body, auth=auth), body


def recovery_contracts(command):
    results = []
    for case in cases:
        completed = datetime.datetime.fromtimestamp((baseline + case.get('completedMinutes', 0)*60000)/1000, datetime.timezone.utc).isoformat() if case['task'] == 'done' else None
        record = focus_record(); record['current'] = current(paused=case.get('paused', False))
        runtime = Runtime(command, task_state(case['task'], completed), record)
        try:
            runtime.boot()
            code, snapshot = runtime.request('/api/v1/focus/state')
            assert code == 200 and snapshot['current'] is None, (case, code, snapshot)
            outcome = snapshot['lastOutcome']
            assert outcome['endReason'] == case['expectedReason'] and outcome['elapsedMs'] == case['expectedElapsedMs'], (case, outcome)
            code, report = runtime.request('/api/v1/focus/statistics?from=2020-01-01&to=2020-01-01')
            assert code == 200 and report['summary']['completedRounds'] == case['expectedRounds'] and report['summary']['workElapsedMs'] == case['expectedElapsedMs'], (case, code, report)
            code, exported = runtime.request('/api/v1/focus/export')
            assert code == 200 and 'receipts' not in exported and len(exported['sessions']) == 1
            runtime.stop(); runtime.boot()
            assert runtime.request('/api/v1/focus/state')[1]['version'] == snapshot['version']
            results.append((outcome['endReason'], outcome['elapsedMs'], report['summary']))
        finally: runtime.close()
    return results


def lifecycle_contract(command):
    runtime = Runtime(command)
    try:
        runtime.boot()
        assert runtime.request('/api/v1/focus/state', auth='none')[0] == 401
        assert runtime.request('/api/focus/state', auth='none')[0] == 403
        assert runtime.request('/api/v1/focus/state?unexpected=1')[0] == 400
        assert runtime.request('/api/v1/focus/sessions?limit=1&limit=2')[0] == 400
        assert runtime.request('/api/v1/focus/statistics?from=2020-01-01&to=2022-01-01')[0] == 400
        assert runtime.request('/api/v1/focus/actions', b'{broken')[0] == 400
        before = runtime.request('/api/v1/focus/state')[1]
        prepared = runtime.request('/api/v1/focus/prepare', {'action': {'type': 'focus.start', 'phase': 'work', 'taskId': 'task-a'}})
        assert prepared[0] == 200 and prepared[1]['focusVersion'] == 0
        assert runtime.request('/api/v1/focus/state')[1]['version'] == before['version']
        (code, started), original = runtime.action({'type': 'focus.start', 'phase': 'work', 'taskId': 'task-a'}, 0, 0, auth='web')
        assert code == 200, started
        sid = started['current']['id']; version = started['version']
        assert runtime.request('/api/v1/state')[1]['version'] == 0
        replay = runtime.request('/api/v1/focus/actions', original)
        assert replay[0] == 200 and replay[1]['replayed'] and replay[1]['version'] == version
        runtime.stop(); runtime.boot()
        assert runtime.request('/api/v1/focus/actions', original)[1]['replayed']
        assert runtime.action({'type': 'focus.start', 'phase': 'work', 'taskId': 'task-a'}, version, 0)[0][0] == 409
        (code, paused), _ = runtime.action({'type': 'focus.pause', 'sessionId': sid}, version)
        assert code == 200 and paused['current']['status'] == 'paused', paused
        (code, resumed), _ = runtime.action({'type': 'focus.resume', 'sessionId': sid}, paused['version'])
        assert code == 200 and resumed['current']['status'] == 'running', resumed
        # Failed durable save leaves authoritative record and original request retryable.
        previous = runtime.directory / 'focus.previous.json'
        previous.unlink(); previous.mkdir()
        (code, failed), finish_request = runtime.action({'type': 'focus.finish', 'sessionId': sid}, resumed['version'])
        assert code == 503 and failed['code'] == 'FOCUS_SAVE_FAILED', (code, failed)
        assert failed['version'] == resumed['version'], failed
        assert str(runtime.directory) not in failed['error'], failed
        assert runtime.request('/api/v1/focus/state')[1]['current']['id'] == sid
        previous.rmdir()
        finished = runtime.request('/api/v1/focus/actions', finish_request)
        assert finished[0] == 200 and finished[1]['current'] is None
        assert runtime.request('/api/v1/focus/actions', finish_request)[1]['replayed']
        summary = runtime.request('/api/v1/focus/task-summary?taskId=task-a&recentLimit=1')
        assert summary[0] == 200
        for filename in ['focus.json', 'focus.previous.json']:
            assert (runtime.directory / filename).stat().st_mode & 0o777 == 0o600
        # Task commit succeeds even if its independent focus archive fails.
        focus_version = finished[1]['version']
        (code, started2), _ = runtime.action({'type': 'focus.start', 'phase': 'work', 'taskId': 'task-a'}, focus_version, 0)
        assert code == 200, started2
        previous.unlink(); previous.mkdir()
        task_write = runtime.request('/api/v1/actions', {'requestId': str(uuid.uuid4()), 'expectedVersion': 0, 'action': {'type': 'task.status', 'id': 'task-a', 'status': 'done'}})
        assert task_write[0] == 200 and task_write[1]['warnings'][0]['code'] == 'FOCUS_RECONCILE_PENDING', task_write
        previous.rmdir(); runtime.stop(); runtime.boot()
        recovered = runtime.request('/api/v1/focus/state')[1]
        assert recovered['current'] is None and recovered['lastOutcome']['endReason'] == 'task_completed'
        # Corrupt independent focus storage does not stop task service or overwrite evidence.
        runtime.stop(); (runtime.directory / 'focus.json').write_text('{broken'); runtime.boot()
        assert runtime.request('/api/v1/state')[0] == 200
        assert runtime.request('/api/v1/focus/state')[0] == 503
        assert (runtime.directory / 'focus.json').read_text() == '{broken'
    finally: runtime.close()


def rollback_contract(command):
    record = focus_record(); record['current'] = current(started=3786948000000)  # 2090, before any plausible test clock.
    runtime = Runtime(command, focus=record)
    try:
        runtime.boot()
        state = runtime.request('/api/v1/focus/state')[1]
        assert state['current']['status'] == 'paused' and state['current']['clockIssue']['code'] == 'CLOCK_CHANGED'
        (code, finished), _ = runtime.action({'type': 'focus.finish', 'sessionId': 'session-fixture'}, state['version'])
        assert code == 200 and finished['lastOutcome']['elapsedMs'] == 0
        (code, conflict), _ = runtime.action({'type': 'focus.start', 'phase': 'work', 'taskId': 'task-a'}, finished['version'], 0)
        assert code == 409 and conflict['code'] == 'CLOCK_CHANGED', conflict
    finally: runtime.close()


def pending_task_context_contract(command):
    runtime = Runtime(command)
    try:
        runtime.boot()
        (code, started), _ = runtime.action({'type': 'focus.start', 'phase': 'work', 'taskId': 'task-a'}, 0, 0)
        assert code == 200
        previous = runtime.directory / 'focus.previous.json'
        previous.unlink(); previous.mkdir()
        done = runtime.request('/api/v1/actions', {'requestId': str(uuid.uuid4()), 'expectedVersion': 0, 'action': {'type': 'task.status', 'id': 'task-a', 'status': 'done'}})
        assert done[0] == 200 and done[1]['warnings'][0]['code'] == 'FOCUS_RECONCILE_PENDING', done
        completed_at = done[1]['state']['tasks'][0]['completedAt']
        undone = runtime.request('/api/v1/actions', {'requestId': str(uuid.uuid4()), 'expectedVersion': 1, 'action': {'type': 'undo'}})
        assert undone[0] == 200 and undone[1]['state']['tasks'][0]['status'] == 'todo', undone
        # A later task undo cannot erase the earlier committed completion awaiting archive.
        previous.rmdir()
        recovered = runtime.request('/api/v1/focus/state')[1]
        assert recovered['current'] is None and recovered['lastOutcome']['endReason'] == 'task_completed', recovered
        assert recovered['lastOutcome']['endedAt'] == round(datetime.datetime.fromisoformat(completed_at.replace('Z', '+00:00')).timestamp()*1000), recovered
        assert runtime.request('/api/v1/state')[1]['version'] == 2
    finally: runtime.close()


commands = [['node', str(root / 'server.mjs')], [str(binary), '--headless']]
results = []
for command in commands:
    results.append(recovery_contracts(command))
    lifecycle_contract(command)
    rollback_contract(command)
    pending_task_context_contract(command)
assert results[0] == results[1], results
print('PASS: Node/native focus recovery arbitration, pause/resume/finish, restart receipts, save faults, task warnings, corruption isolation and clock freeze')

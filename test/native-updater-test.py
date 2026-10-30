"""End-to-end check of the in-app updater against two real builds and a local mock of GitHub Releases.

Needs macOS plus two signed builds of the same identity (see docs/updates.md, "Testing the updater"):
  DAYLIGHT_TEST_APP_OLD   Daylight.app of the older version, built with an isolated bundle id
  DAYLIGHT_TEST_APP_NEW   Daylight.app of the newer version, same bundle id and signing identity
  DAYLIGHT_TEST_UPDATE_DIR  output of scripts/release/package-update.mjs for the NEW build
Everything runs in a temporary directory on random local ports. The installed /Applications copy and
~/Library/Application Support/Daylight are never touched. GUI windows of the test copies open briefly.
"""
import hashlib
import http.server
import json
import os
import pathlib
import plistlib
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

old_app = os.environ.get('DAYLIGHT_TEST_APP_OLD'); new_app = os.environ.get('DAYLIGHT_TEST_APP_NEW'); update_dir = os.environ.get('DAYLIGHT_TEST_UPDATE_DIR')
if sys.platform != 'darwin' or not (old_app and new_app and update_dir):
    print('skipped: set DAYLIGHT_TEST_APP_OLD, DAYLIGHT_TEST_APP_NEW and DAYLIGHT_TEST_UPDATE_DIR on macOS to run the updater flow'); sys.exit(0)
old_app, new_app, update_dir = pathlib.Path(old_app), pathlib.Path(new_app), pathlib.Path(update_dir)
version_of = lambda app: plistlib.loads((app / 'Contents/Info.plist').read_bytes())['CFBundleShortVersionString']
OLD, NEW = version_of(old_app), version_of(new_app)
manifest_text = (update_dir / 'latest-mac.json').read_text()
manifest = json.loads(manifest_text)
assert manifest['version'] == NEW, 'update dir does not match the NEW build'
zip_name = f'Daylight-{NEW}-arm64.zip'
zip_bytes = (update_dir / zip_name).read_bytes()
signature = (update_dir / 'latest-mac.json.sig').read_bytes()

def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0)); return sock.getsockname()[1]

class Mock(http.server.BaseHTTPRequestHandler):
    state = {'tag': NEW, 'tamper_zip': False, 'bad_signature': False, 'hits': []}
    def log_message(self, *args): pass
    def send(self, body, kind='application/octet-stream', status=200):
        self.send_response(status); self.send_header('Content-Type', kind); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        state = self.state; state['hits'].append(self.path)
        if self.path == '/releases/latest':
            base = f'https://github.com/liki-0814/daylight-workbench/releases/download/v{NEW}/'
            assets = [{'name': zip_name, 'browser_download_url': base + zip_name, 'size': len(zip_bytes), 'digest': 'sha256:' + hashlib.sha256(zip_bytes).hexdigest()},
                      {'name': 'latest-mac.json', 'browser_download_url': base + 'latest-mac.json', 'size': len(manifest_text)},
                      {'name': 'latest-mac.json.sig', 'browser_download_url': base + 'latest-mac.json.sig', 'size': len(signature)},
                      {'name': f'Daylight-{NEW}-arm64.dmg', 'browser_download_url': base + f'Daylight-{NEW}-arm64.dmg', 'size': 10}]
            self.send(json.dumps({'tag_name': 'v' + state['tag'], 'name': state['tag'], 'html_url': f'https://github.com/liki-0814/daylight-workbench/releases/tag/v{state["tag"]}', 'published_at': '2026-10-30T00:00:00Z', 'body': '## 更新\n- 测试发布', 'draft': False, 'prerelease': False, 'assets': assets}).encode(), 'application/json')
        elif self.path.endswith('/' + zip_name):
            data = bytearray(zip_bytes)
            if state['tamper_zip']: data[len(data) // 2] ^= 0xFF
            self.send(bytes(data))
        elif self.path.endswith('/latest-mac.json'): self.send(manifest_text.encode(), 'application/json')
        elif self.path.endswith('/latest-mac.json.sig'):
            data = bytearray(signature)
            if state['bad_signature']: data[10] = ord('A') if data[10] != ord('A') else ord('B')
            self.send(bytes(data))
        else: self.send(b'missing', status=404)
mock = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Mock)
threading.Thread(target=mock.serve_forever, daemon=True).start()
base = f'http://127.0.0.1:{mock.server_address[1]}'

root = pathlib.Path(tempfile.mkdtemp(prefix='daylight-updater-test-'))
procs = []
def checked(condition, message):
    if not condition: raise AssertionError(message)
    print('✓', message)

class Instance:
    """One isolated copy of the app: its own install location, data directory and port."""
    def __init__(self, name, source=old_app, extra_env=None):
        self.dir = root / name; self.apps = self.dir / 'Apps'; self.data = self.dir / 'data'; self.port = free_port()
        self.apps.mkdir(parents=True); self.data.mkdir()
        self.app = self.apps / 'Daylight.app'
        subprocess.check_call(['ditto', str(source), str(self.app)])
        self.env = {'WORKBENCH_DATA_DIR': str(self.data), 'PORT': str(self.port), 'DAYLIGHT_UPDATE_TEST_BASE': base, 'DAYLIGHT_HELPER_WAIT': '20', 'DAYLIGHT_HELPER_HEALTH': '40', **(extra_env or {})}
        self.url = f'http://127.0.0.1:{self.port}'; self.updates = self.data / 'updates'
    def executable(self): return str(self.app / 'Contents/MacOS/Daylight')
    def pids(self):
        out = subprocess.run(['pgrep', '-f', self.executable()], capture_output=True, text=True).stdout.split()
        return [int(pid) for pid in out]
    def start(self):
        process = subprocess.Popen([self.executable(), '--isolated-gui'], env={**os.environ, **self.env}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); procs.append(process)
        threading.Thread(target=process.wait, daemon=True).start()  # reap it: a zombie would look like a live parent to the updater
        self.wait_ready(); return process
    def wait_ready(self, timeout=40):
        end = time.time() + timeout
        while time.time() < end:
            try: self.state(); return
            except (OSError, urllib.error.URLError, KeyError): time.sleep(0.2)
        raise AssertionError('app did not come up on ' + self.url)
    def state(self):
        with urllib.request.urlopen(self.url + '/api/state', timeout=3) as response: self.token = json.loads(response.read())['token']
        return self.get()
    def call(self, body=None):
        request = urllib.request.Request(self.url + '/api/app/updater', data=None if body is None else json.dumps(body).encode(), headers={'x-workbench-token': self.token, 'Content-Type': 'application/json', **({'Origin': self.url} if body is not None else {})}, method='GET' if body is None else 'POST')
        try:
            with urllib.request.urlopen(request, timeout=5) as response: return response.status, json.loads(response.read())
        except urllib.error.HTTPError as error: return error.code, json.loads(error.read())
    def get(self): return self.call()[1]
    def check(self):
        request = urllib.request.Request(self.url + '/api/app/update?refresh=1', headers={'x-workbench-token': self.token})
        with urllib.request.urlopen(request, timeout=15) as response: return json.loads(response.read())
    def post(self, **body): return self.call(body)
    def wait(self, predicate, timeout=60, what='state'):
        end = time.time() + timeout; last = None
        while time.time() < end:
            try: last = self.state()
            except (OSError, urllib.error.URLError, KeyError, ValueError): last = None
            if last and predicate(last): return last
            time.sleep(0.4)
        log = self.updates / 'helper.log'
        raise AssertionError(f'timed out waiting for {what}; last={json.dumps(last)[:600]}; helper.log=' + (log.read_text()[-1500:] if log.exists() else 'none'))
    def installed_version(self): return version_of(self.app)
    def quit(self):
        for pid in self.pids():
            try: os.kill(pid, signal.SIGKILL)
            except ProcessLookupError: pass
        time.sleep(0.5)

def wait_until(fn, timeout=60, what='condition'):
    end = time.time() + timeout
    while time.time() < end:
        value = fn()
        if value: return value
        time.sleep(0.4)
    raise AssertionError('timed out waiting for ' + what)

def verify(app):
    return subprocess.run(['codesign', '--verify', '--strict', '--deep', str(app)], capture_output=True).returncode == 0

instances = []
try:
    # 1. Download, verify, install, relaunch, health, backup.
    a = Instance('flow'); instances.append(a); a.start()
    status = a.wait(lambda s: s.get('reason') != 'checking', 30, 'environment check')
    checked(status['supported'] is True and status['current']['signing'] == 'self-signed' and status['current']['version'] == OLD and status['phase'] == 'idle', f'{OLD} reports an in-app-capable signed build {json.dumps(status)[:400]}')
    checked(status['mode'] == 'notify', 'default mode is notify-only')
    release = a.check()
    checked(release['status'] == 'available' and release['latest']['install']['ok'] is True, f'release check finds {NEW} with a verified-installable package {json.dumps(release)[:300]}')
    code, answer = a.post(action='download')
    checked(code == 200, f'download request accepted {json.dumps(answer)[:300]}')
    ready = a.wait(lambda s: s['phase'] == 'ready' or s.get('error'), 60, 'download')
    checked(ready['phase'] == 'ready' and ready['staged']['version'] == NEW, f'{NEW} downloaded, verified and extracted')
    folder = a.updates / NEW
    checked(oct(folder.stat().st_mode & 0o777) == '0o700', 'update directory is private (0700)')
    xattrs = subprocess.run(['xattr', '-lr', str(folder)], capture_output=True, text=True).stdout
    checked('com.apple.quarantine' not in xattrs, 'downloaded payload carries no quarantine flag')
    checked(verify(folder / 'extract/Daylight.app'), 'staged app passes codesign --strict --deep')
    old_pids = a.pids()
    code, answer = a.post(action='install')
    checked(code == 200, f'install request accepted {json.dumps(answer)[:300]}')
    wait_until(lambda: not set(old_pids) & set(a.pids()), 40, 'old process to exit')
    result = a.wait(lambda s: s['current']['version'] == NEW and s.get('lastResult'), 90, 'new version to report healthy')
    checked(a.installed_version() == NEW and verify(a.app), f'installed bundle is {NEW} and validly signed')
    checked(result['lastResult']['status'] == 'success' and result['backup']['version'] == OLD, f'result success; {OLD} kept as the single backup')
    checked(not (a.updates / NEW).exists(), 'staged files are cleaned after success')
    # 2. Manual rollback.
    code, answer = a.post(action='rollback'); checked(code == 200, 'rollback request accepted')
    rolled = a.wait(lambda s: s['current']['version'] == OLD and s.get('lastResult', {}).get('kind') == 'rollback', 90, 'rollback')
    checked(a.installed_version() == OLD and rolled['lastResult']['status'] == 'success', f'manual rollback returned to {OLD}')
    checked(any(item.get('to') == NEW for item in rolled['history']), 'history records the earlier update')
    a.quit()

    # 3. Rejections leave the installed app untouched.
    b = Instance('reject'); instances.append(b); b.start()
    Mock.state['tamper_zip'] = True
    b.check(); b.post(action='download'); failed = b.wait(lambda s: s.get('error'), 60, 'tampered download to fail')
    checked(failed['phase'] == 'idle' and b.installed_version() == OLD, f'tampered package rejected ({failed["error"]["code"]}); app unchanged')
    Mock.state['tamper_zip'] = False; Mock.state['bad_signature'] = True
    # A forged manifest is refused already at the release check, so there is nothing to download.
    b.post(action='ack'); release = b.check(); code, answer = b.post(action='download')
    install = release['latest']['install']
    checked(install.get('ok') is False and install.get('code') == 'bad-signature' and code == 409 and b.get()['phase'] == 'idle', f'forged manifest signature rejected at check ({install.get("code")}); download refused ({code})')
    Mock.state['bad_signature'] = False; Mock.state['tag'] = OLD
    b.post(action='ack'); b.check(); code, answer = b.post(action='download')
    time.sleep(2); same = b.get()
    checked(same['phase'] == 'idle' and not (b.updates / OLD).exists(), 'same-version release is not downloaded')
    Mock.state['tag'] = NEW
    b.quit()

    # 4. A build that never reports healthy is rolled back automatically.
    c = Instance('health', extra_env={'DAYLIGHT_HELPER_HEALTH': '0.2'}); instances.append(c); c.start()
    c.check(); c.post(action='download'); c.wait(lambda s: s['phase'] == 'ready', 60, 'download')
    c.post(action='install')
    outcome = c.wait(lambda s: s['current']['version'] == OLD and s.get('lastResult', {}).get('status') == 'rolled-back', 90, 'automatic rollback')
    checked(c.installed_version() == OLD and verify(c.app), 'unhealthy new build was rolled back to the old one automatically')
    c.quit()

    # 5. Quit-time installs: the helper without a relaunch validates the new build headlessly before declaring success.
    d = Instance('quit'); instances.append(d)
    d.updates.mkdir(parents=True); staging = d.updates / NEW / 'extract'; staging.mkdir(parents=True)
    subprocess.check_call(['ditto', str(new_app), str(staging / 'Daylight.app')])
    helper = d.dir / 'DaylightUpdater'; shutil.copy(old_app / 'Contents/Resources/DaylightUpdater', helper)
    dead = subprocess.Popen(['/usr/bin/true']); dead.wait()
    code = subprocess.run([str(helper), '--mode', 'install', '--parent-pid', str(dead.pid), '--target', str(d.app), '--source', str(staging / 'Daylight.app'), '--backup-dir', str(d.updates / 'backup'), '--updates-dir', str(d.updates), '--expected-version', NEW, '--from-version', OLD, '--bundle-id', plistlib.loads((d.app / 'Contents/Info.plist').read_bytes())['CFBundleIdentifier'], '--relaunch', '0', '--wait-seconds', '5'], capture_output=True, timeout=120).returncode
    result = json.loads((d.updates / 'last-result.json').read_text())
    checked(code == 0 and result['status'] == 'success' and d.installed_version() == NEW and verify(d.app), 'quit-time (no relaunch) install swaps, smoke-tests and succeeds')
    checked(not d.pids(), 'quit-time install does not leave an app running')

    # 6. An ad-hoc build cannot self-update; it is told to install the DMG once.
    e = Instance('adhoc'); instances.append(e)
    subprocess.check_call(['codesign', '--force', '--deep', '-s', '-', str(e.app)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    e.start(); adhoc = e.wait(lambda s: s.get('reason') != 'checking', 30, 'environment check')
    checked(adhoc['supported'] is False and adhoc.get('reason') == 'adhoc', 'ad-hoc signed build reports unsupported (adhoc) and keeps the DMG path: ' + json.dumps({k: adhoc.get(k) for k in ('supported', 'reason', 'message')}) + ' ' + adhoc['current']['signing'])
    e.quit()
    print('PASS native updater')
finally:
    for instance in instances: instance.quit()
    for process in procs:
        if process.poll() is None: process.kill()
    mock.shutdown(); shutil.rmtree(root, ignore_errors=True)

"""Packaged native routing, AI sidecar and installed-format Skill deletion, without inference."""
import json, os, pathlib, socket, subprocess, tempfile, time, uuid, urllib.request, urllib.error
root = pathlib.Path(__file__).resolve().parent.parent
binary = root / 'dist/native/Daylight.app/Contents/MacOS/Daylight'
client = root / 'skills/daylight-workbench/scripts/workbench.py'
with tempfile.TemporaryDirectory(prefix='daylight-native-conversations-') as tmp:
    directory = pathlib.Path(tmp)
    records = directory / 'ai/conversations'; records.mkdir(parents=True)
    cid = str(uuid.uuid4()); updated = '2026-10-03T00:00:00.000Z'
    (records / (cid + '.json')).write_text(json.dumps({'id':cid,'title':'隔离测试记录','backend':'codex','config':{'model':'test'},'scope':{'kind':'workspace'},'status':'idle','messages':[],'createdAt':updated,'updatedAt':updated}))
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
    base = f'http://127.0.0.1:{port}'; process = None
    def request(route, headers=None):
        try:
            with urllib.request.urlopen(urllib.request.Request(base+route,headers=headers or {}),timeout=10) as r: return r.status,json.load(r)
        except urllib.error.HTTPError as e: return e.code,json.loads(e.read())
    def cli(*args):
        return json.loads(subprocess.check_output(['python3',str(client),'--url',base,'--data-dir',tmp,*args]))
    def boot():
        global process
        process=subprocess.Popen([str(binary),'--headless'],env={**os.environ,'PORT':str(port),'WORKBENCH_DATA_DIR':tmp},stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
        for _ in range(100):
            try: return request('/api/state')[1]
            except OSError: time.sleep(.1)
        raise RuntimeError('Native startup timed out')
    def stop():
        if process and process.poll() is None: process.terminate(); process.wait(timeout=10)
    try:
        web=boot(); before=cli('state')
        assert request('/api/v1/ai/state')[0]==401
        bearer={'Authorization':'Bearer '+(directory/'agent-token').read_text().strip()}
        assert request('/api/v1/ai/state',{**bearer,'Origin':'https://example.com'})[0]==401
        assert cli('capabilities')['aiConversations']['operations']==['ai.conversation.delete']
        snapshot=cli('conversations'); assert snapshot['conversations'][0]['id']==cid
        assert request('/api/ai/state',{'X-Workbench-Token':web['token']})[1]['version']==snapshot['version']
        args=['delete-conversation','--id',cid,'--updated-at',updated,'--expected-version',snapshot['version'],'--request-id',str(uuid.uuid4())]
        assert cli(*args)['ok']
        assert not (records/(cid+'.json')).exists()
        assert cli('conversations')['conversations']==[]
        assert cli('state')['state']==before['state']
        stop(); boot()
        assert cli(*args)['ok']; assert cli('conversations')['conversations']==[]
        print('PASS: native AI routing, Bearer/Origin auth, Skill deletion, unchanged tasks, restart replay')
    finally: stop()

"""Packaged Swift -> AI helper -> local CLI discovery. No model inference."""
import json, os, pathlib, socket, subprocess, tempfile, time, urllib.request, urllib.error
root = pathlib.Path(__file__).resolve().parent.parent
with tempfile.TemporaryDirectory(prefix='daylight-native-ai-') as tmp:
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
    base = f'http://127.0.0.1:{port}'
    process = subprocess.Popen([str(root/'dist/native/Daylight.app/Contents/MacOS/Daylight'), '--headless'], env={**os.environ,'PORT':str(port),'WORKBENCH_DATA_DIR':tmp}, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    def request(route, data=None, token=None):
        req = urllib.request.Request(base+route,data=json.dumps(data).encode() if data is not None else None,headers={'X-Workbench-Token':token} if token else {})
        try:
            with urllib.request.urlopen(req,timeout=60) as r: return r.status,json.loads(r.read())
        except urllib.error.HTTPError as e: return e.code,json.loads(e.read())
    try:
        for _ in range(100):
            try: status,state=request('/api/state');break
            except OSError: time.sleep(.1)
        token=state['token']
        assert request('/api/ai/settings')[0]==403
        status,result=request('/api/ai/settings',token=token);assert status==200,result
        for backend in ['codex','qoder']:
            status,result=request('/api/ai/discover',{'backend':backend,'path':''},token)
            assert status==200 and result['models'],result
            print(f'PASS: native {backend} discovery ({len(result["models"])} models)')
        assert request('/api/state')[1]['state']['tasks']==[]
        print('PASS: AI auth and independent task data')
    finally:
        process.terminate();process.wait(timeout=10)

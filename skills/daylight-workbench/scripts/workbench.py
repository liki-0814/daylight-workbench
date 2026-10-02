#!/usr/bin/env python3
"""Local Daylight API client; credentials never enter stdout or CLI arguments."""
import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url')
    parser.add_argument('--data-dir')
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('capabilities')
    state = commands.add_parser('state')
    state.add_argument('--query')
    state.add_argument('--project')
    state.add_argument('--view', choices=['all', 'today', 'inbox', 'done'], default='all')
    state.add_argument('--date')
    tasks = commands.add_parser('tasks', help='统一任务查询；旧 state 命令保持兼容')
    tasks.add_argument('--scope', choices=['all', 'today'], default='all')
    tasks.add_argument('--status', choices=['all', 'open', 'done'], default='all')
    group = tasks.add_mutually_exclusive_group()
    group.add_argument('--project')
    group.add_argument('--unassigned', action='store_true')
    tasks.add_argument('--query')
    tasks.add_argument('--date')
    export = commands.add_parser('export')
    export.add_argument('--out', required=True, help='New output file; existing files are never overwritten')
    apply = commands.add_parser('apply')
    apply.add_argument('--expected-version', type=int, required=True)
    apply.add_argument('--request-id', required=True)
    apply.add_argument('--file', required=True, help='JSON action file, or - for stdin')
    apply.add_argument('--date')
    args = parser.parse_args()
    config = json.loads((Path(__file__).resolve().parents[1] / 'config.json').read_text())
    url = args.url or config['url']
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != 'http' or parsed.hostname != '127.0.0.1' or parsed.username or parsed.password or parsed.path not in ['', '/'] or parsed.query or parsed.fragment:
        raise ValueError('仅允许 http://127.0.0.1:PORT 本机地址')
    # Access .port to validate malformed port values before reading credentials.
    if not parsed.port:
        raise ValueError('地址必须包含端口')
    token_file = Path(args.data_dir or config['data_dir']).expanduser() / 'agent-token'
    token = token_file.read_text().strip()
    route = '/api/v1/capabilities' if args.command == 'capabilities' else '/api/v1/state'
    if args.command == 'tasks':
        params = {'scope': args.scope, 'status': args.status}
        for key, value in [('projectId', args.project), ('query', args.query), ('day', args.date)]:
            if value is not None:
                params[key] = value
        if args.unassigned:
            params['unassigned'] = '1'
        route = '/api/v1/tasks?' + urllib.parse.urlencode(params)
    payload = None
    if args.command == 'apply':
        action = json.load(sys.stdin) if args.file == '-' else json.loads(Path(args.file).expanduser().read_text())
        payload = {'requestId': args.request_id, 'expectedVersion': args.expected_version, 'action': action}
        if args.date:
            payload['day'] = args.date
        route = '/api/v1/actions'
    request = urllib.request.Request(url.rstrip('/') + route,
                                     data=json.dumps(payload, ensure_ascii=False).encode() if payload is not None else None,
                                     headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(request, timeout=15) as response:
            result = json.load(response)
    except urllib.error.HTTPError as error:
        try:
            detail = json.loads(error.read())
        except (ValueError, UnicodeError):
            detail = {'error': '本地接口返回错误'}
        if args.command == 'tasks' and error.code == 404 and detail.get('error') == '接口不存在':
            detail['hint'] = '服务尚不支持统一任务查询，请使用 state --view all|today|inbox|done'
        print(json.dumps({'httpStatus': error.code, **detail}, ensure_ascii=False), file=sys.stderr)
        return 1
    if args.command == 'state':
        tasks = result['state']['tasks']
        projects = {p['id']: p for p in result['state']['projects']}
        date = args.date or result['localDate']
        if args.view == 'today':
            by_id = {task['id']: task for task in tasks}
            tasks = [by_id[tid] for tid in result['state']['plans'].get(date, [])]
        elif args.view == 'inbox':
            tasks = [t for t in tasks if t['projectId'] is None and t['status'] != 'done']
        elif args.view == 'done':
            tasks = [t for t in tasks if t['status'] == 'done']
        if args.project:
            tasks = [t for t in tasks if t['projectId'] == args.project]
        if args.query:
            tasks = [t for t in tasks if args.query.casefold() in (t['title'] + ' ' + t['notes'] + ' ' + projects.get(t['projectId'], {}).get('name', '')).casefold()]
        # Retain the complete authoritative state; filtering is a read-only view.
        result['matchingTasks'] = tasks
    if args.command == 'export':
        output = Path(args.out).expanduser()
        with output.open('x', encoding='utf8') as stream:
            json.dump(result['state'], stream, ensure_ascii=False, indent=2)
        print(json.dumps({'exported': str(output.resolve()), 'version': result['version']}, ensure_ascii=False))
    else:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, urllib.error.URLError) as error:
        print(json.dumps({'error': str(error), 'hint': '检查 config.json 和本地服务；不确定的写操作只用原 request ID 与原参数重试'}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)

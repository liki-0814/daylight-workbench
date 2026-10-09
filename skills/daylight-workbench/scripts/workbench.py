#!/usr/bin/env python3
"""Local Daylight API client; credentials never enter stdout or CLI arguments."""
import argparse
import json
import re
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
    commands.add_parser('extensions-state', help='只读 ~/.agents 扩展来源与接入事实')
    commands.add_parser('extensions-diagnostics', help='静态检查，不启动 MCP')
    extension_detail = commands.add_parser('extension-detail')
    extension_detail.add_argument('--id', required=True)
    extension_detail.add_argument('--file')
    extension_operation = commands.add_parser('extension-operation', help='读取原请求的持久回执')
    extension_operation.add_argument('--id', required=True)
    extension_prepare = commands.add_parser('extensions-prepare', help='预览差异，不写入或启动 MCP')
    extension_prepare.add_argument('--file', required=True)
    extension_apply = commands.add_parser('extensions-apply', help='执行用户已经审阅的扩展动作')
    extension_apply.add_argument('--file', required=True)
    extension_apply.add_argument('--expected-version', required=True)
    extension_apply.add_argument('--plan-id', required=True)
    extension_apply.add_argument('--request-id', required=True)
    calendar = commands.add_parser('calendar', help='最多62天的日期安排与当前状态')
    calendar.add_argument('--from', dest='from_day', required=True)
    calendar.add_argument('--to', dest='to_day', required=True)
    calendar.add_argument('--status', choices=['all', 'open', 'done'], default='all')
    calendar.add_argument('--query')
    commands.add_parser('focus-state')
    stats = commands.add_parser('focus-stats', help='专注计时汇总，最多366天')
    stats.add_argument('--from', dest='from_day', required=True)
    stats.add_argument('--to', dest='to_day', required=True)
    sessions = commands.add_parser('focus-sessions')
    sessions.add_argument('--from', dest='from_day')
    sessions.add_argument('--to', dest='to_day')
    sessions.add_argument('--phase', choices=['work', 'shortBreak'])
    sessions.add_argument('--limit', type=int, default=20)
    sessions.add_argument('--cursor')
    for command in [calendar, stats, sessions]:
        projects = command.add_mutually_exclusive_group()
        projects.add_argument('--project')
        projects.add_argument('--unassigned', action='store_true')
    for command in [stats, sessions]:
        command.add_argument('--task')
    task_focus = commands.add_parser('task-focus', help='任务全历史计时累计')
    task_focus.add_argument('--id', required=True)
    task_focus.add_argument('--recent-limit', type=int, default=5)
    focus_prepare = commands.add_parser('focus-prepare', help='只预览专注动作，不写入')
    focus_prepare.add_argument('--file', required=True)
    focus_apply = commands.add_parser('focus-apply', help='执行用户明确授权的专注动作')
    focus_apply.add_argument('--file', required=True)
    focus_apply.add_argument('--expected-version', type=int, required=True)
    focus_apply.add_argument('--expected-task-version', type=int)
    focus_apply.add_argument('--request-id', required=True)
    focus_apply.add_argument('--expires-at', type=int)
    focus_export = commands.add_parser('focus-export')
    focus_export.add_argument('--out', required=True)
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
    commands.add_parser('conversations', help='读取 AI 会话列表、版本和 updatedAt')
    delete = commands.add_parser('delete-conversation', help='删除明确指定的已结束对话；不可撤销')
    delete.add_argument('--id', required=True)
    delete.add_argument('--updated-at', required=True)
    delete.add_argument('--expected-version', required=True)
    delete.add_argument('--request-id', required=True)
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
    if not re.fullmatch(r'[a-f0-9]{64}', token):
        raise ValueError('本机凭证格式异常，请检查服务数据目录')
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
    focus_commands = ['focus-state', 'focus-stats', 'focus-sessions', 'task-focus', 'focus-prepare', 'focus-apply', 'focus-export']
    extension_commands = ['extensions-state', 'extensions-diagnostics', 'extension-detail', 'extension-operation', 'extensions-prepare', 'extensions-apply']
    if args.command in extension_commands:
        route = '/api/v1/extensions/' + {'extensions-state': 'state', 'extensions-diagnostics': 'diagnostics', 'extension-detail': 'objects', 'extension-operation': 'operations', 'extensions-prepare': 'prepare', 'extensions-apply': 'actions'}[args.command]
        if args.command in ['extension-detail', 'extension-operation']:
            if not re.fullmatch(r'[a-zA-Z0-9_-]{1,100}', args.id):
                raise ValueError('扩展或操作 ID 无效')
            route += '/' + args.id
        if args.command == 'extension-detail' and args.file:
            route += '?' + urllib.parse.urlencode({'file': args.file})
        if args.command in ['extensions-prepare', 'extensions-apply']:
            action = json.load(sys.stdin) if args.file == '-' else json.loads(Path(args.file).expanduser().read_text())
            payload = {'action': action}
            if args.command == 'extensions-apply':
                payload.update({'requestId': args.request_id, 'expectedVersion': args.expected_version, 'planId': args.plan_id})
    if args.command == 'calendar' or args.command in focus_commands:
        route = '/api/v1/calendar' if args.command == 'calendar' else '/api/v1/focus/' + {
            'focus-state': 'state', 'focus-stats': 'statistics', 'focus-sessions': 'sessions',
            'task-focus': 'task-summary', 'focus-prepare': 'prepare', 'focus-apply': 'actions', 'focus-export': 'export'}[args.command]
        params = {}
        for field, key in [('from_day', 'from'), ('to_day', 'to'), ('project', 'projectId'), ('query', 'query'), ('status', 'status'), ('task', 'taskId'), ('phase', 'phase'), ('limit', 'limit'), ('cursor', 'cursor')]:
            value = getattr(args, field, None)
            if value is not None:
                params[key] = value
        if getattr(args, 'unassigned', False):
            params['unassigned'] = '1'
        if args.command == 'task-focus':
            params = {'taskId': args.id, 'recentLimit': args.recent_limit}
        if params:
            route += '?' + urllib.parse.urlencode(params)
        if args.command in ['focus-prepare', 'focus-apply']:
            action = json.load(sys.stdin) if args.file == '-' else json.loads(Path(args.file).expanduser().read_text())
            payload = {'action': action}
            if args.command == 'focus-apply':
                payload.update({'requestId': args.request_id, 'expectedVersion': args.expected_version})
                if args.expected_task_version is not None:
                    payload['expectedTaskVersion'] = args.expected_task_version
                if args.expires_at is not None:
                    payload['expiresAt'] = args.expires_at
    if args.command == 'conversations':
        route = '/api/v1/ai/state'
    if args.command == 'delete-conversation':
        route = '/api/v1/ai/actions'
        payload = {'requestId': args.request_id, 'expectedVersion': args.expected_version,
                   'action': {'type': 'ai.conversation.delete', 'id': args.id, 'expectedUpdatedAt': args.updated_at}}
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
        if args.command == 'calendar' or args.command in focus_commands or args.command in extension_commands:
            check = urllib.request.Request(url.rstrip('/') + '/api/v1/capabilities', headers={'Authorization': 'Bearer ' + token})
            with opener.open(check, timeout=15) as response:
                caps = json.load(response)
            if not caps.get('extensions' if args.command in extension_commands else 'calendarQuery' if args.command == 'calendar' else 'focus'):
                raise ValueError('服务尚不支持此功能，请升级服务；不得直接编辑数据文件')
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
    if args.command in ['export', 'focus-export']:
        output = Path(args.out).expanduser()
        with output.open('x', encoding='utf8') as stream:
            json.dump(result['state'] if args.command == 'export' else result, stream, ensure_ascii=False, indent=2)
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

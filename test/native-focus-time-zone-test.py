"""Compare Foundation civil-day windows with the Node Intl adapter, including skipped days."""
import json
import pathlib
import subprocess
import tempfile

root = pathlib.Path(__file__).resolve().parent.parent
cases = [
    {'from': '2025-12-31', 'to': '2026-01-02', 'timeZone': 'UTC'},
    {'from': '2026-03-07', 'to': '2026-03-09', 'timeZone': 'America/New_York'},
    {'from': '2026-10-31', 'to': '2026-11-02', 'timeZone': 'America/New_York'},
    {'from': '2026-10-01', 'to': '2026-10-03', 'timeZone': 'Asia/Kathmandu'},
    {'from': '2011-12-29', 'to': '2011-12-31', 'timeZone': 'Pacific/Apia'},
    {'from': '2026-10-03', 'to': '2026-10-05', 'timeZone': 'Australia/Lord_Howe'},
]
with tempfile.TemporaryDirectory(prefix='daylight-focus-time-zone-') as temporary:
    directory = pathlib.Path(temporary)
    fixture = directory / 'cases.json'; fixture.write_text(json.dumps(cases))
    source = directory / 'main.swift'
    source.write_text('''import Foundation
struct Failure: LocalizedError { let message: String; var errorDescription: String? { message } }
func matches(_ text: String, _ pattern: String) -> Bool { text.range(of: pattern, options: .regularExpression) != nil }
let cases = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) as! [[String: String]]
let output = try cases.map { try FocusTimeZone.windows(from: $0["from"]!, to: $0["to"]!, timeZone: $0["timeZone"]!) }
print(String(data: try JSONSerialization.data(withJSONObject: output, options: .sortedKeys), encoding: .utf8)!)
''')
    executable = directory / 'windows'
    subprocess.run(['swiftc', '-module-cache-path', str(directory / 'cache'), str(root / 'native/FocusTimeZone.swift'), str(source), '-o', str(executable)], check=True)
    subprocess.run(['codesign', '--force', '--sign', '-', str(executable)], check=True, capture_output=True)
    native = json.loads(subprocess.check_output([str(executable), str(fixture)]))
    script = "import fs from 'node:fs'; import {dayWindows} from './focus/time-zone.mjs'; const cases=JSON.parse(fs.readFileSync(process.argv[1])); console.log(JSON.stringify(cases.map(c=>dayWindows(c.from,c.to,c.timeZone))));"
    node = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', script, str(fixture)], cwd=root))
    assert native == node, [(cases[i], a, b) for i, (a, b) in enumerate(zip(native, node)) if a != b]
    assert native[1][1]['endAt'] - native[1][1]['startAt'] == 23*3600000
    assert native[2][1]['endAt'] - native[2][1]['startAt'] == 25*3600000
    assert native[4][1]['exists'] is False and native[4][1]['startAt'] == native[4][1]['endAt']
    print('PASS: Node/Foundation day windows: UTC, 23/25-hour DST, Kathmandu, Samoa skipped date and Lord Howe half-hour DST')

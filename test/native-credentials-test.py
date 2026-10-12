#!/usr/bin/env python3
"""Exercise the production helper with fake Security bindings, never a real keychain."""
import pathlib
import subprocess
import tempfile
import json
import os

root = pathlib.Path(__file__).resolve().parent.parent
bindings = r'''
import Foundation
import CoreFoundation
typealias OSStatus = Int32
let errSecSuccess: OSStatus = 0
let errSecItemNotFound: OSStatus = -25300
let kSecClass = "class", kSecClassGenericPassword = "generic"
let kSecAttrService = "service", kSecAttrAccount = "account"
let kSecReturnData = "returnData", kSecMatchLimit = "limit", kSecMatchLimitOne = "one"
let kSecValueData = "value"
var interactionAllowed = true
func SecKeychainSetUserInteractionAllowed(_ allowed: Bool) -> OSStatus {
 if ProcessInfo.processInfo.environment["FIXTURE_GUARD_FAIL"] == "1" { return -25293 }
 interactionAllowed = allowed; return 0
}
func fixtureOperation() -> OSStatus {
 // Removing/moving the production suppression call must fail this contract.
 guard !interactionAllowed else { exit(90) }
 return ProcessInfo.processInfo.environment["FIXTURE_BLOCKED"] == "1" ? -25308 : -25300
}
func SecItemCopyMatching(_ q: CFDictionary, _ item: UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus { fixtureOperation() }
func SecItemUpdate(_ q: CFDictionary, _ values: CFDictionary) -> OSStatus { fixtureOperation() }
func SecItemAdd(_ q: CFDictionary, _ item: UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus {
 let status = fixtureOperation(); return status == errSecItemNotFound ? 0 : status
}
func SecItemDelete(_ q: CFDictionary) -> OSStatus { fixtureOperation() }
'''
source = (root / 'native/Credentials.swift').read_text().replace('import Security', '')
with tempfile.TemporaryDirectory(prefix='daylight-credentials-contract-') as tmp:
    directory = pathlib.Path(tmp)
    swift = directory / 'main.swift'
    executable = directory / 'credentials-fixture'
    swift.write_text(bindings + source)
    subprocess.run(['swiftc', '-module-cache-path', str(directory / 'cache'), str(swift), '-o', str(executable)], check=True)
    imports = subprocess.check_output(['nm', '-u', str(executable)], text=True)
    assert '_SecItem' not in imports and '_SecKeychain' not in imports, 'Fixture must not link real Security operations'
    for action in ('get', 'set', 'delete'):
        for mode, expected_status in (('', None), ('FIXTURE_BLOCKED', -25308), ('FIXTURE_GUARD_FAIL', -25293)):
            env = os.environ.copy()
            if mode:
                env[mode] = '1'
            result = subprocess.run([str(executable)], input=json.dumps({'action': action, 'id': 'fixture', 'value': 'fixture-value'}), text=True, capture_output=True, env=env, timeout=10)
            if expected_status is None:
                assert result.returncode == 0, (action, result.stderr, result.returncode)
                assert json.loads(result.stdout) == {}
            else:
                assert result.returncode == 1, (action, result.returncode)
                assert result.stdout == ''
                assert result.stderr == f'钥匙串操作失败：{expected_status}'
    invalid = subprocess.run([str(executable)], input='{}', text=True, capture_output=True, timeout=10)
    assert invalid.returncode == 2
    swift.write_text(bindings + source.replace('"local.daylight.proxy"', '"gemini"'))
    executable = directory / 'agy-fixture'
    subprocess.run(['swiftc', '-module-cache-path', str(directory / 'cache'), str(swift), '-o', str(executable)], check=True)
    imports = subprocess.check_output(['nm', '-u', str(executable)], text=True)
    assert '_SecItem' not in imports and '_SecKeychain' not in imports
    for mode, expected_status in (('', None), ('FIXTURE_BLOCKED', -25308), ('FIXTURE_GUARD_FAIL', -25293)):
        env = os.environ.copy()
        if mode:
            env[mode] = '1'
        result = subprocess.run([str(executable)], input='{"action":"get","id":"antigravity"}', text=True, capture_output=True, env=env, timeout=10)
        if expected_status is None:
            assert result.returncode == 0 and json.loads(result.stdout) == {}
            continue
        assert result.returncode == 1 and result.stdout == '', (mode, result.returncode, result.stdout, result.stderr)
        assert result.stderr == f'钥匙串操作失败：{expected_status}'
print('Native credentials contract passed: 13 cases; no real Security API invoked')

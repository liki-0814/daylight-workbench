#!/usr/bin/env python3
"""Build a native macOS app; only explicit runtime files enter the bundle."""
import argparse
import base64
import hashlib
import json
import os
import pathlib
import plistlib
import re
import shutil
import subprocess
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=pathlib.Path, help='isolated output App path (defaults to dist/native/Daylight.app)')
parser.add_argument('--previous-app', type=pathlib.Path, help='previous release app whose helper access identities must remain compatible')
parser.add_argument('--allow-credential-migration', action='store_true', help='explicitly allow a manual-install credential signing migration')
parser.add_argument('--development', action='store_true', help='build an isolated ad-hoc development app')
parser.add_argument('--dmg', action='store_true', help='also create dist/Daylight-<version>-arm64.dmg')
parser.add_argument('--sign-identity', default=os.environ.get('DAYLIGHT_SIGN_IDENTITY'), help='codesign identity (SHA-1 or name); without it the app is ad-hoc signed')
parser.add_argument('--keychain', default=os.environ.get('DAYLIGHT_SIGN_KEYCHAIN'), help='keychain holding the signing identity')
parser.add_argument('--keychain-password-file', default=os.environ.get('DAYLIGHT_SIGN_KEYCHAIN_PASSWORD_FILE'), help='file with the keychain password, used only to unlock it')
parser.add_argument('--bundle-id', default=os.environ.get('DAYLIGHT_BUNDLE_ID', 'local.daylight.workbench'), help='override for isolated test builds')
parser.add_argument('--update-public-key', default=os.environ.get('DAYLIGHT_UPDATE_PUBLIC_KEY'), help='base64 raw Ed25519 public key; defaults to build/update-public-key.txt')
args = parser.parse_args()
if not args.development and args.dmg and not args.previous_app:
    installed_app = pathlib.Path('/Applications/Daylight.app')
    if installed_app.exists():
        args.previous_app = installed_app
if args.development:
    if args.bundle_id == 'local.daylight.workbench':
        args.bundle_id += '.dev'
elif args.bundle_id == 'local.daylight.workbench' and not args.sign_identity:
    parser.error('正式构建必须设置 DAYLIGHT_SIGN_IDENTITY；临时开发请使用 --development')
if args.sign_identity and args.keychain and args.keychain_password_file:
    password = pathlib.Path(args.keychain_password_file).read_text().strip()
    unlock = subprocess.run(['security', 'unlock-keychain', '-p', password, args.keychain], capture_output=True)
    if unlock.returncode:
        raise SystemExit('无法解锁签名钥匙串，请检查签名配置；未输出解锁参数')
root = pathlib.Path(__file__).resolve().parent.parent
version = json.loads((root / 'package.json').read_text())['version']
final_app = (args.output or root / 'dist/native/Daylight.app').resolve()
final_app.parent.mkdir(parents=True, exist_ok=True)

def requirement(binary):
    result = subprocess.run(['codesign', '-d', '-r-', str(binary)], capture_output=True, text=True, check=True)
    return next((line for line in (result.stdout + result.stderr).splitlines() if line.startswith('designated =>')), '')

certificate_info = subprocess.check_output(['security', 'find-certificate', '-c', args.sign_identity, '-Z', *([args.keychain] if args.keychain else [])], text=True) if args.sign_identity else ''
previous_helpers = {}
if args.previous_app and args.sign_identity and not args.allow_credential_migration:
    with (args.previous_app / 'Contents/Info.plist').open('rb') as stream:
        previous_info = plistlib.load(stream)
    if previous_info.get('CFBundleIdentifier') != args.bundle_id:
        raise SystemExit('旧版 App 的 Bundle ID 不同，不能自动复用凭证助手')
    previous_version = previous_info.get('CFBundleShortVersionString')
    previous_source = subprocess.run(['git', 'show', f'v{previous_version}:native/Credentials.swift'], cwd=root, capture_output=True, text=True)
    if previous_source.returncode or previous_source.stdout != (root / 'native/Credentials.swift').read_text():
        raise SystemExit('凭证助手源码已变化或无法核对；如需更换 helper，必须显式使用 --allow-credential-migration')
    expected_certificate = re.search(r'SHA-1 hash: ([0-9A-Fa-f]+)', certificate_info)
    if not expected_certificate:
        raise SystemExit('无法确定发布证书指纹')
    for helper in ('DaylightCredentials', 'DaylightAgyCredentials'):
        old = args.previous_app / 'Contents/Resources' / helper
        if not old.exists():
            raise SystemExit(f'Previous app is missing {helper}')
        subprocess.run(['codesign', '--verify', '--strict', str(old)], check=True)
        actual_certificate = re.search(r'certificate (?:root|leaf) = H"([0-9A-Fa-f]+)"', requirement(old))
        if not actual_certificate or actual_certificate.group(1).lower() != expected_certificate.group(1).lower():
            raise SystemExit(f'{helper}: 发布证书已变化，必须显式使用 --allow-credential-migration')
        previous_helpers[helper] = old
    print(f'Credential helpers reused byte-for-byte: {args.previous_app}')
# Publish only a successfully compiled, checked and signed app.
build_directory = tempfile.TemporaryDirectory(prefix='.daylight-build-', dir=final_app.parent)
app = pathlib.Path(build_directory.name) / final_app.name
contents = app / 'Contents'
resources = contents / 'Resources'
resources.mkdir(parents=True, exist_ok=True)
(contents / 'MacOS').mkdir(exist_ok=True)
module_cache = str(pathlib.Path(build_directory.name) / 'swift-cache')
subprocess.run(['swiftc', '-module-cache-path', module_cache, '-O', '-whole-module-optimization', '-Xlinker', '-dead_strip', '-target', 'arm64-apple-macos13.0', *[str(root / 'native' / name) for name in ('Server.swift', 'Focus.swift', 'FocusTimeZone.swift', 'Proxy.swift', 'Launcher.swift', 'Updater.swift', 'main.swift')], '-o', str(contents / 'MacOS/Daylight')], check=True)
subprocess.run(['strip', '-x', str(contents / 'MacOS/Daylight')], check=True)
shutil.copytree(root / 'public', resources / 'public', dirs_exist_ok=True)
shutil.copytree(root / 'core', resources / 'core', dirs_exist_ok=True)
subprocess.run(['node', str(root / 'scripts/build-native-core.mjs'), str(resources)], check=True)
shutil.copytree(root / 'licenses', resources / 'licenses', dirs_exist_ok=True)
for notice in ('LICENSE', 'THIRD_PARTY_NOTICES.md'):
    shutil.copy2(root / notice, resources / notice)
shutil.copy2(root / 'agent-api.mjs', resources / 'agent-api.mjs')
shutil.copy2(root / 'native/tray-model.mjs', resources / 'tray-model.mjs')
shutil.copytree(root / 'proxy', resources / 'proxy', dirs_exist_ok=True)
shutil.copytree(root / 'cli', resources / 'cli', dirs_exist_ok=True)
credential_service = 'local.daylight.proxy' if args.bundle_id == 'local.daylight.workbench' else args.bundle_id + '.proxy'
credential_source = pathlib.Path(build_directory.name) / 'Credentials.swift'
credential_source.write_text((root / 'native/Credentials.swift').read_text().replace('\"local.daylight.proxy\"', json.dumps(credential_service)))
credential_key = hashlib.sha256(credential_source.read_bytes() + subprocess.check_output(['swiftc', '--version']) + b'-O').hexdigest()[:16]
credential_cache = final_app.parent / 'credential-cache' / credential_key
credential_cache.mkdir(parents=True, exist_ok=True)
def credential_helper(name, source):
    cached = credential_cache / name
    target = resources / name
    if cached.exists():
        shutil.copy2(cached, target)
        return
    subprocess.run(['swiftc', '-module-cache-path', module_cache, '-O', str(source), '-o', str(target)], check=True)
    shutil.copy2(target, cached)
credential_helper('DaylightCredentials', credential_source)
agy_credentials = pathlib.Path(build_directory.name) / 'AgyCredentials.swift'
agy_credentials.write_text((root / 'native/Credentials.swift').read_text().replace('"local.daylight.proxy"', '"gemini"'))
credential_helper('DaylightAgyCredentials', agy_credentials)
print(f'Credential helpers: {credential_cache}')
subprocess.run(['swiftc', '-module-cache-path', module_cache, '-O', '-target', 'arm64-apple-macos13.0', str(root / 'native/UpdaterHelper.swift'), '-o', str(resources / 'DaylightUpdater')], check=True)
shutil.copytree(root / 'skills' / 'daylight-workbench', resources / 'skills' / 'daylight-workbench', dirs_exist_ok=True, ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
shutil.copytree(root / 'ai', resources / 'ai', dirs_exist_ok=True)
shutil.copytree(root / 'extensions', resources / 'extensions', dirs_exist_ok=True)
# Compile the adapter dependency graph instead of copying npm's installation tree.
subprocess.run(['node', str(root / 'scripts/build-runtime.mjs'), str(resources)], check=True)
subprocess.run(['node', str(root / 'scripts/trim-runtime.mjs'), str(resources), str(final_app.parent / 'runtime-files.json')], check=True)
shutil.move(str(resources / 'runtime-build.json'), str(final_app.parent / 'runtime-build.json'))
subprocess.run(['node', '--input-type=module', '-e', f'const adapter = await import({json.dumps((resources / "ai/adapters/qoder.mjs").as_uri())}); if (typeof adapter.run !== "function") throw new Error("Invalid Qoder bundle");'], check=True)

(resources / 'package.json').write_text(json.dumps({'type': 'module'}))
shutil.copy2(root / 'build/icon.icns', resources / 'icon.icns')
update_key = (args.update_public_key or (root / 'build/update-public-key.txt').read_text()).strip()
if len(base64.b64decode(update_key, validate=True)) != 32:
    raise SystemExit('Update public key must be a raw 32-byte Ed25519 key in base64')
with (contents / 'Info.plist').open('wb') as stream:
    plistlib.dump({'CFBundleExecutable': 'Daylight', 'CFBundleIdentifier': args.bundle_id, 'CFBundleName': 'Daylight', 'CFBundleDisplayName': 'Daylight', 'CFBundlePackageType': 'APPL', 'CFBundleShortVersionString': version, 'CFBundleVersion': version, 'CFBundleIconFile': 'icon.icns', 'LSMinimumSystemVersion': '13.0', 'LSApplicationCategoryType': 'public.app-category.productivity', 'NSHighResolutionCapable': True, 'NSAppTransportSecurity': {'NSAllowsLocalNetworking': True}, 'DaylightDevelopment': args.development, 'DaylightUpdatePublicKey': update_key}, stream)

def sign(path, extra=()):
    command = ['codesign', '--force', '--sign', args.sign_identity or '-']
    if args.sign_identity and args.keychain:
        command += ['--keychain', args.keychain]
    subprocess.run([*command, *extra, str(path)], check=True)

# Keychain ACLs can pin the helper CDHash, so normal upgrades reuse exact previous bytes.
signature_identity = (args.sign_identity or 'ad-hoc') + ':' + args.bundle_id
if args.sign_identity:
    signature_identity += certificate_info
signed_cache = credential_cache / ('signed-' + hashlib.sha256(signature_identity.encode()).hexdigest()[:16])
signed_cache.mkdir(parents=True, exist_ok=True)
for helper in ('DaylightCredentials', 'DaylightAgyCredentials'):
    if helper in previous_helpers:
        shutil.copy2(previous_helpers[helper], resources / helper)
        continue
    cached = signed_cache / helper
    if cached.exists():
        shutil.copy2(cached, resources / helper)
    else:
        if args.sign_identity:
            sign(resources / helper, ('--identifier', helper if args.bundle_id == 'local.daylight.workbench' else args.bundle_id + '.' + helper))
        shutil.copy2(resources / helper, cached)
if args.sign_identity:
    sign(resources / 'DaylightUpdater')
# Certificate migration is a manual-install operation, never silently shipped as a compatible build.
for helper in ('DaylightCredentials', 'DaylightAgyCredentials'):
    old = (args.previous_app or final_app) / 'Contents/Resources' / helper
    current = resources / helper
    subprocess.run(['codesign', '--verify', '--strict', str(current)], check=True)
    if args.previous_app and not old.exists():
        raise SystemExit(f'Previous app is missing {helper}')
    if args.sign_identity and not requirement(current):
        raise SystemExit(f'{helper}: 缺少稳定的签名访问身份')
    if args.sign_identity and old.exists():
        old_info = subprocess.run(['codesign', '-dv', str(old)], capture_output=True, text=True).stderr
        # Existing ad-hoc builds require one explicit authorization after migration.
        if 'Signature=adhoc' not in old_info and requirement(old) != requirement(current) and not args.allow_credential_migration:
            raise SystemExit(f'{helper}: 签名访问身份变化，需要显式迁移；未替换已有 App')
print(f'Credential signatures: {signed_cache}')
sign(app)
subprocess.run(['codesign', '--verify', '--strict', '--deep', str(app)], check=True)
if final_app.exists():
    shutil.rmtree(final_app)
app.rename(final_app)
app = final_app
build_directory.cleanup()
if args.dmg:
    with tempfile.TemporaryDirectory(prefix='daylight-dmg-') as tmp:
        stage = pathlib.Path(tmp)
        shutil.copytree(app, stage / app.name)
        (stage / 'Applications').symlink_to('/Applications')
        dmg = root / f'dist/Daylight-{version}-arm64.dmg'
        # HFS+ reduces image metadata overhead; UDZO remains widely compatible.
        subprocess.run(['hdiutil', 'create', '-volname', 'Daylight', '-fs', 'HFS+', '-srcfolder', str(stage), '-ov', '-format', 'UDZO', '-imagekey', 'zlib-level=9', str(dmg)], check=True)
        subprocess.run(['hdiutil', 'verify', str(dmg)], check=True)
        print(dmg)
print(app)

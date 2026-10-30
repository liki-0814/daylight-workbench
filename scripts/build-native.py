#!/usr/bin/env python3
"""Build a native macOS app; only explicit runtime files enter the bundle."""
import argparse
import base64
import json
import os
import pathlib
import plistlib
import shutil
import subprocess
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--dmg', action='store_true', help='also create dist/Daylight-<version>-arm64.dmg')
parser.add_argument('--sign-identity', default=os.environ.get('DAYLIGHT_SIGN_IDENTITY'), help='codesign identity (SHA-1 or name); without it the app is ad-hoc signed')
parser.add_argument('--keychain', default=os.environ.get('DAYLIGHT_SIGN_KEYCHAIN'), help='keychain holding the signing identity')
parser.add_argument('--keychain-password-file', default=os.environ.get('DAYLIGHT_SIGN_KEYCHAIN_PASSWORD_FILE'), help='file with the keychain password, used only to unlock it')
parser.add_argument('--bundle-id', default=os.environ.get('DAYLIGHT_BUNDLE_ID', 'local.daylight.workbench'), help='override for isolated test builds')
parser.add_argument('--update-public-key', default=os.environ.get('DAYLIGHT_UPDATE_PUBLIC_KEY'), help='base64 raw Ed25519 public key; defaults to build/update-public-key.txt')
args = parser.parse_args()
root = pathlib.Path(__file__).resolve().parent.parent
version = json.loads((root / 'package.json').read_text())['version']
final_app = root / 'dist/native/Daylight.app'
final_app.parent.mkdir(parents=True, exist_ok=True)
# Publish only a successfully compiled, checked and signed app.
build_directory = tempfile.TemporaryDirectory(prefix='.daylight-build-', dir=final_app.parent)
app = pathlib.Path(build_directory.name) / final_app.name
contents = app / 'Contents'
resources = contents / 'Resources'
resources.mkdir(parents=True, exist_ok=True)
(contents / 'MacOS').mkdir(exist_ok=True)
module_cache = str(pathlib.Path(build_directory.name) / 'swift-cache')
subprocess.run(['swiftc', '-module-cache-path', module_cache, '-O', '-whole-module-optimization', '-Xlinker', '-dead_strip', '-target', 'arm64-apple-macos13.0', *[str(root / 'native' / name) for name in ('Server.swift', 'Focus.swift', 'FocusTimeZone.swift', 'FocusNotifications.swift', 'FocusTray.swift', 'DisplayAccessibility.swift', 'NativeReveal.swift', 'Proxy.swift', 'Launcher.swift', 'Updater.swift', 'main.swift')], '-o', str(contents / 'MacOS/Daylight')], check=True)
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
subprocess.run(['swiftc', '-module-cache-path', module_cache, '-O', str(root / 'native/Credentials.swift'), '-o', str(resources / 'DaylightCredentials')], check=True)
agy_credentials = pathlib.Path(build_directory.name) / 'AgyCredentials.swift'
agy_credentials.write_text((root / 'native/Credentials.swift').read_text().replace('"local.daylight.proxy"', '"gemini"'))
subprocess.run(['swiftc', '-module-cache-path', module_cache, '-O', str(agy_credentials), '-o', str(resources / 'DaylightAgyCredentials')], check=True)
subprocess.run(['swiftc', '-module-cache-path', module_cache, '-O', '-target', 'arm64-apple-macos13.0', str(root / 'native/UpdaterHelper.swift'), '-o', str(resources / 'DaylightUpdater')], check=True)
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
    plistlib.dump({'CFBundleExecutable': 'Daylight', 'CFBundleIdentifier': args.bundle_id, 'CFBundleName': 'Daylight', 'CFBundleDisplayName': 'Daylight', 'CFBundlePackageType': 'APPL', 'CFBundleShortVersionString': version, 'CFBundleVersion': version, 'CFBundleIconFile': 'icon.icns', 'LSMinimumSystemVersion': '13.0', 'LSApplicationCategoryType': 'public.app-category.productivity', 'NSHighResolutionCapable': True, 'NSAppTransportSecurity': {'NSAllowsLocalNetworking': True}, 'DaylightUpdatePublicKey': update_key}, stream)

def sign(path, extra=()):
    command = ['codesign', '--force', '--sign', args.sign_identity or '-']
    if args.sign_identity and args.keychain:
        command += ['--keychain', args.keychain]
    subprocess.run([*command, *extra, str(path)], check=True)

if args.sign_identity and args.keychain and args.keychain_password_file:
    password = pathlib.Path(args.keychain_password_file).read_text().strip()
    subprocess.run(['security', 'unlock-keychain', '-p', password, args.keychain], check=True)
# Helper executables are signed on their own, before the app seals the bundle. Their bytes must stay identical
# between releases: the Keychain partition list of stored credentials pins the helper cdhash.
if args.sign_identity:
    for helper in ('DaylightCredentials', 'DaylightAgyCredentials', 'DaylightUpdater'):
        sign(resources / helper)
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

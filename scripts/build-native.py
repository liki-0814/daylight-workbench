#!/usr/bin/env python3
"""Build a native macOS app; only explicit runtime files enter the bundle."""
import json
import pathlib
import plistlib
import shutil
import subprocess
import sys
import tempfile

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
subprocess.run(['swiftc', '-O', '-whole-module-optimization', '-Xlinker', '-dead_strip', '-target', 'arm64-apple-macos13.0', str(root / 'native/Server.swift'), str(root / 'native/Proxy.swift'), str(root / 'native/Launcher.swift'), str(root / 'native/main.swift'), '-o', str(contents / 'MacOS/Daylight')], check=True)
subprocess.run(['strip', '-x', str(contents / 'MacOS/Daylight')], check=True)
shutil.copytree(root / 'public', resources / 'public', dirs_exist_ok=True)
shutil.copytree(root / 'licenses', resources / 'licenses', dirs_exist_ok=True)
for notice in ('LICENSE', 'THIRD_PARTY_NOTICES.md'):
    shutil.copy2(root / notice, resources / notice)
shutil.copy2(root / 'agent-api.mjs', resources / 'agent-api.mjs')
shutil.copy2(root / 'native/tray-model.mjs', resources / 'tray-model.mjs')
shutil.copytree(root / 'proxy', resources / 'proxy', dirs_exist_ok=True)
shutil.copytree(root / 'cli', resources / 'cli', dirs_exist_ok=True)
subprocess.run(['swiftc', '-O', str(root / 'native/Credentials.swift'), '-o', str(resources / 'DaylightCredentials')], check=True)
shutil.copytree(root / 'ai', resources / 'ai', dirs_exist_ok=True)
# Compile the adapter dependency graph instead of copying npm's installation tree.
subprocess.run(['node', str(root / 'scripts/build-runtime.mjs'), str(resources)], check=True)
subprocess.run(['node', str(root / 'scripts/trim-runtime.mjs'), str(resources), str(final_app.parent / 'runtime-files.json')], check=True)
shutil.move(str(resources / 'runtime-build.json'), str(final_app.parent / 'runtime-build.json'))
subprocess.run(['node', '--input-type=module', '-e', f'const adapter = await import({json.dumps((resources / "ai/adapters/qoder.mjs").as_uri())}); if (typeof adapter.run !== "function") throw new Error("Invalid Qoder bundle");'], check=True)

(resources / 'package.json').write_text(json.dumps({'type': 'module'}))
shutil.copy2(root / 'build/icon.icns', resources / 'icon.icns')
with (contents / 'Info.plist').open('wb') as stream:
    plistlib.dump({'CFBundleExecutable': 'Daylight', 'CFBundleIdentifier': 'local.daylight.workbench', 'CFBundleName': 'Daylight', 'CFBundleDisplayName': 'Daylight', 'CFBundlePackageType': 'APPL', 'CFBundleShortVersionString': version, 'CFBundleVersion': version, 'CFBundleIconFile': 'icon.icns', 'LSMinimumSystemVersion': '13.0', 'LSApplicationCategoryType': 'public.app-category.productivity', 'NSHighResolutionCapable': True, 'NSAppTransportSecurity': {'NSAllowsLocalNetworking': True}}, stream)
subprocess.run(['codesign', '--force', '--sign', '-', str(app)], check=True)
subprocess.run(['codesign', '--verify', '--strict', str(app)], check=True)
if final_app.exists():
    shutil.rmtree(final_app)
app.rename(final_app)
app = final_app
build_directory.cleanup()
if '--dmg' in sys.argv:
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

#!/usr/bin/env python3
"""Build a native macOS app; only explicit runtime files enter the bundle."""
import json
import pathlib
import plistlib
import shutil
import subprocess
import sys

root = pathlib.Path(__file__).resolve().parent.parent
version = json.loads((root / 'package.json').read_text())['version']
app = root / 'dist/native/Daylight.app'
if app.exists():
    shutil.rmtree(app)
contents = app / 'Contents'
resources = contents / 'Resources'
resources.mkdir(parents=True, exist_ok=True)
(contents / 'MacOS').mkdir(exist_ok=True)
subprocess.run(['swiftc', '-O', '-target', 'arm64-apple-macos13.0', str(root / 'native/Server.swift'), str(root / 'native/main.swift'), '-o', str(contents / 'MacOS/Daylight')], check=True)
shutil.copytree(root / 'public', resources / 'public', dirs_exist_ok=True)
shutil.copy2(root / 'agent-api.mjs', resources / 'agent-api.mjs')
shutil.copy2(root / 'native/tray-model.mjs', resources / 'tray-model.mjs')
shutil.copy2(root / 'build/icon.icns', resources / 'icon.icns')
with (contents / 'Info.plist').open('wb') as stream:
    plistlib.dump({'CFBundleExecutable': 'Daylight', 'CFBundleIdentifier': 'local.daylight.workbench', 'CFBundleName': 'Daylight', 'CFBundleDisplayName': 'Daylight', 'CFBundlePackageType': 'APPL', 'CFBundleShortVersionString': version, 'CFBundleVersion': version, 'CFBundleIconFile': 'icon.icns', 'LSMinimumSystemVersion': '13.0', 'LSApplicationCategoryType': 'public.app-category.productivity', 'NSHighResolutionCapable': True, 'NSAppTransportSecurity': {'NSAllowsLocalNetworking': True}}, stream)
subprocess.run(['codesign', '--force', '--sign', '-', str(app)], check=True)
if '--dmg' in sys.argv:
    with __import__('tempfile').TemporaryDirectory(prefix='daylight-dmg-') as tmp:
        stage = pathlib.Path(tmp)
        shutil.copytree(app, stage / app.name)
        (stage / 'Applications').symlink_to('/Applications')
        dmg = root / f'dist/Daylight-{version}-arm64.dmg'
        subprocess.run(['hdiutil', 'create', '-volname', 'Daylight', '-srcfolder', str(stage), '-ov', '-format', 'UDZO', str(dmg)], check=True)
        subprocess.run(['hdiutil', 'verify', str(dmg)], check=True)
        print(dmg)
print(app)

"""Construct the public payload only from pinned inputs; never scan a model directory."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
FORGE = ROOT / 'forge-rs'
CACHE = FORGE / 'target/release-inputs'
TARGET = FORGE / 'target/native-resources'
PINS = ROOT / 'tools/release-inputs.json'
COMPONENTS = json.loads((ROOT / 'tools/forge-components.json').read_text())
NOTICE_ARCHIVE = 'forge-component-notices.zip'
NOTICE_HASH = '1e42ec948b12d49627cb0f6ed93da78c7c1c9c18c9d71252393d2051a46d872a'
NOTICE_URL = 'https://github.com/StarsationX/midi-studio/releases/download/forge-components-v1/' + NOTICE_ARCHIVE


def digest(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def archives(with_components):
    CACHE.mkdir(parents=True, exist_ok=True)
    inputs = json.loads(PINS.read_text()) if with_components else {NOTICE_ARCHIVE: (NOTICE_URL, NOTICE_HASH)}
    for name, (url, expected) in inputs.items():
        dest = CACHE / name
        if dest.is_file() and digest(dest) == expected:
            continue
        tmp = dest.with_suffix('.part')
        with urllib.request.urlopen(url, timeout=90) as response, tmp.open('wb') as out:
            shutil.copyfileobj(response, out)
        if digest(tmp) != expected:
            raise ValueError(f'{url}: SHA-256 mismatch')
        tmp.replace(dest)


def unpack(archive, stage, members):
    with zipfile.ZipFile(archive) as z:
        for member, relative in members.items():
            dest = stage / relative
            dest.parent.mkdir(parents=True, exist_ok=True)
            with z.open(member) as src, dest.open('wb') as out:
                shutil.copyfileobj(src, out)


def crate_notices(out):
    # Use resolved Windows dependency edges, not every optional or test dependency in Cargo.lock.
    packages = {}
    for project in (FORGE, ROOT / 'src-tauri'):
        meta = json.loads(subprocess.check_output(['cargo', 'metadata', '--locked', '--format-version', '1',
                         '--filter-platform', 'x86_64-pc-windows-msvc', '--manifest-path', str(project / 'Cargo.toml')]))
        nodes = {n['id']: n for n in meta['resolve']['nodes']}
        todo, seen = [meta['resolve']['root']], set()
        while todo:
            current = todo.pop()
            if current in seen:
                continue
            seen.add(current)
            todo.extend(d['pkg'] for d in nodes[current]['deps'] if any(k['kind'] is None for k in d['dep_kinds']))
        packages.update({p['id']: p for p in meta['packages'] if p['id'] in seen and p['source']})
    with out.open('w', encoding='utf-8') as text:
        for p in sorted(packages.values(), key=lambda p: (p['name'], p['version'])):
            base = Path(p['manifest_path']).parent
            name, version = p['name'], p['version']
            text.write(f"\n=== {name} {version}: {p['license']} ===\nSource: https://crates.io/crates/{name}/{version}\n")
            files = sorted(x for x in base.iterdir() if x.name.upper().startswith(('LICENSE','LICENCE','COPYING','COPYRIGHT','UNLICENSE','NOTICE')))
            for entry in files:
                for f in ([entry] if entry.is_file() else sorted(x for x in entry.rglob('*') if x.is_file())):
                    text.write(f'\n{f.name}\n{f.read_text(encoding="utf-8-sig", errors="replace")}\n')
            if not files:
                key = next((k for k in ('symphonia','webview2-com') if name.startswith(k)), name)
                text.write((ROOT / 'third-party/rust' / (key + '.txt')).read_text(encoding='utf-8'))


def stage_components(out):
    game = 'GAME-1.0.3-medium-onnx'
    unpack(CACHE / 'game.zip', out, {f'{game}/{n}.onnx': f'game/{game}/{n}.onnx' for n in ('encoder','estimator','segmenter','bd2dur','dur2bd')})
    unpack(CACHE / 'basic.whl', out, {'basic_pitch/saved_models/icassp_2022/nmp.onnx': 'basic_pitch/nmp.onnx',
           **{f'basic_pitch-0.4.0.dist-info/{n}': f'notices/BasicPitch-{n}' for n in ('LICENSE','NOTICE')}})
    unpack(CACHE / 'ort.nupkg', out, {**{f'runtimes/win-x64/native/{n}.dll': f'ort/{n}.dll' for n in
           ('onnxruntime','onnxruntime_providers_shared','onnxruntime_providers_cuda')}, 'LICENSE': 'notices/ORT-LICENSE',
           'ThirdPartyNotices.txt': 'notices/ORT-ThirdPartyNotices.txt'})
    unpack(CACHE / 'transkun.whl', out, {'transkun-2.0.1.dist-info/LICENSE': 'notices/Transkun-LICENSE'})
    env = Path(os.environ.get('MIDI_STUDIO_FORGE_ENV_DIR') or Path(os.environ.get('LOCALAPPDATA','')) / 'midi-studio/forge-env')
    models = Path(os.environ.get('MIDI_STUDIO_MODELS_DIR') or env / 'models')
    (out / 'onnx').mkdir()
    for item in (c for c in COMPONENTS if c['group'] == 'piano'):
        name, expected = Path(item['path']).name, item['sha256']
        src = next((p for p in (models/'onnx'/name, FORGE/'assets/onnx'/name, FORGE/'assets'/name) if p.is_file() and digest(p) == expected), None)
        if src is None:
            raise ValueError(f'Missing verified Transkun 2.0.1 export: {name} (sha256={expected}); supply under MIDI_STUDIO_MODELS_DIR/onnx')
        shutil.copyfile(src, out/'onnx'/name)


def stage(out, with_components):
    notices = out / 'notices'
    notices.mkdir()
    for f in (ROOT / 'third-party').iterdir():
        if f.is_file():
            shutil.copyfile(f, notices / f.name)
    shutil.copyfile(PINS, notices / PINS.name)
    shutil.copyfile(ROOT/'tools/forge-components.json', notices/'forge-components.json')
    if with_components:
        stage_components(out)
        for item in COMPONENTS:
            p = item['path']
            staged = out / (p.removeprefix('assets/') if p.startswith('assets/') else 'ort/'+Path(p).name)
            if staged.stat().st_size != item['size'] or digest(staged) != item['sha256']:
                raise ValueError(f'Unexpected component bytes: {p}')
    else:
        unpack(CACHE/NOTICE_ARCHIVE, out, {n: f'notices/{n}' for n in
               ('BasicPitch-LICENSE','BasicPitch-NOTICE','ORT-LICENSE','ORT-ThirdPartyNotices.txt','Transkun-LICENSE')})
    wheel = ROOT/'python-engine/wheelhouse/ncls-0.0.70-cp313-cp313-win_amd64.whl'
    if digest(wheel) != '92f32b582a199c73e9c20c939ac2fd38e7279c17772f89a697e96b982fab1186':
        raise ValueError('Unexpected NCLS wheel')
    unpack(wheel, out, {'ncls-0.0.70.dist-info/licenses/LICENSE': 'notices/NCLS-LICENSE'})
    for n in ('AUTHORS','LICENCE','COPYING.LGPL','LICENSE-PFFFT.txt'):
        shutil.copyfile(FORGE/'vendor/libsoxr'/n, notices/('libsoxr-'+n))
    shutil.copyfile(ROOT/'renderer/soundfonts/FluidR3_GM/LICENSE.txt', notices/'FluidR3-MIDIjs-LICENSE.txt')
    with zipfile.ZipFile(notices/'forge-relink-source.zip','w',zipfile.ZIP_DEFLATED) as z:
        for p in [ROOT/'LICENSE', FORGE/'Cargo.toml', FORGE/'Cargo.lock', FORGE/'build.rs']:
            z.write(p,p.name)
        reference = FORGE/'src/medley_reference.pcm'
        if reference.is_file():
            z.write(reference, 'src/medley_reference.pcm')
        for folder in ('src','vendor'):
            for p in sorted((FORGE/folder).rglob('*')):
                if p.is_file() and p.suffix.lower() in ('.c','.h','.rs','','.txt','.lgpl'):
                    z.write(p,p.relative_to(FORGE))
    crate_notices(notices/'Rust-licenses.txt')
    hashes = [f'{digest(p)}  {p.relative_to(out).as_posix()}' for p in sorted(out.rglob('*')) if p.is_file()]
    (notices/'SHA256SUMS.txt').write_text('\n'.join(hashes)+'\n', encoding='utf-8')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--components', action='store_true', help='Also stage the separate pinned public Forge component payload.')
    args = parser.parse_args()
    archives(args.components)
    target = TARGET if args.components else FORGE/'target/core-resources'
    with tempfile.TemporaryDirectory(dir=CACHE.parent) as temp:
        stage(Path(temp), args.components)
        if target.exists():
            shutil.rmtree(target)
        Path(temp).rename(target)
    print(f'Staged {"component" if args.components else "core"} payload at {target}')

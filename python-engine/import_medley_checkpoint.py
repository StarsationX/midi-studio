"""Convert an owned legacy Medley checkpoint using an already installed Forge (offline).

  <Forge Python> import_medley_checkpoint.py <MSST dir> <checkpoint> <destination ONNX>

Keep both original files. Nothing is published unless the graph is byte-identical
with the tested Medley export. Existing files are never overwritten.
"""
import hashlib
import os
from pathlib import Path
import subprocess
import sys
import tempfile

CKPT = "BS-Rofo-SW-Fixed.ckpt"
CONFIG = "BS-Rofo-SW-Fixed.yaml"
CHECKPOINT_SHA = "24e7d35ee9c64415673d3fd33e06a67cac2c103c5df6267ba1576459c775916e"
CONFIG_SHA = "f9fada9f94e5ba2d2e4600196299459294bc5f532b314c209cc156ac63e4329b"
MODEL_SHA = "fa89f1997f7120f1eb3cac19e7590653d6e6b92ba9dd2d486645d86c0667aede"
# The full 2.13.0 export differs from the tested 2.11.0 graph only in
# producer_version. No weights, nodes, or other exporter versions are accepted.
TORCH_213_SHA = "5962fc18080380b91cd7bdbd437358ae23e7330d44b67ea4d6d10a75f659643f"


def file_hash(source, copy=None):
    digest = hashlib.sha256()
    with source.open('rb') as reader:
        while chunk := reader.read(1024 * 1024):
            digest.update(chunk)
            if copy is not None:
                copy.write(chunk)
    return digest.hexdigest()


def verify(source, expected, copy=None):
    if file_hash(source, copy) != expected:
        raise ValueError(f'{source.name} has a different SHA-256 than the tested Medley file. Nothing was installed.')


def verify_export(graph):
    sha = file_hash(graph)
    if sha == MODEL_SHA:
        return
    if sha == TORCH_213_SHA:
        with graph.open('r+b') as out:
            if out.read(19) != b'\x08\x08\x12\x07pytorch\x1a\x062.13.0':
                raise ValueError('Unexpected ONNX producer header.')
            out.seek(16)
            out.write(b'1')
        verify(graph, MODEL_SHA)
        return
    raise ValueError(f'This exporter produced an unrecognized graph ({sha}). Choose the tested ONNX instead.')


def convert(msst, checkpoint, destination):
    if not (msst / 'models' / 'bs_roformer' / 'bs_roformer.py').is_file():
        raise ValueError('The original local Forge MSST code is required. Import an existing tested ONNX instead.')
    exporter = Path(__file__).resolve().with_name('export_bsrofo_body.py')
    if not exporter.is_file():  # source checkout, rather than bundled python-engine/
        exporter = exporter.parent.parent / 'forge-rs' / 'tools' / exporter.name
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.medley-', dir=destination.parent) as folder:
        stage = Path(folder)
        # Load only the exact bytes we verified, not a reopened user-selected pickle.
        for source, name, sha in [(checkpoint, CKPT, CHECKPOINT_SHA), (checkpoint.with_name(CONFIG), CONFIG, CONFIG_SHA)]:
            with (stage / name).open('xb') as out:
                verify(source, sha, out)
        if destination.exists():
            verify(destination, MODEL_SHA)
            return
        graph = stage / 'bsrofo_sw_body.onnx'
        env = dict(os.environ, ATTN_GROUPS='8', EXACT_ACT='0', CHECK_SMALL='0', HF_HUB_OFFLINE='1')
        subprocess.run([sys.executable, '-I', str(exporter), str(msst), str(stage), str(graph), '1151', '64'], env=env, check=True)
        verify_export(graph)
        # Windows rename fails if the target already exists; on POSIX use link
        # for the same atomic no-clobber guarantee. The temp dir is same-volume.
        try:
            if os.name == 'nt':
                os.rename(graph, destination)
            else:
                os.link(graph, destination)
        except FileExistsError:
            verify(destination, MODEL_SHA)


if __name__ == '__main__':
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    try:
        convert(*(Path(arg).resolve() for arg in sys.argv[1:]))
    except (OSError, ValueError, subprocess.CalledProcessError) as exc:
        sys.exit(f'Offline Medley conversion failed: {exc}')
    print(f'Verified Medley model: {sys.argv[3]}')

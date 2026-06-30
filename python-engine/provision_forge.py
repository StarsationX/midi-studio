#!/usr/bin/env python3
r"""provision_forge.py - First-run provisioner for the Midi-Forge heavy env.

Runs under the TINY player interpreter (stdlib only) and bootstraps the heavy
interpreter from scratch into the forge-env dir (default
%LOCALAPPDATA%\midi-studio\forge-env):

  embeddable Python 3.13 -> pip -> PyTorch+CUDA (cu128) -> requirements ->
  basic-pitch (--no-deps) -> onnxruntime -> MSST -> BS-Rofo model + FFmpeg ->
  verify_install.py

Properties: RESUMABLE (each step skips if already done, so an interrupted run or
an adopted legacy env continues); HONEST progress (indeterminate "don't close"
for the unmeasurable pip steps); SAFE FINALIZE (env.json/.ready written only
after verify passes); DISK GUARDED (preflight + re-checks before the big steps).

Progress protocol (parsed by forge-provisioner.js):
    MSTEP|<pct>|<step>|<message>     (pct = -1 means indeterminate)
    MLOG|<text>
    MDONE|ok
    MFAIL|<message>
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
import zipfile
from pathlib import Path

ENV_VERSION = "1"
PYVER = "3.13.5"
PYEMBED_URL = f"https://www.python.org/ftp/python/{PYVER}/python-{PYVER}-embed-amd64.zip"
GETPIP_URL = "https://bootstrap.pypa.io/get-pip.py"
TORCH_INDEX = "https://download.pytorch.org/whl/cu128"
MSST_REF = os.environ.get("MSST_REF", "main")  # TODO: pin to a commit (supply chain)
MSST_ZIP_URL = ("https://github.com/ZFTurbo/Music-Source-Separation-Training/archive/"
                f"{MSST_REF}.zip")

MIN_FREE_GB_START, MIN_FREE_GB_TORCH, MIN_FREE_GB_MODEL = 15, 8, 2
_NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0


def emit(line): sys.stdout.write(line + "\n"); sys.stdout.flush()
def step(pct, name, msg): emit(f"MSTEP|{pct}|{name}|{msg}")
def log(msg): emit(f"MLOG|{msg}")


class ProvisionError(Exception):
    pass


class Provisioner:
    def __init__(self, env_dir: Path, engine_dir: Path):
        self.env_dir = env_dir
        self.engine_dir = engine_dir
        self.py = env_dir / "python" / "python.exe"
        self.models_dir = env_dir / "models"
        self.wheelhouse = engine_dir / "wheelhouse"

    def _free_gb(self):
        try:
            anchor = self.env_dir if self.env_dir.exists() else Path(self.env_dir.anchor)
            return shutil.disk_usage(str(anchor)).free / (1024 ** 3)
        except Exception:
            return float("inf")

    def _require_disk(self, min_gb, where):
        free = self._free_gb()
        if free < min_gb:
            raise ProvisionError(
                f"Not enough free disk for {where}: need ~{min_gb} GB, {free:.1f} GB free.")

    def _run(self, args, env=None):
        log("$ " + " ".join(str(a) for a in args))
        proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, encoding="utf-8", errors="replace",
                                cwd=str(self.env_dir), env=env, creationflags=_NO_WINDOW)
        for line in proc.stdout:
            log(line.rstrip())
        if proc.wait() != 0:
            raise ProvisionError(f"command failed: {args[0]}")

    def _pip(self, *args):
        base = [str(self.py), "-m", "pip", "install", "--retries", "5", "--timeout", "60",
                "--disable-pip-version-check", "--no-warn-script-location"]
        if self.wheelhouse.is_dir():
            base += ["--find-links", str(self.wheelhouse)]
        self._run(base + list(args))

    def _download(self, url, dest, label):
        log(f"download {url}")
        dest.parent.mkdir(parents=True, exist_ok=True)
        req = urllib.request.Request(url, headers={"User-Agent": "midi-studio-provisioner"})
        with urllib.request.urlopen(req, timeout=60) as r, open(dest, "wb") as f:
            total = int(r.headers.get("Content-Length", "0"))
            read, last = 0, -1
            while True:
                chunk = r.read(1024 * 256)
                if not chunk:
                    break
                f.write(chunk); read += len(chunk)
                mb = read / 1048576
                if total:
                    pct = int(read * 100 / total)
                    if pct != last:
                        step(pct, label, f"{label} {pct}% ({mb:.0f} MB)"); last = pct
                elif int(mb) % 8 == 0 and int(mb) != last:
                    step(-1, label, f"{label} {mb:.0f} MB"); last = int(mb)

    def ensure_python(self):
        if self.py.exists():
            log("embedded Python present"); return
        step(10, "Python", "Downloading embedded Python…")
        zp = self.env_dir / "python-embed.zip"
        self._download(PYEMBED_URL, zp, "Python")
        pdir = self.env_dir / "python"; pdir.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(zp) as z:
            z.extractall(pdir)
        zp.unlink(missing_ok=True)
        for pth in pdir.glob("python*._pth"):
            pth.write_text(pth.read_text().replace("#import site", "import site"))
        step(14, "Python", "Bootstrapping pip…")
        gp = pdir / "get-pip.py"
        self._download(GETPIP_URL, gp, "pip")
        self._run([str(self.py), str(gp), "--no-warn-script-location"])
        gp.unlink(missing_ok=True)

    def _torch_installed(self):
        return (self.env_dir / "python" / "Lib" / "site-packages" / "torch").exists()

    def install_torch(self):
        # A cancelled/failed torch install leaves a half-populated dir that the
        # "torch dir exists" check would wrongly treat as done. Guard with a
        # marker: if it's present, the last attempt didn't finish — wipe + redo.
        site = self.env_dir / "python" / "Lib" / "site-packages"
        partial = self.env_dir / ".torch.partial"
        if partial.exists():
            log("previous torch install was interrupted — cleaning up first")
            for d in ("torch", "torchaudio", "torchvision", "torchcodec"):
                shutil.rmtree(site / d, ignore_errors=True)
        elif self._torch_installed():
            log("torch present"); return
        self._require_disk(MIN_FREE_GB_TORCH, "PyTorch + CUDA")
        step(-1, "PyTorch", "Installing PyTorch + CUDA (~3 GB, 5–12 min — don't close)…")
        partial.write_text("1")
        self._pip("--index-url", TORCH_INDEX,
                  "torch==2.11.0", "torchaudio==2.11.0", "torchvision==0.26.0")
        self._pip("torchcodec==0.11.1")
        partial.unlink(missing_ok=True)

    def install_deps(self):
        req = self.engine_dir / "requirements.txt"
        step(-1, "Packages", "Installing Python packages…")
        # --prefer-binary: the embeddable Python has no dev headers (Python.h), so
        # it CANNOT compile C-extension sdists. A few pins (e.g. ncls, a Transkun
        # dep) no longer publish a wheel for current Pythons, so pip would try to
        # build from source and fail with "No module named Cython" / missing
        # Python.h. We ship those wheels in python-engine/wheelhouse (added to
        # --find-links by _pip); prefer-binary makes pip take them over an sdist.
        if req.exists():
            self._pip("-r", str(req), "--prefer-binary")
        else:
            log(f"requirements.txt not found at {req}")
        self._pip("--no-deps", "--prefer-binary", "basic-pitch==0.4.0")
        self._pip("--prefer-binary", "onnxruntime")

    def fetch_msst(self):
        if (self.env_dir / "msst" / "inference.py").exists():
            log("MSST present"); return
        step(70, "MSST", "Downloading separation framework…")
        zp = self.env_dir / "msst.zip"
        self._download(MSST_ZIP_URL, zp, "MSST")
        with zipfile.ZipFile(zp) as z:
            z.extractall(self.env_dir)
        zp.unlink(missing_ok=True)
        ex = self.env_dir / f"Music-Source-Separation-Training-{MSST_REF}"
        if ex.exists():
            dst = self.env_dir / "msst"
            if dst.exists():
                shutil.rmtree(dst, ignore_errors=True)
            ex.rename(dst)

    def fetch_assets(self):
        self._require_disk(MIN_FREE_GB_MODEL, "the model + FFmpeg")
        step(80, "Model", "Downloading model + FFmpeg (~900 MB)…")
        script = self.engine_dir / "download_assets.py"
        if not script.exists():
            raise ProvisionError(f"download_assets.py not found at {script}")
        env = dict(os.environ, MIDI_STUDIO_MODELS_DIR=str(self.models_dir), PYTHONUNBUFFERED="1")
        self.models_dir.mkdir(parents=True, exist_ok=True)
        proc = subprocess.Popen([str(self.py), str(script)], stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, text=True, encoding="utf-8",
                                errors="replace", cwd=str(self.env_dir), env=env,
                                creationflags=_NO_WINDOW)
        for line in proc.stdout:
            log(line.rstrip())
        if proc.wait() != 0:
            raise ProvisionError("download_assets.py failed")

    def verify(self):
        step(95, "Verify", "Verifying installation…")
        script = self.engine_dir / "verify_install.py"
        if not script.exists():
            log("verify_install.py missing; skipping deep verify"); return
        env = dict(os.environ, MIDI_STUDIO_MODELS_DIR=str(self.models_dir))
        self._run([str(self.py), str(script)], env=env)

    def finalize(self):
        (self.env_dir / "env.json").write_text(json.dumps(
            {"envVersion": ENV_VERSION, "ready": True, "python": str(self.py),
             "ts": int(time.time())}, indent=2))
        (self.env_dir / ".ready").write_text(ENV_VERSION)

    def run(self):
        self.env_dir.mkdir(parents=True, exist_ok=True)
        self._require_disk(MIN_FREE_GB_START, "first-time setup")
        step(5, "Start", "Preparing…")
        self.ensure_python()
        self.install_torch()
        self.install_deps()
        self.fetch_msst()
        self.fetch_assets()
        self.verify()
        self.finalize()
        step(100, "Done", "Midi-Forge is ready.")
        emit("MDONE|ok")

    def plan(self):
        log(f"env_dir    = {self.env_dir}")
        log(f"engine_dir = {self.engine_dir}")
        log(f"free_disk  = {self._free_gb():.1f} GB (need >= {MIN_FREE_GB_START})")
        log(f"python     = {'present' if self.py.exists() else 'MISSING -> download'}")
        log(f"torch      = {'present' if self._torch_installed() else 'MISSING -> pip cu128'}")
        log(f"msst       = {'present' if (self.env_dir / 'msst' / 'inference.py').exists() else 'MISSING'}")
        log(f"models     = {self.models_dir} ({'present' if self.models_dir.is_dir() and any(self.models_dir.iterdir()) else 'missing'})")
        emit("MDONE|ok")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--env-dir", default=os.environ.get("MIDI_STUDIO_FORGE_ENV_DIR", ""))
    ap.add_argument("--engine-dir", default=os.environ.get("MIDI_STUDIO_ENGINE_DIR", ""))
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    env_dir = Path(a.env_dir) if a.env_dir else (
        Path(os.environ.get("LOCALAPPDATA", Path.home())) / "midi-studio" / "forge-env")
    engine_dir = Path(a.engine_dir) if a.engine_dir else Path(__file__).resolve().parent
    prov = Provisioner(env_dir, engine_dir)
    try:
        prov.plan() if a.dry_run else prov.run()
        return 0
    except ProvisionError as e:
        emit(f"MFAIL|{e}"); return 1
    except Exception as e:  # noqa: BLE001
        emit(f"MFAIL|{type(e).__name__}: {e}"); return 1


if __name__ == "__main__":
    sys.exit(main())

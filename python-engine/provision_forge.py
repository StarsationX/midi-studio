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
import threading
import time
import urllib.request
import zipfile
from pathlib import Path

ENV_VERSION = "1"
PYVER = "3.13.5"
PYEMBED_URL = f"https://www.python.org/ftp/python/{PYVER}/python-{PYVER}-embed-amd64.zip"
GETPIP_URL = "https://bootstrap.pypa.io/get-pip.py"
TORCH_INDEX = "https://download.pytorch.org/whl/cu128"
TORCH_INDEX_CPU = "https://download.pytorch.org/whl/cpu"
# cuda | cpu | auto, auto installs the CUDA build only when an NVIDIA GPU is
# actually present.
TORCH_BUILD = os.environ.get("FORGE_TORCH", "auto").lower()
MSST_REF = os.environ.get("MSST_REF", "main")  # TODO: pin to a commit (supply chain)
MSST_ZIP_URL = ("https://github.com/ZFTurbo/Music-Source-Separation-Training/archive/"
                f"{MSST_REF}.zip")

MIN_FREE_GB_START, MIN_FREE_GB_TORCH, MIN_FREE_GB_MODEL = 15, 8, 2
# The CUDA wheel is 2.75 GB on its own and unpacks to several more; the CPU
# wheel is around a tenth of that.
MIN_FREE_GB_START_CPU, MIN_FREE_GB_TORCH_CPU = 6, 2
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
        # pip unpacks a ~2.8 GB torch wheel through its cache and temp dir. Those
        # default to %LOCALAPPDATA% and %TEMP% on C:, so a user who picked another
        # drive for Forge storage precisely because C: is full still ran out of
        # space mid-download. Keep every big write on the drive they chose.
        self.pip_cache = env_dir / "pip-cache"
        self.tmp_dir = env_dir / "tmp"
        self._nvidia = None
        self._t0 = time.time()

    def _nvidia_present(self):
        """Is there an NVIDIA GPU the CUDA build could actually use?

        A machine with no NVIDIA card was still downloading 2.75 GB of CUDA
        wheels it can never run, the slowest, most painful part of setup, for
        nothing. AMD/Intel keep GPU acceleration through onnxruntime-directml,
        which is installed either way.
        """
        if TORCH_BUILD in ("cuda", "cpu"):
            return TORCH_BUILD == "cuda"
        if self._nvidia is not None:
            return self._nvidia
        # File check, not a subprocess. Running nvidia-smi here could hang the
        # whole setup before a single line of output ("stuck at Preparing"),
        # and subprocess.run's timeout does not save you when a grandchild
        # holds the pipes. nvcuda.dll is installed by every NVIDIA driver that
        # can run CUDA, which is exactly the question being asked.
        system32 = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32"
        self._nvidia = (system32 / "nvcuda.dll").exists()
        return self._nvidia

    def _drive(self):
        return str(Path(self.env_dir).anchor) or str(self.env_dir)

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
                f"Not enough free disk on {self._drive()} for {where}: need ~{min_gb} GB, "
                f"{free:.1f} GB free. Free up space, or pick another drive with "
                f"Settings -> Forge storage -> Change.")

    def _child_env(self, extra=None):
        self.pip_cache.mkdir(parents=True, exist_ok=True)
        self.tmp_dir.mkdir(parents=True, exist_ok=True)
        env = dict(os.environ, PIP_CACHE_DIR=str(self.pip_cache),
                   TMP=str(self.tmp_dir), TEMP=str(self.tmp_dir))
        if extra:
            env.update(extra)
        return env

    def _site_packages_mb(self):
        """Bytes written into the environment so far, as MB."""
        total = 0
        root = self.env_dir / "python" / "Lib" / "site-packages"
        try:
            for base, _dirs, files in os.walk(root):
                for name in files:
                    try:
                        total += os.path.getsize(os.path.join(base, name))
                    except OSError:
                        pass
        except OSError:
            return 0
        return total / (1024 * 1024)

    def _watch_progress(self, label, expected_mb):
        """Report growth while a command prints nothing.

        pip writes several GB of files after its last line of output, so the
        longest part of setup looks identical to a hang. Watch the folder
        instead of waiting for the process to say something.
        """
        stop = threading.Event()
        start_mb = self._site_packages_mb()

        def run():
            while not stop.wait(6.0):
                grown = max(0.0, self._site_packages_mb() - start_mb)
                if expected_mb:
                    pct = min(99, int(grown * 100 / expected_mb))
                    step(-1, label, f"{label}: {grown:,.0f} MB written (~{pct}%)")
                else:
                    step(-1, label, f"{label}: {grown:,.0f} MB written")
        thread = threading.Thread(target=run, daemon=True, name="progress")
        thread.start()
        return stop

    def _run(self, args, env=None):
        log("$ " + " ".join(str(a) for a in args))
        proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, encoding="utf-8", errors="replace",
                                cwd=str(self.env_dir), env=env, creationflags=_NO_WINDOW)
        out_of_space = False
        for line in proc.stdout:
            line = line.rstrip()
            if "No space left on device" in line or "Errno 28" in line:
                out_of_space = True
            log(line)
        if proc.wait() != 0:
            if out_of_space:
                raise ProvisionError(
                    f"Ran out of disk space on {self._drive()} ({self._free_gb():.1f} GB free). "
                    f"Free up space, or move Forge storage to a bigger drive with "
                    f"Settings -> Forge storage -> Change, then run setup again.")
            raise ProvisionError(f"command failed: {args[0]}")

    def _pip(self, *args, watch=None, expected_mb=0):
        base = [str(self.py), "-m", "pip", "install", "--retries", "5", "--timeout", "60",
                "--disable-pip-version-check", "--no-warn-script-location"]
        if self.wheelhouse.is_dir():
            base += ["--find-links", str(self.wheelhouse)]
        stop = self._watch_progress(watch, expected_mb) if watch else None
        try:
            self._run(base + list(args), env=self._child_env())
        finally:
            if stop is not None:
                stop.set()

    def _download(self, url, dest, label):
        log(f"download {url}")
        dest.parent.mkdir(parents=True, exist_ok=True)
        req = urllib.request.Request(url, headers={"User-Agent": "midi-studio-provisioner"})
        with urllib.request.urlopen(req, timeout=60) as r, open(dest, "wb") as f:
            total = int(r.headers.get("Content-Length", "0"))
            read, last, beat = 0, -1, 0.0
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
                # GitHub archives send no Content-Length, so the bar cannot move.
                # The log must still show life or a slow link reads as a hang.
                if mb - beat >= 4:
                    beat = mb; log(f"{label} {mb:.0f} MB")
        log(f"{label} downloaded ({read / 1048576:.0f} MB)")

    def ensure_python(self):
        if self.py.exists():
            self._mark("embedded Python present"); return
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
        # marker: if it's present, the last attempt didn't finish, wipe + redo.
        site = self.env_dir / "python" / "Lib" / "site-packages"
        partial = self.env_dir / ".torch.partial"
        if partial.exists():
            log("previous torch install was interrupted, cleaning up first")
            for d in ("torch", "torchaudio", "torchvision", "torchcodec"):
                shutil.rmtree(site / d, ignore_errors=True)
        elif self._torch_installed():
            log("torch present"); return
        cuda = self._nvidia_present()
        self._mark("installing PyTorch, this is the long one")
        if cuda:
            self._require_disk(MIN_FREE_GB_TORCH, "PyTorch + CUDA")
            step(-1, "PyTorch", "Installing PyTorch + CUDA (~3 GB, 5, 12 min, don't close)…")
        else:
            self._require_disk(MIN_FREE_GB_TORCH_CPU, "PyTorch")
            log("no NVIDIA GPU found, installing the CPU build of PyTorch "
                "(about 2.5 GB less to download; AMD/Intel GPUs still accelerate "
                "through DirectML)")
            step(-1, "PyTorch", "Installing PyTorch (CPU build, ~300 MB)…")
        partial.write_text("1")
        # Unpacked sizes, roughly: the CUDA build lands around 5.5 GB, the CPU
        # build around 800 MB. Close enough to turn silence into a percentage.
        self._pip("--index-url", TORCH_INDEX if cuda else TORCH_INDEX_CPU,
                  "torch==2.11.0", "torchaudio==2.11.0", "torchvision==0.26.0",
                  watch="PyTorch", expected_mb=5500 if cuda else 800)
        self._pip("torchcodec==0.11.1")
        partial.unlink(missing_ok=True)

    def install_deps(self):
        self._mark("installing the Python packages")
        req = self.engine_dir / "requirements.txt"
        step(-1, "Packages", "Installing Python packages…")
        # --prefer-binary: the embeddable Python has no dev headers (Python.h), so
        # it CANNOT compile C-extension sdists. A few pins (e.g. ncls, a Transkun
        # dep) no longer publish a wheel for current Pythons, so pip would try to
        # build from source and fail with "No module named Cython" / missing
        # Python.h. We ship those wheels in python-engine/wheelhouse (added to
        # --find-links by _pip); prefer-binary makes pip take them over an sdist.
        if req.exists():
            self._pip("-r", str(req), "--prefer-binary", watch="Packages", expected_mb=1200)
        else:
            log(f"requirements.txt not found at {req}")
        self._pip("--no-deps", "--prefer-binary", "basic-pitch==0.4.0")
        # onnxruntime-directml (not plain onnxruntime): ships both the CPU EP
        # (basic-pitch) AND DmlExecutionProvider, which gives GPU separation on
        # ANY DirectX 12 card, the only GPU path for non-CUDA users (AMD/Intel).
        self._pip("--prefer-binary", "onnxruntime-directml")

    def fetch_msst(self):
        self._mark("fetching the separation framework")
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
        self._mark("downloading the model and FFmpeg")
        self._require_disk(MIN_FREE_GB_MODEL, "the model + FFmpeg")
        step(80, "Model", "Downloading model + FFmpeg (~900 MB)…")
        script = self.engine_dir / "download_assets.py"
        if not script.exists():
            raise ProvisionError(f"download_assets.py not found at {script}")
        env = self._child_env({"MIDI_STUDIO_MODELS_DIR": str(self.models_dir), "PYTHONUNBUFFERED": "1"})
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
        self._mark("verifying")
        step(95, "Verify", "Verifying installation…")
        script = self.engine_dir / "verify_install.py"
        if not script.exists():
            log("verify_install.py missing; skipping deep verify"); return
        env = self._child_env({"MIDI_STUDIO_MODELS_DIR": str(self.models_dir)})
        self._run([str(self.py), str(script)], env=env)

    def finalize(self):
        # The wheel cache is only useful while setup is retrying; several GB of it
        # is not something to leave sitting on the drive the user picked.
        shutil.rmtree(self.pip_cache, ignore_errors=True)
        shutil.rmtree(self.tmp_dir, ignore_errors=True)
        (self.env_dir / "env.json").write_text(json.dumps(
            {"envVersion": ENV_VERSION, "ready": True, "python": str(self.py),
             "ts": int(time.time())}, indent=2))
        (self.env_dir / ".ready").write_text(ENV_VERSION)

    def _mark(self, message):
        """Every phase says when it started. A silent setup is unfixable."""
        log(f"[{time.time() - self._t0:5.1f}s] {message}")

    def run(self):
        self._mark(f"setup starting in {self.env_dir}")
        step(5, "Start", "Checking your system…")
        self.env_dir.mkdir(parents=True, exist_ok=True)
        self._mark("checking graphics driver")
        cuda = self._nvidia_present()
        self._mark(f"{'NVIDIA driver found. CUDA build' if cuda else 'no NVIDIA driver. CPU build (much smaller)'}")
        self._mark(f"checking free space on {self._drive()}")
        self._require_disk(MIN_FREE_GB_START if cuda else MIN_FREE_GB_START_CPU, "first-time setup")
        self._mark(f"{self._free_gb():.1f} GB free, ok")
        self._mark("checking the embedded Python")
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
        cuda = self._nvidia_present()
        need = MIN_FREE_GB_START if cuda else MIN_FREE_GB_START_CPU
        log(f"torch      = {'CUDA build (NVIDIA GPU found)' if cuda else 'CPU build (no NVIDIA GPU)'}")
        log(f"free_disk  = {self._free_gb():.1f} GB on {self._drive()} (need >= {need})")
        log(f"python     = {'present' if self.py.exists() else 'MISSING -> download'}")
        log(f"torch      = {'present' if self._torch_installed() else ('MISSING -> pip ' + ('cu128' if cuda else 'cpu'))}")
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

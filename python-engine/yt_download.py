"""Download audio from a URL (YouTube etc.) and save as MP3 via yt-dlp + bundled FFmpeg.

Usage: yt_download.py <url> [output_dir]
Prints "DOWNLOADED: <path>" on success so callers (GUI) can pick up the file.
"""
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
FFMPEG_BIN = ROOT / "ffmpeg" / "ffmpeg-master-latest-win64-lgpl-shared" / "bin"
if FFMPEG_BIN.exists():
    os.environ["PATH"] = str(FFMPEG_BIN) + os.pathsep + os.environ.get("PATH", "")

import yt_dlp

# Where finished MP3s land by default. Override with arg 2.
DEFAULT_OUT = Path(os.environ.get("YT_OUTPUT_DIR", str(ROOT / "downloads")))


def _sanitize(name: str) -> str:
    name = re.sub(r'[<>:"/\\|?*]', "_", name)
    return name.strip().rstrip(".")[:120] or "audio"


def download(url: str, out_dir: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    final_path: dict[str, str] = {}

    def hook(d):
        if d["status"] == "finished":
            final_path["file"] = d.get("filename", "")

    opts = {
        "format": "bestaudio/best",
        "outtmpl": str(out_dir / "%(title)s.%(ext)s"),
        "restrictfilenames": False,
        "windowsfilenames": True,
        "noplaylist": True,
        "quiet": False,
        "no_warnings": False,
        "progress_hooks": [hook],
        "postprocessors": [
            {"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": "0"},
        ],
        "postprocessor_args": ["-ar", "44100"],
    }
    if FFMPEG_BIN.exists():
        opts["ffmpeg_location"] = str(FFMPEG_BIN)

    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=True)

    # After FFmpegExtractAudio the file is <title>.mp3; derive it robustly.
    title = info.get("title", "audio")
    mp3 = out_dir / f"{_sanitize(title)}.mp3"
    if mp3.exists():
        return mp3
    # Fallback: hook filename with .mp3 suffix
    if final_path.get("file"):
        cand = Path(final_path["file"]).with_suffix(".mp3")
        if cand.exists():
            return cand
    # Last resort: newest .mp3 in the dir
    mp3s = sorted(out_dir.glob("*.mp3"), key=lambda p: p.stat().st_mtime, reverse=True)
    if mp3s:
        return mp3s[0]
    raise RuntimeError("Download finished but no MP3 was produced.")


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: yt_download.py <url> [output_dir]")
        return 1
    url = sys.argv[1].strip()
    out_dir = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else DEFAULT_OUT

    print(f"Downloading audio from: {url}")
    print(f"Output folder: {out_dir}")
    try:
        mp3 = download(url, out_dir)
    except Exception as e:
        msg = str(e)
        print(f"[ERROR] {type(e).__name__}: {msg}")
        low = msg.lower()
        if "unavailable" in low or "private" in low:
            print("Hint: the video may be private, deleted, or region-locked.")
        elif "sign in" in low or "age" in low or "confirm your age" in low:
            print("Hint: age-restricted videos can't be downloaded without sign-in.")
        elif "javascript" in low or "format" in low or "nsig" in low:
            print("Hint: YouTube sometimes needs a JS runtime for certain videos.")
            print("      Installing Deno (https://deno.com) and reopening usually fixes it.")
        else:
            print("Hint: check the URL is correct and you have an internet connection.")
        return 1
    print(f"\nDONE.")
    print(f"DOWNLOADED: {mp3}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

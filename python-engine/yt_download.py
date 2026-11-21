"""Download audio from a URL (YouTube etc.) and save as MP3 via yt-dlp + bundled FFmpeg.

Usage: yt_download.py <url> [output_dir]
Prints "DOWNLOADED: <path>" on success so callers (GUI) can pick up the file.
"""
import os
import sys
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent

# FFmpeg lives in the provisioned forge-env (next to the heavy interpreter), not
# this (read-only when packaged) script dir. Resolve a base that actually holds
# it; fall back to ROOT for a co-located dev/source checkout.
_ASSET_BASE = Path(sys.executable).resolve().parent
if _ASSET_BASE.name.lower() in ("python", "scripts"):
    _ASSET_BASE = _ASSET_BASE.parent
if not (_ASSET_BASE / "ffmpeg").exists() and (ROOT / "ffmpeg").exists():
    _ASSET_BASE = ROOT

FFMPEG_BIN = _ASSET_BASE / "ffmpeg" / "ffmpeg-master-latest-win64-lgpl-shared" / "bin"
if FFMPEG_BIN.exists():
    os.environ["PATH"] = str(FFMPEG_BIN) + os.pathsep + os.environ.get("PATH", "")

import yt_dlp

def _default_out() -> Path:
    override = os.environ.get("YT_OUTPUT_DIR", "").strip()
    if override:
        return Path(override)
    home = Path(os.environ.get("USERPROFILE", str(Path.home())))
    return home / "Documents" / "MIDI Studio"


# Where finished MP3s land by default. Override with arg 2 or YT_OUTPUT_DIR.
DEFAULT_OUT = _default_out()


def _host_is(url: str, domain: str) -> bool:
    try:
        hostname = (urlsplit(url).hostname or "").lower().rstrip(".")
    except ValueError:
        return False
    return hostname == domain or hostname.endswith("." + domain)


def _is_youtube(url: str) -> bool:
    return _host_is(url, "youtube.com") or _host_is(url, "youtu.be")


def download(url: str, out_dir: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    final_path: dict[str, str] = {}
    processed_paths: list[str] = []
    is_youtube = _is_youtube(url)

    def hook(d):
        if d["status"] == "finished":
            final_path["file"] = d.get("filename", "")

    def processed(d):
        if d.get("status") == "finished":
            filename = (d.get("info_dict") or {}).get("filepath")
            if filename:
                processed_paths.append(filename)

    opts = {
        "format": "bestaudio/best",
        "outtmpl": str(out_dir / "%(title)s.%(ext)s"),
        "restrictfilenames": False,
        "windowsfilenames": True,
        "noplaylist": True,
        "quiet": False,
        "no_warnings": False,
        "progress_hooks": [hook],
        "postprocessor_hooks": [processed],
        "postprocessors": [
            {"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": "0"},
        ],
        "postprocessor_args": ["-ar", "44100"],
    }
    if is_youtube:
        # Keep the alternate-client retry specific to YouTube; other extractors
        # cannot recover from a rejected request by changing YouTube clients.
        opts["extractor_args"] = {"youtube": {"player_client": ["android"]}}
        opts["js_runtimes"] = {"node": {}, "deno": {}}
    if FFMPEG_BIN.exists():
        opts["ffmpeg_location"] = str(FFMPEG_BIN)
    # Login-walled sources (most Instagram reels, some TikTok) only work with a
    # signed-in session. Opt in per-run rather than always poking at browser
    # profiles: set YT_COOKIES_BROWSER=chrome|edge|firefox|brave.
    browser = os.environ.get("YT_COOKIES_BROWSER", "").strip().lower()
    if browser:
        opts["cookiesfrombrowser"] = (browser,)

    def extract():
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=True)
            if not isinstance(info, dict):
                raise RuntimeError("The site did not return an audio download.")
            return info, ydl.prepare_filename(info)

    try:
        info, expected = extract()
    except yt_dlp.utils.DownloadError:
        if not is_youtube:
            raise
        print("Retrying with yt-dlp's default player clients...")
        opts.pop("extractor_args", None)
        final_path.clear()
        processed_paths.clear()
        info, expected = extract()

    # Prefer the postprocessor's exact path, including any final move or rename.
    # Every fallback belongs to this extraction; another MP3 in the output
    # folder must never make a failed or incomplete download look successful.
    candidates = list(reversed(processed_paths))
    if info.get("filepath"):
        candidates.append(info["filepath"])
    for item in info.get("requested_downloads") or []:
        if isinstance(item, dict) and item.get("filepath"):
            candidates.append(item["filepath"])
    if final_path.get("file"):
        candidates.append(str(Path(final_path["file"]).with_suffix(".mp3")))
    if expected:
        candidates.append(str(Path(expected).with_suffix(".mp3")))
    for filename in candidates:
        candidate = Path(filename)
        if candidate.suffix.lower() == ".mp3" and candidate.is_file():
            return candidate
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
        if _host_is(url, "musescore.com") and ("403" in low or "forbidden" in low):
            print("Hint: MuseScore refused the downloader request (HTTP 403).")
            print("Hint: Open the score in your browser to check that it is available.")
            print("Hint: If MuseScore offers an audio download, save it there and import the audio file into Forge.")
        elif "login" in low or "cookies" in low or "empty media response" in low or "sign in" in low:
            print("Hint: This source may require a signed-in session.")
            print("Hint: To use your browser session, explicitly set YT_COOKIES_BROWSER=firefox (or chrome/edge/brave) and retry.")
        elif "rate-limit" in low or "429" in low:
            print("Hint: The site is limiting requests. Wait before trying again.")
        elif "unavailable" in low or "private" in low:
            print("Hint: The source may be private, deleted, or region-locked.")
        elif "403" in low or "forbidden" in low:
            print("Hint: The site refused the downloader request (HTTP 403).")
            print("Hint: Check that the URL opens in your browser. An updated yt-dlp may support site changes.")
            print(f'Hint: Update with "{sys.executable}" -m pip install -U yt-dlp')
        elif _is_youtube(url) and ("javascript" in low or "format" in low or "nsig" in low):
            print("Hint: YouTube may need a JavaScript runtime for this video.")
            print("Hint: Install Deno (https://deno.com), reopen MIDI Studio, and retry.")
        else:
            print("Hint: check the URL is correct and you have an internet connection.")
        return 1
    print(f"\nDONE.")
    print(f"DOWNLOADED: {mp3}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""Deterministic downloader tests. Run: python tools/test_yt_download.py"""
import contextlib
import copy
import importlib.util
import io
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest import mock


class DownloadError(Exception):
    pass


fake_yt_dlp = types.ModuleType("yt_dlp")
fake_yt_dlp.utils = types.SimpleNamespace(DownloadError=DownloadError)
script = Path(__file__).resolve().parents[1] / "python-engine" / "yt_download.py"
spec = importlib.util.spec_from_file_location("studio_yt_download", script)
downloader = importlib.util.module_from_spec(spec)
with mock.patch.dict(sys.modules, {"yt_dlp": fake_yt_dlp}):
    spec.loader.exec_module(downloader)


class DownloaderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.out = Path(self.temp.name)
        self.calls = []
        self.steps = []
        self.addCleanup(mock.patch.stopall)
        mock.patch.dict(os.environ, {"YT_COOKIES_BROWSER": ""}).start()
        mock.patch.object(downloader, "FFMPEG_BIN", self.out / "missing-ffmpeg").start()
        mock.patch.object(fake_yt_dlp, "YoutubeDL", self.make_ydl, create=True).start()

    def make_ydl(self, options):
        self.calls.append(copy.deepcopy(options))
        owner = self

        class FakeYDL:
            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

            def extract_info(self, url, download):
                owner.assertTrue(download)
                step = owner.steps.pop(0)
                if isinstance(step, Exception):
                    raise step
                return step(options)

            def prepare_filename(self, info):
                return info.get("expected", str(owner.out / "expected.webm"))

        return FakeYDL()

    def audio(self, filename="score.mp3"):
        result = self.out / filename
        result.write_bytes(b"ID3-test-audio")
        return result

    def test_youtube_hostname_matching(self):
        for url in ["https://youtube.com/watch?v=x", "https://www.youtube.com/watch?v=x",
                    "https://music.youtube.com/watch?v=x", "https://youtu.be/x",
                    "https://YOUTUBE.COM./watch?v=x"]:
            with self.subTest(url=url):
                self.assertTrue(downloader._is_youtube(url))
        for url in ["https://youtube.com.example/watch", "https://notyoutube.com/watch",
                    "https://youtube.com@evil.example/watch", "https://example.com/youtube.com",
                    "https://example.com/?url=https://youtu.be/x", "https://youtu.be.evil.example/x",
                    "https://[invalid"]:
            with self.subTest(url=url):
                self.assertFalse(downloader._is_youtube(url))

    def test_youtube_retries_once_with_default_clients(self):
        result = self.audio()
        self.steps = [DownloadError("HTTP Error 403"), lambda _: {"filepath": str(result)}]
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(downloader.download("https://youtu.be/x", self.out), result)
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(self.calls[0]["extractor_args"]["youtube"]["player_client"], ["android"])
        self.assertNotIn("extractor_args", self.calls[1])
        self.assertIn("node", self.calls[1]["js_runtimes"])

    def test_youtube_retry_failure_propagates(self):
        self.steps = [DownloadError("first failure"), DownloadError("last failure")]
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaisesRegex(DownloadError, "last failure"):
            downloader.download("https://youtube.com/watch?v=x", self.out)
        self.assertEqual(len(self.calls), 2)

    def test_other_sites_do_not_retry_or_get_youtube_options(self):
        for url in ["https://musescore.com/user/1/scores/2", "https://soundcloud.com/artist/song",
                    "https://youtube.com.evil.example/watch"]:
            with self.subTest(url=url):
                self.calls.clear()
                self.steps = [DownloadError("HTTP Error 403")]
                with self.assertRaises(DownloadError):
                    downloader.download(url, self.out)
                self.assertEqual(len(self.calls), 1)
                self.assertNotIn("extractor_args", self.calls[0])
                self.assertNotIn("js_runtimes", self.calls[0])
                self.assertNotIn("cookiesfrombrowser", self.calls[0])

    def test_cookies_require_explicit_opt_in(self):
        result = self.audio()
        self.steps = [lambda _: {"filepath": str(result)}]
        with mock.patch.dict(os.environ, {"YT_COOKIES_BROWSER": " Firefox "}):
            self.assertEqual(downloader.download("https://example.com/audio", self.out), result)
        self.assertEqual(self.calls[0]["cookiesfrombrowser"], ("firefox",))

    def test_postprocessor_exact_path_wins_over_title_and_expected_name(self):
        unrelated = self.audio("old-title.mp3")
        actual = self.audio("actual – score (2).mp3")

        def extracted(options):
            options["postprocessor_hooks"][0]({"status": "finished", "info_dict": {"filepath": str(actual)}})
            return {"title": "old-title", "expected": str(unrelated)}

        self.steps = [extracted]
        self.assertEqual(downloader.download("https://musescore.com/user/1/scores/2", self.out), actual)

    def test_progress_filename_identifies_converted_output(self):
        actual = self.audio("resolved song.mp3")

        def extracted(options):
            options["progress_hooks"][0]({"status": "finished", "filename": str(actual.with_suffix(".webm"))})
            return {"title": "title with a different sanitization"}

        self.steps = [extracted]
        self.assertEqual(downloader.download("https://youtube.com/watch?v=x", self.out), actual)

    def test_expected_filename_handles_cached_audio(self):
        actual = self.audio("existing score.mp3")
        self.steps = [lambda _: {"expected": str(actual.with_suffix(".m4a"))}]
        self.assertEqual(downloader.download("https://soundcloud.com/artist/song", self.out), actual)

    def test_requested_download_filepath_is_supported(self):
        actual = self.audio("requested.MP3")
        self.steps = [lambda _: {"requested_downloads": [{"filepath": str(actual)}]}]
        self.assertEqual(downloader.download("https://example.com/audio", self.out), actual)

    def test_unrelated_mp3_cannot_turn_incomplete_download_into_success(self):
        self.audio("some other song.mp3")
        self.steps = [lambda _: {"title": "missing song"}]
        with self.assertRaisesRegex(RuntimeError, "no MP3"):
            downloader.download("https://example.com/audio", self.out)

    def test_reported_path_must_be_a_real_mp3_file(self):
        (self.out / "directory.mp3").mkdir()
        self.audio("source.webm")
        self.steps = [lambda _: {"filepath": str(self.out / "source.webm"),
                                 "requested_downloads": [{"filepath": str(self.out / "directory.mp3")}]}]
        with self.assertRaisesRegex(RuntimeError, "no MP3"):
            downloader.download("https://example.com/audio", self.out)

    def test_youtube_retry_clears_paths_from_failed_attempt(self):
        stale = self.audio("failed attempt.mp3")

        def failed(options):
            options["postprocessor_hooks"][0]({"status": "finished", "info_dict": {"filepath": str(stale)}})
            options["progress_hooks"][0]({"status": "finished", "filename": str(stale)})
            raise DownloadError("failed after postprocessing")

        self.steps = [failed, lambda _: {"title": "missing retry output"}]
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaisesRegex(RuntimeError, "no MP3"):
            downloader.download("https://youtu.be/x", self.out)

    def error_output(self, url, error):
        captured = io.StringIO()
        with mock.patch.object(downloader, "download", side_effect=error), \
                mock.patch.object(sys, "argv", [str(script), url, str(self.out)]), \
                contextlib.redirect_stdout(captured):
            self.assertEqual(downloader.main(), 1)
        return captured.getvalue()

    def test_musescore_403_has_accurate_labeled_hints(self):
        output = self.error_output("https://musescore.com/user/1/scores/2", DownloadError("HTTP Error 403: Forbidden"))
        self.assertIn("Hint: MuseScore refused", output)
        self.assertIn("Hint: Open the score in your browser", output)
        self.assertIn("Hint: If MuseScore offers an audio download", output)
        self.assertNotIn("YouTube", output)
        self.assertNotIn("DOWNLOADED:", output)
        hint_lines = output.split("[ERROR]", 1)[1].splitlines()[1:]
        self.assertTrue(all(line.startswith("Hint:") for line in hint_lines))

    def test_non_youtube_format_error_does_not_suggest_youtube_runtime(self):
        output = self.error_output("https://example.com/audio", DownloadError("Requested format is unavailable"))
        self.assertNotIn("YouTube", output)
        self.assertNotIn("Deno", output)

    def test_rate_limit_is_not_misdiagnosed_as_login(self):
        output = self.error_output("https://example.com/audio", DownloadError("rate-limit HTTP 429"))
        self.assertIn("Hint: The site is limiting requests", output)
        self.assertNotIn("signed-in", output)


if __name__ == "__main__":
    unittest.main()

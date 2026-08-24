#!/usr/bin/env python3
"""
ipc_main.py: JSON-over-stdio bridge between the Electron frontend and the
midi_player engine. Spawned by the Electron main process as a sidecar.

Protocol (newline-delimited JSON in both directions):

  IN  (Electron -> Python):
    {"cmd": "list_windows"}
    {"cmd": "load_midi", "path": "...", "mapping": "roblox", "tempo": 1.0}
    {"cmd": "play", "midi_path": "...", "target_hwnd": 12345,
                    "mapping": "roblox", "tempo": 1.0,
                    "countdown": 3, "stats": false}
    {"cmd": "stop"}
    {"cmd": "pause"}
    {"cmd": "resume"}
    {"cmd": "toggle_pause"}
    {"cmd": "seek", "time": 12.34}
    {"cmd": "set_hotkeys", "play": "<f6>", "stop": "<f7>", "pause": "<f8>",
                           "tempo_up": "", "tempo_down": "", "tempo_set": ""}
    {"cmd": "shutdown"}

  OUT (Python -> Electron):
    {"event": "ready"}
    {"event": "windows", "windows": [{"hwnd":..., "pid":..., "process":..., "title":...}]}
    {"event": "log", "level": "info"|"warn"|"error", "message": "..."}
    {"event": "midi_loaded", "events": [...], "duration": 198.4, "bpm": 120.0,
                              "note_to_key": {"36": "1", ...},
                              "min_note": 21, "max_note": 108,
                              "unmapped": [22, 25]}
    {"event": "countdown", "i": 3}
    {"event": "playback_started", "client_perf_now": <python perf_counter at start>}
    {"event": "progress", "elapsed": 1.234, "played": 42,
                          "total_notes": 856, "focus_lost": false,
                          "user_paused": false, "frozen_elapsed": null}
    {"event": "playback_done", "stats": {...}}
    {"event": "hotkey", "name": "play"|"stop"|"pause"|"tempo_up"|"tempo_down"|"tempo_set"}
    {"event": "error", "message": "..."}
"""

import os
import sys
# Embeddable / bundled Python does not put the script's own directory on
# sys.path (a ._pth file disables that), so sibling imports like `midi_player`
# fail in a packaged build. Make this script self-locating.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import json
import queue
import statistics
import threading
import time
import traceback
from pathlib import Path

from pynput.keyboard import Controller, GlobalHotKeys

import midi_player as engine


def _script_dir():
    """Return the directory containing the `mappings/` folder.

    Dev mode: alongside this .py file.
    PyInstaller --onefile: in sys._MEIPASS (where bundled data is extracted).
    PyInstaller --onedir:  next to the .exe.
    """
    if getattr(sys, 'frozen', False):
        if hasattr(sys, '_MEIPASS'):
            return Path(sys._MEIPASS)
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


SCRIPT_DIR = _script_dir()

# A persistent, user-writable mappings folder in AppData (set by the Electron
# main process). The portable .exe re-extracts to a fresh temp dir every launch,
# so any mapping kept next to the bundled ones would vanish; AppData survives.
# We resolve a mapping name here first, then fall back to the bundled presets.
USER_MAPPINGS_DIR = os.environ.get("MIDI_STUDIO_MAPPINGS_DIR") or ""


def _resolve_mapping(arg):
    """Prefer a user-managed copy in AppData so custom / edited mappings persist."""
    if USER_MAPPINGS_DIR and arg and not os.path.isabs(str(arg)):
        name = str(arg)
        cand = os.path.join(USER_MAPPINGS_DIR, name if name.endswith(".json") else name + ".json")
        if os.path.isfile(cand):
            return cand
    return arg

# ---------------------------------------------------------------------------
# stdio plumbing
# ---------------------------------------------------------------------------

_out_lock = threading.Lock()


def emit(event_dict):
    line = json.dumps(event_dict, separators=(",", ":"), ensure_ascii=False)
    with _out_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def log(level, message):
    emit({"event": "log", "level": level, "message": str(message)})


# ---------------------------------------------------------------------------
# global state
# ---------------------------------------------------------------------------

class Bridge:
    def __init__(self):
        self.session_state = None
        self.session_target = None
        self.session_thread = None
        self.progress_thread = None
        self.kb = Controller()
        self.hotkey_listener = None
        self.play_hotkey = "<f6>"
        self.stop_hotkey = "<f7>"
        self.pause_hotkey = "<f8>"
        self.tempo_up_hotkey = ""
        self.tempo_down_hotkey = ""
        self.tempo_set_hotkey = ""
        self.seek_fwd_hotkey = ""
        self.next_hotkey = ""
        self.prev_hotkey = ""
        self.seek_back_hotkey = ""
        self.last_play_args = None         # so a hotkey "play" can re-fire
        self._stop_requested = False
        self._restart_hotkeys()

    # ---- commands ----

    def cmd_list_windows(self, _):
        wins = []
        for w in engine.list_windows():
            if not w.get("title"):
                continue
            wins.append({
                "hwnd": int(w["hwnd"]),
                "pid": int(w.get("pid", 0)),
                "process": w.get("process", ""),
                "title": w["title"],
            })
        wins.sort(key=lambda x: (x["process"].lower(), x["title"].lower()))
        emit({"event": "windows", "windows": wins})

    def cmd_load_midi(self, msg):
        try:
            mapping_data, note_to_key = engine.load_mapping(
                _resolve_mapping(msg["mapping"]), SCRIPT_DIR)
            tempo = float(msg.get("tempo", 1.0))
            transpose = int(msg.get("transpose", 0) or 0)
            if msg.get("auto_transpose"):
                transpose, _, _ = engine.best_transpose(msg["path"], note_to_key)
            events, unmapped, total, bpm = engine.parse_midi(
                msg["path"], note_to_key, tempo, transpose)
            # Compress event tuples for transport
            payload = [
                [round(t, 6), k, round(d, 6), n, c]
                for (t, k, d, n, c) in events
            ]
            emit({
                "event": "midi_loaded",
                "events": payload,
                "duration": round(total, 3),
                "bpm": round(bpm, 2),
                "note_to_key": {str(k): v for k, v in note_to_key.items()},
                "mapping_name": mapping_data.get("name", msg["mapping"]),
                "unmapped": unmapped,
                "transpose": transpose,
            })
        except Exception as e:
            emit({"event": "error", "message": f"load_midi failed: {e}"})

    def cmd_play(self, msg):
        if self.session_thread and self.session_thread.is_alive():
            # A stop immediately followed by play (e.g. live tempo change)
            # can arrive while the old session thread is still winding down.
            # Give it a moment instead of dropping the play.
            self.session_thread.join(timeout=1.0)
            if self.session_thread.is_alive():
                log("warn", "Play requested but a session is already running.")
                return
        self.last_play_args = msg
        self._stop_requested = False
        self.session_thread = threading.Thread(
            target=self._run_session, args=(msg,),
            daemon=True, name="session")
        self.session_thread.start()

    def cmd_stop(self, _):
        s = self.session_state
        if s is not None:
            s.stop_event.set()
            s.pause_event.set()
        self._stop_requested = True
        log("info", "Stop requested.")

    def cmd_pause(self, _):
        s = self.session_state
        if s is None:
            return
        if not s.user_paused:
            s.set_user_paused(True)
            log("info", "Paused.")

    def cmd_resume(self, _):
        s = self.session_state
        if s is None:
            return
        if s.user_paused:
            s.set_user_paused(False)
            if s.focus_lost:
                log("info", "Resumed (still waiting on target focus).")
            else:
                log("info", "Resumed.")

    def cmd_toggle_pause(self, _):
        s = self.session_state
        if s is None:
            return
        if s.user_paused:
            self.cmd_resume(_)
        else:
            self.cmd_pause(_)

    def cmd_seek(self, msg):
        s = self.session_state
        if s is None:
            return
        try:
            t = float(msg.get("time", 0.0))
        except (TypeError, ValueError):
            return
        # Clamp to track duration; bounded by playback_loop too.
        if s.total_duration > 0:
            t = max(0.0, min(t, s.total_duration))
        else:
            t = max(0.0, t)
        s.seek_request = t

    def cmd_refocus(self, _):
        target = self.session_target
        if target is None and self.last_play_args:
            try:
                target = self._resolve_window(int(self.last_play_args["target_hwnd"]))
            except (KeyError, TypeError, ValueError):
                target = None
        if target is None:
            log("warn", "Target window is no longer available. Refresh the target list.")
            return
        if engine.focus_window(target):
            log("info", "Target focused. Playback will resume.")
        else:
            log("warn", "Windows blocked target focus. Click the target window once to resume.")

    def cmd_set_hotkeys(self, msg):
        self.play_hotkey = msg.get("play", "<f6>") or ""
        self.stop_hotkey = msg.get("stop", "<f7>") or ""
        self.pause_hotkey = msg.get("pause", "<f8>") or ""
        self.tempo_up_hotkey = msg.get("tempo_up", "") or ""
        self.tempo_down_hotkey = msg.get("tempo_down", "") or ""
        self.tempo_set_hotkey = msg.get("tempo_set", "") or ""
        self.seek_fwd_hotkey = msg.get("seek_fwd", "") or ""
        self.next_hotkey = msg.get("next_track", "") or ""
        self.prev_hotkey = msg.get("prev_track", "") or ""
        self.seek_back_hotkey = msg.get("seek_back", "") or ""
        self._restart_hotkeys()

    def cmd_shutdown(self, _):
        s = self.session_state
        if s is not None:
            s.stop_event.set()
            s.pause_event.set()
        if self.hotkey_listener is not None:
            try:
                self.hotkey_listener.stop()
            except Exception:
                pass
        emit({"event": "shutdown_ack"})
        time.sleep(0.05)
        sys.exit(0)

    # ---- hotkeys ----

    def _restart_hotkeys(self):
        if self.hotkey_listener is not None:
            try:
                self.hotkey_listener.stop()
            except Exception:
                pass
            self.hotkey_listener = None
        bindings = {}
        if self.play_hotkey:
            bindings[self.play_hotkey] = lambda: emit(
                {"event": "hotkey", "name": "play"})
        if self.stop_hotkey:
            bindings[self.stop_hotkey] = lambda: emit(
                {"event": "hotkey", "name": "stop"})
        if self.pause_hotkey:
            bindings[self.pause_hotkey] = lambda: emit(
                {"event": "hotkey", "name": "pause"})
        if self.tempo_up_hotkey:
            bindings[self.tempo_up_hotkey] = lambda: emit(
                {"event": "hotkey", "name": "tempo_up"})
        if self.tempo_down_hotkey:
            bindings[self.tempo_down_hotkey] = lambda: emit(
                {"event": "hotkey", "name": "tempo_down"})
        if self.tempo_set_hotkey:
            bindings[self.tempo_set_hotkey] = lambda: emit(
                {"event": "hotkey", "name": "tempo_set"})
        if self.seek_fwd_hotkey:
            bindings[self.seek_fwd_hotkey] = lambda: emit(
                {"event": "hotkey", "name": "seek_fwd"})
        if self.next_hotkey:
            bindings[self.next_hotkey] = lambda: emit(
                {"event": "hotkey", "name": "next_track"})
        if self.prev_hotkey:
            bindings[self.prev_hotkey] = lambda: emit(
                {"event": "hotkey", "name": "prev_track"})
        if self.seek_back_hotkey:
            bindings[self.seek_back_hotkey] = lambda: emit(
                {"event": "hotkey", "name": "seek_back"})
        if not bindings:
            return
        try:
            self.hotkey_listener = GlobalHotKeys(bindings)
            self.hotkey_listener.start()
            log("info", f"Hotkeys: play={self.play_hotkey} "
                        f"stop={self.stop_hotkey} pause={self.pause_hotkey}"
                        + (f" tempo+={self.tempo_up_hotkey}" if self.tempo_up_hotkey else "")
                        + (f" tempo-={self.tempo_down_hotkey}" if self.tempo_down_hotkey else "")
                        + (f" tempo=set:{self.tempo_set_hotkey}" if self.tempo_set_hotkey else ""))
        except Exception as e:
            log("error", f"Failed to bind hotkeys: {e}")

    # ---- session worker ----

    def _run_session(self, msg):
        try:
            target_hwnd = int(msg["target_hwnd"])
            mapping_arg = msg["mapping"]
            tempo = float(msg.get("tempo", 1.0))
            countdown = int(msg.get("countdown", 3))
            collect_stats = bool(msg.get("stats", False))
            sustain = bool(msg.get("sustain", False))
            midi_path = msg["midi_path"]
            try:
                start_at = float(msg.get("start_at", 0.0))
                if start_at < 0:
                    start_at = 0.0
            except (TypeError, ValueError):
                start_at = 0.0
            try:
                raw_end = msg.get("end_at")
                end_at = float(raw_end) if raw_end is not None else None
            except (TypeError, ValueError):
                end_at = None

            target = self._resolve_window(target_hwnd)
            if target is None:
                emit({"event": "error",
                      "message": "Target window no longer exists."})
                return
            self.session_target = target

            mapping_data, note_to_key = engine.load_mapping(
                _resolve_mapping(mapping_arg), SCRIPT_DIR)
            events, unmapped, total_dur, bpm = engine.parse_midi(
                midi_path, note_to_key, tempo, int(msg.get("transpose", 0) or 0))
            if not events:
                emit({"event": "error", "message": "MIDI has no playable events."})
                return
            if end_at is not None:
                end_at = max(0.0, min(end_at, total_dur))
                if end_at <= start_at:
                    emit({"event": "error", "message": "Playback range stop must be after start."})
                    return

            log("info", f"Mapping {mapping_data.get('name', mapping_arg)} "
                        f"({len(note_to_key)} notes)")
            log("info", f"{len(events)} events, {total_dur:.1f}s, ~{bpm:.1f} BPM")
            if unmapped:
                log("warn", f"Skipped {len(unmapped)} unmapped notes: {unmapped}")

            # Use a fixed latency offset (~1.5 ms is the measured average for
            # pynput's Win32 SendInput on modern hardware). Previously we ran
            # benchmark_keypress here which pressed 'a' 20 times to measure
            # the real overhead, but those presses landed in whatever window
            # had focus when Play fired, usually the target game, sending
            # 20 stray 'a's right before playback started. Not worth the
            # ~1 ms accuracy gain.
            latency = 0.0015

            log("info", f"Focusing target: {target['process']} | {target['title']}")
            focused = False
            for _ in range(3):
                if engine.focus_window(target):
                    focused = True
                    break
                time.sleep(0.12)
            if not focused:
                log("warn", "Windows could not switch windows automatically. "
                    "Playback will wait until you focus the target.")
            time.sleep(0.15)

            if countdown > 0:
                for i in range(countdown, 0, -1):
                    if self._stop_requested:
                        log("info", "Cancelled before playback.")
                        return
                    emit({"event": "countdown", "i": i})
                    time.sleep(1)

            self.session_state = engine.State(len(events), total_dur, bpm)
            # If the user pre-seeked via the scrubber before pressing Play,
            # apply that as the initial position, playback_loop honours
            # seek_request at the top of its first iteration.
            if start_at > 0 and total_dur > 0:
                self.session_state.seek_request = min(start_at, total_dur)
            emit({"event": "playback_started",
                  "total_notes": len(events),
                  "duration": round(total_dur, 3),
                  "bpm": round(bpm, 2),
                  "start_elapsed": round(start_at, 4)})

            # Focus monitor pushes focus state into state; we mirror to UI.
            threading.Thread(
                target=engine.focus_monitor,
                args=(self.session_state, target,
                      lambda m: log("info", m)),
                daemon=True, name="focus-monitor").start()

            # Progress emitter (50ms cadence so frontend can extrapolate).
            self.progress_thread = threading.Thread(
                target=self._progress_loop, args=(self.session_state,),
                daemon=True, name="progress")
            self.progress_thread.start()

            engine.playback_loop(events, self.session_state, self.kb,
                                 latency, None, collect_stats, sustain, end_at)

            stats_payload = None
            if collect_stats and self.session_state.timing_errors:
                errs = [e * 1000 for e in self.session_state.timing_errors]
                stats_payload = {
                    "notes": len(errs),
                    "mean_ms": statistics.mean(errs),
                    "median_ms": statistics.median(errs),
                    "stdev_ms": statistics.stdev(errs) if len(errs) > 1 else 0.0,
                    "min_ms": min(errs),
                    "max_ms": max(errs),
                    "over_5ms": sum(1 for e in errs if abs(e) > 5),
                }

            emit({"event": "playback_done", "stats": stats_payload})

        except Exception:
            emit({"event": "error", "message": traceback.format_exc()})
        finally:
            s = self.session_state
            if s is not None:
                s.stop_event.set()
                s.pause_event.set()
            self.session_state = None
            self.session_target = None

    def _progress_loop(self, state):
        while not state.stop_event.is_set():
            elapsed = (state.frozen_elapsed
                       if state.frozen_elapsed is not None
                       else (time.perf_counter() - state.base_time
                             if state.base_time > 0 else 0.0))
            emit({
                "event": "progress",
                "elapsed": round(elapsed, 4),
                "played": state.played_count,
                "focus_lost": bool(state.focus_lost),
                "user_paused": bool(state.user_paused),
                "frozen_elapsed": (round(state.frozen_elapsed, 4)
                                   if state.frozen_elapsed is not None
                                   else None),
                "base_time_perf": round(state.base_time, 6),
            })
            time.sleep(0.05)

    def _resolve_window(self, hwnd):
        for w in engine.list_windows():
            if int(w["hwnd"]) == hwnd:
                return w
        return None


# ---------------------------------------------------------------------------
# main loop
# ---------------------------------------------------------------------------

DISPATCH = {
    "list_windows":  "cmd_list_windows",
    "load_midi":     "cmd_load_midi",
    "play":          "cmd_play",
    "stop":          "cmd_stop",
    "pause":         "cmd_pause",
    "resume":        "cmd_resume",
    "toggle_pause":  "cmd_toggle_pause",
    "seek":          "cmd_seek",
    "refocus":       "cmd_refocus",
    "set_hotkeys":   "cmd_set_hotkeys",
    "shutdown":      "cmd_shutdown",
}


def main():
    # Force UTF-8 stdio so JSON with non-ASCII filenames survives.
    try:
        sys.stdin.reconfigure(encoding="utf-8")
        sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
    except Exception:
        pass

    bridge = Bridge()
    emit({"event": "ready"})

    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception as e:
            emit({"event": "error", "message": f"bad JSON: {e}"})
            continue
        cmd = msg.get("cmd")
        method = DISPATCH.get(cmd)
        if method is None:
            emit({"event": "error", "message": f"unknown cmd: {cmd}"})
            continue
        try:
            getattr(bridge, method)(msg)
        except Exception:
            emit({"event": "error", "message": traceback.format_exc()})


if __name__ == "__main__":
    main()

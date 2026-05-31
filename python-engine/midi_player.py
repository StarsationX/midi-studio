#!/usr/bin/env python3
"""
midi_player.py — Plays MIDI files by simulating keypresses into a target window.

Design summary (see README for full notes):
  * Playback runs on the main thread. It pre-computes every event before the
    first note plays and does ZERO allocation in its hot loop — only sleep,
    keypress, and a non-blocking queue.put_nowait() to feed the display.
  * The pygame display runs in its own daemon thread. It is allowed to drop
    frames if the system is loaded; it can never delay a note.
  * A focus-monitor daemon thread polls the foreground window every 500 ms.
    If focus drifts off the target, playback pauses; when focus returns, the
    base time is shifted forward by the pause duration and playback resumes.
"""

import argparse
import contextlib
import ctypes
import gc
import json
import queue
import statistics
import sys
import threading
import time
from pathlib import Path

import mido
from pynput.keyboard import Controller, Key

PLATFORM = sys.platform

if PLATFORM == "win32":
    import win32con
    import win32gui
    import win32process
    import psutil
    _winmm = ctypes.WinDLL("winmm")
    _kernel32 = ctypes.WinDLL("kernel32")
    THREAD_PRIORITY_HIGHEST = 2
elif PLATFORM == "darwin":
    try:
        from AppKit import NSWorkspace  # type: ignore
    except ImportError:
        NSWorkspace = None


# ---------------------------------------------------------------------------
# Performance helpers (Windows-specific, no-ops elsewhere)
# ---------------------------------------------------------------------------

@contextlib.contextmanager
def hi_res_timer():
    """Raise system timer resolution to 1 ms (Windows). Without this,
    time.sleep() snaps to the default ~15.6 ms quantum."""
    if PLATFORM == "win32":
        _winmm.timeBeginPeriod(1)
        try:
            yield
        finally:
            _winmm.timeEndPeriod(1)
    else:
        yield


def boost_thread_priority():
    """Bump current thread to HIGHEST on Windows. Best-effort; no-op elsewhere."""
    if PLATFORM == "win32":
        try:
            _kernel32.SetThreadPriority(_kernel32.GetCurrentThread(),
                                        THREAD_PRIORITY_HIGHEST)
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Window enumeration / focus
# ---------------------------------------------------------------------------

def list_windows_win():
    out = []

    def cb(hwnd, _):
        if not win32gui.IsWindowVisible(hwnd):
            return
        title = win32gui.GetWindowText(hwnd)
        if not title:
            return
        try:
            _, pid = win32process.GetWindowThreadProcessId(hwnd)
            try:
                pname = psutil.Process(pid).name()
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pname = ""
            out.append({"hwnd": hwnd, "title": title, "pid": pid, "process": pname})
        except Exception:
            pass

    win32gui.EnumWindows(cb, None)
    return out


def list_windows_mac():
    if NSWorkspace is None:
        return []
    out = []
    for app in NSWorkspace.sharedWorkspace().runningApplications():
        name = app.localizedName()
        if name:
            out.append({
                "hwnd": app.processIdentifier(),
                "title": name,
                "pid": app.processIdentifier(),
                "process": name,
                "_nsapp": app,
            })
    return out


def list_windows():
    return list_windows_win() if PLATFORM == "win32" else list_windows_mac()


def find_matching_windows(target):
    t = target.lower()
    return [w for w in list_windows()
            if t in w["title"].lower() or t in w["process"].lower()]


def focus_window(win):
    if PLATFORM == "win32":
        hwnd = win["hwnd"]
        if win32gui.IsIconic(hwnd):
            win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
        try:
            win32gui.SetForegroundWindow(hwnd)
        except Exception:
            # Windows blocks SetForegroundWindow unless caller owns the
            # foreground. The classic workaround: tap Alt to release the
            # restriction, then try again.
            kb = Controller()
            kb.press(Key.alt)
            kb.release(Key.alt)
            try:
                win32gui.SetForegroundWindow(hwnd)
            except Exception:
                pass
    elif PLATFORM == "darwin":
        nsapp = win.get("_nsapp")
        if nsapp is not None:
            nsapp.activateWithOptions_(1 << 1)  # NSApplicationActivateIgnoringOtherApps


def focused_id():
    if PLATFORM == "win32":
        return win32gui.GetForegroundWindow()
    if PLATFORM == "darwin" and NSWorkspace is not None:
        app = NSWorkspace.sharedWorkspace().frontmostApplication()
        return app.processIdentifier() if app else None
    return None


def window_alive(win):
    if PLATFORM == "win32":
        return bool(win32gui.IsWindow(win["hwnd"]))
    return True


# ---------------------------------------------------------------------------
# Mapping + MIDI parsing
# ---------------------------------------------------------------------------

PRESETS = ("virtualpiano", "virtualpiano66",
           "roblox", "roblox61", "roblox66", "roblox88", "roblox88ctrl")


def load_mapping(arg, script_dir):
    if arg in PRESETS:
        path = script_dir / "mappings" / f"{arg}.json"
    else:
        path = Path(arg)
    if not path.is_file():
        raise FileNotFoundError(f"Mapping file not found: {path}")
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    return data, {int(k): v for k, v in data["note_to_key"].items()}


def parse_midi(midi_path, note_to_key, tempo_scale):
    """
    Returns:
        events: sorted list of (t_sec, key_str, duration_sec, midi_note, channel)
        unmapped: sorted list of MIDI note numbers we had to skip
        total_duration: float seconds (after tempo scaling)
        bpm: estimated initial BPM (for the info bar)
    """
    mid = mido.MidiFile(midi_path)

    events = []
    unmapped = set()
    open_notes = {}   # (channel, note) -> (start_time, key)
    abs_time = 0.0

    for msg in mid:                       # mido yields msg.time in seconds
        abs_time += msg.time
        if msg.type == "note_on" and msg.velocity > 0:
            key = note_to_key.get(msg.note)
            if key is None:
                unmapped.add(msg.note)
                continue
            open_notes[(msg.channel, msg.note)] = (abs_time, key)
        elif msg.type == "note_off" or (msg.type == "note_on" and msg.velocity == 0):
            k = (msg.channel, msg.note)
            if k in open_notes:
                start, key = open_notes.pop(k)
                events.append((start, key, abs_time - start, msg.note, msg.channel))

    # Hanging notes (missing note_off) — close them at end-of-file.
    for (channel, note), (start, key) in open_notes.items():
        events.append((start, key, max(0.05, abs_time - start), note, channel))

    events.sort(key=lambda e: e[0])

    # Collapse near-simultaneous same-key events. Pressing the same char
    # twice within 5 ms is indistinguishable from one press to the target
    # app, but the second press still costs ~1.5 ms of keypress latency
    # — that's where the worst chord-induced timing errors come from.
    # The collapse is critical for white-only Roblox layouts where chords
    # like C+C# both map to '1'.
    DEDUP_WINDOW = 0.005
    deduped = []
    last_t_for = {}
    for evt in events:
        t = evt[0]
        k = evt[1]
        if t - last_t_for.get(k, -1.0) < DEDUP_WINDOW:
            continue
        last_t_for[k] = t
        deduped.append(evt)
    events = deduped

    # Normalise so the first event is t=0 and apply tempo scaling.
    first_t = events[0][0] if events else 0.0
    events = [((t - first_t) / tempo_scale, k, d / tempo_scale, n, c)
              for (t, k, d, n, c) in events]
    total = (mid.length - first_t) / tempo_scale

    # Initial BPM from the first set_tempo (or 120 default).
    bpm = 120.0
    for m in mido.MidiFile(midi_path):
        if m.type == "set_tempo":
            bpm = 60_000_000 / m.tempo
            break
    bpm *= tempo_scale

    return events, sorted(unmapped), max(total, 0.0), bpm


# ---------------------------------------------------------------------------
# Keypress helpers
# ---------------------------------------------------------------------------

# Characters that require Shift on a US layout (covers Virtual Piano / Roblox).
_SHIFTED_SYMBOLS = set('!@#$%^&*()_+{}|:"<>?~')

_MOD_KEYS = {
    "ctrl": Key.ctrl,  "control": Key.ctrl,
    "shift": Key.shift,
    "alt":  Key.alt,
    "win":  Key.cmd,   "cmd": Key.cmd,  "meta": Key.cmd,
}


def _needs_shift(ch):
    return len(ch) == 1 and (ch.isupper() or ch in _SHIFTED_SYMBOLS)


def _base_key(ch):
    """Return the unshifted base for a shifted symbol (US layout)."""
    table = {
        "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6",
        "&": "7", "*": "8", "(": "9", ")": "0",
        "_": "-", "+": "=",
        "{": "[", "}": "]", "|": "\\",
        ":": ";", '"': "'",
        "<": ",", ">": ".", "?": "/",
        "~": "`",
    }
    return table.get(ch, ch)


def _parse_mapping_value(value):
    """Split a mapping value into (modifier list, base char).

    Single char  →  ([], char)            e.g. "a"  → ([], "a")
    Shifted char →  (["shift"], unshifted) e.g. "!"  → (["shift"], "1")
    Modifier form → "mod+...+char"        e.g. "ctrl+1" → (["ctrl"], "1")
                                          e.g. "ctrl+shift+a" → (["ctrl","shift"], "a")
    Allows the base to itself be a shifted symbol — Shift is then added
    on top of whatever explicit mods were declared."""
    if len(value) <= 1 or "+" not in value:
        # plain char (or empty); shift handling deferred to caller
        base = value
        mods = []
    else:
        parts = value.split("+")
        # support "ctrl++" → base "+"
        if parts[-1] == "" and len(parts) >= 2:
            base = "+"
            parts = parts[:-2]
        else:
            base = parts[-1]
            parts = parts[:-1]
        mods = [p.strip().lower() for p in parts if p.strip()]

    if _needs_shift(base):
        if base.isalpha():
            base = base.lower()
        else:
            base = _base_key(base)
        if "shift" not in mods:
            mods.append("shift")

    return mods, base


def play_keys(kb, value):
    """Press + release a key, applying any modifiers declared in the mapping.

    pynput's Win32 backend doesn't auto-shift for uppercase / symbol keys,
    so we drive Shift manually here (and Ctrl/Alt for extended layouts)."""
    mods, base = _parse_mapping_value(value)
    mod_keys = [_MOD_KEYS[m] for m in mods if m in _MOD_KEYS]
    for mk in mod_keys:
        kb.press(mk)
    try:
        kb.press(base); kb.release(base)
    finally:
        for mk in reversed(mod_keys):
            kb.release(mk)


def benchmark_keypress(kb, samples=20):
    """Average wall-clock cost of one press+release. Used to nudge target
    times earlier so the keypress LANDS on the beat rather than starts on it."""
    times = []
    for _ in range(samples):
        t0 = time.perf_counter()
        kb.press("a"); kb.release("a")
        times.append(time.perf_counter() - t0)
    return statistics.mean(times)


# ---------------------------------------------------------------------------
# Shared state
# ---------------------------------------------------------------------------

class State:
    __slots__ = (
        "total_notes", "total_duration", "bpm",
        "played_count", "elapsed",
        "pause_event", "stop_event", "focus_lost", "user_paused",
        "timing_errors",
        "base_time",       # perf_counter() reference; visualizer reads this
        "frozen_elapsed",  # float when paused, None when running
        "seek_request",    # float seconds when user requested a seek, else None
    )

    def __init__(self, total_notes, total_duration, bpm):
        self.total_notes = total_notes
        self.total_duration = total_duration
        self.bpm = bpm
        self.played_count = 0
        self.elapsed = 0.0
        self.pause_event = threading.Event()
        self.pause_event.set()           # set == running, clear == paused
        self.stop_event = threading.Event()
        self.focus_lost = False
        self.user_paused = False
        self.timing_errors = []
        self.base_time = 0.0
        self.frozen_elapsed = None
        self.seek_request = None

    # The pause gate is paused when EITHER focus is lost OR the user paused.
    # Helpers below keep the two sources coherent — flipping one shouldn't
    # accidentally resume when the other is still asserted.
    def _refresh_pause_event(self):
        if self.user_paused or self.focus_lost:
            self.pause_event.clear()
        else:
            self.pause_event.set()

    def set_user_paused(self, paused):
        self.user_paused = bool(paused)
        self._refresh_pause_event()

    def set_focus_lost(self, lost):
        self.focus_lost = bool(lost)
        self._refresh_pause_event()


# ---------------------------------------------------------------------------
# Hot playback loop
# ---------------------------------------------------------------------------

_SPIN_THRESHOLD = 0.003   # busy-wait the final 3 ms
_PAUSE_POLL_SLICE = 0.025  # cap individual sleeps so pause/stop is responsive

def _hybrid_sleep(target):
    """Sleep until perf_counter() >= target. sleep() for the bulk, spin the tail."""
    while True:
        remaining = target - time.perf_counter()
        if remaining <= 0:
            return
        if remaining > _SPIN_THRESHOLD:
            time.sleep(remaining - _SPIN_THRESHOLD)
        else:
            while time.perf_counter() < target:
                pass
            return


def playback_loop(events, state, kb, latency_offset, q, collect_stats):
    """ZERO allocation in the inner body. Every variable is local.

    Wrapped in hi_res_timer() so time.sleep() honours millisecond targets
    on Windows. Boosts thread priority and disables GC for the duration so
    the OS scheduler / Python runtime don't steal multi-millisecond slices.

    Pause handling: the sleep is sliced into ~25 ms chunks while we still
    have time, so a user pause (or focus-loss) is detected within ~25 ms
    instead of waiting out the full inter-note gap."""
    pause_event = state.pause_event
    stop_event = state.stop_event
    perf = time.perf_counter
    put_nowait = q.put_nowait if q is not None else None
    Full = queue.Full
    play = play_keys
    spin = _SPIN_THRESHOLD
    poll = _PAUSE_POLL_SLICE

    boost_thread_priority()
    gc_was_enabled = gc.isenabled()
    if gc_was_enabled:
        gc.disable()

    try:
      with hi_res_timer():
        base = perf()
        state.base_time = base
        state.frozen_elapsed = None
        total = len(events)

        i = 0
        while i < total:
            if stop_event.is_set():
                return

            # Honour seek requests at the start of each event iteration.
            seek = state.seek_request
            if seek is not None:
                state.seek_request = None
                target_t = max(0.0, seek)
                j = 0
                while j < total and events[j][0] < target_t:
                    j += 1
                i = j
                base = perf() - target_t
                state.base_time = base
                state.elapsed = target_t
                state.played_count = i
                if not pause_event.is_set():
                    state.frozen_elapsed = target_t
                else:
                    state.frozen_elapsed = None
                if i >= total:
                    break

            t_sec, key, duration, note, channel = events[i]

            while True:
                if stop_event.is_set():
                    return

                if not pause_event.is_set():
                    ps = perf()
                    state.frozen_elapsed = ps - base   # freeze visualizer
                    pause_event.wait()
                    if stop_event.is_set():
                        return
                    base += perf() - ps                # shift timeline forward
                    state.base_time = base
                    state.frozen_elapsed = None

                target = base + t_sec - latency_offset

                # Pause/seek-aware sleep. Short slices so a flip during a
                # long inter-note gap is honoured promptly.
                interrupted = False
                while True:
                    if stop_event.is_set():
                        return
                    if state.seek_request is not None:
                        interrupted = True
                        break
                    remaining = target - perf()
                    if remaining <= 0:
                        break
                    if not pause_event.is_set():
                        interrupted = True
                        break
                    if remaining > spin:
                        nap = remaining - spin
                        if nap > poll:
                            nap = poll
                        time.sleep(nap)
                    else:
                        while perf() < target:
                            pass
                        break

                # Normal completion of the sleep — go fire the event.
                if not interrupted:
                    break
                # A seek arrived: bail out of the middle loop too so the
                # outer loop's seek handler runs (otherwise we'd loop in
                # here forever — seek_request stays set, inner sleep keeps
                # detecting it, middle loop keeps re-entering inner).
                if state.seek_request is not None:
                    break
                # Otherwise it was a pause — loop the middle while again
                # to drain it.

            # If a seek was requested mid-sleep, restart the outer loop
            # without firing this event.
            if state.seek_request is not None:
                continue

            actual = perf()
            play(kb, key)

            if put_nowait is not None:
                try:
                    put_nowait(("hit", note, key, channel, duration, actual))
                except Full:
                    pass

            state.played_count = i + 1
            state.elapsed = actual - base
            if collect_stats:
                state.timing_errors.append(actual - target)

            i += 1

        stop_event.set()
    finally:
        if gc_was_enabled:
            gc.enable()


# ---------------------------------------------------------------------------
# Focus monitor
# ---------------------------------------------------------------------------

def focus_monitor(state, target_win, log_fn=print):
    target_id = target_win["hwnd"]
    while not state.stop_event.is_set():
        if not window_alive(target_win):
            log_fn("[!] Target window closed — stopping playback.")
            state.stop_event.set()
            state.pause_event.set()
            return
        cur = focused_id()
        if cur != target_id:
            if not state.focus_lost:
                state.set_focus_lost(True)
                log_fn("[!] Focus lost — playback paused. "
                       "Re-focus the target window to resume.")
        else:
            if state.focus_lost:
                state.set_focus_lost(False)
                if not state.user_paused:
                    log_fn("[+] Focus regained — resuming.")
        time.sleep(0.5)


# ---------------------------------------------------------------------------
# Display thread (pygame)
# ---------------------------------------------------------------------------

CHANNEL_COLORS = [
    (88, 166, 255), (255, 122, 122), (122, 255, 168), (255, 200, 87),
    (200, 122, 255), (255, 122, 220), (122, 220, 255), (255, 255, 130),
    (130, 255, 255), (255, 130, 200), (200, 255, 130), (200, 200, 200),
    (255, 165, 0),   (180, 180, 255), (130, 180, 130), (220, 220, 220),
]
LOOKAHEAD = 3.0


def display_thread(state, q, events, note_to_key, total_duration, mapping_name):
    import pygame
    pygame.init()
    pygame.font.init()

    win_w, win_h = 900, 600
    screen = pygame.display.set_mode((win_w, win_h), pygame.RESIZABLE)
    pygame.display.set_caption(f"MIDI Player — {mapping_name}")
    clock = pygame.time.Clock()
    font_s = pygame.font.SysFont("Consolas", 12)
    font_m = pygame.font.SysFont("Consolas", 14)
    font_b = pygame.font.SysFont("Consolas", 18, bold=True)

    # Always-on-top (Windows). Best-effort; ignore failures.
    if PLATFORM == "win32":
        try:
            hwnd = pygame.display.get_wm_info()["window"]
            win32gui.SetWindowPos(hwnd, win32con.HWND_TOPMOST, 0, 0, 0, 0,
                                  win32con.SWP_NOMOVE | win32con.SWP_NOSIZE
                                  | win32con.SWP_NOACTIVATE)
        except Exception:
            pass

    # Compute MIDI range from events, padded to whole octaves.
    if events:
        lo = min(e[3] for e in events)
        hi = max(e[3] for e in events)
        lo = max(21, (lo // 12) * 12 - 1)
        hi = min(108, ((hi // 12) + 1) * 12)
    else:
        lo, hi = 36, 96

    white_notes = [n for n in range(lo, hi + 1) if n % 12 in (0, 2, 4, 5, 7, 9, 11)]
    n_white = max(1, len(white_notes))
    white_index = {n: i for i, n in enumerate(white_notes)}

    active = {}  # midi_note -> (release_perf_time, channel)

    def note_geom(note, w_white, w_black):
        if (note % 12) in (1, 3, 6, 8, 10):           # black
            below = note - 1
            i = white_index.get(below)
            if i is None:
                return None
            x = (i + 1) * w_white - w_black / 2
            return x, w_black
        i = white_index.get(note)
        if i is None:
            return None
        return i * w_white, w_white

    running = True
    while running:
        for ev in pygame.event.get():
            if ev.type == pygame.QUIT:
                running = False
                state.stop_event.set()
            elif ev.type == pygame.VIDEORESIZE:
                win_w, win_h = ev.w, ev.h
                screen = pygame.display.set_mode((win_w, win_h), pygame.RESIZABLE)

        if state.stop_event.is_set() and q.empty():
            running = False

        now = time.perf_counter()
        # Drain queue (display thread is allowed to lag behind real notes).
        while True:
            try:
                msg = q.get_nowait()
            except queue.Empty:
                break
            if msg[0] == "hit":
                _, note, _key, channel, duration, actual = msg
                active[note] = (actual + max(duration, 0.10), channel)

        # Cull stale highlights.
        for n in [n for n, (rel, _) in active.items() if rel < now]:
            del active[n]

        # Layout
        roll_h = int(win_h * 0.60)
        kb_h = int(win_h * 0.28)
        info_h = win_h - roll_h - kb_h
        wkey_w = win_w / n_white
        bkey_w = wkey_w * 0.6
        kb_top = roll_h
        bk_h = int(kb_h * 0.62)

        screen.fill((18, 20, 26))

        # ---- piano roll ----
        pygame.draw.rect(screen, (24, 26, 32), pygame.Rect(0, 0, win_w, roll_h))
        hit_y = roll_h - 4
        # Smooth elapsed: tween from base_time so notes scroll at exact tempo,
        # not in jumps every time a note fires.
        if state.base_time == 0.0:
            elapsed = 0.0
        elif state.frozen_elapsed is not None:
            elapsed = state.frozen_elapsed
        else:
            elapsed = time.perf_counter() - state.base_time
        view_start = elapsed - 0.25
        view_end = elapsed + LOOKAHEAD
        px_per_sec = roll_h / LOOKAHEAD

        # subtle octave grid
        for n in white_notes:
            if n % 12 == 0:
                g = note_geom(n, wkey_w, bkey_w)
                if g:
                    pygame.draw.line(screen, (35, 38, 46),
                                     (int(g[0]), 0), (int(g[0]), roll_h), 1)

        for t_sec, _key, duration, note, channel in events:
            if t_sec + duration < view_start:
                continue
            if t_sec > view_end:
                break
            g = note_geom(note, wkey_w, bkey_w)
            if g is None:
                continue
            x, w = g
            y_bot = hit_y - (t_sec - elapsed) * px_per_sec
            h = max(3, duration * px_per_sec)
            y_top = y_bot - h
            color = CHANNEL_COLORS[channel % len(CHANNEL_COLORS)]
            if note in active and t_sec <= elapsed <= t_sec + duration + 0.05:
                color = tuple(min(255, c + 60) for c in color)
            pygame.draw.rect(
                screen, color,
                pygame.Rect(int(x) + 1, int(y_top), max(1, int(w) - 2), int(h)),
                border_radius=3)

        pygame.draw.line(screen, (255, 255, 255), (0, hit_y), (win_w, hit_y), 2)

        # ---- keyboard ----
        for n in white_notes:
            g = note_geom(n, wkey_w, bkey_w)
            if g is None:
                continue
            x, w = g
            highlight = n in active
            color = (240, 240, 240) if not highlight else \
                    CHANNEL_COLORS[active[n][1] % len(CHANNEL_COLORS)]
            pygame.draw.rect(screen, color,
                             pygame.Rect(int(x), kb_top, max(1, int(w) - 1), kb_h))
            pygame.draw.rect(screen, (40, 40, 40),
                             pygame.Rect(int(x), kb_top, max(1, int(w) - 1), kb_h), 1)
            label = note_to_key.get(n)
            if label:
                txt = font_s.render(label, True, (40, 40, 40))
                screen.blit(txt,
                            (int(x) + int(w / 2) - txt.get_width() // 2,
                             kb_top + kb_h - 18))

        for n in range(lo, hi + 1):
            if (n % 12) not in (1, 3, 6, 8, 10):
                continue
            g = note_geom(n, wkey_w, bkey_w)
            if g is None:
                continue
            x, w = g
            highlight = n in active
            color = (30, 30, 30) if not highlight else \
                    CHANNEL_COLORS[active[n][1] % len(CHANNEL_COLORS)]
            pygame.draw.rect(screen, color,
                             pygame.Rect(int(x), kb_top, int(w), bk_h))
            label = note_to_key.get(n)
            if label:
                txt_color = (240, 240, 240) if not highlight else (20, 20, 20)
                txt = font_s.render(label, True, txt_color)
                screen.blit(txt,
                            (int(x) + int(w / 2) - txt.get_width() // 2,
                             kb_top + bk_h - 16))

        # ---- info bar ----
        info_y = kb_top + kb_h
        pygame.draw.rect(screen, (28, 30, 36),
                         pygame.Rect(0, info_y, win_w, info_h))
        ix, iy = 10, info_y + 8
        e_min = int(elapsed // 60); e_sec = int(elapsed % 60)
        t_min = int(total_duration // 60); t_sec_i = int(total_duration % 60)
        line1 = (f"BPM {state.bpm:6.1f}   "
                 f"{e_min:02d}:{e_sec:02d} / {t_min:02d}:{t_sec_i:02d}   "
                 f"Notes {state.played_count}/{state.total_notes}   "
                 f"Active {len(active)}")
        screen.blit(font_m.render(line1, True, (220, 220, 220)), (ix, iy))

        pb = pygame.Rect(ix, iy + 22, win_w - 240, 8)
        pygame.draw.rect(screen, (60, 60, 70), pb)
        if total_duration > 0:
            fill = int(pb.w * min(1.0, elapsed / total_duration))
            pygame.draw.rect(screen, (88, 166, 255),
                             pygame.Rect(pb.x, pb.y, fill, pb.h))

        if state.focus_lost:
            status, color = "● LOST FOCUS – paused", (255, 80, 80)
        else:
            status, color = "● FOCUSED", (80, 220, 120)
        s_txt = font_b.render(status, True, color)
        screen.blit(s_txt, (win_w - s_txt.get_width() - 10, iy + 4))

        pygame.display.flip()
        clock.tick(60)

    pygame.quit()


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    p = argparse.ArgumentParser(
        description="Play a MIDI file by simulating keypresses into a target window.")
    p.add_argument("midi", nargs="?", help="path to a MIDI file (.mid)")
    p.add_argument("--target",
                   help="window title substring or process name")
    p.add_argument("--mapping", default="virtualpiano",
                   help="preset name (virtualpiano, roblox) or path to JSON")
    p.add_argument("--list-windows", action="store_true",
                   help="print all visible windows and exit")
    p.add_argument("--tempo-scale", type=float, default=1.0,
                   help="tempo multiplier (1.0 = original; 2.0 = 2× speed)")
    p.add_argument("--stats", action="store_true",
                   help="print per-note timing error summary after playback")
    p.add_argument("--no-display", action="store_true",
                   help="disable the pygame display window (max performance)")
    p.add_argument("--countdown", type=int, default=3,
                   help="seconds to wait before playback starts (default 3)")
    args = p.parse_args()

    script_dir = Path(__file__).resolve().parent

    if args.list_windows:
        for w in list_windows():
            print(f"  [{w['pid']:>6}] {w['process']:<32} | {w['title']}")
        return

    if not args.midi or not args.target:
        p.error("midi file and --target are required (use --list-windows to inspect)")

    if not Path(args.midi).is_file():
        print(f"MIDI file not found: {args.midi}")
        return

    # ---- target window ----
    matches = find_matching_windows(args.target)
    if not matches:
        print(f'No windows match "{args.target}". Use --list-windows.')
        return
    if len(matches) > 1:
        print(f'Multiple windows match "{args.target}":')
        for i, m in enumerate(matches):
            print(f"  [{i}] {m['process']:<32} | {m['title']}")
        sel = input("Pick one [0]: ").strip() or "0"
        try:
            target = matches[int(sel)]
        except (ValueError, IndexError):
            print("Invalid selection.")
            return
    else:
        target = matches[0]
    print(f"Target: {target['process']} | {target['title']}")

    # ---- mapping ----
    mapping_data, note_to_key = load_mapping(args.mapping, script_dir)
    print(f"Mapping: {mapping_data.get('name', args.mapping)} "
          f"({len(note_to_key)} notes mapped)")

    # ---- parse ----
    print(f"Parsing MIDI: {args.midi}")
    events, unmapped, total_dur, bpm = parse_midi(
        args.midi, note_to_key, args.tempo_scale)
    print(f"  {len(events)} events, {total_dur:.1f}s, ~{bpm:.1f} BPM")
    if unmapped:
        print(f"  WARNING: {len(unmapped)} MIDI notes had no mapping and "
              f"were skipped:")
        print(f"    {unmapped}")
    if not events:
        print("Nothing to play.")
        return

    # ---- benchmark keypress latency ----
    kb = Controller()
    print("Benchmarking keypress latency (20 samples)...")
    latency = benchmark_keypress(kb, 20)
    print(f"  avg keypress overhead = {latency * 1000:.3f} ms")

    # ---- focus + countdown ----
    print("Focusing target window...")
    focus_window(target)
    time.sleep(0.3)
    for i in range(args.countdown, 0, -1):
        print(f"  starting in {i}...", flush=True)
        time.sleep(1)

    state = State(len(events), total_dur, bpm)
    q = None if args.no_display else queue.Queue(maxsize=4096)

    if not args.no_display:
        threading.Thread(
            target=display_thread,
            args=(state, q, events, note_to_key, total_dur,
                  mapping_data.get("name", args.mapping)),
            daemon=True, name="display").start()
        # Give pygame a moment, then re-focus the target so the display
        # doesn't steal foreground from the game.
        time.sleep(0.4)
        focus_window(target)
        time.sleep(0.2)

    threading.Thread(
        target=focus_monitor, args=(state, target),
        daemon=True, name="focus-monitor").start()

    try:
        playback_loop(events, state, kb, latency, q, args.stats)
    except KeyboardInterrupt:
        pass
    finally:
        state.stop_event.set()
        state.pause_event.set()

    if not args.no_display:
        time.sleep(0.4)   # let display drain & close

    if args.stats and state.timing_errors:
        errs = [e * 1000 for e in state.timing_errors]
        print("\n=== Timing Error Summary (ms) ===")
        print(f"  notes played   : {len(errs)}")
        print(f"  mean error     : {statistics.mean(errs):+.3f}")
        print(f"  median error   : {statistics.median(errs):+.3f}")
        print(f"  stdev          : "
              f"{statistics.stdev(errs) if len(errs) > 1 else 0:.3f}")
        print(f"  min / max      : {min(errs):+.3f} / {max(errs):+.3f}")
        over = sum(1 for e in errs if abs(e) > 5)
        print(f"  notes >5ms err : {over} ({100*over/len(errs):.1f}%)")


if __name__ == "__main__":
    main()

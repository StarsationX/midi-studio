use std::cmp::Reverse;
use std::collections::BinaryHeap;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Condvar, Mutex};

use crate::keys::{Key, KeyAction, KeySink, Stroke};
use crate::midi::NoteEvent;
use crate::win::{perf, spin_until, HiResTimer, Sleeper, ThreadPriority};

const PAUSE_POLL_SLICE: f64 = 0.025;
const CHORD_WINDOW: f64 = 0.003;
const NULL_VK: u16 = 0xFF;

/// threading.Event: set == open. `is_set` is a lock-free read for the hot loop.
pub struct Gate {
    flag: AtomicBool,
    lock: Mutex<bool>,
    cv: Condvar,
}

impl Gate {
    pub fn new(set: bool) -> Self {
        Gate { flag: AtomicBool::new(set), lock: Mutex::new(set), cv: Condvar::new() }
    }

    pub fn is_set(&self) -> bool {
        self.flag.load(Ordering::Acquire)
    }

    pub fn set(&self) {
        let mut g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        *g = true;
        self.flag.store(true, Ordering::Release);
        self.cv.notify_all();
    }

    pub fn clear(&self) {
        let mut g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        *g = false;
        self.flag.store(false, Ordering::Release);
    }

    pub fn wait(&self) {
        let mut g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        while !*g {
            g = self.cv.wait(g).unwrap_or_else(|e| e.into_inner());
        }
    }
}

/// An f64 slot; NaN stands for Python's None where the field is optional.
pub struct AtomicF64(AtomicU64);

impl AtomicF64 {
    pub fn new(v: f64) -> Self {
        AtomicF64(AtomicU64::new(v.to_bits()))
    }
    pub fn get(&self) -> f64 {
        f64::from_bits(self.0.load(Ordering::Acquire))
    }
    pub fn set(&self, v: f64) {
        self.0.store(v.to_bits(), Ordering::Release)
    }
    pub fn take(&self) -> f64 {
        f64::from_bits(self.0.swap(f64::NAN.to_bits(), Ordering::AcqRel))
    }
    pub fn opt(&self) -> Option<f64> {
        let v = self.get();
        (!v.is_nan()).then_some(v)
    }
}

pub struct State {
    pub total_notes: usize,
    pub total_duration: f64,
    pub bpm: f64,
    pub played_count: AtomicUsize,
    pub elapsed: AtomicF64,
    pub pause: Gate,
    pub stop: Gate,
    paused_by: Mutex<(bool, bool)>,
    user_paused: AtomicBool,
    focus_lost: AtomicBool,
    pub base_time: AtomicF64,
    pub frozen_elapsed: AtomicF64,
    pub seek_request: AtomicF64,
}

impl State {
    pub fn new(total_notes: usize, total_duration: f64, bpm: f64) -> Self {
        State {
            total_notes,
            total_duration,
            bpm,
            played_count: AtomicUsize::new(0),
            elapsed: AtomicF64::new(0.0),
            pause: Gate::new(true),
            stop: Gate::new(false),
            paused_by: Mutex::new((false, false)),
            user_paused: AtomicBool::new(false),
            focus_lost: AtomicBool::new(false),
            base_time: AtomicF64::new(0.0),
            frozen_elapsed: AtomicF64::new(f64::NAN),
            seek_request: AtomicF64::new(f64::NAN),
        }
    }

    pub fn user_paused(&self) -> bool {
        self.user_paused.load(Ordering::Acquire)
    }

    pub fn focus_lost(&self) -> bool {
        self.focus_lost.load(Ordering::Acquire)
    }

    pub fn set_user_paused(&self, paused: bool) {
        let mut g = self.paused_by.lock().unwrap_or_else(|e| e.into_inner());
        g.0 = paused;
        self.user_paused.store(paused, Ordering::Release);
        self.refresh(*g);
    }

    pub fn set_focus_lost(&self, lost: bool) {
        let mut g = self.paused_by.lock().unwrap_or_else(|e| e.into_inner());
        g.1 = lost;
        self.focus_lost.store(lost, Ordering::Release);
        self.refresh(*g);
    }

    fn refresh(&self, (user, focus): (bool, bool)) {
        if user || focus {
            self.pause.clear();
        } else {
            self.pause.set();
        }
    }

    pub fn halt(&self) {
        self.stop.set();
        self.pause.set();
    }

    fn seek_pending(&self) -> bool {
        !self.seek_request.get().is_nan()
    }
}

/// How much earlier each event must be AIMED so chords straddle the beat
/// instead of trailing it: a group of `size` injections is aimed early by the
/// mean serial delay, (size-1)/2 * cost, clamped so it never starts before the
/// previous group can finish injecting.
///
/// `batched`: onsets sharing an exact timestamp go out in ONE SendInput, so
/// they cost one injection, not one each. A group's size then counts distinct
/// timestamps; a chord written as one instant gets no shift at all.
pub fn chord_aim_shifts(events: &[NoteEvent], inject_cost: Option<f64>, batched: bool) -> Vec<f64> {
    let n = events.len();
    let mut shifts = vec![0.0; n];
    let cost = match inject_cost {
        Some(c) if c > 0.0 => c,
        _ => return shifts,
    };
    let mut prev: Option<(f64, usize)> = None;
    let mut i = 0;
    while i < n {
        let t0 = events[i].t;
        let mut j = i + 1;
        while j < n && events[j].t - t0 < CHORD_WINDOW {
            j += 1;
        }
        let size = if batched {
            1 + events[i..j].windows(2).filter(|w| w[1].t != w[0].t).count()
        } else {
            j - i
        };
        let mut want = (size as f64 - 1.0) * 0.5 * cost;
        if let Some((prev_aim, prev_size)) = prev {
            let room = t0 - (prev_aim + prev_size as f64 * cost);
            if want > room {
                want = room;
            }
        }
        if want < 0.0 {
            want = 0.0;
        }
        shifts[i..j].iter_mut().for_each(|s| *s = want);
        prev = Some((t0 - want, size));
        i = j;
    }
    shifts
}

#[derive(Clone, Copy, PartialEq)]
struct Due(f64, Key);

impl Eq for Due {}

impl Ord for Due {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.0.total_cmp(&other.0).then(self.1.cmp(&other.1))
    }
}

impl PartialOrd for Due {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

/// The keyboard as playback drives it. Dropping it lets go of everything still
/// held, so neither a stop, an error nor a panic can leave a key stuck down.
struct Keyboard<'a> {
    sink: &'a mut dyn KeySink,
    held: Vec<(Key, f64)>,
    heap: BinaryHeap<Reverse<Due>>,
    buf: Vec<KeyAction>,
}

impl<'a> Keyboard<'a> {
    fn new(sink: &'a mut dyn KeySink) -> Self {
        Keyboard { sink, held: Vec::with_capacity(32), heap: BinaryHeap::with_capacity(256), buf: Vec::with_capacity(64) }
    }

    fn flush(&mut self) {
        if !self.buf.is_empty() {
            let mut batch = std::mem::take(&mut self.buf);
            self.sink.send(&batch);
            batch.clear();
            self.buf = batch;
        }
    }

    fn release_due(&mut self, now_t: f64) {
        while let Some(Reverse(Due(rt, k))) = self.heap.peek().copied() {
            if rt > now_t {
                break;
            }
            self.heap.pop();
            if let Some(pos) = self.held.iter().position(|(hk, hr)| *hk == k && *hr == rt) {
                self.held.remove(pos);
                self.buf.push(KeyAction::Up(k));
            }
        }
        self.flush();
    }

    fn release_all(&mut self) {
        for (k, _) in self.held.drain(..) {
            self.buf.push(KeyAction::Up(k));
        }
        self.heap.clear();
        self.flush();
    }

    fn tap(&mut self, s: &Stroke) {
        s.push_tap(&mut self.buf);
    }

    fn hold(&mut self, s: &Stroke, release_at: f64) {
        if let Some(pos) = self.held.iter().position(|(k, _)| *k == s.base) {
            self.held.remove(pos);
            self.buf.push(KeyAction::Up(s.base));
            self.flush();
            spin_until(perf() + 0.001);
        }
        s.push_hold(&mut self.buf);
        self.held.push((s.base, release_at));
        self.heap.push(Reverse(Due(release_at, s.base)));
    }
}

impl Drop for Keyboard<'_> {
    fn drop(&mut self) {
        self.release_all();
    }
}

#[derive(Clone, Debug)]
pub struct PlayOpts {
    pub latency: f64,
    pub collect_stats: bool,
    pub sustain: bool,
    pub end_at: Option<f64>,
    pub inject_cost: Option<f64>,
    pub batch: bool,
}

impl Default for PlayOpts {
    fn default() -> Self {
        PlayOpts { latency: 0.0, collect_stats: false, sustain: false, end_at: None, inject_cost: None, batch: true }
    }
}

/// The hot loop. Returns the per-note timing errors (seconds, against where
/// each note belongs musically) when `collect_stats` is on.
///
/// Sustain holds keys for each note's duration; releases sit on a min-heap in
/// timeline seconds, so a pause (which shifts `base`) keeps them consistent.
/// Pause, seek and stop release everything, and resuming never re-presses.
pub fn playback_loop(events: &[NoteEvent], state: &State, sink: &mut dyn KeySink, opts: &PlayOpts) -> Result<Vec<f64>, String> {
    let strokes = events.iter().map(|e| Stroke::parse(&e.key)).collect::<Result<Vec<_>, _>>()?;
    let shifts = chord_aim_shifts(events, opts.inject_cost, opts.batch);
    let mut errors = Vec::with_capacity(if opts.collect_stats { events.len() } else { 0 });

    let _prio = ThreadPriority::highest();
    let _timer = HiResTimer::begin();
    let sleeper = Sleeper::new();
    let spin = sleeper.spin_threshold();
    let mut kb = Keyboard::new(sink);

    let total = events.len();
    let mut base = perf();
    state.base_time.set(base);
    state.frozen_elapsed.set(f64::NAN);

    let mut i = 0;
    while i < total {
        if state.stop.is_set() {
            return Ok(errors);
        }

        let seek = state.seek_request.take();
        if !seek.is_nan() {
            if !kb.held.is_empty() {
                kb.release_all();
            }
            let target_t = seek.max(0.0);
            i = events.iter().position(|e| e.t >= target_t).unwrap_or(total);
            base = perf() - target_t;
            state.base_time.set(base);
            state.elapsed.set(target_t);
            state.played_count.store(i, Ordering::Release);
            state.frozen_elapsed.set(if state.pause.is_set() { f64::NAN } else { target_t });
            if i >= total {
                break;
            }
        }

        let mut t_sec = events[i].t;
        let mut aim_shift = shifts[i];
        let range_finished = matches!(opts.end_at, Some(end) if t_sec >= end);
        if range_finished {
            t_sec = opts.end_at.unwrap();
            aim_shift = 0.0;
        }

        loop {
            if state.stop.is_set() {
                return Ok(errors);
            }
            if !state.pause.is_set() {
                if !kb.held.is_empty() {
                    kb.release_all();
                }
                let ps = perf();
                state.frozen_elapsed.set(ps - base);
                state.pause.wait();
                if state.stop.is_set() {
                    return Ok(errors);
                }
                base += perf() - ps;
                state.base_time.set(base);
                state.frozen_elapsed.set(f64::NAN);
            }

            let target = base + t_sec - opts.latency - aim_shift;
            let mut interrupted = false;
            loop {
                if state.stop.is_set() {
                    return Ok(errors);
                }
                if state.seek_pending() {
                    interrupted = true;
                    break;
                }
                if !kb.heap.is_empty() {
                    kb.release_due(perf() - base);
                }
                let remaining = target - perf();
                if remaining <= 0.0 {
                    break;
                }
                if !state.pause.is_set() {
                    interrupted = true;
                    break;
                }
                if remaining > spin {
                    sleeper.sleep((remaining - spin).min(PAUSE_POLL_SLICE));
                } else {
                    spin_until(target);
                    break;
                }
            }
            if !interrupted || state.seek_pending() {
                break;
            }
        }

        if state.seek_pending() {
            continue;
        }

        if range_finished {
            state.elapsed.set(opts.end_at.unwrap());
            kb.release_all();
            state.stop.set();
            return Ok(errors);
        }

        let mut j = i + 1;
        if opts.batch {
            while j < total && events[j].t == events[i].t {
                j += 1;
            }
        }
        let actual = perf();
        for k in i..j {
            if opts.sustain {
                let d = events[k].dur;
                kb.hold(&strokes[k], events[k].t + if d > 0.03 { d } else { 0.03 });
            } else {
                kb.tap(&strokes[k]);
            }
        }
        kb.flush();

        state.played_count.store(j, Ordering::Release);
        state.elapsed.set(actual - base);
        if opts.collect_stats {
            for e in &events[i..j] {
                errors.push(actual - (base + e.t));
            }
        }
        i = j;
    }

    while !kb.heap.is_empty() && !state.stop.is_set() {
        kb.release_due(perf() - base);
        if !kb.heap.is_empty() {
            sleeper.sleep(PAUSE_POLL_SLICE);
        }
    }
    state.stop.set();
    Ok(errors)
}

fn median(v: &mut [f64]) -> f64 {
    v.sort_by(f64::total_cmp);
    let n = v.len();
    if n % 2 == 1 { v[n / 2] } else { (v[n / 2 - 1] + v[n / 2]) / 2.0 }
}

/// This machine's real injection cost, typing nothing anywhere: an undefined
/// virtual key (0xFF) travels the whole SendInput path with no recipient.
///
/// Returns (aim, chord_press, chord_tap) medians in seconds: an isolated press
/// (what playback aims early by), and back-to-back hold / tap batches (what one
/// chord member costs the next, which chord centring compensates for).
pub fn calibrate_injection(sink: &mut dyn KeySink, burst_samples: usize, spaced_samples: usize, spacing: f64) -> Option<(f64, f64, f64)> {
    if burst_samples == 0 || spaced_samples == 0 {
        return None;
    }
    let nk = Key::Vk(NULL_VK);
    let (down, up) = ([KeyAction::Down(nk)], [KeyAction::Up(nk)]);
    let both = [KeyAction::Down(nk), KeyAction::Up(nk)];
    let _timer = HiResTimer::begin();
    let sleeper = Sleeper::new();
    for _ in 0..4 {
        sink.send(&both);
    }
    let (mut press, mut tap, mut aim) = (Vec::new(), Vec::new(), Vec::new());
    for _ in 0..burst_samples {
        let t0 = perf();
        sink.send(&down);
        let t1 = perf();
        sink.send(&up);
        let t2 = perf();
        sink.send(&both);
        let t3 = perf();
        press.push(t1 - t0);
        tap.push(t3 - t2);
    }
    for _ in 0..spaced_samples {
        let t0 = perf();
        sink.send(&down);
        let t1 = perf();
        sink.send(&up);
        aim.push(t1 - t0);
        sleeper.sleep(spacing);
    }
    Some((median(&mut aim), median(&mut press), median(&mut tap)))
}

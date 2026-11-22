use std::cmp::Reverse;
use std::collections::BinaryHeap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Condvar, Mutex, MutexGuard};
use std::time::Duration;

use crate::keys::{Key, KeyAction, KeySink, Stroke};
use crate::midi::NoteEvent;
use crate::win::{perf, spin_until, HiResTimer, Sleeper, ThreadPriority};

const PRECISE_WAIT_WINDOW: f64 = 0.004;
const CHORD_WINDOW: f64 = 0.003;
const NULL_VK: u16 = 0xFF;

// Notes, range bounds, seeks and held-key deadlines stay in 1× score seconds.
// Only the conversion between score and wall time changes with the tempo.
struct Transport {
    score: f64,
    wall: f64,
    tempo: f64,
    duration: f64,
    pending_seek: Option<f64>,
    started: bool,
    stopped: bool,
    user_paused: bool,
    focus_lost: bool,
}

impl Transport {
    fn running(&self) -> bool {
        self.started && !self.user_paused && !self.focus_lost
    }

    fn position(&self, now: f64) -> f64 {
        if self.running() { self.score + (now - self.wall) * self.tempo } else { self.score }
    }

    fn deadline(&self, score: f64) -> f64 {
        self.wall + (score - self.score) / self.tempo
    }

    fn anchor(&mut self, now: f64) {
        self.score = self.position(now);
        self.wall = now;
    }

    fn set_tempo(&mut self, tempo: f64, now: f64) {
        self.anchor(now);
        self.tempo = tempo;
    }

    fn seek_to(&mut self, score: f64, now: f64) {
        self.score = score.clamp(0.0, self.duration);
        self.wall = now;
        self.pending_seek = Some(self.score);
    }
}

pub(crate) struct Progress {
    pub tempo: f64,
    pub elapsed: f64,
    pub base_time: f64,
    pub user_paused: bool,
    pub focus_lost: bool,
}

pub struct State {
    pub played_count: AtomicUsize,
    transport: Mutex<Transport>,
    changed: Condvar,
}

impl State {
    pub fn new(tempo: f64) -> Self {
        State {
            played_count: AtomicUsize::new(0),
            transport: Mutex::new(Transport {
                score: 0.0, wall: 0.0, tempo, duration: f64::INFINITY, pending_seek: None,
                started: false, stopped: false, user_paused: false, focus_lost: false,
            }),
            changed: Condvar::new(),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Transport> {
        self.transport.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub(crate) fn prepare(&self, duration: f64, start_score: f64) {
        let mut t = self.lock();
        t.duration = duration;
        let start = t.pending_seek.unwrap_or(start_score);
        t.seek_to(start, perf());
    }

    pub fn set_tempo(&self, tempo: f64) {
        if !tempo.is_finite() || tempo <= 0.0 {
            return;
        }
        let mut t = self.lock();
        if t.tempo != tempo {
            t.set_tempo(tempo, perf());
            self.changed.notify_one();
        }
    }

    pub fn seek(&self, elapsed: f64) {
        if elapsed.is_finite() {
            let mut t = self.lock();
            let score = elapsed * t.tempo;
            t.seek_to(score, perf());
            self.changed.notify_one();
        }
    }

    pub(crate) fn progress(&self) -> Progress {
        let t = self.lock();
        let elapsed = t.position(perf()) / t.tempo;
        Progress {
            tempo: t.tempo, elapsed, base_time: t.wall - t.score / t.tempo,
            user_paused: t.user_paused, focus_lost: t.focus_lost,
        }
    }

    pub fn user_paused(&self) -> bool {
        self.lock().user_paused
    }

    pub fn focus_lost(&self) -> bool {
        self.lock().focus_lost
    }

    pub fn set_user_paused(&self, paused: bool) {
        let mut t = self.lock();
        t.anchor(perf());
        t.user_paused = paused;
        self.changed.notify_one();
    }

    pub fn set_focus_lost(&self, lost: bool) {
        let mut t = self.lock();
        t.anchor(perf());
        t.focus_lost = lost;
        self.changed.notify_one();
    }

    pub fn stopped(&self) -> bool {
        self.lock().stopped
    }

    pub fn halt(&self) {
        self.lock().stopped = true;
        self.changed.notify_one();
    }
}

#[cfg(test)]
mod tests {
    use super::State;

    #[test]
    fn live_tempo_preserves_score_and_retimes_only_remaining_distance() {
        let state = State::new(0.5);
        state.prepare(20.0, 3.0);
        let mut t = state.lock();
        t.wall = 100.0;
        t.started = true;

        t.set_tempo(2.0, 104.0);
        assert_eq!(t.position(104.0), 5.0);
        assert_eq!(t.deadline(7.0), 105.0);
        t.set_tempo(0.25, 105.0);
        assert_eq!(t.position(105.0), 7.0);
        assert_eq!(t.deadline(8.0), 109.0);

        t.anchor(109.0);
        t.user_paused = true;
        t.set_tempo(4.0, 200.0);
        assert_eq!(t.position(500.0), 8.0);
        assert_eq!(t.position(500.0) / t.tempo, 2.0);
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
/// Sustain releases live on a min-heap in score seconds; a tempo change
/// changes their wall deadlines, not the keys being held. A pause or seek
/// releases them, and resuming never re-presses them.
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
    let mut i = 0;
    {
        let mut t = state.lock();
        t.wall = perf();
        t.started = true;
    }
    loop {
        let mut t = state.lock();
        if t.stopped {
            return Ok(errors);
        }
        if let Some(score) = t.pending_seek.take() {
            drop(t);
            kb.release_all();
            i = events.partition_point(|e| e.t < score);
            state.played_count.store(i, Ordering::Release);
            continue;
        }
        if !t.running() {
            if !kb.held.is_empty() {
                drop(t);
                kb.release_all();
            } else {
                drop(state.changed.wait(t).unwrap_or_else(|e| e.into_inner()));
            }
            continue;
        }

        let now = perf();
        let score = t.position(now);
        let release = kb.heap.peek().map(|Reverse(Due(at, _))| *at);
        if release.is_some_and(|at| at <= score) {
            drop(t);
            kb.release_due(score);
            continue;
        }
        let next = events.get(i);
        let range_end = opts.end_at.filter(|end| next.is_none_or(|e| e.t >= *end));
        let onset = next.filter(|_| range_end.is_none());
        // Injection compensation is measured in wall seconds, not score seconds.
        let boundary = range_end.map(|end| t.deadline(end)).or_else(|| {
            onset.map(|e| t.deadline(e.t) - opts.latency - shifts[i])
        });
        let target = match (boundary, release) {
            (Some(b), Some(r)) => b.min(t.deadline(r)),
            (Some(b), None) => b,
            (None, Some(r)) => t.deadline(r),
            (None, None) => break,
        };
        let remaining = target - now;
        if remaining > PRECISE_WAIT_WINDOW {
            // A fast tempo change can bring the next note much closer. Wake
            // immediately on control changes; keep the high-resolution tail.
            let wait = Duration::from_secs_f64((remaining - PRECISE_WAIT_WINDOW).min(3600.0));
            drop(state.changed.wait_timeout(t, wait).unwrap_or_else(|e| e.into_inner()));
            continue;
        }
        if remaining > 0.0 {
            drop(t);
            if remaining > spin { sleeper.sleep(remaining - spin) } else { spin_until(target) }
            continue;
        }
        if boundary.is_none_or(|b| now < b) {
            continue; // rounding at a release deadline; resample the clock
        }
        if range_end.is_some() {
            break;
        }
        let beat = t.deadline(events[i].t);
        let min_hold = 0.03 * t.tempo;
        drop(t);

        let mut j = i + 1;
        if opts.batch {
            while j < total && events[j].t == events[i].t {
                j += 1;
            }
        }
        let actual = perf();
        for k in i..j {
            if opts.sustain {
                kb.hold(&strokes[k], events[k].t + events[k].dur.max(min_hold));
            } else {
                kb.tap(&strokes[k]);
            }
        }
        kb.flush();

        state.played_count.store(j, Ordering::Release);
        if opts.collect_stats {
            errors.resize(errors.len() + j - i, actual - beat);
        }
        i = j;
    }

    state.halt();
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

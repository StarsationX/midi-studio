//! Refine instrumental articulation without changing the selected keys.
use crate::{basicpitch::SAMPLE_RATE, pmidi::{Note, PrettyMidi}};

// 32 ms Hann window, sampled every 4 ms on the existing 22.05 kHz detector input.
const WIDTH: usize = 706;
const HOP: usize = 88;
const SIDE: usize = 18;
const FRAMES: usize = 2 * SIDE + 1;

fn hann() -> &'static [f32; WIDTH] {
    static WINDOW: std::sync::LazyLock<[f32; WIDTH]> = std::sync::LazyLock::new(||
        std::array::from_fn(|i| 0.5 - 0.5 * (std::f32::consts::TAU * i as f32 / (WIDTH - 1) as f32).cos()));
    &WINDOW
}

fn coefficients(pitch: u8) -> [f32; 3] {
    let omega = std::f32::consts::TAU * 440.0 * 2.0_f32.powf((f32::from(pitch) - 69.0) / 12.0) / SAMPLE_RATE as f32;
    [1.0, 2.0, 3.0].map(|h| 2.0 * (omega * h).cos())
}

// Three Goertzel bins instead of a song-sized spectrogram.
fn partials(frame: &[f32], hann: &[f32], coeff: &[f32; 3]) -> [f32; 3] {
    let (mut a, mut b) = ([0.0_f32; 3], [0.0_f32; 3]);
    for (&s, &w) in frame.iter().zip(hann) {
        let x = s * w;
        for k in 0..3 {
            let next = x + coeff[k] * a[k] - b[k];
            b[k] = a[k];
            a[k] = next;
        }
    }
    std::array::from_fn(|k| (a[k]*a[k] + b[k]*b[k] - coeff[k]*a[k]*b[k]).max(0.0).sqrt())
}

fn magnitude(frame: &[f32], hann: &[f32; WIDTH], coeff: &[f32; 3]) -> f32 {
    let [a, b, c] = partials(frame, hann, coeff);
    a + 0.45*b + 0.25*c
}

fn audible_attack(wave: &[f32], note: &Note, hann: &[f32; WIDTH]) -> Option<f64> {
    let sample = (note.start * f64::from(SAMPLE_RATE) / HOP as f64).round() as usize * HOP;
    let first = sample.checked_sub(SIDE * HOP + WIDTH / 2)?;
    let block = wave.get(first..first + WIDTH + (FRAMES - 1) * HOP)?;
    let coeff = coefficients(note.pitch);
    let mut env = [0.0; FRAMES];
    for (frame, loud) in env.iter_mut().enumerate() {
        *loud = magnitude(&block[frame * HOP..][..WIDTH], hann, &coeff);
    }
    let mut peak = 0;
    for j in 1..FRAMES-5 {
        if env[j+5] - env[j] > env[peak+5] - env[peak] { peak = j; }
    }
    let at = sample as f64 / f64::from(SAMPLE_RATE)
        + (peak as f64 + 3.0 - SIDE as f64) * HOP as f64 / f64::from(SAMPLE_RATE);
    let delta = at - note.start;
    if !(0.005..=0.042).contains(&delta) { return None; }
    let mut floor = std::array::from_fn::<_, 5, _>(|i| env[peak.saturating_sub(4 - i)]);
    floor.sort_unstable_by(f32::total_cmp);
    let high = &env[peak+5..(peak+11).min(FRAMES)];
    let level = high.iter().sum::<f32>() / high.len() as f32;
    if level < 3.0 * floor[2].max(0.001) || env[peak+5] - env[peak] < 0.38 * level { return None; }
    // A piano sample takes time to speak after key-on. A full correction
    // follows the pluck envelope on paper but puts the rendered piano late.
    Some(note.start + (0.4 * delta).min(0.0165))
}

pub(super) fn align(midi: &mut PrettyMidi, wave: &[f32], vocals: &[Note], piano: &[(f64, f64)]) {
    let [right, left] = midi.instruments.as_mut_slice() else { return };
    if wave.is_empty() || right.notes.is_empty() { return; }
    let hann = hann();
    let mut prev = f64::NEG_INFINITY;
    for i in 0..right.notes.len() {
        let n = right.notes[i];
        let next = right.notes.get(i+1).map_or(f64::INFINITY, |p| p.start);
        let separate = n.start - prev > 0.025 && next - n.start > 0.025;
        prev = n.start;
        if !separate || !(53..=96).contains(&n.pitch) || n.end - n.start <= 0.045 { continue; }
        if vocals.binary_search_by(|p| p.start.total_cmp(&n.start)).is_ok() { continue; }
        let passage = piano.get(piano.partition_point(|&(_, end)| end <= n.start));
        if passage.is_some_and(|&(a, _)| a <= n.start + 0.033) { continue; }
        let l = left.notes.partition_point(|k| k.start < n.start - 0.011);
        if left.notes.get(l).is_some_and(|k| k.start <= n.start + 0.011) { continue; }
        if let Some(at) = audible_attack(wave, &n, &hann) {
            // Delay only: never introduce overlap or move a note past its release.
            if n.end - at > 0.04 && next - at > 0.015 { right.notes[i].start = at; }
        }
    }
}

// Difference between acoustic attack level and the existing piano velocity
// in dB. Only differences *between repeats of the same key* are meaningful:
// this cancels mix gain, register and the piano sample's own loudness.
fn residual(wave: &[f32], n: Note, hann: &[f32; WIDTH]) -> Option<f64> {
    let coeff = coefficients(n.pitch);
    let level = |offset: f64| {
        let center = ((n.start + offset) * f64::from(SAMPLE_RATE)).round() as usize;
        let start = center.checked_sub(WIDTH / 2)?;
        Some(magnitude(wave.get(start..start + WIDTH)?, hann, &coeff))
    };
    let before = level(-0.032)?;
    let mut attack = [level(0.024)?, level(0.048)?, level(0.072)?];
    attack.sort_unstable_by(f32::total_cmp);
    (attack[1] > 1.6 * before.max(0.00035)).then(||
        20.0 * f64::from(attack[1]).log10() - 25.0 * f64::from(n.velocity).log10())
}

#[derive(Clone, Copy)]
struct Repeat { index: usize, db: f64, before: Option<f64> }

impl Repeat {
    fn apply(self, notes: &mut [Note], after: Option<f64>) {
        let reference = match (self.before, after) {
            (Some(a), Some(b)) => (a + b) * 0.5,
            (Some(a), None) | (None, Some(a)) => a,
            _ => return,
        };
        let key = &mut notes[self.index];
        let db = (0.30 * (self.db - reference)).clamp(-2., 2.);
        key.velocity = (f64::from(key.velocity) * 10.0_f64.powf(db / 25.)).round().clamp(1., 127.) as u8;
    }
}

pub(super) fn accent_repeats(midi: &mut PrettyMidi, wave: &[f32], instrumental: &[Note], vocals: &[Note], piano: &[(f64, f64)]) {
    let Some(right) = midi.instruments.first_mut() else { return };
    if wave.is_empty() || instrumental.is_empty() { return; }
    let notes = &mut right.notes;
    let window = hann();
    let mut pending: [Option<Repeat>; 44] = [None; 44];
    for i in 0..notes.len() {
        let n = notes[i];
        if !(53..=96).contains(&n.pitch) || n.end - n.start < 0.080
            || i > 0 && n.start - notes[i-1].start < 0.030
            || notes.get(i+1).is_some_and(|k| k.start - n.start < 0.030) { continue; }
        if piano.get(piano.partition_point(|&(_, end)| end <= n.start)).is_some_and(|&(a, _)| a <= n.start)
            || vocals.binary_search_by(|v| v.start.total_cmp(&n.start)).is_ok() { continue; }
        // align() may already have moved this key up to 16.5 ms later.
        let j = instrumental.partition_point(|k| k.start < n.start - 0.017);
        if !instrumental[j..].iter().take_while(|k| k.start <= n.start).any(|k| k.pitch == n.pitch) { continue; }
        let Some(db) = residual(wave, n, &window) else { continue };
        let slot = &mut pending[usize::from(n.pitch - 53)];
        let before = slot.take().and_then(|prev| {
            let near = n.start - notes[prev.index].start <= 4.0;
            prev.apply(notes, near.then_some(db));
            near.then_some(prev.db)
        });
        *slot = Some(Repeat { index: i, db, before });
    }
    for last in pending.into_iter().flatten() { last.apply(notes, None); }
}

// A ringing pluck can outlast the piano detector's key-off. Require the
// fundamental and the same overtone to rise out of the pre-attack background
// and stay present after key-off. Stop at a dropout or a fresh loud attack.
fn ringing_end(wave: &[f32], n: Note, limit: f64, hann: &[f32; WIDTH]) -> Option<f64> {
    if n.end - n.start < 0.030 { return None; }
    let coeff = coefficients(n.pitch);
    let bands = |t: f64| {
        let center = (t * f64::from(SAMPLE_RATE)).round() as usize;
        let start = center.checked_sub(WIDTH / 2)?;
        Some(partials(wave.get(start..start + WIDTH)?, hann, &coeff))
    };
    let median = |a: [f32; 3], b: [f32; 3], c: [f32; 3]| -> [f32; 3] {
        std::array::from_fn(|i| a[i].clamp(b[i].min(c[i]), b[i].max(c[i])))
    };
    let before = median(bands(n.start - 0.048)?, bands(n.start - 0.036)?, bands(n.start - 0.024)?);
    let attack = median(bands(n.start + 0.024)?, bands(n.start + 0.044)?, bands((n.start + 0.064).min(n.end - 0.012))?);
    // For short, muted attacks the last frames must still fall inside the note.
    let near_end = |offset: f64, earliest: f64| bands((n.end - offset).max(n.start + earliest));
    let tail = median(near_end(0.044, 0.012)?, near_end(0.032, 0.018)?, near_end(0.020, 0.024)?);
    let mut keep = std::array::from_fn::<_, 3, _>(|k| attack[k] > (before[k]*2.5).max(0.001)
        && tail[k] > (attack[k]*0.10).max(before[k]*1.25));
    let mut end = n.end;
    while keep[0] && (keep[1] || keep[2]) && end < limit {
        let next = (end + 0.016).min(limit);
        let Some(level) = bands(next) else { break };
        for k in 0..3 {
            keep[k] &= level[k] > (attack[k]*0.10).max(before[k]*1.3).max(tail[k]*0.30)
                && level[k] < (tail[k]*2.).max(attack[k]*1.15);
        }
        if keep[0] && (keep[1] || keep[2]) { end = next; }
    }
    Some(end)
}

// Both hands already fit before the extension. Check only the newly occupied
// interval. Fingers released between successive attacks are available again.
fn playable_end(hand: &[Note], opposite: &[Note], i: usize, first: &mut usize, other: &mut usize,
    mut end: f64, right: bool) -> f64 {
    let n = hand[i];
    while *other < opposite.len() && opposite[*other].end <= n.start { *other += 1; }
    for k in &opposite[*other..] {
        if k.start >= end { break; }
        let crosses = if right { k.pitch >= n.pitch } else { k.pitch <= n.pitch + 1 };
        if k.end > n.end && crosses { end = end.min(k.start); }
    }
    while *first < i && hand[*first].end <= n.start { *first += 1; }
    let mut fingers = [0.; 4];
    for (j, k) in hand[*first..].iter().enumerate() {
        if k.start >= end { break; }
        if *first + j == i || k.end <= n.end { continue; }
        if k.pitch != n.pitch && k.pitch.abs_diff(n.pitch) <= 12 {
            if let Some(free) = fingers.iter_mut().find(|e| **e <= k.start.max(n.end)) {
                *free = k.end;
                continue;
            }
        }
        return end.min(k.start);
    }
    end
}

// Follow a fundamental and at least one overtone through the boundary.
// A simultaneous 6 dB rise on two audible partials is a possible re-pluck.
fn continuous(wave: &[f32], n: Note, window: &[f32], hop: usize, rate: u32) -> bool {
    let width = window.len();
    let Some(start) = ((n.start * f64::from(rate)).round() as usize).checked_sub(width / 2 + 12 * hop) else { return false };
    let Some(region) = wave.get(start..start + width + 24 * hop) else { return false };
    let omega = std::f32::consts::TAU * 440.0 * 2.0_f32.powf((f32::from(n.pitch) - 69.0) / 12.0) / rate as f32;
    if 3.0 * omega >= std::f32::consts::PI { return false; }
    let coeff = [1., 2., 3.].map(|h| 2. * (h * omega).cos());
    let floor = width as f32 * 0.00025;
    let mut low = [f32::MAX; 3];
    let mut high = [0_f32; 3];
    let mut history = [[0.0; 3]; 2];
    for (i, frame) in region.windows(width).step_by(2 * hop).enumerate() {
        let levels = partials(frame, window, &coeff);
        let previous = &mut history[i % 2];
        if i >= 2 && (0..3).filter(|&h| levels[h] > floor && levels[h] > 2. * previous[h]).count() >= 2 { return false; }
        *previous = levels;
        for h in 0..3 { low[h] = low[h].min(levels[h]); high[h] = high[h].max(levels[h]); }
    }
    let steady = |h: usize| low[h] > floor && low[h] > high[h] * 0.5;
    steady(0) && (steady(1) || steady(2))
}

/// Join contiguous right-hand notes only when the backing detector heard
/// one hold and both the backing mix and isolated guitar have no new attack.
pub(super) fn join_splits(notes: &mut Vec<Note>, backing: &[Note], vocals: &[Note], piano: &[(f64, f64)],
    wave: &[f32], guitar: &[f32], isolated: &[bool]) {
    if guitar.is_empty() || backing.is_empty() { return; }
    static SMALL: std::sync::LazyLock<[f32; WIDTH / 2]> = std::sync::LazyLock::new(||
        std::array::from_fn(|i| 0.5 - 0.5 * (std::f32::consts::TAU * i as f32 / (WIDTH / 2 - 1) as f32).cos()));
    let voice_span = vocals.iter().map(|v| v.end - v.start).fold(0., f64::max);
    let mut last = [usize::MAX; 128];
    let mut written = 0;
    for read in 0..notes.len() {
        let n = notes[read];
        if (53..=96).contains(&n.pitch) {
            let slot = &mut last[usize::from(n.pitch)];
            if *slot != usize::MAX {
                let prior: Note = notes[*slot];
                let start = ((n.start - 0.065) * 20.).floor() as usize;
                let end = ((n.start + 0.065) * 20.).floor() as usize;
                if (n.start - prior.end).abs() < 0.001 && n.start - prior.start > 0.10
                    && isolated.get(start..=end).is_some_and(|bins| bins.iter().all(|&ok| ok))
                    && backing[backing.partition_point(|k| k.start < prior.start - 0.035)..]
                        .iter().take_while(|k| k.start <= prior.start + 0.035)
                        .any(|k| k.pitch == n.pitch && k.end >= n.start + 0.048)
                    && !piano.get(piano.partition_point(|&(_, t)| t <= prior.start)).is_some_and(|&(s, _)| s < n.end)
                    && !vocals[vocals.partition_point(|v| v.start < prior.start - voice_span)..]
                        .iter().take_while(|v| v.start < n.end).any(|v| v.end > prior.start)
                    && continuous(wave, n, hann(), HOP, SAMPLE_RATE)
                    && continuous(guitar, n, &*SMALL, HOP / 2, SAMPLE_RATE / 2) {
                    notes[*slot].end = n.end;
                    continue;
                }
            }
            *slot = written;
        }
        if written != read { notes[written] = n; }
        written += 1;
    }
    notes.truncate(written);
}

/// The reduction cuts a melodic key at the next attack, even when the player
/// kept it down. Corroborate the pitched detector with the backing detector
/// or with a ringing fundamental and overtone in the backing waveform.
/// Finalize holds before shaping dynamics so the loudness estimate uses
/// the actual sounding duration. No attack or other key moves.
pub(super) fn restore_held_keys(midi: &mut PrettyMidi, instrumental: &[Note], backing: &[Note], vocals: &[Note], piano: &[(f64, f64)], wave: &[f32]) {
    const MIN_TAIL: f64 = 0.050;
    let [right, left] = midi.instruments.as_mut_slice() else { return };
    if instrumental.is_empty() || backing.is_empty() { return; }
    let window = hann();
    let (mut rh, mut lh) = (0, 0);
    for i in 0..right.notes.len() {
        let n = right.notes[i];
        if !(53..=96).contains(&n.pitch) { continue; }
        let j = instrumental.partition_point(|k| k.start < n.start - 0.035);
        let Some(raw) = instrumental[j..].iter().take_while(|k| k.start <= n.start + 0.025)
            .filter(|k| k.pitch == n.pitch)
            .min_by(|a, b| (a.start - n.start).abs().total_cmp(&(b.start - n.start).abs())) else { continue };
        let j = backing.partition_point(|k| k.start < raw.start - 0.035);
        let near = &backing[j..j + backing[j..].partition_point(|k| k.start <= raw.start + 0.035)];
        if near.contains(raw) { continue; } // piano fallback, not independent evidence
        let confirmed = near.iter().filter(|k| k.pitch == n.pitch && k.velocity >= 55)
            .min_by(|a, b| (a.start - raw.start).abs().total_cmp(&(b.start - raw.start).abs()))
            .map_or(n.end, |k| k.end.max(n.end));
        // The melodic detector may stop at the next picked string while the
        // polyphonic detector still follows this one. Trust that independent
        // hold for at most 1.2 s beyond the written release.
        let mut end = raw.end.min(confirmed + 0.40).max(confirmed.min(n.end + 1.20));
        let v = vocals.partition_point(|k| k.start < n.start);
        if v > 0 && vocals[v - 1].end > n.start { continue; }
        if let Some(next) = vocals.get(v) { end = end.min(next.start); }
        if let Some(&(start, _)) = piano.get(piano.partition_point(|&(_, stop)| stop <= n.start)) {
            end = end.min(start);
        }
        if end < n.end + MIN_TAIL { continue; }
        end = playable_end(&right.notes, &left.notes, i, &mut rh, &mut lh, end, true);
        if end > confirmed {
            let held = Note { end: confirmed, ..n };
            end = if end >= confirmed + MIN_TAIL && !wave.is_empty() {
                ringing_end(wave, held, end, window).unwrap_or(confirmed)
            } else { confirmed };
        }
        if end >= n.end + MIN_TAIL { right.notes[i].end = end; }
    }
}

// Some low plucks are recognized as 30–50 ms attacks, but ring underneath
// the next chord. Don't turn them into a pedal: follow the SAME partials from
// the attack, stop at a dropout or re-strike, and never add a note.
pub(super) fn hold_lower(midi: &mut PrettyMidi, backing: &[Note], piano: &[(f64, f64)], wave: &[f32]) {
    let [right, left] = midi.instruments.as_mut_slice() else { return };
    if backing.is_empty() || wave.is_empty() { return; }
    let window = hann();
    let (mut lh, mut rh) = (0, 0);
    for i in 0..left.notes.len() {
        let n = left.notes[i];
        if !(40..=65).contains(&n.pitch) { continue; }
        let j = backing.partition_point(|k| k.start < n.start - 0.035);
        let Some(source) = backing[j..].iter().take_while(|k| k.start <= n.start + 0.035)
            .filter(|k| k.pitch == n.pitch && k.velocity >= 45)
            .min_by(|a, b| (a.start - n.start).abs().total_cmp(&(b.start - n.start).abs())) else { continue };
        let mut end = source.end.clamp(n.end + 0.35, n.end + 0.80);
        if let Some(&(start, _)) = piano.get(piano.partition_point(|&(_, stop)| stop <= n.start)) {
            end = end.min(start);
        }
        if end < n.end + 0.050 { continue; }
        end = playable_end(&left.notes, &right.notes, i, &mut lh, &mut rh, end, false);
        if end < n.end + 0.050 { continue; }
        if let Some(heard) = ringing_end(wave, n, end, window) {
            if heard >= n.end + 0.050 { left.notes[i].end = heard; }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pmidi::Instrument;
    #[test]
    fn backing_hold_needs_both_steady_guitar_and_isolation() {
        let a = Note { pitch: 69, start: 0.1, end: 0.35, velocity: 75 };
        let b = Note { start: a.end, end: 0.62, ..a };
        let held = Note { end: b.end, ..a };
        let tone = |rate: u32, repluck: bool| (0..rate).map(|i| {
            let t = f64::from(i) / f64::from(rate);
            let phase = std::f64::consts::TAU * 440. * t;
            let amplitude = if repluck && t < b.start { 0.02 } else { 0.25 };
            (amplitude * (phase.sin() + 0.4 * (2. * phase).sin())) as f32
        }).collect::<Vec<_>>();
        let mix = tone(SAMPLE_RATE, false);
        let mut mask = [true; 20];
        let check = |pluck, mask: &[bool]| {
            let mut notes = vec![a, b];
            join_splits(&mut notes, &[held], &[], &[], &mix, &tone(SAMPLE_RATE / 2, pluck), mask);
            notes
        };
        assert_eq!(check(false, &mask), [held]);
        assert_eq!(check(true, &mask), [a, b]); // the mix alone would erase this pluck
        mask[7] = false;
        assert_eq!(check(false, &mask), [a, b]); // another energetic stem vetoes the merge
    }

    #[test]
    fn longer_polyphonic_release_survives_successive_reachable_notes() {
        let n = key(64, 0.20, 0.40);
        let mut midi = PrettyMidi::new(960, 120.);
        let mut hand = Instrument::new(0, false, "Right");
        hand.notes.push(n);
        hand.notes.extend((0..6).map(|i| {
            let start = 0.42 + 0.1 * f64::from(i);
            key(67 + i, start, start + 0.06)
        }));
        midi.instruments.extend([hand, Instrument::new(0, false, "Left")]);
        restore_held_keys(&mut midi, &[key(64, 0.215, 0.39)], &[key(64, 0.20, 1.02)], &[], &[], &[]);
        assert_eq!(midi.instruments[0].notes[0], key(64, 0.20, 1.02));
    }

    #[test]
    fn short_lower_pluck_rings_until_silence_or_hand_crossing() {
        let n = key(50, 0.20, 0.242);
        let wave: Vec<_> = (0..SAMPLE_RATE).map(|i| {
            let t = f64::from(i) / f64::from(SAMPLE_RATE);
            let phase = std::f64::consts::TAU * 146.832 * t;
            if (0.20..0.49).contains(&t) { (0.2 * phase.sin() + 0.10 * (2.*phase).sin()) as f32 } else { 0. }
        }).collect();
        for (right, piano, release) in [
            (None, None, 0.46..0.52),
            (Some(key(49, 0.36, 0.50)), None, 0.359..0.361),
            (None, Some((0.10, 0.60)), 0.241..0.243),
        ] {
            let mut midi = PrettyMidi::new(960, 120.);
            let mut rh = Instrument::new(0, false, "Right");
            rh.notes.extend(right);
            let mut lh = Instrument::new(0, false, "Left");
            lh.notes.push(n);
            midi.instruments.extend([rh, lh]);
            hold_lower(&mut midi, &[n], piano.as_slice(), &wave);
            let out = midi.instruments[1].notes[0];
            assert!(release.contains(&out.end), "{}", out.end);
            assert_eq!(out, Note { end: out.end, ..n });
        }
    }


    fn key(pitch: u8, start: f64, end: f64) -> Note { Note { pitch, start, end, velocity: 72 } }

    #[test]
    fn clipped_pluck_keeps_only_independently_supported_playable_tail() {
        let raw = key(64, 0.20, 0.82);
        let corroborated = key(64, 0.21, 0.73);
        let aligned = key(64, 0.21, 0.41);
        for (other, left, blocker, voice, passage, expected) in [
            (corroborated, None, None, None, None, 0.73),
            (raw, None, None, None, None, 0.41), // copied fallback
            (corroborated, Some(key(65, 0.52, 0.63)), None, None, None, 0.52),
            (corroborated, Some(key(65, 0.15, 0.63)), None, None, None, 0.41),
            (corroborated, None, Some(key(64, 0.50, 0.59)), None, None, 0.50),
            (corroborated, None, Some(key(77, 0.54, 0.64)), None, None, 0.54),
            (corroborated, None, None, Some(aligned), None, 0.41),
            (corroborated, None, None, Some(key(72, 0.52, 0.90)), None, 0.52),
            (corroborated, None, None, None, Some((0.1, 0.9)), 0.41),
            (corroborated, None, None, None, Some((0.52, 0.9)), 0.52),
        ] {
            let mut midi = PrettyMidi::new(960, 120.);
            let mut rh = Instrument::new(0, false, "Right");
            let mut lh = Instrument::new(0, false, "Left");
            rh.notes.extend([aligned, key(69, 0.41, 0.51)]);
            rh.notes.extend(blocker);
            lh.notes.extend(left);
            midi.instruments.extend([rh, lh]);
            restore_held_keys(&mut midi, &[raw], &[other], voice.as_slice(), passage.as_slice(), &[]);
            assert_eq!(midi.instruments[0].notes[0], Note { end: expected, ..aligned });
            assert_eq!(midi.instruments[0].notes[1], key(69, 0.41, 0.51));
        }
    }

    #[test]
    fn held_tail_yields_to_a_fifth_other_key() {
        let raw = key(64, 0.0, 0.9);
        let mut midi = PrettyMidi::new(960, 120.);
        let mut rh = Instrument::new(0, false, "Right");
        rh.notes.push(key(64, 0.0, 0.2));
        rh.notes.extend((0..5).map(|i| key(65+i, 0.2 + 0.1*f64::from(i), 1.)));
        midi.instruments.extend([rh, Instrument::new(0, false, "Left")]);
        restore_held_keys(&mut midi, &[raw], &[key(64, 0.01, 1.)], &[], &[], &[]);
        assert_eq!(midi.instruments[0].notes[0].end, midi.instruments[0].notes[5].start);
    }

    #[test]
    fn unconfirmed_pluck_rings_only_until_the_wave_dies_or_the_key_repeats() {
        let pluck = key(69, 0.20, 0.38);
        let raw = key(69, 0.20, 0.80);
        let wave = (0..SAMPLE_RATE).map(|i| {
            let t = f64::from(i) / f64::from(SAMPLE_RATE);
            let phase = std::f64::consts::TAU * 440. * t;
            if (0.20..0.60).contains(&t) { (0.2*phase.sin() + 0.1*(2.*phase).sin()) as f32 } else { 0. }
        }).collect::<Vec<_>>();
        for (repeat, vocals, piano, source, range) in [
            (None, None, None, &wave[..], 0.57..0.62),
            (Some(key(69, 0.52, 0.60)), None, None, &wave, 0.52..0.521),
            (None, Some(pluck), None, &wave, 0.38..0.381),
            (None, None, Some((0.1, 0.9)), &wave, 0.38..0.381),
            (None, None, None, &wave[..(SAMPLE_RATE as usize / 3)], 0.38..0.381),
        ] {
            let mut midi = PrettyMidi::new(960, 120.);
            let mut rh = Instrument::new(0, false, "Right");
            rh.notes.push(pluck);
            rh.notes.extend(repeat);
            midi.instruments.extend([rh, Instrument::new(0, false, "Left")]);
            restore_held_keys(&mut midi, &[raw], &[key(60, 0.21, 0.40)], vocals.as_slice(), piano.as_slice(), source);
            let result = midi.instruments[0].notes[0];
            assert!(range.contains(&result.end), "{}", result.end);
            assert_eq!(result, Note { end: result.end, ..pluck });
        }
    }

    #[test]
    fn late_pluck_moves_but_block_chords_and_sustained_tones_do_not() {
        let tone = |t: f32| (std::f32::consts::TAU * 440. * t).sin();
        let rate = SAMPLE_RATE as usize;
        let wave: Vec<_> = (0..rate*2).map(|i| {
            let t = i as f32 / rate as f32;
            if (0.32..0.50).contains(&t) || t >= 0.72 { tone(t) } else { 0.0 }
        }).collect();
        let mut midi = PrettyMidi::new(960, 120.0);
        let mut right = Instrument::new(0, false, "Right");
        for start in [0.3, 0.7, 1.0] { right.notes.push(Note { pitch: 69, start, end: start+0.15, velocity: 70 }); }
        let mut left = Instrument::new(0, false, "Left");
        left.notes.push(Note { pitch: 45, start: 0.7, end: 0.9, velocity: 64 });
        midi.instruments.extend([right, left]);
        align(&mut midi, &wave, &[], &[]);
        let keys = &midi.instruments[0].notes;
        assert!((0.305..0.317).contains(&keys[0].start));
        assert_eq!((keys[0].end, keys[1].start, keys[2].start), (0.3+0.15, 0.7, 1.0));
    }

    #[test]
    fn repeated_plucks_keep_the_recorded_accent_without_accenting_a_vocal_or_piano() {
        let starts = [0.2, 0.7, 1.2, 1.7];
        let keys: Vec<_> = starts.map(|start| Note { pitch: 69, start, end: start+0.16, velocity: 80 }).into();
        let wave = (0..2*SAMPLE_RATE).map(|i| {
            let t = f64::from(i) / f64::from(SAMPLE_RATE);
            starts.iter().zip([0.08, 0.3, 0.01, 0.01]).find(|(s, _)| (**s..**s+0.16).contains(&t))
                .map_or(0.0, |(_, gain)| gain * (std::f64::consts::TAU * 440.0 * t).sin() as f32)
        }).collect::<Vec<_>>();
        let mut midi = PrettyMidi::new(960, 120.);
        let mut hand = Instrument::new(0, false, "Right");
        hand.notes.clone_from(&keys);
        midi.instruments.push(hand);
        accent_repeats(&mut midi, &wave, &keys, &keys[2..3], &[(1.6, 2.)]);
        let out = &midi.instruments[0].notes;
        assert!(out[0].velocity < 80 && out[1].velocity > 80);
        assert_eq!(out[2..], keys[2..]);
    }
}

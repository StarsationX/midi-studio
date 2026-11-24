//! Give the louder string in the recording the louder piano voice, without
//! treating every key in a chord as a separate phrase-level volume change.
use super::response::{attack_db, KeyResponse};
use crate::pmidi::{Note, PrettyMidi};
use std::sync::LazyLock;

const STEP: usize = 8;
const RATE: f64 = 44_100. / STEP as f64;
const WIDTH: usize = 640;
const NEAR: f64 = 0.22;
const LIMIT_DB: f64 = 6.;
static WINDOW: LazyLock<[f32; WIDTH]> = LazyLock::new(|| std::array::from_fn(|i|
    0.5 - 0.5 * (std::f32::consts::TAU * i as f32 / (WIDTH - 1) as f32).cos()));

/// The backing is the mean of three 44.1 kHz stems. Restore their gain when
/// combining with bass and vocals; never let a kick or snare set a key's touch.
/// Retain one sample per eight, not another full-rate copy of the recording.
pub(crate) fn mix(bass: &[f32], vocals: &[f32], backing: &[f32]) -> Vec<f32> {
    bass.chunks_exact(STEP).zip(vocals.chunks_exact(STEP)).zip(backing.chunks_exact(STEP))
        .map(|((b, v), h)| (0..STEP).map(|i| b[i] + v[i] + 3. * h[i]).sum::<f32>() / STEP as f32)
        .collect()
}

struct Probe { coeff: [f64; 3], weights: [f64; 3] }
static PROBES: LazyLock<[Probe; 88]> = LazyLock::new(|| std::array::from_fn(|i| {
    let hz = 440. * 2_f64.powf((i as f64 + 21. - 69.) / 12.);
    Probe {
        coeff: [1., 2., 3.].map(|h| 2. * (std::f64::consts::TAU * h * hz / RATE).cos()),
        weights: std::array::from_fn(|j| if (j + 1) as f64 * hz < 0.46 * RATE { [1., 0.35, 0.12][j] } else { 0. }),
    }
}));

// One Hann window over the early sounding part of the written note. Ignore
// partials above the analysis band; never fold an overtone onto a lower key.
fn residual(n: Note, mix: &[f32]) -> Option<f64> {
    let probe = PROBES.get(usize::from(n.pitch.checked_sub(21)?))?;
    if probe.weights[0] == 0. { return None; }
    let center = n.start + (0.5 * (n.end - n.start)).min(0.080);
    let start = ((center * RATE).round() as usize).saturating_sub(WIDTH / 2);
    let window = mix.get(start..start + WIDTH)?;
    let (mut a, mut b) = ([0.; 3], [0.; 3]);
    let mut peak = 0.0_f32;
    for (&sample, &w) in window.iter().zip(WINDOW.iter()) {
        peak = peak.max(sample.abs());
        let input = f64::from(sample * w);
        let last = a;
        for j in 0..3 { a[j] = input + probe.coeff[j] * last[j] - b[j]; }
        b = last;
    }
    if peak < 0.0001 { return None; }
    let power: f64 = (0..3).map(|j| probe.weights[j] *
        (a[j]*a[j] + b[j]*b[j] - probe.coeff[j]*a[j]*b[j]).max(0.)).sum();
    Some(10. * power.max(1e-6).log10() - attack_db(n.pitch) - 25. * f64::from(n.velocity.max(1)).log10())
}

struct Strike { hand: usize, index: usize, note: Note, section: usize, residual: f64, energy: f64, gain: f64 }

pub(crate) fn balance(midi: &mut PrettyMidi, mix: &[f32], piano: &[(f64, f64)]) -> bool {
    let [right, left] = midi.instruments.as_slice() else { return false };
    if mix.len() < WIDTH { return false; }
    let hands = [&right.notes, &left.notes];
    let mut strikes = Vec::with_capacity(right.notes.len() + left.notes.len());
    let mut indices = [0; 2];
    let mut section = 0;
    loop {
        let hand = match (hands[0].get(indices[0]), hands[1].get(indices[1])) {
            (Some(a), Some(b)) => usize::from(a.start > b.start),
            (Some(_), None) => 0, (None, Some(_)) => 1, (None, None) => break,
        };
        let index = indices[hand];
        indices[hand] += 1;
        let note = hands[hand][index];
        while section < piano.len() && piano[section].1 <= note.start { section += 1; }
        if piano.get(section).is_some_and(|&(start, _)| start < note.end) { continue; }
        let Some(residual) = residual(note, mix) else { continue };
        let duration = note.end - note.start;
        let velocity = f64::from(note.velocity);
        let energy = KeyResponse::new(note.pitch, note.velocity, duration).at(duration.min(0.12)).0
            * velocity * velocity * velocity.sqrt();
        strikes.push(Strike { hand, index, note, section, residual, energy, gain: 1. });
    }
    // Compare nearby keys rather than the absolute recording level. Notes
    // outside the chord provide only weak context; a lone note gets no accent.
    let mut bounds = (0, 0);
    for i in 0..strikes.len() {
        let k = &strikes[i];
        let mut weight = 0.;
        let mut shared = 0.;
        let mut sum = 0.;
        for s in neighbors(&strikes, k, &mut bounds) {
            if s.note.pitch == k.note.pitch || s.section != k.section { continue; }
            let mut w = 1.2 - (s.note.start - k.note.start).abs() / NEAR;
            if s.hand == k.hand { w *= 0.8; }
            if (s.residual - k.residual).abs() > 25. { w *= 0.4; }
            if overlaps(s.note, k.note) { shared += w; } else { w *= 0.2; }
            sum += w * s.residual;
            weight += w;
        }
        if shared > 0. {
            let db = (0.9 * shared / weight * (k.residual - sum / weight)).clamp(-LIMIT_DB, LIMIT_DB);
            strikes[i].gain = 10_f64.powf(db / 10.);
        }
    }
    // Share the available loudness between the sounding keys. Raising every
    // strong partial without this step also makes the whole chord louder.
    bounds = (0, 0);
    let mut changed = false;
    for k in &strikes {
        let (mut before, mut after) = (0., 0.);
        for s in neighbors(&strikes, k, &mut bounds) {
            if s.section != k.section || !overlaps(s.note, k.note) { continue; }
            let energy = s.energy * (1. - (s.note.start - k.note.start).abs() / (NEAR + 0.01));
            before += energy;
            after += energy * s.gain;
        }
        if after == 0. || before * k.gain == after { continue; }
        let touch = (before * k.gain / after).powf(0.4)
            .clamp(10_f64.powf(-LIMIT_DB / 25.), 10_f64.powf(LIMIT_DB / 25.));
        let velocity = (f64::from(k.note.velocity) * touch).round().clamp(1., 127.) as u8;
        changed |= velocity != k.note.velocity;
        midi.instruments[k.hand].notes[k.index].velocity = velocity;
    }
    changed
}

fn overlaps(a: Note, b: Note) -> bool { a.start < b.end && b.start < a.end }

fn neighbors<'a>(strikes: &'a [Strike], k: &Strike, (first, last): &mut (usize, usize)) -> &'a [Strike] {
    while strikes[*first].note.start < k.note.start - NEAR { *first += 1; }
    while *last < strikes.len() && strikes[*last].note.start <= k.note.start + NEAR { *last += 1; }
    &strikes[*first..*last]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pmidi::Instrument;

    #[test]
    fn recorded_balance_reverses_an_accent_without_touching_measured_piano_or_a_lone_key() {
        let mut m = PrettyMidi::new(960, 120.);
        let mut right = Instrument::new(0, false, "Right");
        let mut left = Instrument::new(0, false, "Left");
        for start in [0.2, 0.8, 1.4, 2.] {
            let n = Note { pitch: 67, velocity: 64, start, end: start + 0.25 };
            right.notes.push(n);
            if start != 2. { left.notes.push(Note { pitch: 52, ..n }); }
        }
        m.instruments.extend([right, left]);
        let wave: Vec<_> = (0..(2.5 * RATE) as usize).map(|i| {
            let t = i as f64 / RATE;
            let (lo, hi) = if t < 0.7 { (0.5, 0.01) } else { (0.01, 0.5) };
            let phase = std::f64::consts::TAU * t;
            (lo * (phase * 164.814).sin() + hi * (phase * 391.995).sin()) as f32
        }).collect();
        assert!(balance(&mut m, &wave, &[(1.3, 1.8)]));
        let (r, l) = (&m.instruments[0].notes, &m.instruments[1].notes);
        assert!(l[0].velocity > 64 && r[0].velocity < 64);
        assert!(l[1].velocity < 64 && r[1].velocity > 64);
        assert_eq!((r[2].velocity, l[2].velocity, r[3].velocity), (64, 64, 64));
    }
}

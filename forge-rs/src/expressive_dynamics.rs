//! Match phrase contrast, not drum hits or the absolute mastering level.
use crate::pmidi::PrettyMidi;

// Half-second bins on the separator clock. A triangular window prevents one
// loud attack from accenting an entire chord or making adjacent notes pump.
fn smoothed(bins: &[f64], i: usize) -> f64 {
    let end = bins.len() - 1;
    (bins[i.saturating_sub(2)] + 2.0 * bins[i.saturating_sub(1)] + 3.0 * bins[i]
        + 2.0 * bins[(i + 1).min(end)] + bins[(i + 2).min(end)]) / 9.0
}

pub(super) fn shape(midi: &mut PrettyMidi, source: &[f64], piano: &[(f64, f64)]) {
    let measured_piano = |t: f64| piano.get(piano.partition_point(|&(_, end)| end <= t))
        .is_some_and(|&(start, _)| start <= t);
    if source.len() < 8 || !midi.instruments.iter().flat_map(|t| &t.notes).any(|n| !measured_piano(n.start)) {
        return;
    }
    // Estimate the relative power of the *written arrangement*: a full chord
    // naturally plays louder than a single key, even at identical velocity.
    // Integrate a decaying piano key into each half-second it occupies.
    let mut score = vec![0.0; source.len()];
    for n in midi.instruments.iter().flat_map(|t| &t.notes) {
        let end = (n.end + 0.08).min(n.start + 5.0);
        let first = (n.start * 2.0) as usize;
        let last = ((end * 2.0).ceil() as usize).min(score.len());
        if first >= last { continue; }
        let velocity = f64::from(n.velocity);
        let power = velocity * velocity * velocity.sqrt();
        let mut attack = 1.0;
        for (j, bin) in score[first..last].iter_mut().enumerate() {
            let elapsed = (0.5 * (first + j + 1) as f64).min(end) - n.start;
            let decay = (-2.0 * elapsed).exp();
            *bin += power * (attack - decay);
            attack = decay;
        }
    }
    let levels: Vec<_> = (0..source.len()).map(|i| (smoothed(source, i), smoothed(&score, i))).collect();
    let (smax, pmax) = levels.iter().fold((0.0_f64, 0.0_f64), |(s, p), &(a, b)| (s.max(a), p.max(b)));
    // Calibrate typical loudness only where both the recording and the score
    // are audible. Mastering gain then cancels; long rests do not set the gain.
    score.clear();
    for (i, &(s, p)) in levels.iter().enumerate() {
        if s > 0.001 * smax && p > 0.006 * pmax && !measured_piano((i as f64 + 0.5) * 0.5) {
            score.push(s / p);
        }
    }
    if score.len() < 4 { return; }
    let mid = score.len() / 2;
    let anchor = *score.select_nth_unstable_by(mid, f64::total_cmp).1;
    score.clear();
    for (s, p) in levels {
        // A missing voice isn't a reason to hammer the remaining keys. The
        // bound is in rendered dB; the sampler maps velocity to gain with ^1.25.
        let ratio = (s / (p.max(pmax * 1e-9) * anchor)).max(1e-9);
        let gain_db = (0.65 * 10.0 * ratio.log10()).clamp(-8.0, 5.0);
        score.push(10.0_f64.powf(gain_db / 25.0));
    }
    for n in midi.instruments.iter_mut().flat_map(|t| &mut t.notes) {
        if measured_piano(n.start) { continue; } // retain measured keystroke velocity
        let at = (2.0 * n.start - 0.5).clamp(0.0, (score.len() - 1) as f64);
        let i = at as usize;
        let gain = score[i] + at.fract() * (score[(i + 1).min(score.len() - 1)] - score[i]);
        n.velocity = (f64::from(n.velocity) * gain).round().clamp(1.0, 127.0) as u8;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pmidi::{Instrument, Note};

    #[test]
    fn crescendo_follows_the_recording_not_its_master_gain_or_piano_keystrokes() {
        fn velocities(scale: f64) -> Vec<u8> {
            let mut m = PrettyMidi::new(960, 120.);
            let mut hand = Instrument::new(0, false, "Hand");
            for i in 0..30 {
                let start = i as f64 / 2.;
                hand.notes.push(Note { pitch: 70, velocity: 70, start, end: start + 0.25 });
            }
            m.instruments.push(hand);
            let source: Vec<_> = (0..30).map(|i| scale * if i < 12 { 0.1 } else { 1.0 }).collect();
            shape(&mut m, &source, &[(12., 15.)]);
            m.instruments[0].notes.iter().map(|n| n.velocity).collect()
        }
        let v = velocities(1.);
        assert_eq!(v, velocities(0.01));
        assert!(v[3] + 15 < v[18]);
        assert!(v[24..].iter().all(|&v| v == 70));
    }
}

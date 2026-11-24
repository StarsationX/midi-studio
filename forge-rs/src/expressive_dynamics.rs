//! Match phrase contrast, not drum hits or the absolute mastering level.
use crate::pmidi::PrettyMidi;

#[derive(Clone, Copy, Default)]
pub(super) struct Power {
    pub(super) total: f64,
    low: f64,
}

impl Power {
    // On the 44.1 kHz separator clock a 128-sample average is 3 dB down
    // near 153 Hz. Measure the low band without another FFT or sample buffer.
    pub(super) fn add_stem(&mut self, samples: &[f32]) -> f64 {
        let mut total = 0.;
        let mut low = 0.;
        for block in samples.chunks(128) {
            let mut sum = 0.;
            for &x in block {
                let x = f64::from(x);
                total += x * x;
                sum += x;
            }
            low += sum * sum / block.len() as f64;
        }
        self.total += total / samples.len() as f64;
        self.low += low / samples.len() as f64;
        total
    }

    fn smooth(self, before: Self, after: Self) -> Self {
        Self {
            total: (before.total + 2. * self.total + after.total) * 0.25,
            low: (before.low + 2. * self.low + after.low) * 0.25,
        }
    }

    fn low_share(self) -> f64 {
        (self.low / self.total.max(f64::MIN_POSITIVE)).clamp(0.01, 0.98)
    }

    fn balance(self) -> f64 {
        let share = self.low_share();
        share / (1. - share)
    }
}

// A bass key contributes to both bands through its overtones. Keys above
// this crossover have little energy below it, regardless of hand assignment.
fn low_weight(pitch: u8) -> f64 {
    f64::from(63_u8.saturating_sub(pitch).min(24)) / 24.
}

pub(super) fn shape(midi: &mut PrettyMidi, source: &[Power], piano: &[(f64, f64)]) {
    let measured_piano = |t: f64| piano.get(piano.partition_point(|&(_, end)| end <= t))
        .is_some_and(|&(start, _)| start <= t);
    if source.len() < 8 || !midi.instruments.iter().flat_map(|t| &t.notes).any(|n| !measured_piano(n.start)) {
        return;
    }
    // Estimate the relative power of the *written arrangement*: a full chord
    // naturally plays louder than a single key, even at identical velocity.
    // Integrate a decaying piano key into each half-second it occupies.
    let mut bins: Vec<_> = source.iter().map(|&s| (s, Power::default())).collect();
    for n in midi.instruments.iter().flat_map(|t| &t.notes) {
        let end = (n.end + 0.08).min(n.start + 5.0);
        let first = (n.start * 2.0) as usize;
        let last = ((end * 2.0).ceil() as usize).min(bins.len());
        if first >= last { continue; }
        let velocity = f64::from(n.velocity);
        // A high piano string dies away faster than a bass string. Integrate
        // exp(-rate * t), so a held treble key isn't mistaken for a loud chord.
        let rate = 2. + 0.3 * f64::from(n.pitch.saturating_sub(60).min(20));
        let power = velocity * velocity * velocity.sqrt() / rate;
        let low = power * low_weight(n.pitch);
        let mut attack = 1.0;
        for (j, (_, written)) in bins[first..last].iter_mut().enumerate() {
            let elapsed = (0.5 * (first + j + 1) as f64).min(end) - n.start;
            let decay = (-rate * elapsed).exp();
            written.total += power * (attack - decay);
            written.low += low * (attack - decay);
            attack = decay;
        }
    }
    // Smooth one half-second either side. Longer windows blur short accents.
    let mut before = bins[0];
    let mut peak = (Power::default(), Power::default());
    for i in 0..bins.len() {
        let (s, p) = bins[i];
        let after = bins[(i + 1).min(bins.len() - 1)];
        bins[i] = (s.smooth(before.0, after.0), p.smooth(before.1, after.1));
        before = (s, p);
        let (s, p) = bins[i];
        peak.0.total = peak.0.total.max(s.total);
        peak.0.low = peak.0.low.max(s.low);
        peak.1.total = peak.1.total.max(p.total);
        peak.1.low = peak.1.low.max(p.low);
    }
    // Anchor relative gains only where both the recording and the written
    // notes are audible. Rests and solo piano must not set the band's level.
    let audible = |i: usize, s: Power, p: Power| s.total > 0.001 * peak.0.total
        && p.total > 0.006 * peak.1.total && !measured_piano((i as f64 + 0.5) * 0.5);
    let mut ratios = Vec::with_capacity(bins.len());
    for (i, &(s, p)) in bins.iter().enumerate() {
        if audible(i, s, p) { ratios.push(s.total / p.total); }
    }
    let median = |v: &mut [f64]| *v.select_nth_unstable_by(v.len() / 2, f64::total_cmp).1;
    if ratios.len() < 4 { return; }
    let anchor = median(&mut ratios);
    ratios.clear();
    for (i, &(s, p)) in bins.iter().enumerate() {
        if audible(i, s, p) && s.low > 0.005 * peak.0.low && p.low > 0.006 * peak.1.low {
            ratios.push(s.balance() / p.balance());
        }
    }
    let balance_anchor = (ratios.len() >= 8).then(|| median(&mut ratios));
    let gains: Vec<_> = bins.into_iter().map(|(s, p)| {
        let ratio = s.total / (p.total.max(peak.1.total * 1e-9) * anchor);
        let volume = (8.5 * ratio.max(1e-9).log10()).clamp(-8., 5.);
        let tilt = balance_anchor.map_or(0., |base| {
            let confidence = (p.low / (peak.1.low * 0.01)).min(1.);
            (6.5 * (s.balance() / (p.balance() * base)).log10()).clamp(-5., 5.) * confidence
        });
        // Redistribute energy between registers rather than turning both up.
        let gain = if tilt == 0. { volume } else {
            volume - 10. * (1. + p.low_share() * (10_f64.powf(tilt / 10.) - 1.)).log10()
        };
        (gain, tilt)
    }).collect();
    for n in midi.instruments.iter_mut().flat_map(|t| &mut t.notes) {
        if measured_piano(n.start) { continue; } // retain measured keystroke velocity
        let at = (2.0 * n.start - 0.5).clamp(0.0, (gains.len() - 1) as f64);
        let i = at as usize;
        let weight = low_weight(n.pitch);
        let level = |(gain, tilt): (f64, f64)| gain + weight * tilt;
        let left = level(gains[i]);
        let db = left + at.fract() * (level(gains[(i + 1).min(gains.len() - 1)]) - left);
        n.velocity = (f64::from(n.velocity) * 10_f64.powf(db / 25.)).round().clamp(1.0, 127.0) as u8;
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
            let source: Vec<_> = (0..30).map(|i| Power {
                total: scale * if i < 12 { 0.1 } else { 1.0 }, low: 0.,
            }).collect();
            shape(&mut m, &source, &[(12., 15.)]);
            m.instruments[0].notes.iter().map(|n| n.velocity).collect()
        }
        let v = velocities(1.);
        assert_eq!(v, velocities(0.01));
        assert!(v[3] + 15 < v[18]);
        assert!(v[24..].iter().all(|&v| v == 70));
    }

    #[test]
    fn equal_loudness_bass_and_treble_phrases_shift_touch_between_keys() {
        let power = |hz: f64| {
            let wave: Vec<_> = (0..22050).map(|i|
                (std::f64::consts::TAU * hz * f64::from(i) / 44100.).sin() as f32
            ).collect();
            let mut p = Power::default();
            p.add_stem(&wave);
            p
        };
        let mut midi = PrettyMidi::new(960, 120.);
        let mut keys = Instrument::new(0, false, "Duet");
        let mut phrases = [power(82.); 24];
        phrases[12..].fill(power(880.));
        for i in 0..24 {
            let start = i as f64 * 0.5;
            for pitch in [42, 78] {
                keys.notes.push(Note { pitch, start, end: start + 0.35, velocity: 70 });
            }
        }
        midi.instruments.push(keys);
        shape(&mut midi, &phrases, &[]);
        let n = &midi.instruments[0].notes;
        assert!(n[10].velocity > n[34].velocity); // bass steps back
        assert!(n[11].velocity < n[35].velocity); // treble comes forward
    }
}

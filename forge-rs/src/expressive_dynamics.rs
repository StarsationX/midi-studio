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
            total: (before.total + 4. * self.total + after.total) / 6.,
            low: (before.low + 4. * self.low + after.low) / 6.,
        }
    }

    // Deep bass is balanced separately. Don't treat a louder bass fundamental
    // as an equally large increase in the rest of the arrangement.
    fn phrase_power(self) -> f64 { self.total - 0.65 * self.low }

    fn low_share(self) -> f64 {
        (self.low / self.total.max(f64::MIN_POSITIVE)).clamp(0.01, 0.98)
    }

    fn balance(self) -> f64 {
        let share = self.low_share();
        share / (1. - share)
    }
}

// Bundled Grand Piano, MIDI 21..108: relative attack power, power decay
// per second, and low-band energy fraction. Generated from the samples by
// tools/calibrate_medley_piano.py; no soundfont decoding in the exporter.
const GRAND_PIANO: [(f64, f64, f64); 88] = [
    (1.196, 0.4, 0.723), (1.183, 0.4, 0.721), (1.157, 0.4, 0.708), (1.130, 0.4, 0.671), (1.170, 0.5, 0.673), (1.248, 0.7, 0.646),
    (1.246, 0.7, 0.622), (1.254, 0.7, 0.636), (1.233, 0.7, 0.612), (1.253, 0.8, 0.615), (0.688, 1.5, 0.501), (0.685, 1.6, 0.466),
    (0.684, 1.7, 0.438), (0.666, 1.7, 0.437), (0.915, 1.8, 0.568), (0.904, 1.9, 0.565), (0.902, 2.0, 0.550), (0.915, 2.2, 0.542),
    (0.907, 2.3, 0.542), (1.726, 1.5, 0.709), (1.752, 1.6, 0.671), (1.810, 1.8, 0.689), (1.939, 2.0, 0.603), (2.028, 2.3, 0.586),
    (2.021, 2.4, 0.561), (2.042, 2.6, 0.545), (1.392, 2.1, 0.252), (1.429, 2.3, 0.251), (1.417, 2.4, 0.218), (1.403, 2.5, 0.186),
    (1.384, 2.6, 0.177), (1.669, 1.6, 0.218), (1.615, 1.6, 0.154), (1.659, 1.8, 0.173), (1.034, 2.4, 0.213), (1.044, 2.6, 0.175),
    (1.022, 2.7, 0.173), (1.028, 2.9, 0.147), (0.946, 1.8, 0.098), (0.952, 1.9, 0.083), (0.946, 2.0, 0.074), (0.961, 2.2, 0.039),
    (0.955, 2.3, 0.025), (0.382, 4.4, 0.043), (0.384, 4.7, 0.043), (0.376, 4.9, 0.038), (1.787, 2.7, 0.019), (1.802, 2.9, 0.022),
    (1.812, 3.1, 0.042), (1.849, 3.4, 0.051), (0.706, 6.9, 0.053), (0.679, 7.2, 0.047), (0.671, 7.6, 0.053), (0.684, 8.1, 0.045),
    (0.673, 8.5, 0.029), (1.010, 13.7, 0.013), (1.019, 14.4, 0.017), (0.990, 15.0, 0.013), (0.791, 15.2, 0.035), (0.774, 15.9, 0.031),
    (0.700, 15.7, 0.034), (0.675, 16.2, 0.022), (0.603, 15.9, 0.023), (0.584, 16.3, 0.017), (0.565, 16.9, 0.028), (2.629, 17.1, 0.012),
    (2.625, 18.2, 0.009), (2.549, 19.0, 0.006), (2.534, 20.1, 0.005), (2.539, 21.5, 0.008), (2.250, 16.0, 0.006), (2.271, 17.3, 0.003),
    (2.234, 18.0, 0.002), (2.233, 19.3, 0.006), (0.154, 23.9, 0.009), (0.146, 23.9, 0.007), (0.136, 23.9, 0.011), (0.121, 23.9, 0.010),
    (0.111, 23.9, 0.010), (0.105, 23.9, 0.008), (0.089, 23.9, 0.007), (0.082, 23.9, 0.005), (0.071, 23.9, 0.004), (0.065, 23.9, 0.004),
    (0.294, 23.9, 0.002), (0.266, 23.9, 0.001), (0.240, 23.9, 0.001), (0.213, 23.9, 0.001),
];

fn key_response(pitch: u8) -> (f64, f64, f64) {
    GRAND_PIANO[usize::from(pitch.clamp(21, 108) - 21)]
}

// Even a low piano string radiates overtones; its maximum measured
// low-band fraction is about two thirds, not one.
fn bass_touch(low_share: f64) -> f64 { (low_share / 0.65).min(1.) }

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
        // Energy-equivalent release of the sampled piano's fading envelope.
        let end = (n.end + 0.035).min(n.start + 5.0);
        let first = (n.start * 2.0) as usize;
        let last = ((end * 2.0).ceil() as usize).min(bins.len());
        if first >= last { continue; }
        let velocity = f64::from(n.velocity);
        // A high piano string dies away faster than a bass string. Integrate
        // exp(-rate * t), so a held treble key isn't mistaken for a loud chord.
        let (level, rate, low_share) = key_response(n.pitch);
        let power = velocity * velocity * velocity.sqrt() * level / rate;
        let low = power * low_share;
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
        if audible(i, s, p) { ratios.push(s.phrase_power() / p.phrase_power()); }
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
    ratios.clear();
    // A swelling bass should be allowed to get louder even when the energy
    // above the bass falls. Use broadband power as the bass key's reference.
    ratios.extend(bins.iter().enumerate().filter(|&(i, &(s, p))| audible(i, s, p))
        .map(|(_, &(s, p))| s.total / p.total));
    let broadband_anchor = median(&mut ratios);
    let gains: Vec<_> = bins.into_iter().map(|(s, p)| {
        let level_db = |ratio: f64| (8.5 * ratio.max(1e-9).log10()).clamp(-8., 5.);
        let floor = peak.1.total * 1e-9;
        let volume = level_db(s.phrase_power() / (p.phrase_power().max(floor) * anchor));
        let bass_volume = level_db(s.total / (p.total.max(floor) * broadband_anchor));
        let tilt = balance_anchor.map_or(0., |base| {
            let confidence = (p.low / (peak.1.low * 0.01)).min(1.);
            (9. * (s.balance() / (p.balance() * base)).log10()).clamp(-7., 7.) * confidence
        });
        // Redistribute energy between registers rather than turning both up.
        let gain = if tilt == 0. { volume } else {
            volume - 10. * (1. + bass_touch(p.low_share()) * (10_f64.powf(tilt / 10.) - 1.)).log10()
        };
        (gain, tilt + bass_volume - volume)
    }).collect();
    for n in midi.instruments.iter_mut().flat_map(|t| &mut t.notes) {
        if measured_piano(n.start) { continue; } // retain measured keystroke velocity
        let (_, rate, low_share) = key_response(n.pitch);
        let span = (n.end - n.start + 0.035).min(5.);
        // Energy centroid of exp(-rate*t) over the sounding part of the key:
        // its strike sets the level of the whole note, not just the onset bin.
        let center = 1. / rate - span / (rate * span).exp_m1();
        let at = (2.0 * (n.start + center) - 0.5).clamp(0.0, (gains.len() - 1) as f64);
        let i = at as usize;
        let weight = bass_touch(low_share);
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
    fn a_quieter_piano_key_does_not_make_an_even_phrase_disappear() {
        let mut midi = PrettyMidi::new(960, 120.);
        let mut hand = Instrument::new(0, false, "Melody");
        for i in 0..24 {
            let start = f64::from(i) * 0.5;
            hand.notes.push(Note { pitch: if i < 12 { 66 } else { 69 }, velocity: 70,
                start, end: start + 0.3 });
        }
        midi.instruments.push(hand);
        let source = [Power { total: 1., low: 0.03 }; 24];
        shape(&mut midi, &source, &[]);
        let notes = &midi.instruments[0].notes;
        // The bundled F#4 is much quieter than A4 at the same MIDI velocity.
        assert!(notes[4].velocity > notes[16].velocity + 10);
    }

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

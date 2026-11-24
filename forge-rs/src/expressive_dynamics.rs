//! Match phrase contrast, not drum hits or the absolute mastering level.
use crate::pmidi::PrettyMidi;
#[path = "medley_key_response.rs"]
mod response;
#[path = "expressive_salience.rs"]
pub(super) mod salience;
use response::KeyResponse;

// Must divide the 44.1 kHz separator clock and nest inside half-second
// piano-passage windows without rounding.
pub(super) const WINDOWS_PER_SECOND: usize = 20;

#[derive(Clone, Copy, Default)]
pub(super) struct Power {
    pub(super) total: f64,
    low: f64,
    mid: f64,
}

impl Power {
    // Nested block means on the 44.1 kHz separator clock. The 128-sample
    // mean measures bass; variation between 8-sample means inside a
    // 64-sample block emphasizes the middle register, not hiss or sub-bass.
    pub(super) fn add_stem(&mut self, samples: &[f32]) -> f64 {
        let mut total = 0.;
        let mut low = 0.;
        let mut mid = 0.;
        for block in samples.chunks(128) {
            let mut sum = 0.;
            for group in block.chunks(64) {
                let mut group_sum = 0.;
                for short in group.chunks(8) {
                    let mut short_sum = 0.;
                    for &x in short {
                        let x = f64::from(x);
                        total += x * x;
                        short_sum += x;
                    }
                    mid += short_sum * short_sum / short.len() as f64;
                    group_sum += short_sum;
                }
                mid -= group_sum * group_sum / group.len() as f64;
                sum += group_sum;
            }
            low += sum * sum / block.len() as f64;
        }
        self.total += total / samples.len() as f64;
        self.low += low / samples.len() as f64;
        self.mid += mid.max(0.) / samples.len() as f64;
        total
    }

    fn smooth(self, before: Self, after: Self) -> Self {
        Self {
            total: (before.total + 4. * self.total + after.total) / 6.,
            low: (before.low + 4. * self.low + after.low) / 6.,
            mid: (before.mid + 4. * self.mid + after.mid) / 6.,
        }
    }

    // Let the melody follow the middle register, with some broadband
    // context: a sparse, very high line still belongs in the arrangement.
    fn melody_power(self) -> f64 { 0.75 * self.mid + 0.25 * self.phrase_power() }

    fn phrase_power(self) -> f64 { self.total - 0.65 * self.low }

    fn low_share(self) -> f64 {
        (self.low / self.total.max(f64::MIN_POSITIVE)).clamp(0.01, 0.98)
    }

    fn balance(self) -> f64 {
        self.low_share() / (self.melody_power() / self.total.max(f64::MIN_POSITIVE)).clamp(0.01, 1.)
    }
}

// Even a low piano string radiates overtones; its maximum measured
// low-band fraction is about two thirds, not one.
fn bass_touch(low_share: f64) -> f64 { (low_share / 0.65).min(1.) }

pub(super) fn shape(midi: &mut PrettyMidi, source: &[Power], piano: &[(f64, f64)], mix: &[f32]) {
    let measured_piano = |t: f64| piano.get(piano.partition_point(|&(_, end)| end <= t))
        .is_some_and(|&(start, _)| start <= t);
    if source.len() < 4 * WINDOWS_PER_SECOND || !midi.instruments.iter().flat_map(|t| &t.notes).any(|n| !measured_piano(n.start)) {
        return;
    }
    let mut fit = Fit::default();
    if !shape_at(midi, source.iter().copied(), WINDOWS_PER_SECOND, &measured_piano, None, &mut fit) { return; }
    let rebalanced = salience::balance(midi, mix, piano);
    // Recompute what the voices sound like together after the melody accent.
    // Only a bounded correction may bring the wider mix back into balance.
    let residual = Some(if rebalanced { (0.95, 5.) } else { (0.65, 3.) });
    shape_at(midi, source.iter().copied(), WINDOWS_PER_SECOND, &measured_piano, residual, &mut fit);
    // A note can have only one velocity. After fitting the accents, correct
    // leftover phrase drift without flattening their differences.
    let average = |chunk: &[Power]| {
        let mut p = Power::default();
        for s in chunk { p.total += s.total; p.low += s.low; p.mid += s.mid; }
        p.total /= chunk.len() as f64;
        p.low /= chunk.len() as f64;
        p.mid /= chunk.len() as f64;
        p
    };
    if rebalanced {
        // Bring back short accents without undoing the new chord balance.
        let hz = 10;
        shape_at(midi, source.chunks(WINDOWS_PER_SECOND / hz).map(average), hz, &measured_piano, residual, &mut fit);
    }
    shape_at(midi, source.chunks(WINDOWS_PER_SECOND / 2).map(average), 2, &measured_piano, residual, &mut fit);
}

#[derive(Default)]
struct Fit {
    bins: Vec<(Power, Power)>,
    ratios: Vec<f64>,
    gains: Vec<(f64, f64)>,
}

fn shape_at(midi: &mut PrettyMidi, source: impl ExactSizeIterator<Item = Power>, per_second: usize,
    measured_piano: &impl Fn(f64) -> bool, residual: Option<(f64, f64)>, fit: &mut Fit) -> bool {
    let hz = per_second as f64;
    // Estimate the relative power of the *written arrangement*: a full chord
    // naturally plays louder than a single key, even at identical velocity.
    // Integrate each decaying piano key into the windows where it can be heard.
    let Fit { bins, ratios, gains } = fit;
    bins.clear();
    bins.extend(source.map(|s| (s, Power::default())));
    for n in midi.instruments.iter().flat_map(|t| &t.notes) {
        let key = KeyResponse::new(n.pitch, n.velocity, n.end - n.start);
        let end = n.start + key.end();
        let first = (n.start * hz) as usize;
        let last = ((end * hz).ceil() as usize).min(bins.len());
        if first >= last { continue; }
        let velocity = f64::from(n.velocity);
        let gain = velocity * velocity * velocity.sqrt();
        let mut previous = (0., 0., 0.);
        for (j, (_, written)) in bins[first..last].iter_mut().enumerate() {
            let elapsed = ((first + j + 1) as f64 / hz).min(end) - n.start;
            let energy = key.at(elapsed);
            written.total += gain * (energy.0 - previous.0);
            written.low += gain * (energy.1 - previous.1);
            written.mid += gain * (energy.2 - previous.2);
            previous = energy;
        }
    }
    // Smooth adjacent windows, not entire beats: an offbeat can be much quieter.
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
        && p.total > 0.006 * peak.1.total && !measured_piano((i as f64 + 0.5) / hz);
    // Fit a melody accent to its register. For the bounded follow-up,
    // reference the wider mix so an entire phrase doesn't drift in volume.
    let loudness = |p: Power| if residual.is_some() { p.phrase_power() } else { p.melody_power() };
    ratios.clear();
    ratios.reserve(bins.len());
    for (i, &(s, p)) in bins.iter().enumerate() {
        if audible(i, s, p) { ratios.push(loudness(s) / loudness(p)); }
    }
    let median = |v: &mut [f64]| *v.select_nth_unstable_by(v.len() / 2, f64::total_cmp).1;
    if ratios.len() < 2 * per_second { return false; }
    let anchor = median(ratios);
    ratios.clear();
    for (i, &(s, p)) in bins.iter().enumerate() {
        if audible(i, s, p) && s.low > 0.005 * peak.0.low && p.low > 0.006 * peak.1.low {
            ratios.push(s.balance() / p.balance());
        }
    }
    let balance_anchor = (ratios.len() >= 4 * per_second).then(|| median(ratios));
    ratios.clear();
    // A swelling bass should be allowed to get louder even when the energy
    // above the bass falls. Use broadband power as the bass key's reference.
    ratios.extend(bins.iter().enumerate().filter(|&(i, &(s, p))| audible(i, s, p))
        .map(|(_, &(s, p))| s.total / p.total));
    let broadband_anchor = median(ratios);
    gains.clear();
    gains.extend(bins.iter().map(|&(s, p)| {
        let level_db = |ratio: f64| (10. * ratio.max(1e-9).log10()).clamp(-9., 6.);
        let floor = peak.1.total * 1e-9;
        let volume = level_db(loudness(s) / (loudness(p).max(floor) * anchor));
        if per_second == 10 { return (volume, 0.); }
        let bass_volume = level_db(s.total / (p.total.max(floor) * broadband_anchor));
        let tilt = balance_anchor.map_or(0., |base| {
            let confidence = (p.low / (peak.1.low * 0.01)).min(1.);
            (10. * (s.balance() / (p.balance() * base)).log10()).clamp(-8., 8.) * confidence
        });
        // Redistribute energy between registers rather than turning both up.
        let gain = if tilt == 0. { volume } else {
            volume - 10. * (1. + bass_touch(p.low_share()) * (10_f64.powf(tilt / 10.) - 1.)).log10()
        };
        (gain, tilt + bass_volume - volume)
    }));
    for n in midi.instruments.iter_mut().flat_map(|t| &mut t.notes) {
        if measured_piano(n.start) { continue; } // retain measured keystroke velocity
        let key = KeyResponse::new(n.pitch, n.velocity, n.end - n.start);
        let (total, low, _) = key.at(key.end());
        // A held note has only one velocity. Sample early, middle and late
        // thirds of its *energy*, not three equally spaced times: the tail of
        // a fast-decaying key shouldn't inherit the accent of the next note.
        let weight = bass_touch(low / total);
        let level = |(gain, tilt): (f64, f64)| gain + weight * tilt;
        let sample = |quantile: f64| {
            let time = n.start + key.quantile(total, quantile);
            let at = (hz * time - 0.5).clamp(0., (gains.len() - 1) as f64);
            let i = at as usize;
            let left = level(gains[i]);
            left + at.fract() * (level(gains[(i + 1).min(gains.len() - 1)]) - left)
        };
        let db = (sample(1. / 6.) + sample(0.5) + sample(5. / 6.)) / 3.;
        let db = residual.map_or(db, |(strength, bound)| (strength * db).clamp(-bound, bound));
        n.velocity = (f64::from(n.velocity) * 10_f64.powf(db / 25.)).round().clamp(1.0, 127.0) as u8;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pmidi::{Instrument, Note};

    #[test]
    fn neighboring_strikes_keep_an_accent_within_one_beat() {
        let mut midi = PrettyMidi::new(960, 120.);
        let mut keys = Instrument::new(0, false, "Melody");
        for i in 0..32 {
            let start = f64::from(i) * 0.25 + 0.015;
            keys.notes.push(Note { pitch: 69, velocity: 70, start, end: start + 0.13 });
        }
        midi.instruments.push(keys);
        // Every beat has the same mean energy; only the offbeat is accented.
        let source: Vec<_> = (0..8 * WINDOWS_PER_SECOND).map(|i| {
            let t = (i as f64 + 0.5) / WINDOWS_PER_SECOND as f64;
            let total = if t % 0.5 >= 0.25 { 1. } else { 0.12 };
            Power { total, low: 0.03 * total, mid: 0.7 * total }
        }).collect();
        shape(&mut midi, &source, &[], &[]);
        for pair in midi.instruments[0].notes[4..28].chunks_exact(2) {
            assert!(pair[1].velocity > pair[0].velocity + 10);
        }
    }

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
        let source = [Power { total: 1., low: 0.03, mid: 0.7 }; 12 * WINDOWS_PER_SECOND];
        shape(&mut midi, &source, &[], &[]);
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
            let source: Vec<_> = (0..15 * WINDOWS_PER_SECOND).map(|i| {
                let total = scale * if i < 6 * WINDOWS_PER_SECOND { 0.1 } else { 1.0 };
                Power { total, low: 0., mid: 0.7 * total }
            }).collect();
            shape(&mut m, &source, &[(12., 15.)], &[]);
            m.instruments[0].notes.iter().map(|n| n.velocity).collect()
        }
        let v = velocities(1.);
        assert_eq!(v, velocities(0.01));
        assert!(v[3] + 15 < v[18]);
        assert!(v[24..].iter().all(|&v| v == 70));
    }

    #[test]
    fn a_bright_wash_does_not_accent_the_melody_like_a_pitched_phrase() {
        let tone = |period: usize| {
            let wave: Vec<_> = (0..2048).map(|i| (std::f32::consts::TAU * (i % period) as f32 / period as f32).sin()).collect();
            let mut power = Power::default();
            power.add_stem(&wave);
            power
        };
        // These signals have equal broadband power and zero mean in every
        // bass window. Only the first has energy in the piano melody band.
        let mut source = [tone(64); 12 * WINDOWS_PER_SECOND];
        source[6 * WINDOWS_PER_SECOND..].fill(tone(4));
        let mut midi = PrettyMidi::new(960, 120.);
        let mut hand = Instrument::new(0, false, "Melody");
        for i in 0..24 {
            let start = f64::from(i) * 0.5;
            hand.notes.push(Note { start, end: start + 0.35, pitch: 72, velocity: 75 });
        }
        midi.instruments.push(hand);
        shape(&mut midi, &source, &[], &[]);
        let keys = &midi.instruments[0].notes;
        assert!(keys[5].velocity > keys[17].velocity);
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
        let mut phrases = [power(82.); 12 * WINDOWS_PER_SECOND];
        phrases[6 * WINDOWS_PER_SECOND..].fill(power(880.));
        for i in 0..24 {
            let start = i as f64 * 0.5;
            for pitch in [42, 78] {
                keys.notes.push(Note { pitch, start, end: start + 0.35, velocity: 70 });
            }
        }
        midi.instruments.push(keys);
        shape(&mut midi, &phrases, &[], &[]);
        let n = &midi.instruments[0].notes;
        assert!(n[10].velocity > n[34].velocity); // bass steps back
        assert!(n[11].velocity < n[35].velocity); // treble comes forward
    }
}

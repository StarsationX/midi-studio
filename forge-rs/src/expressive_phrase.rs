//! Fit the loudness of a chord without assigning the chord's full power to
//! each key. A held key contributes only the energy it emits in each window.
use super::{Fit, Key, EPS, NONE, PHRASE};
use super::super::super::{response::KeyResponse, Power, WINDOWS_PER_SECOND};

impl Fit {
    pub(super) fn phrases(&mut self, keys: &[Key], source: &[Power], piano: &[(f64, f64)]) {
        if source.is_empty() { return; }
        let curves: Vec<_> = keys.iter().map(|k|
            KeyResponse::matched(k.note.pitch, k.note.velocity, k.note.end - k.note.start)
        ).collect();
        let mut active = Vec::<usize>::new();
        // One pair of response lookups per ringing key, shared by all three
        // measurements. Reuse the storage for every window of the recording.
        let mut terms = Vec::new();
        let hz = WINDOWS_PER_SECOND as f64;
        // The short window follows an accent; the longer window keeps that
        // accent from pulling a whole phrase away from its recorded level.
        // Give register balance more time than overall loudness: a single
        // accented syllable needn't pull the bass out of the next chord.
        let windows = [(2, 14850., 675.), (10, 37125., 7500.)];
        for (group, (stride, level_weight, balance_weight)) in windows.into_iter().enumerate() {
            active.clear();
            let (mut next, mut passage) = (0, 0);
            for (i, chunk) in source.chunks(stride).enumerate() {
                let start = (i * stride) as f64 / hz;
                let end = (i * stride + chunk.len()) as f64 / hz;
                while passage < piano.len() && piano[passage].1 <= start { passage += 1; }
                if piano.get(passage).is_some_and(|p| p.0 < end) { continue; }
                active.retain(|&j| keys[j].note.start + curves[j].end() > start);
                while next < keys.len() && keys[next].note.start < end {
                    if keys[next].note.start + curves[next].end() > start { active.push(next); }
                    next += 1;
                }
                if active.is_empty() { continue; }
                let mut source_power = [0.; 3];
                for p in chunk {
                    source_power[0] += p.total;
                    source_power[1] += p.low;
                    source_power[2] += p.mid;
                }
                let [level, bass, middle] = source_power.map(|v| (v / hz) as f32);
                if level <= EPS { continue; }
                terms.clear();
                let mut low_power = 0.;
                for &j in &active {
                    let onset = keys[j].note.start;
                    let (a, lo_a, mid_a) = curves[j].at(start - onset);
                    let (b, lo_b, mid_b) = curves[j].at(end - onset);
                    let bands = [b - a, lo_b - lo_a, mid_b - mid_a];
                    let scaled = bands.map(|x| keys[j].scale * x as f32);
                    low_power += scaled[1];
                    terms.push((j, scaled));
                }
                let band = |n: usize| terms.iter().map(move |&(j, x)| (j, x[n]));
                self.add(level, level_weight, PHRASE + group, NONE, band(0));
                if bass <= EPS || middle <= EPS { continue; }
                // A bass note also excites the middle band. Fit the ratio
                // of the *whole chord*, not independent left/right gains.
                let reference = self.add(middle, 0.65 * balance_weight, PHRASE + 2 + group, NONE, band(2));
                let middle_power = self.rows[reference].base;
                if middle_power > EPS && low_power > EPS {
                    // Compare each key's share of the two bands. If the same
                    // key supplies both, hitting it harder cannot change their
                    // ratio. Distinct bass and melody voices can trade level.
                    let separation = 0.5 * terms.iter().map(|(_, p)|
                        (p[1] / low_power - p[2] / middle_power).abs()).sum::<f32>();
                    self.add(bass, (1. + 35. * separation) * balance_weight,
                        PHRASE + 4 + group, reference, band(1));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pmidi::Note;

    #[test]
    fn repeated_chords_follow_the_bass_without_a_louder_phrase() {
        // Both halves have the same broadband target and the same notes.
        // Only the relative strength of the pitched registers changes.
        let mut keys = Vec::new();
        for beat in 0..12 {
            for pitch in [38, 69] {
                let start = f64::from(beat) * 0.5;
                keys.push(Key { note: Note { pitch, start, end: start + 0.3, velocity: 70 },
                    hand: usize::from(pitch == 38), index: beat as usize, scale: 1., gain: 1.,
                    shared: true, energy: 0., weight: 0., step: 0. });
            }
        }
        let source: Vec<_> = (0..6 * WINDOWS_PER_SECOND).map(|i| {
            let low = if i < 3 * WINDOWS_PER_SECOND { 0.50 } else { 0.08 };
            Power { total: 1., low, mid: 0.50, beat: 0. }
        }).collect();
        let mut fit = Fit::default();
        fit.phrases(&keys, &source, &[]);
        fit.solve(&mut keys);
        let balance = |beat: usize| keys[2 * beat].gain / keys[2 * beat + 1].gain;
        assert!(balance(3) > 1.3 * balance(9));
    }

    #[test]
    fn a_single_bass_key_cannot_independently_raise_its_overtones() {
        let gains = |change_register: bool| {
            let mut keys: Vec<_> = (0..10).map(|i| {
                let start = i as f64;
                Key { note: Note { pitch: 38, start, end: start + 0.2, velocity: 70 },
                    hand: 1, index: i, scale: 1., gain: 1., shared: false,
                    energy: 0., weight: 0., step: 0. }
            }).collect();
            let source: Vec<_> = (0..10 * WINDOWS_PER_SECOND).map(|i| {
                let low = if change_register && i >= 5 * WINDOWS_PER_SECOND { 0.08 } else { 0.5 };
                Power { total: 1., low, mid: 0.5, beat: 0. }
            }).collect();
            let mut fit = Fit::default();
            fit.phrases(&keys, &source, &[]);
            fit.solve(&mut keys);
            keys.into_iter().map(|k| k.gain).collect::<Vec<_>>()
        };
        for (constant, changing) in gains(false).into_iter().zip(gains(true)) {
            assert!((constant - changing).abs() < 1e-4);
        }
    }
}

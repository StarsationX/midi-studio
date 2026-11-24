//! Fit the loudness of a chord without assigning the chord's full power to
//! each key. A held key contributes only the energy it emits in each window.
use super::{Fit, Key, EPS, NONE, PHRASE};
use super::super::super::{response::KeyResponse, Power, WINDOWS_PER_SECOND};

impl Fit {
    pub(super) fn phrases(&mut self, keys: &[Key], source: &[Power], piano: &[(f64, f64)]) {
        if source.is_empty() { return; }
        let curves: Vec<_> = keys.iter().map(|k|
            KeyResponse::new(k.note.pitch, k.note.velocity, k.note.end - k.note.start)
        ).collect();
        let mut active = Vec::<usize>::new();
        let hz = WINDOWS_PER_SECOND as f64;
        // The short window follows an accent; the longer window keeps that
        // accent from pulling a whole phrase away from its recorded level.
        for (group, (stride, weight)) in [(2, 100.), (10, 250.)].into_iter().enumerate() {
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
                let recorded = (chunk.iter().map(|p| p.total - 0.78 * p.low + p.supported_beat()).sum::<f64>() / hz) as f32;
                if recorded <= EPS { continue; }
                self.add(recorded, weight, PHRASE + group, NONE, active.iter().map(|&j| {
                    let onset = keys[j].note.start;
                    let (a, lo_a, _) = curves[j].at(start - onset);
                    let (b, lo_b, _) = curves[j].at(end - onset);
                    (j, keys[j].scale * ((b - a) - 0.78 * (lo_b - lo_a)) as f32)
                }));
            }
        }
    }
}

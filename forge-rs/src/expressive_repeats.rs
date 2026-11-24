//! A repeated key can have a strong–weak pattern even when the phrase stays loud.
//! Compare nearby strikes of that pitch, discounting sound from other ringing keys.
use super::{Fit, Key, EPS, PITCHES};

pub(super) struct Strike {
    pub(super) time: f64,
    pub(super) key: usize,
    pub(super) source: f32,
    own: f32,
    share: f32,
}

impl Strike {
    pub(super) fn new(time: f64, key: usize, source: f32) -> Self {
        Self { time, key, source, own: 0., share: 0. }
    }
}

#[derive(Clone, Copy, Default)]
struct Local { recording: f64, piano: f64, count: usize }

impl Fit {
    // Reuse the solver's finished per-key accumulators. Their weighted means
    // are the remaining broadband error and this key's share of that band.
    // A quiet inner voice can move farther than a note carrying the whole mix.
    fn measure_headroom(&self, keys: &mut [Key], first_attack: usize) {
        for k in &mut *keys { k.step = 0.; k.weight = 0.; k.energy = 0.; }
        let mut begin = 0;
        for row in &self.rows[..first_attack] {
            let terms = &self.terms[begin..row.end];
            begin = row.end;
            if row.group != PITCHES + 2 || row.weight == 0. { continue; }
            let total = terms.iter().map(|&(i,x)| x * keys[i].gain).sum::<f32>().max(EPS);
            let residual = (row.target - (total / row.base).ln()).clamp(-1.5, 1.5);
            for &(i, unit) in terms {
                let k = &mut keys[i];
                let power = unit * k.gain;
                let share = power / total;
                let w = share * power.sqrt();
                k.step += w * residual;
                k.weight += w;
                k.energy += w * share;
            }
        }
    }

    pub(super) fn follow_repeats(&self, keys: &mut [Key], first_row: usize, strikes: &mut [Strike]) {
        if strikes.len() < 2 { return; }
        self.measure_headroom(keys, first_row);
        let pitch = |k: &Key| usize::from(k.note.pitch - 21);
        let mut begin = first_row.checked_sub(1).map_or(0, |i| self.rows[i].end);
        // Measure every strike before changing any gain. Otherwise an earlier
        // correction would leak into the reference level for the next note.
        for (h, row) in strikes.iter_mut().zip(&self.rows[first_row..]) {
            let mut total = 0.;
            for &(i, unit) in &self.terms[begin..row.end] {
                let power = unit * keys[i].gain;
                total += power;
                if i == h.key { h.own += power; }
            }
            begin = row.end;
            h.share = h.own / total.max(EPS);
            h.source *= h.share;
        }
        // Strike times are ordered. One sliding window covers every pitch;
        // a key needs at least one other audible strike to set a local level.
        const NEAR: f64 = 1.5;
        let mut levels = [Local::default(); PITCHES];
        let (mut first, mut end) = (0, 0);
        for h in strikes.iter() {
            while end < strikes.len() && strikes[end].time < h.time + NEAR {
                let s = &strikes[end];
                if s.own > EPS {
                    let l = &mut levels[pitch(&keys[s.key])];
                    l.piano += f64::from(s.own); l.recording += f64::from(s.source); l.count += 1;
                }
                end += 1;
            }
            while strikes[first].time < h.time - NEAR {
                let s = &strikes[first];
                if s.own > EPS {
                    let l = &mut levels[pitch(&keys[s.key])];
                    l.piano -= f64::from(s.own); l.recording -= f64::from(s.source); l.count -= 1;
                    if l.count == 0 { *l = Local::default(); }
                }
                first += 1;
            }
            let k = &mut keys[h.key];
            let l = &levels[pitch(k)];
            if l.count < 2 || h.own <= EPS || l.recording <= 0. || l.piano <= 0. { continue; }
            let ratio = f64::from(h.source) * l.piano / (f64::from(h.own) * l.recording);
            let delta = (0.8 * h.share.sqrt() * (ratio as f32).max(EPS).ln()).clamp(-0.8, 0.8);
            // Allow about half a dB of phrase movement, more in the direction
            // the recording calls for. Keep the bound in log-power units.
            let delta = if k.energy > EPS {
                let room = (0.12 * k.weight + delta.signum() * k.step).max(0.025 * k.weight) / k.energy;
                delta.clamp(-room, room)
            } else { delta };
            k.gain = (k.gain * delta.exp()).min((127. / f32::from(k.note.velocity)).powf(2.5));
        }
    }
}

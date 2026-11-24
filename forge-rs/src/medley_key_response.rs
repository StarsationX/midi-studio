//! Cumulative energy of the bundled Grand Piano (total, low, melody band).
//! The same curve determines the energy in a window and where its accents land.

struct Profile {
    unit: [f64; 3],
    cdf: [[u16; 15]; 3], // implicit zero knot, followed by nondecreasing samples
}

include!("medley_piano_profiles.rs");

const RELEASE: f64 = 0.45;
const MAX_SPAN: f64 = TIMES[TIMES.len() - 1];

pub(super) struct KeyResponse {
    profile: &'static Profile,
    hold: f64,
    release_rate: f64,
}

impl KeyResponse {
    pub(super) fn new(pitch: u8, velocity: u8, duration: f64) -> Self {
        // player.js: peak = 0.72 * (v/127)^1.25, ramping exponentially to
        // 0.0001 over 450 ms. Twice the log-amplitude slope gives power decay.
        let v = f64::from(velocity.clamp(1, 127)) / 127.;
        Self {
            profile: &PROFILES[usize::from(pitch.clamp(21, 108) - 21)],
            hold: duration.max(0.06).min(MAX_SPAN),
            release_rate: (2. / RELEASE) * (7200_f64.ln() + 1.25 * v.ln()),
        }
    }

    pub(super) fn end(&self) -> f64 { (self.hold + RELEASE).min(MAX_SPAN) }

    // After key-up, advance through the sampled curve by the integral of the
    // release's relative power. This approximates the sample's continuing decay
    // while preserving the player's velocity-dependent release energy.
    fn sample_time(&self, elapsed: f64) -> f64 {
        let t = elapsed.max(0.).min(self.end());
        if t <= self.hold { return t; }
        self.hold - (-(t - self.hold) * self.release_rate).exp_m1() / self.release_rate
    }

    pub(super) fn at(&self, elapsed: f64) -> (f64, f64, f64) {
        let t = self.sample_time(elapsed);
        let i = TIMES[1..].partition_point(|&s| s < t);
        let f = (t - TIMES[i]) / (TIMES[i + 1] - TIMES[i]);
        let energy = |b: usize| {
            let row = &self.profile.cdf[b];
            let left = if i == 0 { 0. } else { f64::from(row[i - 1]) };
            (left + f * (f64::from(row[i]) - left)) * self.profile.unit[b]
        };
        (energy(0), energy(1), energy(2))
    }

    /// Invert `at(elapsed).0`; `total` is `at(end()).0` for this note.
    pub(super) fn quantile(&self, total: f64, q: f64) -> f64 {
        if !(total > 0. && q > 0.) { return 0.; }
        if q >= 1. { return self.end(); }
        let row = &self.profile.cdf[0];
        let target = total * q / self.profile.unit[0];
        let i = row.partition_point(|&s| f64::from(s) <= target);
        // Rounding at the last knot, or a sample that has already decayed fully.
        if i == row.len() { return self.end(); }
        let left = if i == 0 { 0. } else { f64::from(row[i - 1]) };
        let t = TIMES[i] + (TIMES[i + 1] - TIMES[i]) * (target - left) / (f64::from(row[i]) - left);
        if t <= self.hold { return t; }
        let released = self.release_rate * (t - self.hold);
        if released >= 1. { return self.end(); }
        (self.hold - (-released).ln_1p() / self.release_rate).min(self.end())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quietest_release_uses_the_actual_floor_not_a_fixed_tail() {
        let key = KeyResponse::new(60, 1, 0.01);
        let peak = 0.72 * (1_f64 / 127.).powf(1.25);
        let floor_power = (0.0001 / peak).powi(2);
        let tail = RELEASE * (1. - floor_power) / -floor_power.ln();
        assert!((key.sample_time(key.end()) - 0.06 - tail).abs() < 1e-12);
    }

    #[test]
    fn all_keys_have_bounded_invertible_energy() {
        for pitch in 0..=127 {
            for (velocity, duration) in [(1, 0.), (70, 0.27), (127, 90.)] {
                let key = KeyResponse::new(pitch, velocity, duration);
                let end = key.end();
                let (total, low, mid) = key.at(end);
                assert!(total > 0. && low >= 0. && mid >= 0. && end <= MAX_SPAN);
                assert_eq!(key.at(-1.), (0., 0., 0.));
                assert_eq!(key.at(100.), key.at(end));
                for q in [0., 1. / 6., 0.5, 5. / 6., 1.] {
                    let t = key.quantile(total, q);
                    assert!((0.0..=end).contains(&t));
                    assert!((key.at(t).0 / total - q).abs() < 1e-9);
                }
            }
        }
    }
}

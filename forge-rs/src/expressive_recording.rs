//! Keep phrase-level measurements and a low-rate attack reference from the
//! recording itself. Neither signal is an input to note detection.
use super::{salience, Power, WINDOWS_PER_SECOND};
use anyhow::{ensure, Result};

#[derive(Default)]
pub(crate) struct Recording {
    pub(super) bands: Vec<Power>,
    pub(super) wave: Vec<f32>,
}

// Second-order Butterworth high/low pass, transposed direct form II. Filter
// history crosses window boundaries: a bass note does not restart every 50 ms.
struct Section { b: f64, b1: f64, a1: f64, a2: f64, state: [f64; 2] }
impl Section {
    fn new(rate: f64, hz: f64, high_pass: bool) -> Self {
        let (s, c) = (std::f64::consts::TAU * (hz / rate).min(0.45)).sin_cos();
        let a = 1. + s * std::f64::consts::FRAC_1_SQRT_2;
        let sign = if high_pass { -1. } else { 1. };
        let b = (1. - sign*c) / (2.*a);
        Self { b, b1: 2.*sign*b, a1: -2.*c/a, a2: (2.-a)/a, state: [0.; 2] }
    }
    fn tick(&mut self, x: f64) -> f64 {
        let t = self.b*x;
        let y = t + self.state[0];
        self.state = [self.b1*x - self.a1*y + self.state[1], t - self.a2*y];
        y
    }
}

impl Recording {
    pub(crate) fn measure(samples: &[f32], rate: u32) -> Result<Self> {
        let hz = WINDOWS_PER_SECOND;
        ensure!(rate as usize >= hz, "Invalid recording sample rate: {rate}");
        if samples.len() < 4 * rate as usize { return Ok(Self::default()); }
        let wave = crate::resample::resample_hq(samples, 1, f64::from(rate), salience::RATE)?;
        let mut filters = [(100., 4800.), (40., 165.), (280., 1800.)].map(|(lo, hi)|
            (Section::new(f64::from(rate), lo, true), Section::new(f64::from(rate), hi, false)));
        let count = (samples.len() as u64 * hz as u64).div_ceil(u64::from(rate)) as usize;
        let mut bands = Vec::with_capacity(count);
        let mut start = 0;
        for i in 1..=count {
            let end = ((i as u64 * u64::from(rate) / hz as u64) as usize).min(samples.len());
            let mut sum = [0.; 3];
            for &x in &samples[start..end] {
                for (s, (high, low)) in sum.iter_mut().zip(&mut filters) {
                    let y = low.tick(high.tick(f64::from(x)));
                    *s += y*y;
                }
            }
            let [total, low, mid] = sum.map(|s| s / (end-start) as f64);
            bands.push(Power { total, low, mid, beat: 0. });
            start = end;
        }
        Ok(Self { bands, wave })
    }

    pub(crate) fn limit_to_pitched(&mut self, pitched: &[Power]) {
        // The mix can reinforce a phrase, not turn a drum-only break into a
        // swell. Truncate a possible final partial window from resampling.
        self.bands.truncate(pitched.len());
        for (band, stem) in self.bands.iter_mut().zip(pitched) {
            band.total = band.total.min(2.5 * stem.phrase_power());
            band.low = band.low.min(2.5 * stem.total);
            band.mid = band.mid.min(2.5 * stem.total);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bass_and_melody_trade_places_on_the_source_clock() {
        let rate = 22_050; // A 50 ms window is not an integer number of samples.
        let x: Vec<_> = (0..4*rate+1).map(|i| {
            let hz = if i < 2*rate { 82.4 } else { 880. };
            (std::f64::consts::TAU * hz * f64::from(i) / f64::from(rate)).sin() as f32
        }).collect();
        let mut r = Recording::measure(&x, rate).unwrap();
        assert_eq!(r.bands.len(), 81);
        assert!(r.bands[35].low > 20.*r.bands[45].low);
        assert!(r.bands[45].mid > 20.*r.bands[35].mid);
        let silence = vec![Power::default(); r.bands.len()];
        r.limit_to_pitched(&silence);
        assert!(r.bands.iter().all(|p| p.total == 0. && p.low == 0. && p.mid == 0.));
    }
}

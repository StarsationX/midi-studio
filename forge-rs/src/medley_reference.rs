//! Low-rate analytical playback of the bundled acoustic grand. Generated from its
//! CC BY 3.0 US samples; see third-party/THIRD-PARTY.txt and calibrate_medley_piano.py.
use super::{Key, PITCHES};
use super::super::super::salience::{RATE, WIDTH};
use std::sync::LazyLock;

// Little-endian sample offsets (including the end), then one float scale per
// key and signed 8-bit mu-law samples. The four-millisecond attack is baked in.
static BANK: &[u8] = include_bytes!("medley_reference.pcm");
const HEADER: usize = 4 * (2 * PITCHES + 1);
static DECODE: LazyLock<[f32; 256]> = LazyLock::new(|| std::array::from_fn(|i| {
    let x = i as i8 as f32;
    x.signum() * (256_f32.powf(x.abs() / 127.) - 1.) / 255.
}));
fn word(i: usize) -> [u8; 4] { BANK[4*i..4*i+4].try_into().unwrap() }

pub(super) struct Voice {
    pub(super) start: isize,
    pub(super) end: isize,
    release: isize,
    amplitude: f32,
    log_decay: f32,
    decay: f32,
    wave: &'static [u8],
}
impl Voice {
    pub(super) fn new(k: &Key) -> Self {
        let n = k.note;
        let i = usize::from(n.pitch - 21);
        let offset = |i| HEADER + u32::from_le_bytes(word(i)) as usize;
        let wave = &BANK[offset(i)..offset(i+1)];
        let scale = f32::from_le_bytes(word(PITCHES+1+i));
        let start = (n.start * RATE).round() as isize;
        let hold = ((n.end - n.start).max(0.06) * RATE).round() as isize;
        let release = start + hold;
        let end = (start + wave.len() as isize).min(release + (0.45 * RATE) as isize);
        let velocity = (f32::from(n.velocity) / 127.).powf(1.25);
        let log_decay = (0.0001 / (0.72 * velocity)).ln() / (0.45 * RATE as f32);
        Self { start, end, release, wave, amplitude: velocity * scale, log_decay, decay: log_decay.exp() }
    }

    // Visit only the sounding intersection, indexed relative to the requested
    // listening window. Note-off starts the sampled player's exponential release;
    // it is not a hard cut, nor another 450 ms at full strength.
    pub(super) fn window(&self, at: isize, width: usize, mut take: impl FnMut(usize, f32)) {
        let a = self.start.max(at);
        let b = self.end.min(at + width as isize);
        if b <= a { return; }
        let mut gain = self.amplitude * (((a-self.release).max(0) as f32) * self.log_decay).exp();
        let mut time = a;
        for &code in &self.wave[(a-self.start) as usize..(b-self.start) as usize] {
            take((time-at) as usize, gain * DECODE[usize::from(code)]);
            if time >= self.release { gain *= self.decay; }
            time += 1;
        }
    }
}

type Partials = [[f32; 2]; 3];
struct Probe { kernel: Box<[Partials]>, weights: [f32; 3] }
static KERNELS: [std::sync::OnceLock<Probe>; PITCHES] = [const { std::sync::OnceLock::new() }; PITCHES];
impl Probe {
    fn for_pitch(pitch: u8) -> &'static Self {
        KERNELS[usize::from(pitch-21)].get_or_init(|| {
            let hz = 440. * 2_f64.powf((f64::from(pitch)-69.) / 12.);
            let omega = std::f64::consts::TAU * hz / RATE;
            let weights = std::array::from_fn(|h| if (h+1) as f64 * hz < 0.46*RATE { [1.,0.35,0.12][h] } else { 0. });
            let kernel = (0..WIDTH).map(|i| {
                let w = 0.5 - 0.5*(std::f64::consts::TAU * i as f64 / (WIDTH-1) as f64).cos();
                std::array::from_fn(|h| {
                    let (s,c) = (omega * (h+1) as f64 * i as f64).sin_cos();
                    [(w*c) as f32, (w*s) as f32]
                })
            }).collect();
            Self { kernel, weights }
        })
    }
    fn energy(&self, p: &Partials) -> f32 {
        p.iter().zip(self.weights).map(|([x,y], w)| w*(x*x+y*y)).sum()
    }
}

// Return independent positive terms (needed by the log-power fitter) and the
// change in predicted level when those same notes are sounded together. Blend
// rather than trusting sample-exact interference after MIDI tick rounding.
#[derive(Default)]
pub(super) struct Meter { pub(super) terms: Vec<(usize,f32)> }
impl Meter {
    pub(super) fn strike(&mut self, voices: &[Voice], active: &[usize], pitch: u8, at: isize) -> f32 {
        let probe = Probe::for_pitch(pitch);
        self.terms.clear();
        let mut sum = [[0.;2];3];
        let mut power = 0.;
        for &i in active {
            let mut partials = [[0.;2];3];
            voices[i].window(at, WIDTH, |j, gain| {
                for (out, [x,y]) in partials.iter_mut().zip(probe.kernel[j]) { out[0] += gain*x; out[1] += gain*y; }
            });
            let e = probe.energy(&partials);
            if e <= super::EPS { continue; }
            self.terms.push((i,e));
            power += e;
            for (z,[x,y]) in sum.iter_mut().zip(partials) { z[0] += x; z[1] += y; }
        }
        if power <= super::EPS { return 1.; }
        0.05 + 0.95*(probe.energy(&sum)/power).clamp(0.1,4.)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pmidi::Note;
    #[test]
    fn released_unison_still_contributes_to_the_next_attack() {
        let key = |start,end| Key { note: Note { pitch: 57, velocity: 80, start, end },
            hand: 0,index: 0,scale: 1.,gain: 1.,energy: 0.,weight: 0.,step: 0.,shared: false };
        let voices = [Voice::new(&key(0.,0.15)), Voice::new(&key(0.16,0.35))];
        let mut m = Meter::default();
        m.strike(&voices, &[0,1], 57, (0.16*RATE) as isize);
        assert_eq!(m.terms.len(), 2);
        assert!(m.terms[0].1 > 0. && m.terms[0].1 < m.terms[1].1);
        m.strike(&voices, &[0,1], 57, (0.83*RATE) as isize);
        assert!(m.terms.is_empty());
    }
}

//! Fit the keys that are still sounding, not just the ones struck together.
//! Each key has one gain for its entire life. A shared overtone counts once in
//! the predicted spectrum, even when two voices are capable of producing it.
use super::salience::RATE;
use crate::pmidi::{Note, PrettyMidi};
use realfft::RealFftPlanner;
use std::sync::LazyLock;

include!("medley_piano_spectra.rs");
const N: usize = 1024;
const HOP: usize = N / 4;
const EPS: f32 = 1e-14;
const LIMIT: f32 = 7.943282; // ±9 dB of power
const BAND_WEIGHT: [f32; 3] = [0.35, 0.45, 1.];
static WINDOW: LazyLock<[f32; N]> = LazyLock::new(|| std::array::from_fn(|i|
    0.5 - 0.5 * (std::f32::consts::TAU * i as f32 / (N - 1) as f32).cos()));
static BANDS: LazyLock<[[f32; 3]; N / 2 + 1]> = LazyLock::new(|| std::array::from_fn(|i| {
    let hz = (i as f32 * RATE as f32 / N as f32).max(1.);
    [(-(hz / 170.).powi(4)).exp(), 1. / ((1. + (280. / hz).powi(6)) * (1. + (hz / 1800.).powi(6))),
        1. / (1. + (100. / hz).powi(6))]
}));
struct Template { bin: [u16; 16], power: [f32; 16], energy: f32, bands: [f32; 3] }
impl Template {
    const fn decode(packed: [u32; 16], register: [u16; 3]) -> Self {
        let mut t = Self { bin: [0; 16], power: [0.; 16], energy: 0., bands: [0.; 3] };
        let mut i = 0;
        while i < 16 {
            t.bin[i] = (packed[i] >> 16) as u16;
            t.power[i] = f32::from_bits(packed[i] << 16);
            t.energy += t.power[i];
            i += 1;
        }
        let mut i = 0;
        while i < 3 { t.bands[i] = f32::from_bits((register[i] as u32) << 16); i += 1; }
        t
    }
}
// Power admitted before a given position in the Hann window. Templates
// already include the leading silence; shorten only the portion after key-up.
static CDF: LazyLock<[f32; N+1]> = LazyLock::new(|| {
    let mut c = [0.; N+1];
    for i in 0..N { c[i+1] = c[i] + WINDOW[i] * WINDOW[i]; }
    let total = c[N]; c.iter_mut().for_each(|v| *v /= total); c
});

struct Key {
    note: Note, hand: usize, index: usize, scale: f32, gain: f32,
    energy: f32, weight: f32, step: f32, shared: bool,
}
struct Voice { key: usize, template: usize, scale: f32, observed: [f32; 16] }
struct Frame { end: usize, shared: bool, written: [f32; 3], target: [f32; 3] }

fn collect(mix: &[f32], piano: &[(f64, f64)], keys: &mut [Key]) -> (Vec<Frame>, Vec<Voice>) {
    let fft = RealFftPlanner::<f32>::new().plan_fft_forward(N);
    let (mut input, mut freq, mut scratch) = (fft.make_input_vec(), fft.make_output_vec(), fft.make_scratch_vec());
    let mut frames = Vec::new();
    let mut voices = Vec::new();
    let mut active = Vec::<usize>::new();
    let (mut next, mut passage) = (0, 0);
    let half = (N / 2) as f64 / RATE;
    for center in (0..mix.len()).step_by(HOP) {
        let t = center as f64 / RATE;
        active.retain(|&i| keys[i].note.end + half + 0.015 > t);
        while next < keys.len() && keys[next].note.start < t + half {
            active.push(next); next += 1;
        }
        if active.is_empty() { if next == keys.len() { break; } continue; }
        while passage < piano.len() && piano[passage].1 <= t - half { passage += 1; }
        if piano.get(passage).is_some_and(|p| p.0 < t + half) { continue; }
        input.fill(0.);
        let from = center.saturating_sub(N / 2);
        let to = (center + N / 2).min(mix.len());
        let pad = (N / 2).saturating_sub(center);
        for (i, &v) in mix[from..to].iter().enumerate() { input[i + pad] = WINDOW[i + pad] * v; }
        fft.process_with_scratch(&mut input, &mut freq, &mut scratch).expect("fixed Medley FFT dimensions");
        let mut target = [0.; 3];
        let mut amplitude = [0.; N/2 + 1];
        for ((a, w), z) in amplitude.iter_mut().zip(BANDS.iter()).zip(&freq) {
            let power = z.norm_sqr(); *a = power.sqrt();
            for j in 0..3 { target[j] += power * w[j]; }
        }
        if target[2] < 1e-6 { continue; }
        let begin = voices.len();
        let mut written = [0.; 3];
        let mut first_pitch = None;
        let mut shared = false;
        for &i in &active {
            let k = &mut keys[i];
            let age = t - k.note.start;
            // A centered Hann window hears part of a key on either side of
            // its attack and release. Do not count it at full strength there.
            let cut = |rel: f64| CDF[((rel * RATE).round() + (N / 2) as f64).clamp(0., N as f64) as usize];
            let onset = cut(-age);
            let gate = (cut(k.note.end + 0.015 - t) - onset) / (1. - onset).max(EPS);
            if gate < 0.01 { continue; }
            let a = AGES.partition_point(|&v| v < age);
            let a = if a == AGES.len() || a > 0 && age - AGES[a-1] <= AGES[a] - age { a-1 } else { a };
            let template = usize::from(k.note.pitch - 21) * AGES.len() + a;
            let key = &KEYS[template];
            if key.energy <= EPS { continue; }
            let scale = gate * k.scale;
            k.energy += scale * key.energy;
            for j in 0..3 {
                let e = scale * key.bands[j]; written[j] += e; k.weight += BAND_WEIGHT[j] * e;
            }
            shared |= *first_pitch.get_or_insert(k.note.pitch) != k.note.pitch;
            voices.push(Voice { key: i, template, scale, observed: key.bin.map(|b| amplitude[usize::from(b)]) });
        }
        if begin == voices.len() { continue; }
        if shared { for v in &voices[begin..] { keys[v.key].shared = true; } }
        frames.push(Frame { end: voices.len(), shared, written, target });
    }
    (frames, voices)
}

// Anchor each register to its own median: a compressed recording and an
// acoustic piano need not have the same bass level or mastering gain.
fn anchor(frames: &mut [Frame]) {
    let mut ratios = Vec::with_capacity(frames.len());
    for b in 0..3 {
        let (mut src, mut played) = (0_f32, 0_f32);
        for f in frames.iter() { src = src.max(f.target[b]); played = played.max(f.written[b]); }
        ratios.clear();
        ratios.extend(frames.iter().filter(|f| f.target[b] > 0.001 * src && f.written[b] > 0.01 * played)
            .map(|f| f.target[b] / f.written[b]));
        let mid = ratios.len() / 2;
        let norm = (!ratios.is_empty()).then(|| *ratios.select_nth_unstable_by(mid, f32::total_cmp).1);
        for f in frames.iter_mut() {
            let adjust = norm.map_or(1., |m| (f.target[b] / (m * f.written[b]).max(EPS)).clamp(0.22313, 4.48169).powf(0.8));
            f.target[b] = f.written[b] * adjust;
        }
    }
}

fn fit(keys: &mut [Key], frames: &[Frame], voices: &[Voice]) {
    for _ in 0..4 {
        let mut start = 0;
        for f in frames {
            let sounding = &voices[start..f.end]; start = f.end;
            if !f.shared { continue; }
            let mut power = [0.; N/2+1];
            for v in sounding {
                let k = &KEYS[v.template]; let scale = v.scale * keys[v.key].gain;
                for j in 0..16 { power[usize::from(k.bin[j])] += scale * k.power[j]; }
            }
            let (mut sum, mut energy) = (0., 0.);
            // Assign each observed bin in proportion to the power that each
            // sounding key predicts there, rather than crediting every key.
            for v in sounding {
                let k = &KEYS[v.template]; let note = &mut keys[v.key];
                let scale = v.scale * note.gain;
                let dot: f32 = (0..16).map(|j| k.power[j] * v.observed[j] / power[usize::from(k.bin[j])].max(EPS).sqrt()).sum();
                sum += dot * scale; energy += k.energy * scale;
                note.step += v.scale * k.energy * (dot / k.energy).max(EPS).ln();
            }
            let common = (sum / energy.max(EPS)).max(EPS).ln();
            for v in sounding { keys[v.key].step -= v.scale * KEYS[v.template].energy * common; }
        }
        for k in &mut *keys {
            if k.shared { k.gain = ((k.gain.ln() + 1.5 * k.step / k.energy) / 1.24).exp().clamp(1./LIMIT, LIMIT); }
            k.step = 0.;
        }
        // A good relative chord fit can still be much too loud. Match the
        // short-time phrase power before choosing the next set of key gains.
        start = 0;
        for f in frames {
            let sounding = &voices[start..f.end]; start = f.end;
            let mut total = [0.; 3];
            for v in sounding {
                let scale = v.scale * keys[v.key].gain;
                for (e, b) in total.iter_mut().zip(KEYS[v.template].bands) { *e += scale * b; }
            }
            let correction: [f32; 3] = std::array::from_fn(|j| BAND_WEIGHT[j] *
                (f.target[j].max(EPS) / total[j].max(EPS)).ln().clamp(-1.4, 1.4));
            for v in sounding {
                let dot: f32 = correction.iter().zip(KEYS[v.template].bands).map(|(a,b)| a*b).sum();
                keys[v.key].step += v.scale * dot;
            }
        }
        for k in &mut *keys {
            if k.shared { k.gain = (k.gain * (k.step / k.weight.max(EPS)).exp()).clamp(1./LIMIT, LIMIT); }
            k.step = 0.;
        }
    }
}

pub(super) fn apply(midi: &mut PrettyMidi, mix: &[f32], piano: &[(f64, f64)]) {
    if mix.len() < N || midi.instruments.len() != 2 { return; }
    let mut keys = Vec::with_capacity(midi.note_count());
    for (hand, track) in midi.instruments.iter().enumerate() {
        for (index, &note) in track.notes.iter().enumerate() {
            let p = piano.partition_point(|s| s.1 <= note.start);
            if note.velocity == 0 || !(21..=98).contains(&note.pitch)
                || piano.get(p).is_some_and(|s| s.0 < note.end) { continue; }
            let v = f32::from(note.velocity);
            keys.push(Key { note, hand, index, scale: v*v*v.sqrt(), gain: 1., energy: 0., weight: 0., step: 0., shared: false });
        }
    }
    if keys.len() < 2 { return; }
    keys.sort_unstable_by(|a,b| a.note.start.total_cmp(&b.note.start));
    // If even the release windows don't overlap, no relative touch can be fitted.
    let span = N as f64 / RATE + 0.015;
    if !keys.windows(2).any(|pair| pair[0].note.end + span > pair[1].note.start) { return; }
    let (mut frames, voices) = collect(mix, piano, &mut keys);
    if !keys.iter().any(|k| k.shared) { return; }
    anchor(&mut frames);
    fit(&mut keys, &frames, &voices);
    for k in keys.iter().filter(|k| k.shared) {
        let touch = (f32::from(k.note.velocity) * k.gain.powf(0.4)).round().clamp(1.,127.) as u8;
        midi.instruments[k.hand].notes[k.index].velocity = touch;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pmidi::Instrument;

    #[test]
    fn late_chord_entry_tracks_a_ringing_voice_without_rewriting_the_phrase() {
        let mut m = PrettyMidi::new(960, 120.);
        let (mut right, mut left) = (Instrument::new(0, false, "Right"), Instrument::new(0, false, "Left"));
        for start in [0.2, 1.6, 3.] {
            left.notes.push(Note { pitch: 52, start, end: start+0.92, velocity: 65 });
            right.notes.push(Note { pitch: 68, start: start+0.35, end: start+0.9, velocity: 65 });
        }
        right.notes.push(Note { pitch: 60, start: 4.3, end: 4.6, velocity: 65 });
        m.instruments.extend([right, left]);
        let audio: Vec<_> = (0..(5.*RATE) as usize).map(|i| {
            let t = i as f64 / RATE;
            let beat = (t-0.2).rem_euclid(1.4);
            let (lo, hi) = if t < 1.5 { (0.4, 0.035) } else { (0.035, 0.4) };
            let phase = t * std::f64::consts::TAU;
            let low = if beat < 0.92 { lo * (164.814 * phase).sin() } else { 0. };
            let high = if (0.35..0.9).contains(&beat) { hi * (415.305 * phase).sin() } else { 0. };
            (low + high) as f32
        }).collect();
        apply(&mut m, &audio, &[(2.95, 4.)]);
        let (r,l) = (&m.instruments[0].notes, &m.instruments[1].notes);
        assert!(r[1].velocity > r[0].velocity && l[0].velocity > l[1].velocity);
        assert_eq!((r[2].velocity,l[2].velocity,r[3].velocity), (65,65,65));
    }
}

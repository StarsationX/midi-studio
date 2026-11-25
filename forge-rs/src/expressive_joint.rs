//! Fit attack contrast and short-time chord balance together. A velocity affects
//! every frame in which its key rings, including other notes' attack windows.
use super::{Frame, Key, Voice, AGES, EPS, KEYS, N, RATE};
use std::sync::LazyLock;
#[path = "expressive_phrase.rs"]
mod phrase;
#[path = "expressive_repeats.rs"]
mod repeats;
use repeats::Strike;

const PITCHES: usize = 78;
const FIRST: usize = 14; // Register used for relative chord colour (MIDI 35..89).
const WIDTH: usize = 54;

#[path = "medley_reference.rs"]
mod reference;
#[path = "medley_voicing.rs"]
mod voicing;
const PHRASE: usize = PITCHES + 3;
const GROUPS: usize = PHRASE + 9; // Two phrase scales plus three sampled-playback bands.
const NONE: usize = usize::MAX;
struct Filter { first: usize, weights: Vec<f32> }
static FILTERS: LazyLock<[Filter; PITCHES]> = LazyLock::new(|| std::array::from_fn(|p| {
    let hz = 440. * 2_f32.powf((p as f32 + 21. - 69.) / 12.);
    let bins = N as f32 / RATE as f32;
    let (center, width) = (hz * bins, (0.014 * hz).max(4.2) * bins);
    let first = (center - 3. * width).ceil().max(0.) as usize;
    let last = ((center + 3. * width).floor() as usize).min(N / 2);
    let weights = (first..=last).map(|i| (-0.5*((i as f32-center)/width).powi(2)).exp()).collect();
    Filter { first, weights }
}));
static TONES: LazyLock<Vec<[f32; PITCHES]>> = LazyLock::new(|| KEYS.iter().map(|k| {
    std::array::from_fn(|p| {
        let f = &FILTERS[p];
        k.bin.iter().zip(k.power).filter_map(|(&bin, power)| usize::from(bin).checked_sub(f.first)
            .and_then(|i| f.weights.get(i)).map(|w| w * power)).sum()
    })
}).collect());

#[derive(Default)]
pub(super) struct Evidence {
    bands: Vec<[f32; 3]>,
    chords: Vec<[f32; WIDTH]>,
}
impl Evidence {
    pub(super) fn record(&mut self, bands: [f32; 3], shared: bool, amplitude: &[f32; N/2+1]) {
        if shared && self.bands.len() % 2 == 0 {
            self.chords.push(std::array::from_fn(|i| {
                let f = &FILTERS[FIRST+i];
                amplitude[f.first..].iter().zip(&f.weights).map(|(a,w)| w*a*a).sum()
            }));
        }
        self.bands.push(bands);
    }
}

struct Row {
    end: usize, reference: usize, group: usize,
    base: f32, target: f32, weight: f32,
    inverse: f32, log_gain: f32, gradient: f32, curvature: f32,
}
// Row indices refer to the two attack probes, not just their newly struck
// keys: both measurements may also contain a third note that is still ringing.
struct AttackPair { earlier: usize, later: usize, weight: f32, target: f32 }
#[derive(Default)]
struct Fit { rows: Vec<Row>, terms: Vec<(usize, f32)>, pairs: Vec<AttackPair> }
impl Fit {
    // A reference row turns an absolute target into a proportion: one pitch
    // within a chord, or the bass relative to the middle of the recording.
    fn add(&mut self, src: f32, weight: f32, group: usize, reference: usize,
        terms: impl Iterator<Item=(usize, f32)>) -> usize {
        let mut base = 0.;
        self.terms.extend(terms.filter(|&(_, e)| e > EPS).inspect(|&(_, e)| base += e));
        let mut target = (src.max(EPS) / base.max(EPS)).ln();
        if reference != NONE { target -= self.rows[reference].target; }
        if group == NONE && reference != NONE { target = target.clamp(-1.5, 1.5); }
        let index = self.rows.len();
        self.rows.push(Row { end: self.terms.len(), reference, group, base, target,
            weight: if base > EPS { weight } else { 0. }, inverse: 0., log_gain: 0., gradient: 0., curvature: 0. });
        index
    }

    fn chord(&mut self, voices: &[Voice], observed: &[f32; WIDTH]) {
        let mut played = [0.; WIDTH];
        let mut fundamental = [false; WIDTH];
        for v in voices {
            let pitch = v.template / AGES.len();
            if (FIRST..FIRST + WIDTH).contains(&pitch) { fundamental[pitch - FIRST] = true; }
            for (dest, &tone) in played.iter_mut().zip(&TONES[v.template][FIRST..]) { *dest += tone*v.scale; }
        }
        let floor = 0.018 * played.iter().copied().fold(0., f32::max);
        let noise = 0.008 * observed.iter().copied().fold(0., f32::max);
        let mut bins = [0usize; WIDTH];
        let (mut count, mut total, mut src) = (0, 0., 0.);
        for i in 0..WIDTH {
            // A strong piano partial absent from the recording is evidence
            // for turning a voice down, not a reason to skip the measurement.
            if played[i] > 0.30*floor && (observed[i] > noise || played[i] > 2.*floor) {
                bins[count] = i; count += 1; total += played[i]; src += observed[i];
            }
        }
        if count < 2 || total <= EPS || src <= EPS { return; }
        let bins = &bins[..count];
        let reference = self.add(src, 0., NONE, NONE, voices.iter().map(|v| {
            (v.key, v.scale * bins.iter().map(|i| TONES[v.template][FIRST+i]).sum::<f32>())
        }));
        for &i in bins {
            // A sounding key's fundamental is stronger evidence of its
            // intended level than an overtone it may share with another key.
            let focus = if fundamental[i] { 6.0 } else { 1.4 };
            // A loud partial on either side matters. Weighting by agreement
            // alone gave a missing partial zero say in correcting the chord.
            let weight = focus * 350. * (played[i]/total + observed[i]/src);
            self.add(observed[i].max(0.35*noise), weight, NONE, reference,
                voices.iter().map(|v| (v.key, v.scale * TONES[v.template][FIRST+i])));
        }
    }

    fn attacks(&mut self, keys: &[Key], voices: &[reference::Voice], measured: &[Vec<f32>; 2], compare_chords: bool) -> Vec<Strike> {
        let mut probes: Vec<_> = keys.iter().enumerate().filter_map(|(i,k)| {
            let src = *measured[k.hand].get(k.index)?;
            let n = k.note;
            (src > 0.).then(|| Strike::new(n.start + 0.08_f64.min((n.end-n.start)*0.5), i, src))
        }).collect();
        probes.sort_unstable_by(|a,b| a.time.total_cmp(&b.time));
        let mut meter = reference::Meter::default();
        let mut next = 0;
        let mut active = Vec::<usize>::new();
        const WIDTH: isize = super::super::salience::WIDTH as isize;
        const NEAR: f64 = 0.12;
        const WEIGHT: f32 = 75000.;
        let first_row = self.rows.len();
        let mut first = 0;
        let mut previous = [None; PITCHES];
        for (j, hit) in probes.iter().enumerate() {
            let t = hit.time;
            let pitch = keys[hit.key].note.pitch;
            let p = usize::from(pitch - 21);
            let at = ((t * RATE).round() as isize - WIDTH/2).max(0);
            active.retain(|&i| voices[i].end > at);
            while next < keys.len() && voices[next].start < at + WIDTH {
                if voices[next].end > at { active.push(next); }
                next += 1;
            }
            let ratio = meter.strike(voices, &active, pitch, at);
            let row = self.add(hit.source / ratio, WEIGHT, p, NONE, meter.terms.iter().copied());
            if !compare_chords { continue; }
            // A pitch's relative power is comparable between strikes even
            // when the arrangement and the original have different timbres.
            if let Some((time, earlier)) = previous[p].replace((t, row)) {
                let gap = t - time;
                if (0.04..2.).contains(&gap) {
                    self.pairs.push(AttackPair { earlier, later: row, weight: WEIGHT*0.7, target: 0. });
                }
            }
            while t-probes[first].time >= NEAR { first += 1; }
            // A change in register balance must still respect which key
            // carried the accent when both hands struck together.
            let weight = 0.65 * WEIGHT;
            for (k, other) in probes[first..j].iter().enumerate() {
                if keys[other.key].note.pitch != keys[hit.key].note.pitch {
                    self.pairs.push(AttackPair { earlier: first_row+first+k, later: row,
                        weight: weight*(1.-((t-other.time)/NEAR) as f32), target: 0. });
                }
            }
        }
        probes
    }

    fn solve(&mut self, keys: &mut [Key]) {
        // Compare each attack to a typical strike in *its own* performance.
        // The middle recording strike and the middle piano strike need not
        // occur at the same time: median(observed / piano) loses that contrast.
        let mut levels: [Vec<f32>; GROUPS] = std::array::from_fn(|_| Vec::new());
        let mut piano: [Vec<f32>; PITCHES] = std::array::from_fn(|_| Vec::new());
        for r in &self.rows {
            if r.group == NONE || r.weight == 0. { continue; }
            if r.group < PITCHES {
                let log_power = r.base.ln();
                piano[r.group].push(log_power);
                levels[r.group].push(r.target + log_power);
            } else {
                levels[r.group].push(r.target);
            }
        }
        let median = |mut v: Vec<f32>| {
            let mid = v.len() / 2;
            (v.len() >= 4).then(|| *v.select_nth_unstable_by(mid, f32::total_cmp).1)
        };
        let mut medians = levels.map(median);
        for (level, played) in medians.iter_mut().zip(piano.map(median)) {
            if let (Some(src), Some(base)) = (level, played) { *src -= base; }
        }
        for r in &mut self.rows {
            if r.group != NONE {
                if let Some(m) = medians[r.group] {
                    let bound = if (PITCHES..PHRASE).contains(&r.group) { 1.6 } else { 2.5 };
                    r.target = (r.target - m).clamp(-bound, bound);
                } else { r.weight = 0.; }
            }
        }
        self.pairs.retain_mut(|p| {
            let (a,b) = (&self.rows[p.earlier], &self.rows[p.later]);
            // Compare departures from each pitch's usual level, not the raw
            // power of two different instruments or registers.
            p.target = (b.target-a.target).clamp(-2.,2.);
            a.weight > 0. && b.weight > 0.
        });
        for _ in 0..14 {
            for k in &mut *keys { k.step = 0.; k.weight = 0.; }
            let mut begin = 0;
            for r in &mut self.rows {
                let power = self.terms[begin..r.end].iter().map(|&(i,p)| p*keys[i].gain).sum::<f32>().max(EPS); begin = r.end;
                r.inverse = 1./power; r.log_gain = (power/r.base.max(EPS)).ln(); r.gradient = 0.; r.curvature = 0.;
            }
            // A relative observation has opposite derivatives in its numerator
            // and denominator. Accumulate both before distributing to the keys.
            for i in 0..self.rows.len() {
                let r = &self.rows[i]; if r.weight == 0. { continue; }
                let den = r.reference;
                let shift = if den == NONE { 0. } else { self.rows[den].log_gain };
                let d = r.weight * (r.target-r.log_gain+shift).clamp(-1.5, 1.5);
                let w = if den == NONE { r.weight } else { 1.5*r.weight };
                self.rows[i].gradient += d; self.rows[i].curvature += w;
                if den != NONE { self.rows[den].gradient -= d; self.rows[den].curvature += w; }
            }
            for p in &self.pairs {
                let contrast = self.rows[p.later].log_gain-self.rows[p.earlier].log_gain;
                let d = p.weight*(p.target-contrast).clamp(-1.5,1.5);
                self.rows[p.later].gradient += d; self.rows[p.earlier].gradient -= d;
                self.rows[p.later].curvature += p.weight; self.rows[p.earlier].curvature += p.weight;
            }
            begin = 0;
            for r in &self.rows {
                for &(i,p) in &self.terms[begin..r.end] {
                    let k = &mut keys[i]; let share = p*k.gain*r.inverse;
                    k.step += share*r.gradient; k.weight += share*r.curvature;
                }
                begin = r.end;
            }
            for k in &mut *keys {
                let prior = 0.18+0.75*k.weight.sqrt(); let log = k.gain.ln();
                let step = (k.step-prior*log)/(k.weight+prior);
                k.gain = (log+1.2*step).clamp(-1.3,1.3).exp().min((127./f32::from(k.note.velocity)).powf(2.5));
            }
        }
    }
}

// Two or three occurrences are enough to hear a local accent, even though
// they aren't enough to estimate this pitch's typical level for a whole song.
pub(super) fn sparse_repeats(keys: &mut [Key], attacks: &[Vec<f32>; 2]) {
    let mut fit = Fit::default();
    let samples: Vec<_> = keys.iter().map(reference::Voice::new).collect();
    let mut strikes = fit.attacks(keys, &samples, attacks, false);
    fit.follow_repeats(keys, 0, &mut strikes);
}

pub(super) fn refine(keys: &mut [Key], frames: &[Frame], voices: &[Voice], source: &Evidence,
    attacks: &[Vec<f32>; 2], envelope: &[super::super::Power], piano: &[(f64, f64)], recording: &[f32]) {
    let mut peak = [0_f32; 3]; let mut src_peak = [0_f32; 3];
    let mut start = 0;
    let bands: Vec<[f32; 3]> = frames.iter().zip(&source.bands).map(|(f, src)| {
        let mut band = [0.; 3];
        for v in &voices[start..f.end] { for (w,b) in band.iter_mut().zip(KEYS[v.template].bands) { *w += v.scale*b; } }
        start = f.end;
        for j in 0..3 { peak[j] = peak[j].max(band[j]); src_peak[j] = src_peak[j].max(src[j]); }
        band
    }).collect();
    let mut fit = Fit::default(); let mut chords = source.chords.iter(); start = 0;
    for (i, f) in frames.iter().enumerate() {
        let sounding = &voices[start..f.end]; start = f.end;
        let mut mid = NONE;
        for j in [1, 2, 0] {
            let target = source.bands[i][j];
            if bands[i][j] < peak[j]*0.004 || target < src_peak[j]*0.001 { continue; }
            let reference = if j==0 { mid } else { NONE };
            let row = fit.add(target, [275.,110.,180.][j], PITCHES+j, reference,
                sounding.iter().map(|v| (v.key, v.scale*KEYS[v.template].bands[j])));
            if j==1 { mid = row; }
        }
        if f.shared && i%2==0 { fit.chord(sounding, chords.next().unwrap()); }
    }
    fit.phrases(keys, envelope, piano);
    let samples: Vec<_> = keys.iter().map(reference::Voice::new).collect();
    voicing::measure(&mut fit, &samples, recording, piano);
    let first_row = fit.rows.len();
    let mut strikes = fit.attacks(keys, &samples, attacks, true);
    fit.solve(keys);
    fit.follow_repeats(keys, first_row, &mut strikes);
}

/// Refit after the level trims: the phrase level carries far more weight than
/// in `refine`, and the register balance somewhat more.
pub(super) fn polish(keys: &mut [Key], piano: &[(f64, f64)], recording: &[f32], attacks: &[Vec<f32>; 2],
    envelope: &[super::super::Power]) {
    let mut fit = Fit::default();
    fit.phrases(keys, envelope, piano);
    for r in &mut fit.rows {
        r.weight *= if r.group < PHRASE + 2 { 14. } else { 1.7 };
    }
    let samples: Vec<_> = keys.iter().map(reference::Voice::new).collect();
    voicing::measure(&mut fit, &samples, recording, piano);
    fit.attacks(keys, &samples, attacks, true);
    fit.solve(keys);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pmidi::Note;

    #[test]
    fn later_bass_entry_cannot_hide_an_already_measured_accent() {
        let gains = |bass| {
            let key = |pitch, start, hand, index, scale| Key {
                note: Note { pitch, start, end: start + 0.18, velocity: 60 },
                hand, index, scale, gain: 1., shared: false, energy: 0., weight: 0., step: 0.,
            };
            let mut keys = vec![key(69, 0.12, 0, 0, 1.)];
            // The first probe is centered at .20 s and ends before .26 s.
            // This loud octave must not borrow part of the melody's attack.
            if bass { keys.push(key(57, 0.264, 1, 0, 12.)); }
            keys.push(key(69, 1., 0, 1, 1.));
            sparse_repeats(&mut keys, &[vec![1., 1.5], vec![]]);
            (keys[0].gain, keys.last().unwrap().gain)
        };
        let alone = gains(false);
        assert!(alone.0 < 1. && alone.1 > 1.);
        assert_eq!(alone, gains(true));
    }

    #[test]
    fn accents_can_trade_places_without_changing_the_typical_strike_level() {
        let mut fit = Fit::default();
        let mut keys = Vec::new();
        // Same distribution, different order. Most strikes need to get
        // louder, but the recording as a whole hasn't changed gain.
        let played = [1., 1.3, 1.7, 2.2, 2.9];
        let recorded = [1.7, 2.2, 2.9, 1., 1.3];
        for (i, (&power, src)) in played.iter().zip(recorded).enumerate() {
            let start = i as f64;
            keys.push(Key { note: Note { pitch: 69, velocity: 64, start, end: start + 0.3 },
                hand: 0, index: i, scale: 1., gain: 1., energy: 0., weight: 0., step: 0., shared: false });
            fit.add(src, 300., 69 - 21, NONE, std::iter::once((i, power)));
        }
        fit.solve(&mut keys);
        assert!(keys[..3].iter().all(|k| k.gain > 1.4));
        assert!(keys[3..].iter().all(|k| k.gain < 0.65));
    }
}

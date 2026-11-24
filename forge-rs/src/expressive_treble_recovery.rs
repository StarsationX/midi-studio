//! Recover a new strike of a key already played by the right hand. Never infer a pitch
//! from a chord name, or start a new instrumental phrase in an empty bar.
use crate::{basicpitch::SAMPLE_RATE, pmidi::{Note, PrettyMidi}};
use std::sync::LazyLock;

// Compare the same three partials before and after a possible second pluck. The
// piano detector gives the key and time; don't use broadband transients as proof.
const WIDTH: usize = 882; // 40 ms at the detector's 22.05 kHz
const HOP: usize = 176;   // 8 ms
fn pluck(wave: &[f32], n: Note) -> bool {
    static WINDOW: LazyLock<[f32; WIDTH]> = LazyLock::new(|| std::array::from_fn(|i| {
        0.5 - 0.5 * (std::f32::consts::TAU * i as f32 / (WIDTH - 1) as f32).cos()
    }));
    let sample = (n.start * f64::from(SAMPLE_RATE)).round() as usize;
    let Some(first) = sample.checked_sub(10 * HOP + WIDTH / 2) else { return false };
    let Some(block) = wave.get(first..first + WIDTH + 20 * HOP) else { return false };
    let w = std::f32::consts::TAU * 440. * 2f32.powf((f32::from(n.pitch) - 69.) / 12.) / SAMPLE_RATE as f32;
    let coeff: [f32; 3] = std::array::from_fn(|h| 2. * (w * (h + 1) as f32).cos());
    let mut env = [[0f32; 3]; 21];
    for j in 1..env.len() {
        let (mut a, mut b) = ([0.; 3], [0.; 3]);
        for (&x, &weight) in block[j*HOP..][..WIDTH].iter().zip(WINDOW.iter()) {
            let x = x * weight;
            for h in 0..3 {
                let y = x + coeff[h] * a[h] - b[h];
                b[h] = a[h]; a[h] = y;
            }
        }
        for h in 0..3 {
            env[j][h] = (a[h]*a[h] + b[h]*b[h] - coeff[h]*a[h]*b[h]).max(0.).sqrt() * (4. / WIDTH as f32);
        }
    }
    let (mut best, mut at) = (0., 0);
    for j in 4..=16 {
        let rise: [f32; 3] = std::array::from_fn(|h| {
            let pre = env[j-3][h] + env[j-2][h] + env[j-1][h];
            let post = env[j+2][h] + env[j+3][h] + env[j+4][h];
            if post < 3. * if h == 0 { 0.004 } else { 0.0015 } { 0. } else { post / pre.max(0.0009) }
        });
        let score = rise[0].min(rise[1].max(rise[2]));
        if score > best { best = score; at = j; }
    }
    // Reject an unrelated earlier/later crescendo, even if another local rise exists.
    best >= 1.8 && (8..=14).contains(&at)
}

fn onsets(notes: &[Note], start: f64, end: f64) -> &[Note] {
    let i = notes.partition_point(|n| n.start < start);
    &notes[i..i + notes[i..].partition_point(|n| n.start <= end)]
}

fn max_duration(notes: &[Note]) -> f64 {
    notes.iter().map(|n| n.end - n.start).fold(0., f64::max)
}

pub(super) fn apply(midi: &mut PrettyMidi, instrumental: &[Note], backing: &[Note], vocals: &[Note], piano: &[(f64, f64)], wave: &[f32]) {
    let [right, left] = midi.instruments.as_mut_slice() else { return };
    if right.notes.is_empty() || backing.is_empty() { return; }
    let rh_span = max_duration(&right.notes);
    let lh_span = max_duration(&left.notes);
    let voice_span = max_duration(vocals);
    let mut added: Vec<Note> = Vec::new();
    let mut added_span: f64 = 0.;
    for &b in backing {
        if !(53..=96).contains(&b.pitch) || b.velocity < 45 || b.end - b.start < 0.026 { continue; }
        let nearby = onsets(instrumental, b.start - 0.035, b.start + 0.035);
        // supplement_instrumental can copy this exact piano observation. It cannot confirm itself.
        let distinct = !nearby.contains(&b);
        let inst = if distinct { nearby.iter().filter(|i| i.pitch == b.pitch && i.velocity >= 53 && i.end - i.start >= 0.065)
            .min_by(|a, z| (a.start - b.start).abs().total_cmp(&(z.start - b.start).abs())) } else { None };
        let start = inst.map_or(b.start, |i| i.start);
        let mut end = inst.map_or(b.end, |i| i.end.min(b.end));
        if end - start < 0.025 { continue; }
        let recent = right.notes.partition_point(|n| n.start < start - 0.90);
        let before = right.notes.partition_point(|n| n.start < start - 0.075);
        let Some(prior_index) = right.notes[recent..before].iter().rposition(|p| p.pitch == b.pitch).map(|j| recent + j) else { continue };
        let prior = right.notes[prior_index];
        let heard = |notes: &[Note]| onsets(notes, start - 0.075, start + 0.075).iter().any(|n| n.pitch == b.pitch);
        if heard(&right.notes) || heard(&left.notes) || heard(&added) { continue; }
        if onsets(vocals, prior.start - voice_span - 0.24, end + 0.24).iter().any(|n| n.end > prior.start - 0.24) { continue; }
        if piano.get(piano.partition_point(|&(_, stop)| stop <= prior.start - 0.10)).is_some_and(|&(t, _)| t < end + 0.10) { continue; }

        // A missing finger in an already voiced strum needs two model onsets. Away from a
        // strum, only reopen an almost-touching note if its own partials actually reattack.
        let partner = onsets(&right.notes, start - 0.040, start + 0.040).iter()
            .filter(|n| (2..=10).contains(&n.pitch.abs_diff(b.pitch)) && end.min(n.end) - start.max(n.start) >= 0.045)
            .max_by(|a, z| a.end.total_cmp(&z.end));
        if let Some(p) = partner.filter(|_| inst.is_some()) {
            end = end.min(p.end);
        } else {
            if prior.end < start - 0.015 || !(0.080..=0.50).contains(&(start - prior.start)) { continue; }
            let harmonic = |n: &Note| matches!(b.pitch.checked_sub(n.pitch), Some(12 | 19 | 24 | 28 | 31 | 36));
            if onsets(&right.notes, start - 0.045, start + 0.045).iter().chain(onsets(&left.notes, start - 0.045, start + 0.045)).any(harmonic)
                || !pluck(wave, b) { continue; }
        }
        if onsets(&left.notes, start - lh_span, end).iter().any(|n| n.end > start && n.start < end && n.pitch >= b.pitch) { continue; }
        let mut other_fingers = 0;
        if onsets(&right.notes, start - rh_span, end).iter().chain(onsets(&added, start - added_span, end)).any(|n| {
            if std::ptr::eq(n, &right.notes[prior_index]) || n.end <= start || n.start >= end { return false; }
            other_fingers += 1;
            n.pitch == b.pitch || n.pitch.abs_diff(b.pitch) > 12 || other_fingers >= 5
        }) { continue; }
        let velocity = partner.map_or(prior.velocity, |p| prior.velocity.min(p.velocity)).saturating_sub(5).max(1);
        right.notes[prior_index].end = prior.end.min(start);
        let note = Note { start, end, velocity, ..b };
        // Detector onsets of two members of a roll need not sort the same way.
        added.insert(added.partition_point(|n| n.start <= start), note);
        added_span = added_span.max(end - start);
    }
    if !added.is_empty() {
        right.notes.append(&mut added);
        right.notes.sort_unstable_by(|a, b| a.start.total_cmp(&b.start).then(a.pitch.cmp(&b.pitch)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pmidi::Instrument;

    fn key(pitch: u8, start: f64, end: f64) -> Note { Note { pitch, start, end, velocity: 72 } }

    fn hands(right: &[Note], left: &[Note]) -> PrettyMidi {
        let mut m = PrettyMidi::new(960, 120.);
        for notes in [right, left] {
            let mut hand = Instrument::new(0, false, "Hand");
            hand.notes.extend_from_slice(notes);
            m.instruments.push(hand);
        }
        m
    }

    #[test]
    fn struck_chord_tone_requires_two_observations_free_fingers_and_an_unprotected_phrase() {
        let i = key(62, 0.50, 0.68);
        let b = key(62, 0.49, 0.63);
        let prior = key(62, 0.20, 0.52);
        let chord = key(67, 0.49, 0.66);
        for (instrument, blocker, left, voice, passage, added) in [
            (i, None, None, None, None, true),
            (b, None, None, None, None, false), // copied piano fallback
            (i, Some(key(76, 0.54, 0.60)), None, None, None, false),
            (i, None, Some(key(63, 0.56, 0.70)), None, None, false),
            (i, None, None, Some(key(70, 0.67, 1.00)), None, false),
            (i, None, None, None, Some((0.54, 1.20)), false),
        ] {
            let mut m = hands(&[prior, chord], left.as_slice());
            m.instruments[0].notes.extend(blocker);
            let before = m.clone();
            apply(&mut m, &[instrument], &[b], voice.as_slice(), passage.as_slice(), &[]);
            if !added { assert_eq!(m, before); continue; }
            assert_eq!(m.instruments[0].notes, [Note { end: i.start, ..prior }, chord,
                Note { end: b.end, velocity: 67, ..i }]);
            assert_eq!(m.instruments[1], before.instruments[1]);
        }
    }

    #[test]
    fn lone_detector_needs_new_partial_energy_and_a_previously_sounding_key() {
        let b = key(69, 0.50, 0.56);
        let prior = key(69, 0.32, 0.52);
        let sound: Vec<f32> = (0..SAMPLE_RATE).map(|i| {
            let t = i as f32 / SAMPLE_RATE as f32;
            if !(0.5..0.56).contains(&t) { return 0.; }
            let phase = std::f32::consts::TAU * 440. * t;
            0.1 * (phase.sin() + 0.4 * (2. * phase).sin())
        }).collect();
        for (notes, wave, added) in [
            (prior, &sound[..], true), (prior, &[][..], false),
            (Note { end: 0.43, ..prior }, &sound[..], false),
        ] {
            let mut m = hands(&[notes], &[]);
            apply(&mut m, &[b], &[b], &[], &[], wave);
            assert_eq!(m.instruments[0].notes.len(), 1 + usize::from(added));
            if added { assert_eq!(m.instruments[0].notes[0].end, b.start); }
        }
    }
}

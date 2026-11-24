//! Restore a missing finger in an already voiced instrumental strum, not a new phrase.
use crate::{basicpitch::SAMPLE_RATE, pmidi::{Note, PrettyMidi}};
use std::sync::LazyLock;

const WIDTH: usize = (SAMPLE_RATE as usize * 64 + 500) / 1000;
static HANN: LazyLock<[f32; WIDTH]> = LazyLock::new(|| std::array::from_fn(|i| {
    0.5 - 0.5 * (std::f32::consts::TAU * i as f32 / (WIDTH - 1) as f32).cos()
}));

// Bits mark target partials 1, 2 and 3 that another sounding key can supply.
// These semitone intervals place them within 3% of one of that key's first eight harmonics.
fn shared_partials(target: u8, other: u8) -> u8 {
    let d = i16::from(target) - i16::from(other);
    u8::from(matches!(d, 12 | 19 | 24 | 28 | 31 | 34 | 36))
        | (u8::from(matches!(d, -12 | 7 | 12 | 16 | 19 | 22 | 24)) << 1)
        | (u8::from(matches!(d, -19 | -7 | 5 | 9 | 12 | 15 | 17)) << 2)
}

fn struck(wave: &[f32], n: Note, shared: u8) -> bool {
    if shared & 1 != 0 || shared & 6 == 6 { return false; }
    let frame = |t: f64| {
        let start = ((t * f64::from(SAMPLE_RATE)).round() as usize).checked_sub(WIDTH / 2)?;
        wave.get(start..start + WIDTH)
    };
    let (Some(before), Some(after)) = (frame(n.start - 0.042), frame(n.start + ((n.end - n.start) * 0.5).min(0.045))) else { return false };
    let omega = std::f64::consts::TAU * 440. * 2_f64.powf((f64::from(n.pitch) - 69.) / 12.) / f64::from(SAMPLE_RATE);
    // Goertzel bins for the pitch and two flanking frequencies two semitones away.
    let rises = |h: u8, floor: f64| {
        let (p, neighbors, before) = super::partials::contrast(before, after, &*HANN, omega * f64::from(h));
        p > floor * WIDTH as f64 / 4. && p > 1.7 * before && p > 1.35 * neighbors
    };
    rises(1, 0.002) && ((shared & 2 == 0 && rises(2, 0.0008)) || (shared & 4 == 0 && rises(3, 0.0008)))
}

fn onsets(notes: &[Note], a: f64, b: f64) -> &[Note] {
    let tail = &notes[notes.partition_point(|n| n.start < a)..];
    &tail[..tail.partition_point(|n| n.start <= b)]
}

fn span(notes: &[Note]) -> f64 { notes.iter().map(|n| n.end - n.start).fold(0., f64::max) }

pub(super) fn apply(midi: &mut PrettyMidi, instrumental: &[Note], backing: &[Note], vocals: &[Note], piano: &[(f64, f64)], wave: &[f32]) {
    let [right, left] = midi.instruments.as_mut_slice() else { return };
    if wave.is_empty() || right.notes.is_empty() || instrumental.is_empty() { return; }
    let (rh, lh, vh) = (span(&right.notes), span(&left.notes), span(vocals));
    let mut added: Vec<Note> = Vec::new();
    let mut added_span = 0.;
    for &k in instrumental {
        let s = k.start;
        if !(53..=96).contains(&k.pitch) || k.velocity < 50 || k.end - s < 0.065 { continue; }
        if [&right.notes, &left.notes, &added].iter().any(|line| onsets(line, s - 0.068, s + 0.068).iter().any(|n| n.pitch == k.pitch)) { continue; }
        let evidence = onsets(backing, s - 0.035, s + 0.035);
        if evidence.contains(&k) { continue; } // Copied backing fallback is not an instrumental observation.
        let mut partners = onsets(&right.notes, s - 0.040, s + 0.040).iter().filter(|n| {
            (2..=12).contains(&k.pitch.abs_diff(n.pitch)) && k.end.min(n.end) - s.max(n.start) >= 0.045
        });
        let Some(first) = partners.next() else { continue };
        let mut multiple = false;
        let anchor = partners.fold(first, |a, n| { multiple = true; if n.end > a.end { n } else { a } });
        let end = k.end.min(anchor.end);
        let begin = right.notes.partition_point(|n| n.start < s - 0.95);
        let recent = &right.notes[begin..];
        let prior = recent[..recent.partition_point(|n| n.start < s - 0.068)].iter()
            .rposition(|n| n.pitch == k.pitch && n.end >= s - 0.015).map(|i| begin + i);
        // A one-note anchor alone can't establish a chord: require a re-strike or second detector.
        if !multiple && prior.is_none() && !evidence.iter().any(|n| n.pitch == k.pitch) { continue; }
        if piano.get(piano.partition_point(|&(_, t)| t <= s - 0.10)).is_some_and(|&(t, _)| t < end + 0.10)
            || onsets(vocals, s - vh - 0.24, end + 0.24).iter().any(|n| n.end > s - 0.24) { continue; }
        let mut shared = 0;
        let mut fingers = 0;
        let conflict = |n: &Note, treble: bool, shared: &mut u8, fingers: &mut usize| {
            if n.pitch != k.pitch && n.end > s - 0.040 && n.start < s + 0.050 { *shared |= shared_partials(k.pitch, n.pitch); }
            if n.end <= s || n.start >= end { return false; }
            if treble { *fingers += 1; *fingers >= 5 || n.pitch == k.pitch || n.pitch.abs_diff(k.pitch) > 12 } else { n.pitch >= k.pitch }
        };
        if onsets(&left.notes, s - lh - 0.040, end.max(s + 0.050)).iter().any(|n| conflict(n, false, &mut shared, &mut fingers)) { continue; }
        let existing = onsets(&right.notes, s - rh - 0.040, end.max(s + 0.050));
        if existing.iter().filter(|&n| !prior.is_some_and(|i| std::ptr::eq(n, &right.notes[i])))
            .chain(onsets(&added, s - added_span - 0.040, end.max(s + 0.050)))
            .any(|n| conflict(n, true, &mut shared, &mut fingers)) || !struck(wave, k, shared) { continue; }
        let velocity = k.velocity.min(anchor.velocity).saturating_sub(5).max(1);
        if let Some(i) = prior { right.notes[i].end = right.notes[i].end.min(s); }
        added.push(Note { end, velocity, ..k }); // instrumental attacks are already sorted
        added_span = added_span.max(end - s);
    }
    if !added.is_empty() {
        right.notes.append(&mut added);
        right.notes.sort_unstable_by(|a,b| a.start.total_cmp(&b.start).then(a.pitch.cmp(&b.pitch)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pmidi::Instrument;

    fn key(pitch: u8, start: f64, end: f64) -> Note { Note { pitch, start, end, velocity: 66 } }

    #[test]
    fn a_fresh_finger_needs_partial_energy_not_supplied_by_another_string() {
        let k = key(64, 0.5, 0.79);
        let anchor = key(69, 0.51, 0.70);
        let corroborated = key(64, 0.49, 0.74);
        let wave: Vec<_> = (0..SAMPLE_RATE).map(|i| {
            let t = f64::from(i) / f64::from(SAMPLE_RATE);
            let phase = std::f64::consts::TAU * 329.628 * t;
            if (0.50..0.72).contains(&t) { (0.2 * phase.sin() + 0.08 * (2. * phase).sin()) as f32 } else { 0. }
        }).collect();
        for (detector, left, piano, source, count) in [
            (Some(corroborated), None, None, &wave[..], 2),
            (Some(k), None, None, &wave[..], 1), // copied detector fallback
            (None, None, None, &wave[..], 1), // single anchor and no prior strike
            (Some(corroborated), Some(key(52, 0.5, 0.7)), None, &wave[..], 1), // octave harmonic
            (Some(corroborated), Some(key(57, 0.5, 0.7)), None, &wave[..], 1), // lower fifth supplies second partial
            (Some(corroborated), None, Some((0.49, 0.6)), &wave[..], 1),
            (Some(corroborated), None, None, &[][..], 1),
        ] {
            let mut m = PrettyMidi::new(960, 120.);
            let mut r = Instrument::new(0, false, "Right"); r.notes.push(anchor);
            let mut l = Instrument::new(0, false, "Left"); l.notes.extend(left);
            m.instruments.extend([r, l]);
            apply(&mut m, &[k], detector.as_slice(), &[], piano.as_slice(), source);
            assert_eq!(m.instruments[0].notes.len(), count);
            if count == 2 { assert_eq!(m.instruments[0].notes[0], Note { end: anchor.end, velocity: 61, ..k }); }
        }
    }
}

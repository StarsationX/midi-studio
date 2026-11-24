use super::*;

fn key(pitch: u8, start: f64, end: f64) -> Note {
    Note { pitch, start, end, velocity: 72 }
}

#[test]
fn confirmed_dyad_keeps_rolled_onset_but_not_the_following_keys_space() {
    let lead = key(79, 0.12, 0.33);
    let second = key(74, 0.11, 0.51);
    let third = key(71, 0.13, 0.36);
    let piano = [key(74, 0.114, 0.29), key(79, 0.126, 0.42)];
    let dyads = treble_dyads(&[lead], &[second, lead, third], &piano, &[], &[]);
    assert_eq!(dyads.len(), 1);
    assert_eq!((dyads[0].pitch, dyads[0].start, dyads[0].end), (74, 0.11, 0.33));
    assert!(dyads[0].velocity < lead.velocity);
    let prior = key(60, 0., lead.start);
    assert!(treble_dyads(&[prior, lead], &[second, lead], &piano, &[], &[]).is_empty());
}

#[test]
fn copied_detector_keys_and_vocal_attacks_are_not_instrumental_dyads() {
    let lead = key(78, 1., 1.4);
    let nearby = key(74, 1.01, 1.35);
    let both = [lead, nearby];
    let confirmation = [key(78, 1.01, 1.45)];
    assert!(treble_dyads(&[lead], &both, &both, &[], &[]).is_empty());
    assert!(treble_dyads(&[lead], &both, &confirmation, &[lead], &[]).is_empty());
    assert!(treble_dyads(&[lead], &both, &confirmation, &[], &[key(75, 1.2, 1.3)]).is_empty());
    assert!(treble_dyads(&[lead], &[lead, key(90, 1.01, 1.4)], &confirmation, &[], &[]).is_empty());
    assert_eq!(treble_dyads(&[lead], &both, &confirmation, &[], &[]).len(), 1);
}

#[test]
fn separately_timed_keys_keep_their_onsets_and_leave_room_for_the_next_roll() {
    let held = key(66, 0., 0.59);
    let next = key(74, 0.60, 1.);
    let upper = [key(76, 0.02, 0.5), key(74, 0.15, 0.6), key(75, 0.34, 0.8)];
    let mut extra = Vec::new();
    interior_treble(&[held, next], &upper, &[], &[], &[], &mut extra, 1.);
    assert_eq!(extra.len(), 2);
    assert_eq!((extra[0].start, extra[0].end, extra[0].pitch), (0.15, 0.34, 74));
    assert_eq!((extra[1].start, extra[1].end, extra[1].pitch), (0.34, next.start - 0.035, 75));
}

#[test]
fn interior_attacks_never_double_vocals_octaves_or_occupied_hands() {
    let held = key(64, 0., 0.7);
    let upper = key(74, 0.30, 0.55);
    for (n, vocals, bass, dyad) in [
        (key(76, 0.30, 0.55), None, None, None),
        (upper, Some(held), None, None),
        (upper, Some(key(80, 0.5, 1.)), None, None),
        (upper, None, Some(key(75, 0.36, 0.51)), None),
        (upper, None, None, Some(key(70, 0., 0.4))),
    ] {
        let mut extra: Vec<_> = dyad.into_iter().collect();
        let count = extra.len();
        interior_treble(&[held], &[n], &[], vocals.as_slice(), bass.as_slice(), &mut extra, 1.);
        assert_eq!(extra.len(), count);
    }
}

#[test]
fn touching_upper_fragment_needs_an_accent_or_an_independent_attack() {
    let held = key(64, 0.1, 0.7);
    let previous = key(74, 0., 0.3);
    let weak = Note { velocity: 60, ..key(74, 0.3, 0.6) };
    let piano = key(74, 0.31, 0.53);
    for (attack, confirmation, count) in [
        (weak, None, 0),
        (weak, Some(piano), 1),
        (Note { velocity: previous.velocity + 5, ..weak }, None, 1),
    ] {
        let mut extra = Vec::new();
        interior_treble(&[held], &[previous, attack], confirmation.as_slice(), &[], &[], &mut extra, 1.);
        assert_eq!(extra.len(), count);
    }
}

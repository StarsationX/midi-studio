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
    let dyads = treble_partners(&[lead], &[second, lead, third], &piano, &[], &[]);
    assert_eq!(dyads.len(), 1);
    assert_eq!((dyads[0].pitch, dyads[0].start, dyads[0].end), (74, 0.11, 0.33));
    assert!(dyads[0].velocity < lead.velocity);
    let prior = key(60, 0., lead.start);
    assert!(treble_partners(&[prior, lead], &[second, lead], &piano, &[], &[]).is_empty());
}

#[test]
fn copied_detector_keys_and_vocal_attacks_are_not_instrumental_dyads() {
    let lead = key(78, 1., 1.4);
    let nearby = key(74, 1.01, 1.35);
    let both = [lead, nearby];
    let confirmation = [key(78, 1.01, 1.45)];
    assert!(treble_partners(&[lead], &both, &both, &[], &[]).is_empty());
    assert!(treble_partners(&[lead], &both, &confirmation, &[lead], &[]).is_empty());
    assert!(treble_partners(&[lead], &both, &confirmation, &[], &[key(75, 1.2, 1.3)]).is_empty());
    assert!(treble_partners(&[lead], &[lead, key(90, 1.01, 1.4)], &confirmation, &[], &[]).is_empty());
    assert_eq!(treble_partners(&[lead], &both, &confirmation, &[], &[]).len(), 1);
}

#[test]
fn middle_partner_needs_its_own_detector_agreement_and_free_left_hand_space() {
    let lead = key(67, 1., 1.4);
    let middle = key(62, 1.01, 1.35);
    let attacks = [lead, middle];
    let lead_only = [key(67, 1.01, 1.35)];
    assert!(treble_partners(&[lead], &attacks, &lead_only, &[], &[]).is_empty());
    assert!(treble_partners(&[lead], &attacks, &[middle], &[], &[]).is_empty());
    let piano = [key(62, 1.015, 1.32)];
    let low = key(50, 0.94, 1.25);
    for left in [
        [key(62, 0.7, 1.04), low], // a held chord member, not the latest bass note
        [low, key(64, 1.23, 1.36)], // crossing later in the dyad's sustain
    ] {
        assert!(treble_partners(&[lead], &attacks, &piano, &[], &left).is_empty());
    }
    let dyads = treble_partners(&[lead], &attacks, &piano, &[], &[low]);
    assert_eq!(dyads.len(), 1);
    assert_eq!((dyads[0].pitch, dyads[0].start, dyads[0].end), (62, 1.01, 1.35));
}

#[test]
fn a_corroborated_inner_key_does_not_replace_an_available_upper_voice() {
    let lead = key(67, 1., 1.4);
    let mid = Note { velocity: 100, ..key(62, 1., 1.3) };
    let upper = key(71, 1.01, 1.35);
    let piano = [key(62, 1.01, 1.35), key(67, 1.02, 1.3)];
    let partners = treble_partners(&[lead], &[mid, lead, upper], &piano, &[], &[]);
    assert_eq!(partners.len(), 2);
    assert_eq!((partners[0].pitch, partners[0].start), (mid.pitch, mid.start));
    assert_eq!((partners[1].pitch, partners[1].start), (upper.pitch, upper.start));

    let wide = key(75, upper.start, upper.end);
    let partners = treble_partners(&[lead], &[mid, lead, wide], &piano, &[], &[]);
    assert_eq!(partners.len(), 1);
    assert_eq!(partners[0].pitch, wide.pitch);
}

#[test]
fn an_early_strum_partner_can_outlast_its_neighbor() {
    let held = key(64, 1., 1.7);
    let mut partners = vec![key(60, 0.99, 1.5), key(68, 1.01, 1.25)];
    interior_treble(&[held], &[key(74, 1.3, 1.55)], &[], &[], &[], &mut partners, 2.);
    assert_eq!(partners.len(), 2);
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

#[test]
fn a_confirmed_strike_replaces_its_short_lead_in_without_cutting_the_next_roll() {
    let short = key(60, 0.18, 0.238);
    let strike = Note { velocity: 85, ..key(60, 0.238, 0.75) };
    let roll = key(65, 0.48, 0.70);
    let next = Note { velocity: 104, ..key(67, 0.50, 0.80) };
    let backing = [key(62, 0., 0.13), short, strike, roll, next];
    let heard = key(60, 0.240, 0.65);
    let piano = [heard, key(65, 0.485, 0.68)];
    let line = melody(&[], &backing, &piano, 1., 0.5);
    assert_eq!(line.len(), 3);
    assert_eq!((line[1].start, line[1].end, line[2].start), (strike.start, roll.start, next.start));
    let partners = treble_partners(&line, &backing, &piano, &[], &[]);
    assert_eq!(partners.len(), 1);
    assert_eq!((partners[0].pitch, partners[0].start), (roll.pitch, roll.start));

    // Neither a neighboring piano key nor a copied detector event confirms
    // the strike. An independently heard lead-in must also stay in place.
    for evidence in [&[key(61, 0.240, 0.65)][..], &[strike], &[short, heard]] {
        let line = melody(&[], &backing, evidence, 1., 0.5);
        assert_eq!((line[1].start, line[1].end), (short.start, short.end));
    }
}

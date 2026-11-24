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

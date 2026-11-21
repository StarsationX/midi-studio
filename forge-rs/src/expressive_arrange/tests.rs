use super::*;

/// Opt-in validation against a local recording; no commercial fixture is bundled.
#[test]
#[ignore = "set FORGE_TEMPO_FIXTURE to an audio file"]
fn inspect_recording_tempo() {
    let source = std::env::var_os("FORGE_TEMPO_FIXTURE").expect("FORGE_TEMPO_FIXTURE");
    let audio = crate::audio::load(std::path::Path::new(&source)).unwrap();
    let mono = crate::audio::Audio::downmix(&audio.samples, audio.channels);
    let changes = tempo_map(&mono, audio.sample_rate);
    assert!(!changes.is_empty(), "No stable pulse found");
    eprintln!("Measured tempo map (source seconds, BPM): {changes:?}");
}

#[test]
#[ignore = "set FORGE_BASS_FIXTURE and FORGE_BASS_FIXTURE_OUTPUT for a reference comparison"]
fn export_bass_fixture() {
    let source = std::env::var_os("FORGE_BASS_FIXTURE").expect("FORGE_BASS_FIXTURE");
    let output = std::env::var_os("FORGE_BASS_FIXTURE_OUTPUT").expect("FORGE_BASS_FIXTURE_OUTPUT");
    let audio = crate::audio::load(std::path::Path::new(&source)).unwrap();
    let mono = crate::audio::Audio::downmix(&audio.samples, audio.channels);
    let notes = bass_notes(&mono, audio.sample_rate).unwrap();
    let midi = arrange(&[], &[], Some(&notes), mono.len() as f64 / f64::from(audio.sample_rate), &[]);
    assert!(!notes.is_empty());
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(output).unwrap();
    std::io::Write::write_all(&mut file, &midi.to_bytes().unwrap()).unwrap();
    eprintln!("Exported {} bass attacks", notes.len());
}

fn note(pitch: u8, start: f64, end: f64) -> Note {
    Note {
        pitch,
        start,
        end,
        velocity: 80,
    }
}

#[test]
fn keeps_exact_syllable_times_and_register_across_a_breath() {
    let vocals = [
        note(48, 0.1, 0.4),
        note(47, 1.1, 1.55),
        note(89, 1.55, 1.85),
    ];
    let backing = [56, 63, 68].map(|p| note(p, 0.65, 0.9));
    let bass = [note(28, 0., 0.45), note(50, 1.60, 1.86)];
    let midi = arrange(&vocals, &backing, Some(&bass), 2., &[]);
    let lead = &midi.instruments[0].notes;
    assert_eq!(lead.len(), vocals.len());
    for (first, second) in vocals.iter().zip(lead) {
        assert_eq!(
            (first.start, first.pitch, first.end),
            (second.start, second.pitch, second.end)
        );
    }
    assert!(midi.instruments[1]
        .notes
        .iter()
        .any(|n| n.pitch == 50 && n.start == 1.60));
}

#[test]
fn instrumental_hook_survives_sustain_and_louder_inner_voices() {
    let backing = [
        note(76, 0., 0.9),
        note(59, 0.12, 0.45), // moving accompaniment under the held E
        Note { velocity: 90, ..note(62, 0.25, 0.64) },
        note(74, 0.25, 0.62),
        note(72, 0.5, 0.88),
        note(72, 0.88, 1.2), // reattack with no silent gap
        note(59, 1.65, 1.85), // new phrase in a different register
    ];
    let midi = arrange(&[], &backing, Some(&[]), 2., &[]);
    let line: Vec<_> = midi.instruments[0].notes.iter().map(|n| (n.pitch, n.start, n.end)).collect();
    assert_eq!(line, [(76, 0., 0.25), (74, 0.25, 0.5), (72, 0.5, 0.88),
        (72, 0.88, 1.2), (59, 1.65, 1.85)]);
}

#[test]
fn supported_staccato_leap_survives_but_isolated_spike_does_not() {
    let backing = [note(72, 0., 0.8), note(89, 0.25, 0.29), note(91, 0.36, 0.40),
        note(89, 0.47, 0.51), note(94, 1.4, 1.44)];
    let midi = arrange(&[], &backing, Some(&[]), 2., &[]);
    let line: Vec<_> = midi.instruments[0].notes.iter().map(|n| (n.pitch, n.start, n.end)).collect();
    assert_eq!(line, [(72, 0., 0.25), (89, 0.25, 0.29), (91, 0.36, 0.40), (89, 0.47, 0.51)]);
}

#[test]
fn joins_a_fading_split_without_erasing_repeated_attacks() {
    let sources = [
        note(76, 0., 0.10),
        Note { velocity: 66, ..note(76, 0.10, 0.19) }, // fading continuation
        Note { velocity: 89, ..note(76, 0.19, 0.27) }, // fresh accent
        Note { velocity: 62, ..note(76, 0.30, 0.39) }, // clear release
        note(74, 0.40, 0.60),
    ];
    let shape = |m: PrettyMidi| m.instruments[0].notes.iter()
        .map(|n| (n.pitch, n.start, n.end)).collect::<Vec<_>>();
    assert_eq!(shape(arrange(&[], &sources, Some(&[]), 1., &[])),
        [(76, 0., 0.19), (76, 0.19, 0.27), (76, 0.30, 0.39), (74, 0.40, 0.60)]);
    assert_eq!(shape(arrange(&sources, &[], Some(&[]), 1., &[])),
        sources.map(|n| (n.pitch, n.start, n.end)));
}

#[test]
fn octave_echo_is_not_a_new_attack_but_a_confirmed_repeat_is() {
    let a = note(60, 0., 0.20);
    let b = note(60, 0.20, 0.31);
    let c = note(60, 0.35, 0.45);
    let d = note(60, 0.56, 0.68);
    let upper = [note(72, 0.12, 0.42), note(72, 0.49, 0.72)];
    for (piano, expected) in [
        (&[][..], vec![(0., 0.31), (0.56, 0.68)]),
        (&[c][..], vec![(0., 0.31), (0.35, 0.45), (0.56, 0.68)]),
    ] {
        let mut line = vec![a, b, c, d];
        remove_octave_echoes(&mut line, &upper, piano, 0.5);
        assert_eq!(line.iter().map(|n| (n.start, n.end)).collect::<Vec<_>>(), expected);
    }
}

#[test]
fn fleeting_distant_support_yields_to_the_next_bass() {
    let melody = [note(76, 0., 1.)];
    let harmony = [60, 64, 67].map(|p| note(p, 0.2, 0.7));
    for (pitch, landing, expect_chord) in [(29, 0.30, false), (29, 0.45, true), (48, 0.30, true)] {
        let bass = [note(pitch, landing, 0.8)];
        let midi = arrange_with_harmony(&melody, &[], &harmony, Some(&bass), 1., &[]);
        let left = &midi.instruments[1].notes;
        assert_eq!(left.iter().any(|n| n.start == 0.2), expect_chord);
        assert!(left.iter().any(|n| n.pitch == pitch && n.start == landing && n.end == 0.8));
        assert_eq!(midi.instruments[0].notes.len(), 1);
        assert_eq!(midi.instruments[0].notes[0].pitch, 76);
    }
}

#[test]
fn chord_tones_ring_across_repeated_bass_only_as_long_as_sounded() {
    let sources = [note(60, 0.1, 1.4), note(64, 0.1, 1.05), note(67, 0.1, 1.45)];
    let bass = [note(48, 0., 0.47), note(48, 0.5, 0.97), note(48, 1., 1.47)];
    let midi = arrange(&[note(76, 0., 1.6)], &sources, Some(&bass), 1.6, &[]);
    let chord: Vec<_> = midi.instruments[1]
        .notes
        .iter()
        .filter(|n| n.start == 0.1)
        .map(|n| (n.pitch, n.end))
        .collect();
    assert_eq!(chord, [(52, 1.05), (55, 1.45)]);
}

#[test]
fn dense_source_stays_within_an_octave_and_deep_bass_has_space() {
    let mut backing = vec![];
    for i in 0..11 {
        let t = 0.10 + i as f64 * 0.11;
        for p in [43, 45, 48, 51, 52, 58, 60, 63, 67, 69, 74] {
            backing.push(note(p, t, t + 0.35));
        }
    }
    let bass = [note(41, 0., 0.52), note(36, 0.52, 1.31)];
    let midi = arrange(
        &[note(69, 0.137, 0.42), note(71, 0.42, 1.31)],
        &backing,
        Some(&bass),
        1.31,
        &[(0., 89.)],
    );
    let notes = &midi.instruments[1].notes;
    assert!(notes.len() < 13);
    for n in notes {
        let sounding: Vec<_> = notes
            .iter()
            .filter(|x| x.start <= n.start && n.start < x.end)
            .map(|x| x.pitch)
            .collect();
        assert!(
            sounding.len() <= 3
                && sounding.iter().max().unwrap() - sounding.iter().min().unwrap() <= 12
        );
    }
    let midi = arrange(
        &[note(72, 0., 1.)],
        &[48, 52, 55].map(|p| note(p, 0., 1.)),
        Some(&[note(24, 0., 1.)]),
        1.,
        &[],
    );
    assert_eq!(
        midi.instruments[1]
            .notes
            .iter()
            .map(|n| n.pitch)
            .collect::<Vec<_>>(),
        [24, 31]
    );
}

#[test]
fn bass_repeated_same_key_attacks_follow_the_recorded_envelope() {
    let starts = [0.18, 0.51, 0.84, 1.17];
    let wave: Vec<f32> = (0..24000)
        .map(|i| {
            let t = i as f64 / 12000.;
            let gain: f64 = starts
                .iter()
                .filter(|&&s| s <= t && t < 1.5)
                .map(|s| 0.30 * ((s - t) / 0.16).exp())
                .sum();
            (gain * (std::f64::consts::TAU * 55. * t).sin()) as f32
        })
        .collect();
    let bass = bass_notes(&wave, 12000).unwrap();
    assert_eq!(bass.len(), starts.len(), "{bass:?}");
    for (n, start) in bass.iter().zip(starts) {
        assert_eq!(n.pitch, 33);
        assert!((n.start - start).abs() < 0.035, "{n:?}");
    }
    assert!(bass_notes(&vec![0.; 6000], 6000).unwrap().is_empty());
}

#[test]
fn measures_a_tempo_change_and_writes_events_at_source_seconds() {
    let rate = 8000;
    let mut wave = vec![0.; 38 * rate];
    let boundary = 32. * 60. / 106.;
    for (start, end, bpm) in [(0., boundary, 106.), (boundary, 38., 128.)] {
        let mut t: f64 = start;
        while t < end - 0.02 {
            let index = (t * rate as f64).round() as usize;
            for k in 0..80 {
                let hann = 0.5 - 0.5 * (std::f64::consts::TAU * k as f64 / 79.).cos();
                wave[index + k] =
                    (hann * (std::f64::consts::TAU * 1830. * k as f64 / rate as f64).sin()) as f32;
            }
            t += 60. / bpm;
        }
    }
    let changes = tempo_map(&wave, rate as u32);
    assert_eq!(changes.len(), 2, "{changes:?}");
    assert!((changes[0].1 - 106.).abs() < 0.75 && (changes[1].1 - 128.).abs() < 0.75);
    assert!((changes[1].0 - boundary).abs() < 0.05, "{changes:?}");
    assert!(tempo_map(&vec![0.; rate * 7], rate as u32).is_empty());
    let source = [0.583, 17.987, 18.023, 29.051]
        .into_iter()
        .enumerate()
        .map(|(i, t)| note(60 + i as u8, t, t + 0.23))
        .collect::<Vec<_>>();
    let midi = arrange(&source, &[], Some(&[]), 38., &changes);
    let reload = PrettyMidi::from_bytes(&midi.to_bytes().unwrap()).unwrap();
    assert_eq!(reload.tick_scales.len(), 2);
    for (n, original) in reload.instruments[0].notes.iter().zip(&source) {
        assert!((n.start - original.start).abs() < 0.0005 && (n.end - original.end).abs() < 0.0005);
    }
}

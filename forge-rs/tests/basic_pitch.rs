//! basic-pitch decode, pretty_midi writer/reader, stem_to_midi cleanup and
//! melody candidates against the forge env's own Python, from real model
//! output (tools/make_bp_fixture.py). No ONNX Runtime needed.

use forge_rs::basicpitch::{self, Output, Params, N_CONTOUR, N_NOTES};
use forge_rs::dump::read_npy_f32;
use forge_rs::melody::{self, MelodyOpts};
use forge_rs::pmidi::PrettyMidi;
use forge_rs::stemmidi::{self, StemOpts};
use std::path::PathBuf;

fn fix(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name)
}

fn output() -> Output {
    let (sn, note) = read_npy_f32(&fix("bp_note.npy")).unwrap();
    let (_, onset) = read_npy_f32(&fix("bp_onset.npy")).unwrap();
    let (sc, contour) = read_npy_f32(&fix("bp_contour.npy")).unwrap();
    assert_eq!((sn[1], sc[1]), (N_NOTES, N_CONTOUR));
    Output { frames: sn[0], note, onset, contour }
}

fn stem_params() -> Params {
    Params { onset_threshold: 0.5, frame_threshold: 0.3, minimum_note_length: 58.0, minimum_frequency: Some(27.5), maximum_frequency: Some(4186.0), melodia_trick: true, midi_tempo: 120.0 }
}

fn stem_opts() -> StemOpts {
    StemOpts {
        min_note_sec: 0.03,
        min_velocity: 20,
        min_pitch: 0,
        max_pitch: 127,
        bp_onset: 0.5,
        bp_frame: 0.3,
        bp_min_note_ms: 58,
        bp_min_freq: Some(27.5),
        bp_max_freq: Some(4186.0),
        octave_fold: true,
        fold_min: 21,
        fold_max: 108,
        max_polyphony: 0,
        loudness_norm: true,
        normalize: Default::default(),
        velocity_gamma: 0.85,
    }
}

#[test]
fn decode_and_write_match_basic_pitch() {
    let raw = basicpitch::output_to_midi(output(), &stem_params());
    let bytes = raw.to_bytes().unwrap();
    assert_eq!(bytes, std::fs::read(fix("bp_raw.mid")).unwrap(), "predict(...).write()");
    let mut pm = PrettyMidi::from_bytes(&bytes).unwrap();
    stemmidi::clean_midi(&mut pm, &stem_opts());
    assert_eq!(pm.to_bytes().unwrap(), std::fs::read(fix("bp_clean.mid")).unwrap(), "stem_to_midi.clean_midi");
}

#[test]
fn melody_candidates_match_melody_shape() {
    let p = Params {
        onset_threshold: 0.42,
        frame_threshold: 0.28,
        minimum_note_length: 30.0,
        minimum_frequency: Some(basicpitch::midi_to_hz(45.0)),
        maximum_frequency: Some(basicpitch::midi_to_hz(100.0)),
        melodia_trick: true,
        midi_tempo: 120.0,
    };
    let raw = basicpitch::output_to_midi(output(), &p).to_bytes().unwrap();
    assert_eq!(raw, std::fs::read(fix("bp_raw_melody.mid")).unwrap());
    let o = MelodyOpts { min_pitch: 45, max_pitch: 100, fold: true, density: 13.0, onset: 0.42, frame: 0.28, min_note_ms: 30, strict_fifths: true };
    let (_, cands) = melody::build_candidates(&PrettyMidi::from_bytes(&raw).unwrap(), &o, &mut |_| {}).unwrap();
    for c in cands {
        assert_eq!(c.midi.to_bytes().unwrap(), std::fs::read(fix(&format!("bp_melody_{}.mid", c.name))).unwrap(), "{}", c.name);
    }
}

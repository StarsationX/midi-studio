//! Golden tests against fixtures produced by the real Python code
//! (tools/make_test_fixtures.py). Every test first puts the test process in
//! a 7.5 GiB job object.

use forge_rs::assets::AssetPaths;
use forge_rs::dump::{read_npy_f32, Dump};
use forge_rs::{audio, crf, memlimit, midi, post, resample, Note, Options, Transcriber};
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::sync::Once;

static CAP: Once = Once::new();

fn cap() {
    CAP.call_once(|| {
        memlimit::apply(memlimit::DEFAULT_LIMIT_BYTES).expect("job object");
        assert!(!memlimit::can_allocate(9 << 30), "memory cap not active");
    });
}

fn fix(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name)
}

#[derive(Deserialize)]
struct NotesFile {
    notes: Vec<Note>,
}

fn load_notes(p: &Path) -> Vec<Note> {
    serde_json::from_str::<NotesFile>(&std::fs::read_to_string(p).unwrap()).unwrap().notes
}

#[test]
fn memory_cap_refuses_9gib() {
    cap();
    assert!(!memlimit::can_allocate(9 << 30));
    assert!(memlimit::can_allocate(256 << 20));
}

#[test]
fn golden_crf_viterbi_backward() {
    cap();
    #[derive(Deserialize)]
    struct Exp {
        #[serde(rename = "T")]
        t: usize,
        #[serde(rename = "B")]
        b: usize,
        forced: Vec<usize>,
        with_forced: Vec<Vec<(usize, usize)>>,
        no_forced: Vec<Vec<(usize, usize)>>,
    }
    let e: Exp = serde_json::from_str(&std::fs::read_to_string(fix("crf_expected.json")).unwrap()).unwrap();
    let (_, score) = read_npy_f32(&fix("crf_score.npy")).unwrap();
    let (_, noise) = read_npy_f32(&fix("crf_noise.npy")).unwrap();
    assert_eq!(crf::viterbi_backward(&score, &noise, e.t, e.b, Some(&e.forced)), e.with_forced);
    assert_eq!(crf::viterbi_backward(&score, &noise, e.t, e.b, None), e.no_forced);
}

#[test]
fn golden_soxr_bit_exact() {
    cap();
    let (shape, x) = read_npy_f32(&fix("soxr_in.npy")).unwrap();
    let ch = shape[1];
    let (eshape, expect) = read_npy_f32(&fix("soxr_out_48k_st.npy")).unwrap();
    let y = resample::resample_hq(&x, ch, 48000.0, 44100.0).unwrap();
    assert_eq!(y.len(), eshape.iter().product::<usize>());
    assert!(y.iter().zip(&expect).all(|(a, b)| a.to_bits() == b.to_bits()), "48k stereo not bit-exact");

    let mono: Vec<f32> = x.chunks_exact(ch).map(|f| f[0]).collect();
    let (_, expect) = read_npy_f32(&fix("soxr_out_16k_mono.npy")).unwrap();
    let y = resample::resample_hq(&mono, 1, 16000.0, 44100.0).unwrap();
    assert_eq!(y.len(), expect.len());
    assert!(y.iter().zip(&expect).all(|(a, b)| a.to_bits() == b.to_bits()), "16k mono not bit-exact");
}

#[test]
fn golden_midi_writer_and_cleanup() {
    cap();
    let notes = load_notes(&fix("midi_notes.json"));
    let bytes = midi::to_bytes(&notes).unwrap();
    assert_eq!(bytes, std::fs::read(fix("midi_expected.mid")).unwrap(), "writeMidi bytes differ");

    let piano = midi::piano_from_notes(&notes).unwrap();
    let (_, _, cleaned) = post::clean_midi(&piano, &post::CleanOpts::default());
    let bytes = midi::piano_to_bytes(cleaned.as_ref()).unwrap();
    assert_eq!(bytes, std::fs::read(fix("midi_clean_expected.mid")).unwrap(), "clean_midi bytes differ");
}

#[test]
fn readaudio_scaling_16bit() {
    cap();
    let a = audio::load(&fix("demo_16k.wav")).unwrap();
    assert_eq!((a.sample_rate, a.channels), (16000, 1));
    assert_eq!(a.readaudio_scaled(), a.samples);
    assert!(a.samples.iter().all(|&v| (v * 32768.0).fract() == 0.0));
}

/// Full pipeline vs the Python ONNX path (CPU) on the demo fixture. Needs
/// the model files; set FORGE_RS_MODELS / FORGE_RS_AUX / ORT_DYLIB_PATH, or
/// have the forge-env installed. Set FORGE_RS_REQUIRE_MODELS=1 to fail
/// (instead of skip) when they are missing.
#[test]
fn golden_end_to_end_demo() {
    cap();
    let models = std::env::var_os("FORGE_RS_MODELS").map(PathBuf::from);
    let aux = std::env::var_os("FORGE_RS_AUX").map(PathBuf::from);
    let paths = match AssetPaths::resolve(models.as_deref(), aux.as_deref()) {
        Ok(p) => p,
        Err(e) => {
            if std::env::var_os("FORGE_RS_REQUIRE_MODELS").is_some() {
                panic!("models required: {e:#}");
            }
            eprintln!("SKIP golden_end_to_end_demo: {e:#}");
            return;
        }
    };
    let opts = Options::default();
    let mut tr = Transcriber::new(&paths, &opts).expect("load models");
    let (notes, _) = tr.transcribe_file(&fix("demo_16k.wav"), &opts, &Dump::none()).unwrap();
    let expect = load_notes(&fix("demo_16k.expected.json"));
    assert_eq!(notes.len(), expect.len(), "note count");
    let mut max_dt = 0f64;
    for (a, b) in notes.iter().zip(&expect) {
        assert_eq!((a.pitch, a.velocity, a.has_onset, a.has_offset), (b.pitch, b.velocity, b.has_onset, b.has_offset));
        max_dt = max_dt.max((a.start - b.start).abs()).max((a.end - b.end).abs());
    }
    eprintln!("golden e2e: {} notes, max onset/offset diff {:.3e} s", notes.len(), max_dt);
    assert!(max_dt < 1e-6, "timing drift {max_dt} s");
    assert_eq!(midi::to_bytes(&notes).unwrap(), std::fs::read(fix("demo_16k.expected.mid")).unwrap());
    eprintln!("[memcap] {}", memlimit::peaks());
}

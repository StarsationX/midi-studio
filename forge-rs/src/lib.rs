//! forge-rs: MIDI Studio's Transkun v2 piano transcription without Python.
//!
//! Pipeline (mirrors python-engine/transcribe_onnx_dml.py on CPU):
//! audio decode (pydub scale) -> soxr HQ resample to 44.1 kHz -> mono ->
//! 16 s / 8 s-hop segments -> 6-window mel front-end -> transkun_v2.onnx
//! (ONNX Runtime, CPU, fp32) -> semi-CRF Viterbi -> velocity / refined
//! onset-offset heads -> cross-segment merge -> pretty_midi-identical MIDI.
//! `post` adds transcribe.py's loudness normalisation and MIDI cleanup.
//!
//! Separation (mirrors MSST inference.py with BS-Rofo-SW-Fixed): librosa-style
//! load -> `demix` (MSST chunking / fades) -> per chunk torch-exact STFT ->
//! BS-Roformer body (ONNX, CPU or CUDA fp32) -> complex masks -> iSTFT ->
//! six float WAV stems (`separate`, `roformer`, `stft`, `demix`).

pub mod assets;
pub mod audio;
pub mod backbone;
pub mod config;
pub mod crf;
pub mod demix;
pub mod dump;
pub mod frontend;
pub mod heads;
pub mod memlimit;
pub mod midi;
pub mod model_cache;
pub mod ortenv;
pub mod ortopts;
pub mod pipeline;
pub mod post;
pub mod resample;
pub mod roformer;
pub mod separate;
pub mod stft;
pub mod transcribe;

pub use transcribe::{Note, Options, Transcriber};

//! Spotify basic-pitch 0.4.0 as the forge env runs it: the ONNX model
//! (`saved_models/icassp_2022/nmp.onnx`, the backend `basic_pitch` picks
//! when only onnxruntime is installed) on ONNX Runtime's CPU EP, fed the way
//! `inference.get_audio_input` frames the audio, and decoded with
//! `note_creation.model_output_to_notes` (onset inference, peak picking,
//! the melodia trick, pitch bends) into the same pretty_midi object.

use crate::audio::Audio;
use crate::dsp::np_mean_f32;
use crate::pmidi::{Instrument, Note, PitchBend, PrettyMidi};
use crate::resample;
use anyhow::{anyhow, bail, Context, Result};
use ort::session::Session;
use ort::value::Tensor;
use std::collections::BinaryHeap;
use std::path::{Path, PathBuf};

pub const SAMPLE_RATE: u32 = 22050;
pub const FFT_HOP: usize = 256;
/// AUDIO_SAMPLE_RATE * AUDIO_WINDOW_LENGTH - FFT_HOP
pub const AUDIO_N_SAMPLES: usize = 22050 * 2 - FFT_HOP;
/// ANNOTATIONS_FPS * AUDIO_WINDOW_LENGTH
pub const ANNOT_N_FRAMES: usize = (22050 / FFT_HOP) * 2;
const N_OVERLAPPING_FRAMES: usize = 30;
const OVERLAP_LEN: usize = N_OVERLAPPING_FRAMES * FFT_HOP;
const HOP_SIZE: usize = AUDIO_N_SAMPLES - OVERLAP_LEN;
pub const N_NOTES: usize = 88;
pub const N_CONTOUR: usize = 88 * 3;
const MIDI_OFFSET: usize = 21;
const MAX_FREQ_IDX: usize = 87;
pub const MODEL_NAME: &str = "nmp.onnx";

/// Where the model lives: FORGE_RS_BP_MODEL, the forge env's basic_pitch
/// package, then `<exe dir>/assets/basic_pitch/nmp.onnx`.
pub fn default_model_path() -> Result<PathBuf> {
    let mut cands: Vec<PathBuf> = Vec::new();
    if let Some(p) = std::env::var_os("FORGE_RS_BP_MODEL").filter(|v| !v.is_empty()) {
        let p = PathBuf::from(p);
        return if p.is_file() { Ok(p) } else { Err(anyhow!("{} not found", p.display())) };
    }
    let rel = "python/Lib/site-packages/basic_pitch/saved_models/icassp_2022";
    if let Some(f) = crate::ortenv::forge_env_dir() {
        cands.push(f.join(rel).join(MODEL_NAME));
    }
    if let Some(l) = std::env::var_os("LOCALAPPDATA") {
        cands.push(PathBuf::from(l).join("midi-studio/forge-env").join(rel).join(MODEL_NAME));
    }
    if let Some(d) = std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf)) {
        cands.push(d.join("assets/basic_pitch").join(MODEL_NAME));
        if let Some(up) = d.parent().and_then(Path::parent) {
            cands.push(up.join("assets/basic_pitch").join(MODEL_NAME));
        }
    }
    cands.iter().find(|p| p.is_file()).cloned().ok_or_else(|| anyhow!("basic-pitch model {MODEL_NAME} not found (looked in {cands:?}; set FORGE_RS_BP_MODEL)"))
}

/// `librosa.load(path, sr=22050, mono=True)` on already-decoded audio:
/// float32 channel mean, then soxr HQ and `fix_length(ceil(n * ratio))`.
pub fn load_mono(a: &Audio, sr: u32) -> Result<Vec<f32>> {
    if let Some(d) = dump_dir() {
        let _ = std::fs::create_dir_all(&d);
        let _ = crate::dump::write_npy_f32(&d.join("pre.npy"), &[a.frames(), a.channels], &a.samples);
    }
    let mono = Audio::downmix(&a.samples, a.channels);
    if a.sample_rate == sr {
        return Ok(mono);
    }
    let ratio = sr as f64 / a.sample_rate as f64;
    let n = (mono.len() as f64 * ratio).ceil() as usize;
    let mut y = resample::resample_hq(&mono, 1, a.sample_rate as f64, sr as f64)?;
    y.resize(n, 0.0);
    Ok(y)
}

pub struct Model {
    session: Session,
}

/// Model output, unwrapped: `[frames][88]`, `[frames][88]`, `[frames][264]`.
pub struct Output {
    pub frames: usize,
    pub note: Vec<f32>,
    pub onset: Vec<f32>,
    pub contour: Vec<f32>,
}

impl Model {
    /// `ort.InferenceSession(path, providers=["CPUExecutionProvider"])`:
    /// default session options, CPU only.
    pub fn load(path: &Path, intra_threads: Option<usize>) -> Result<Model> {
        let mut b = Session::builder(crate::backbone::environment()?)?;
        if let Some(n) = intra_threads {
            b = b.with_intra_threads(n).map_err(|e| anyhow!("{e}"))?;
        }
        b = b.with_execution_providers([ort::ep::CPU::default().build()]).map_err(|e| anyhow!("CPU EP: {e}"))?;
        let session = b.commit_from_file(path).with_context(|| format!("loading {}", path.display()))?;
        Ok(Model { session })
    }

    /// inference.run_inference on 22.05 kHz mono audio.
    pub fn run(&mut self, audio: &[f32]) -> Result<Output> {
        self.run_frames(audio, true)
    }

    fn run_frames(&mut self, audio: &[f32], with_contour: bool) -> Result<Output> {
        if let Some(d) = dump_dir() {
            let _ = std::fs::create_dir_all(&d);
            let _ = crate::dump::write_npy_f32(&d.join("audio.npy"), &[audio.len()], audio);
        }
        let original_length = audio.len();
        let mut padded = vec![0f32; OVERLAP_LEN / 2];
        padded.extend_from_slice(audio);
        let n_olap = N_OVERLAPPING_FRAMES / 2;
        let keep = ANNOT_N_FRAMES - 2 * n_olap;
        let (mut note, mut onset, mut contour) = (Vec::new(), Vec::new(), Vec::new());
        let mut windows = 0usize;
        let mut i = 0usize;
        while i < padded.len() {
            let end = (i + AUDIO_N_SAMPLES).min(padded.len());
            let mut w = padded[i..end].to_vec();
            w.resize(AUDIO_N_SAMPLES, 0.0);
            let input = Tensor::from_array(([1usize, AUDIO_N_SAMPLES, 1], w))?;
            let out = self.session.run(ort::inputs!["serving_default_input_2:0" => input])?;
            for (name, width, dst) in [
                ("StatefulPartitionedCall:1", N_NOTES, &mut note),
                ("StatefulPartitionedCall:2", N_NOTES, &mut onset),
                ("StatefulPartitionedCall:0", N_CONTOUR, &mut contour),
            ] {
                if width == N_CONTOUR && !with_contour { continue; }
                let (shape, data) = out[name].try_extract_tensor::<f32>()?;
                let dims: Vec<usize> = shape.iter().map(|&d| d as usize).collect();
                if dims != [1, ANNOT_N_FRAMES, width] {
                    bail!("basic-pitch output {name}: shape {dims:?}");
                }
                dst.extend_from_slice(&data[n_olap * width..(n_olap + keep) * width]);
            }
            windows += 1;
            i += HOP_SIZE;
        }
        let n_orig = (original_length as f64 * ((22050 / FFT_HOP) as f64 / SAMPLE_RATE as f64)).floor() as usize;
        let frames = n_orig.min(windows * keep);
        note.truncate(frames * N_NOTES);
        onset.truncate(frames * N_NOTES);
        contour.truncate(frames * N_CONTOUR);
        Ok(Output { frames, note, onset, contour })
    }

    /// Source-timed instrumental attacks, without pitch bends. Decode bounded
    /// blocks so a long song does not require a song-sized polyphonic decoder heap.
    pub(crate) fn instrumental_notes(&mut self, mono: &[f32]) -> Result<Vec<Note>> {
        const BLOCK: usize = 20 * HOP_SIZE;
        const KEPT: usize = ANNOT_N_FRAMES - N_OVERLAPPING_FRAMES;
        let rate = f64::from(SAMPLE_RATE);
        let mut notes = Vec::new();
        for begin in (0..mono.len()).step_by(BLOCK) {
            let end = (begin + BLOCK).min(mono.len());
            // A complete model window on each side; only the central block owns attacks.
            let left = begin.saturating_sub(HOP_SIZE * 2);
            let right = (end + HOP_SIZE * 2).min(mono.len());
            let Output { frames, mut note, mut onset, .. } = self.run_frames(&mono[left..right], false)?;
            let mut events = output_to_notes_polyphonic(&mut note, &mut onset, frames,
                0.42, 0.28, 3, Some(midi_to_hz(97.)), Some(midi_to_hz(53.)), true);
            clean_instrumental_attacks(&mut events, &note, &onset);
            // Each KEPT group advances one input hop. Use this common frame
            // clock for ownership as well as timing on both sides of a seam.
            let first_frame = left / HOP_SIZE * KEPT;
            let owned_from = begin / HOP_SIZE * KEPT;
            let owned_to = (begin + BLOCK) / HOP_SIZE * KEPT;
            let seconds = |f: usize| (f / KEPT * HOP_SIZE + f % KEPT * FFT_HOP) as f64 / rate;
            for (s, e, pitch, amp) in events {
                let f = first_frame + s;
                if !(owned_from..owned_to).contains(&f) { continue; }
                let start = seconds(f);
                let end = seconds(first_frame + e).min(mono.len() as f64 / rate);
                if end <= start { continue; }
                notes.push(Note { pitch, start, end,
                    velocity: (amp * 127.).round_ties_even() as u8 });
            }
        }
        Ok(notes)
    }
}

/// Basic Pitch can emit adjacent fragments while a key is already sounding.
/// Resolve them in the block's context before assigning events to a block.
fn clean_instrumental_attacks(events: &mut Vec<(usize, usize, u8, f32)>, note: &[f32], onset: &[f32]) {
    // Only playable candidates participate: a discarded whisper cannot steal an onset.
    events.retain(|&(_, _, _, amp)| (amp * 127.).round_ties_even() >= 45.);
    events.sort_unstable_by_key(|&(s, _, p, _)| (p, s));
    let mut written = 0;
    let mut last_segment = 0;
    for i in 0..events.len() {
        let (s, e, p, amp) = events[i];
        let k = usize::from(p) - MIDI_OFFSET;
        if written > 0 {
            let (start, end, pitch, level) = events[written - 1];
            // One frame is ~12 ms. Require touching fragments and a recent attack.
            if p == pitch && s.abs_diff(end) <= 1 && s - last_segment <= 14 && s >= 3 {
                let confidence = onset[s * N_NOTES + k];
                let previous = onset[start * N_NOTES + k];
                let floor = (s - 3..s).map(|t| note[t * N_NOTES + k]).fold(1., f32::min);
                let peak = (s..e.min(s + 4)).map(|t| note[t * N_NOTES + k]).fold(0., f32::max);
                if floor > 0.28 && peak - floor < 0.07 && confidence < 0.8 && confidence <= previous {
                    events[written - 1].1 = end.max(e);
                    last_segment = s;
                    continue;
                }
                // A quiet inferred pickup directly before a much clearer attack
                // of the same pitch: keep the measured later attack, not both.
                if s - start <= 8 && previous < 0.42 && confidence > 0.70 && amp - level >= 0.12 {
                    written -= 1;
                }
            }
        }
        events[written] = events[i];
        written += 1;
        last_segment = s;
    }
    events.truncate(written);
}

/// What `predict(...)` is called with.
#[derive(Debug, Clone)]
pub struct Params {
    pub onset_threshold: f64,
    pub frame_threshold: f64,
    /// milliseconds
    pub minimum_note_length: f64,
    pub minimum_frequency: Option<f64>,
    pub maximum_frequency: Option<f64>,
    pub melodia_trick: bool,
    pub midi_tempo: f64,
}

/// librosa.hz_to_midi
fn hz_to_midi(f: f64) -> f64 {
    12.0 * (f.log2() - 440f64.log2()) + 69.0
}

/// librosa.midi_to_hz
pub fn midi_to_hz(m: f64) -> f64 {
    440.0 * 2f64.powf((m - 69.0) / 12.0)
}

/// numpy `a[:, k:]` / `a[:, :k]` bounds for a Python int k on a width-w axis.
fn py_slice_start(k: i64, w: usize) -> usize {
    if k < 0 { (w as i64 + k).max(0) as usize } else { (k as usize).min(w) }
}

/// constrain_frequency, in place on both [T][88] matrices.
fn constrain_frequency(onsets: &mut [f32], frames: &mut [f32], max_freq: Option<f64>, min_freq: Option<f64>) {
    if let Some(f) = max_freq {
        let idx = py_slice_start((hz_to_midi(f) - MIDI_OFFSET as f64).round_ties_even() as i64, N_NOTES);
        for row in onsets.chunks_exact_mut(N_NOTES).chain(frames.chunks_exact_mut(N_NOTES)) {
            row[idx..].iter_mut().for_each(|v| *v = 0.0);
        }
    }
    if let Some(f) = min_freq {
        let idx = py_slice_start((hz_to_midi(f) - MIDI_OFFSET as f64).round_ties_even() as i64, N_NOTES);
        for row in onsets.chunks_exact_mut(N_NOTES).chain(frames.chunks_exact_mut(N_NOTES)) {
            row[..idx].iter_mut().for_each(|v| *v = 0.0);
        }
    }
}

/// np.maximum / np.minimum: NaN wins.
#[inline]
fn np_maximum(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() { f64::NAN } else if a >= b { a } else { b }
}
#[inline]
fn np_minimum(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() { f64::NAN } else if a <= b { a } else { b }
}

/// np.max over a float array (NaN propagates).
fn np_max_f32(v: &[f32]) -> f32 {
    let mut m = v[0];
    for &x in &v[1..] {
        if x.is_nan() || m.is_nan() {
            m = f32::NAN;
        } else if x > m {
            m = x;
        }
    }
    m
}

fn np_max_f64(v: &[f64]) -> f64 {
    let mut m = v[0];
    for &x in &v[1..] {
        m = np_maximum(m, x);
    }
    m
}

/// get_infered_onsets(onsets, frames, n_diff=2), as float64.
fn infered_onsets(onsets: &[f32], frames: &[f32], t: usize) -> Vec<f64> {
    let w = N_NOTES;
    let at = |r: usize, n: usize, c: usize| -> f64 { if r >= n { frames[(r - n) * w + c] as f64 } else { 0.0 } };
    let mut fd = vec![0f64; t * w];
    for r in 0..t {
        for c in 0..w {
            let x = frames[r * w + c] as f64;
            let d1 = x - at(r, 1, c);
            let d2 = x - at(r, 2, c);
            let mut v = np_minimum(d1, d2);
            if v < 0.0 {
                v = 0.0;
            }
            if r < 2 {
                v = 0.0;
            }
            fd[r * w + c] = v;
        }
    }
    let max_on = np_max_f32(onsets) as f64;
    let max_fd = np_max_f64(&fd);
    fd.iter().zip(onsets).map(|(&d, &o)| np_maximum(o as f64, max_on * d / max_fd)).collect()
}

/// `np.mean(frames[a:b, f])` (float32 column).
fn column_mean(frames: &[f32], a: usize, b: usize, f: usize) -> f32 {
    let col: Vec<f32> = (a..b).map(|r| frames[r * N_NOTES + f]).collect();
    np_mean_f32(&col)
}

#[derive(PartialEq)]
struct HeapItem(f64, usize);
impl Eq for HeapItem {}
impl PartialOrd for HeapItem {
    fn partial_cmp(&self, o: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(o))
    }
}
impl Ord for HeapItem {
    // larger value first; equal values: smaller flat index first (np.argmax)
    fn cmp(&self, o: &Self) -> std::cmp::Ordering {
        self.0.total_cmp(&o.0).then(o.1.cmp(&self.1))
    }
}

/// output_to_notes_polyphonic. Returns (start frame, end frame, pitch, amplitude).
#[allow(clippy::too_many_arguments)]
pub fn output_to_notes_polyphonic(
    frames: &mut [f32],
    onsets: &mut [f32],
    t: usize,
    onset_thresh: f64,
    frame_thresh: f64,
    min_note_len: i64,
    max_freq: Option<f64>,
    min_freq: Option<f64>,
    melodia_trick: bool,
) -> Vec<(usize, usize, u8, f32)> {
    const ENERGY_TOL: i64 = 11;
    let w = N_NOTES;
    let n_frames = t as i64;
    if t == 0 {
        return Vec::new();
    }
    constrain_frequency(onsets, frames, max_freq, min_freq);
    let on = infered_onsets(onsets, frames, t);
    // argrelmax(axis=0, mode="clip") then np.where(peak_mat >= thresh), reversed
    let mut onset_idx: Vec<(usize, usize)> = Vec::new();
    for r in 0..t {
        for c in 0..w {
            let x = on[r * w + c];
            let up = on[(r + 1).min(t - 1) * w + c];
            let dn = on[r.saturating_sub(1) * w + c];
            let peak = x > up && x > dn;
            let v = if peak { x } else { 0.0 };
            if v >= onset_thresh {
                onset_idx.push((r, c));
            }
        }
    }
    onset_idx.reverse();
    let mut rem: Vec<f64> = frames.iter().map(|&v| v as f64).collect();
    let mut events = Vec::new();
    let zero_around = |rem: &mut [f64], a: usize, b: usize, f: usize| {
        for r in a..b {
            rem[r * w + f] = 0.0;
            if f < MAX_FREQ_IDX {
                rem[r * w + f + 1] = 0.0;
            }
            if f > 0 {
                rem[r * w + f - 1] = 0.0;
            }
        }
    };
    for (start, f) in onset_idx {
        let s = start as i64;
        if s >= n_frames - 1 {
            continue;
        }
        let mut i = s + 1;
        let mut k = 0i64;
        while i < n_frames - 1 && k < ENERGY_TOL {
            if rem[i as usize * w + f] < frame_thresh {
                k += 1;
            } else {
                k = 0;
            }
            i += 1;
        }
        i -= k;
        if i - s <= min_note_len {
            continue;
        }
        zero_around(&mut rem, start, i as usize, f);
        let amp = column_mean(frames, start, i as usize, f);
        events.push((start, i as usize, (f + MIDI_OFFSET) as u8, amp));
    }

    if melodia_trick && !rem.iter().any(|v| v.is_nan()) {
        let mut heap: BinaryHeap<HeapItem> = rem.iter().enumerate().filter(|(_, &v)| v > frame_thresh).map(|(i, &v)| HeapItem(v, i)).collect();
        loop {
            // np.max(remaining_energy) > frame_thresh, then np.argmax
            let top = loop {
                match heap.peek() {
                    Some(HeapItem(v, i)) if rem[*i].to_bits() != v.to_bits() => {
                        heap.pop();
                    }
                    other => break other.map(|h| (h.0, h.1)),
                }
            };
            let Some((v, flat)) = top else { break };
            if v <= frame_thresh {
                break;
            }
            heap.pop();
            let (i_mid, f) = ((flat / w) as i64, flat % w);
            rem[flat] = 0.0;
            let zero_one = |rem: &mut [f64], i: i64| {
                let r = i as usize;
                rem[r * w + f] = 0.0;
                if f < MAX_FREQ_IDX {
                    rem[r * w + f + 1] = 0.0;
                }
                if f > 0 {
                    rem[r * w + f - 1] = 0.0;
                }
            };
            let mut i = i_mid + 1;
            let mut k = 0i64;
            while i < n_frames - 1 && k < ENERGY_TOL {
                if rem[i as usize * w + f] < frame_thresh {
                    k += 1;
                } else {
                    k = 0;
                }
                zero_one(&mut rem, i);
                i += 1;
            }
            let i_end = i - 1 - k;
            let mut i = i_mid - 1;
            let mut k = 0i64;
            while i > 0 && k < ENERGY_TOL {
                if rem[i as usize * w + f] < frame_thresh {
                    k += 1;
                } else {
                    k = 0;
                }
                zero_one(&mut rem, i);
                i -= 1;
            }
            let i_start = i + 1 + k;
            if i_end - i_start <= min_note_len {
                continue;
            }
            let amp = column_mean(frames, i_start as usize, i_end as usize, f);
            events.push((i_start as usize, i_end as usize, (f + MIDI_OFFSET) as u8, amp));
        }
    }
    events
}

/// scipy.signal.windows.gaussian(51, std=5)
fn freq_gaussian() -> [f64; 51] {
    let mut w = [0f64; 51];
    for (i, v) in w.iter_mut().enumerate() {
        let n = i as f64 - (51.0 - 1.0) / 2.0;
        *v = (-(n * n) / 50.0).exp();
    }
    w
}

/// get_pitch_bends(contours, note_events, n_bins_tolerance=25)
fn pitch_bends(contours: &[f32], events: &[(usize, usize, u8, f32)]) -> Vec<Vec<i64>> {
    const TOL: i64 = 25;
    let g = freq_gaussian();
    let window_length = 2 * TOL + 1;
    events
        .iter()
        .map(|&(s, e, pitch, _)| {
            let hz = midi_to_hz(pitch as f64);
            let freq_idx = (12.0 * 3.0 * (hz / 27.5).log2()).round_ties_even() as i64;
            let fs = (freq_idx - TOL).max(0);
            let fe = (N_CONTOUR as i64).min(freq_idx + TOL + 1);
            let g0 = 0.max(TOL - freq_idx);
            let g1 = window_length - 0.max(freq_idx - (N_CONTOUR as i64 - TOL - 1));
            let pb_shift = TOL - 0.max(TOL - freq_idx);
            let width = (fe - fs).min(g1 - g0).max(0) as usize;
            (s..e)
                .map(|r| {
                    // np.argmax: first maximum, a NaN wins
                    let mut best = 0usize;
                    let mut best_v = f64::NEG_INFINITY;
                    for j in 0..width {
                        let v = contours[r * N_CONTOUR + fs as usize + j] as f64 * g[g0 as usize + j];
                        if v.is_nan() {
                            best = j;
                            break;
                        }
                        if j == 0 || v > best_v {
                            best_v = v;
                            best = j;
                        }
                    }
                    best as i64 - pb_shift
                })
                .collect()
        })
        .collect()
}

/// model_frames_to_time(n_frames)
pub fn model_frames_to_time(n: usize) -> Vec<f64> {
    let window_offset = (FFT_HOP as f64 / SAMPLE_RATE as f64) * (ANNOT_N_FRAMES as f64 - (AUDIO_N_SAMPLES as f64 / FFT_HOP as f64)) + 0.0018;
    (0..n)
        .map(|f| {
            let orig = ((f * FFT_HOP) as f64) / SAMPLE_RATE as f64;
            let win = (f as f64 / ANNOT_N_FRAMES as f64).floor();
            orig - window_offset * win
        })
        .collect()
}

/// np.linspace(start, stop, num)
pub fn linspace(start: f64, stop: f64, num: usize) -> Vec<f64> {
    if num == 0 {
        return Vec::new();
    }
    let div = num - 1;
    let delta = stop - start;
    let mut y: Vec<f64> = if div > 0 {
        let step = delta / div as f64;
        if step == 0.0 {
            (0..num).map(|i| (i as f64 / div as f64) * delta).collect()
        } else {
            (0..num).map(|i| i as f64 * step).collect()
        }
    } else {
        (0..num).map(|i| i as f64 * delta).collect()
    };
    for v in y.iter_mut() {
        *v += start;
    }
    if num > 1 {
        y[num - 1] = stop;
    }
    y
}

/// A note event in seconds, with its pitch bends.
#[derive(Debug, Clone)]
pub struct NoteEvent {
    pub start: f64,
    pub end: f64,
    pub pitch: u8,
    pub amplitude: f32,
    pub bends: Option<Vec<i64>>,
}

fn cmp_event(a: &NoteEvent, b: &NoteEvent) -> std::cmp::Ordering {
    a.start
        .total_cmp(&b.start)
        .then(a.end.total_cmp(&b.end))
        .then(a.pitch.cmp(&b.pitch))
        .then(a.amplitude.total_cmp(&b.amplitude))
        .then_with(|| match (&a.bends, &b.bends) {
            (Some(x), Some(y)) => x.cmp(y),
            _ => std::cmp::Ordering::Equal,
        })
}

/// note_events_to_midi(events, multiple_pitch_bends=False, midi_tempo)
pub fn note_events_to_midi(mut events: Vec<NoteEvent>, midi_tempo: f64) -> PrettyMidi {
    // drop_overlapping_pitch_bends
    events.sort_by(cmp_event);
    for i in 0..events.len().saturating_sub(1) {
        for j in i + 1..events.len() {
            if events[j].start >= events[i].end {
                break;
            }
            events[i].bends = None;
            events[j].bends = None;
        }
    }
    let mut pm = PrettyMidi::new(220, midi_tempo);
    if events.is_empty() {
        return pm;
    }
    // pretty_midi.instrument_name_to_program("Electric Piano 1") == 4
    let mut inst = Instrument::new(4, false, "");
    for ev in &events {
        let vel = (127f32 * ev.amplitude).round_ties_even() as i64;
        inst.notes.push(Note { velocity: vel.clamp(0, 127) as u8, pitch: ev.pitch, start: ev.start, end: ev.end });
        let Some(b) = ev.bends.as_ref().filter(|b| !b.is_empty()) else { continue };
        let times = linspace(ev.start, ev.end, b.len());
        for (t, &v) in times.iter().zip(b) {
            let tick = ((v * 4096) as f64 / 3.0).round_ties_even() as i64;
            inst.pitch_bends.push(PitchBend { pitch: tick.clamp(-8192, 8191) as i32, time: *t });
        }
    }
    pm.instruments.push(inst);
    pm
}

/// predict(...) on 22.05 kHz mono audio: the pretty_midi object and the
/// number of raw note events.
pub fn predict(model: &mut Model, audio: &[f32], p: &Params) -> Result<PrettyMidi> {
    let out = model.run(audio)?;
    Ok(output_to_midi(out, p))
}

/// FORGE_RS_BP_DUMP=<dir>: the model input / output and the note events,
/// for diffing against basic_pitch.inference.predict.
fn dump_dir() -> Option<PathBuf> {
    std::env::var_os("FORGE_RS_BP_DUMP").filter(|v| !v.is_empty()).map(PathBuf::from)
}

pub fn output_to_midi(out: Output, p: &Params) -> PrettyMidi {
    let min_note_len = (p.minimum_note_length / 1000.0 * (SAMPLE_RATE as f64 / FFT_HOP as f64)).round_ties_even() as i64;
    let Output { frames: t, mut note, mut onset, contour } = out;
    if let Some(d) = dump_dir() {
        let _ = std::fs::create_dir_all(&d);
        let _ = crate::dump::write_npy_f32(&d.join("note.npy"), &[t, N_NOTES], &note);
        let _ = crate::dump::write_npy_f32(&d.join("onset.npy"), &[t, N_NOTES], &onset);
        let _ = crate::dump::write_npy_f32(&d.join("contour.npy"), &[t, N_CONTOUR], &contour);
    }
    let evs = output_to_notes_polyphonic(&mut note, &mut onset, t, p.onset_threshold, p.frame_threshold, min_note_len, p.maximum_frequency, p.minimum_frequency, p.melodia_trick);
    if let Some(d) = dump_dir() {
        let v: Vec<serde_json::Value> = evs.iter().map(|&(s, e, pitch, a)| serde_json::json!([s, e, pitch, a.to_bits()])).collect();
        let _ = std::fs::write(d.join("events.json"), serde_json::to_string(&v).unwrap_or_default());
    }
    let bends = pitch_bends(&contour, &evs);
    let times = model_frames_to_time(t);
    let events = evs
        .iter()
        .zip(bends)
        .map(|(&(s, e, pitch, amp), b)| NoteEvent { start: times[s], end: times[e], pitch, amplitude: amp, bends: Some(b) })
        .collect();
    note_events_to_midi(events, p.midi_tempo)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn holds_level_pitch_but_keeps_a_stronger_or_newly_articulated_onset() {
        let mut note = vec![0.55; 60 * N_NOTES];
        let mut onset = vec![0.; note.len()];
        let p = 72;
        let k = p as usize - MIDI_OFFSET;
        let mut events = vec![(5, 12, p, 0.6), (12, 19, p, 0.56), (19, 28, p, 0.6),
                              (28, 36, p, 0.61), (40, 46, p, 0.4), (46, 57, p, 0.7)];
        for (t, c) in [(5, 0.74), (12, 0.6), (19, 0.77), (28, 0.6), (40, 0.3), (46, 0.91)] {
            onset[t * N_NOTES + k] = c;
        }
        note[26 * N_NOTES + k] = 0.21;
        clean_instrumental_attacks(&mut events, &note, &onset);
        assert_eq!(events.iter().map(|&(s,e,_,_)| (s,e)).collect::<Vec<_>>(),
            [(5,19),(19,28),(28,36),(46,57)]);
    }

    #[test]
    fn constants_match_basic_pitch() {
        assert_eq!(AUDIO_N_SAMPLES, 43844);
        assert_eq!(ANNOT_N_FRAMES, 172);
        assert_eq!(HOP_SIZE, 36164);
        let t = model_frames_to_time(400);
        assert_eq!(t[0], 0.0);
        assert!((t[172] - (172.0 * 256.0 / 22050.0 - ((256.0 / 22050.0) * 0.734375 + 0.0018))).abs() < 1e-15);
    }

    #[test]
    fn linspace_matches_numpy_shape() {
        assert_eq!(linspace(1.0, 2.0, 1), vec![1.0]);
        assert_eq!(linspace(0.0, 1.0, 5), vec![0.0, 0.25, 0.5, 0.75, 1.0]);
    }
}

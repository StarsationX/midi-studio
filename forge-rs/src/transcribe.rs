//! End-to-end transcription: a port of what transcribe_onnx_dml.py runs
//! (readAudio -> soxr -> mono -> TransKun.transcribe with the ONNX
//! backbone -> writeMidi), in the same order and with Python's f64 note
//! arithmetic.

use crate::assets::{AssetPaths, Aux};
use crate::audio::{self, Audio};
use crate::backbone::{Backbone, BackboneOut};
use crate::config::{frames_per_segment, target_midi_pitch, CTX_DIM, FS, HOP_SIZE, N_SYMBOLS, SEGMENT_HOP_SEC};
use crate::crf;
use crate::dump::Dump;
use crate::frontend::{FrontEnd, Segmenter};
use crate::heads;
use crate::resample;
use anyhow::Result;
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use std::time::Instant;

/// transkun.Data.Note
#[derive(Debug, Clone, Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub start: f64,
    pub end: f64,
    pub pitch: i32,
    pub velocity: u8,
    pub has_onset: bool,
    pub has_offset: bool,
}

#[derive(Debug, Clone)]
pub struct Options {
    /// Segment hop in seconds (SEGMENT_HOP); segment size stays 16 s.
    pub segment_hop: f64,
    /// ORT intra-op threads (None = ORT default, as the Python session).
    pub intra_threads: Option<usize>,
    pub ort_dylib: Option<std::path::PathBuf>,
    /// Where the backbone runs (CPU unless asked; CUDA is fp32, TF32 off).
    pub ep: crate::roformer::Ep,
}

impl Default for Options {
    fn default() -> Self {
        Options { segment_hop: SEGMENT_HOP_SEC, intra_threads: None, ort_dylib: None, ep: crate::roformer::Ep::Cpu }
    }
}

#[derive(Debug, Default, Clone, Serialize)]
pub struct Timings {
    pub load_models_s: f64,
    pub decode_audio_s: f64,
    pub resample_s: f64,
    pub frontend_s: f64,
    pub backbone_s: f64,
    pub decode_s: f64,
    pub total_s: f64,
    pub segments: usize,
}

pub struct Transcriber {
    pub aux: Aux,
    frontend: FrontEnd,
    backbone: Backbone,
    pitches: Vec<i32>,
    pub load_s: f64,
    /// Called after each segment's backbone pass with (done, total).
    pub progress: Option<Box<dyn FnMut(usize, usize) + Send>>,
}

impl Transcriber {
    pub fn new(paths: &AssetPaths, opts: &Options) -> Result<Self> {
        let t0 = Instant::now();
        crate::backbone::init_ort(opts.ort_dylib.as_deref())?;
        let aux = Aux::load(&paths.aux)?;
        let frontend = FrontEnd::new(&aux);
        let backbone = Backbone::load_on(&paths.onnx, opts.intra_threads, opts.ep)?;
        Ok(Transcriber { aux, frontend, backbone, pitches: target_midi_pitch(), load_s: t0.elapsed().as_secs_f64(), progress: None })
    }

    /// readAudio scaling + soxr (if fs != 44100) + downmix, in
    /// transcribe_onnx_dml.py's order (resample before the mono mix).
    pub fn prepare_audio(&self, a: &Audio, timings: &mut Timings, dump: &Dump) -> Result<Vec<f32>> {
        let t0 = Instant::now();
        let x = a.readaudio_scaled();
        let x = if a.sample_rate != FS {
            let y = resample::resample_hq(&x, a.channels, a.sample_rate as f64, FS as f64)?;
            dump.npy_f32("resampled", &[y.len() / a.channels, a.channels], &y);
            y
        } else {
            x
        };
        timings.resample_s += t0.elapsed().as_secs_f64();
        Ok(Audio::downmix(&x, a.channels))
    }

    /// Unit-scale audio (as `audio::load` returns it) -> notes.
    pub fn transcribe_audio(&mut self, a: &Audio, opts: &Options, dump: &Dump) -> Result<(Vec<Note>, Timings)> {
        let mut timings = Timings::default();
        let t_all = Instant::now();
        let mono = self.prepare_audio(a, &mut timings, dump)?;
        let notes = self.transcribe_mono(&mono, opts, &mut timings, dump)?;
        timings.total_s = t_all.elapsed().as_secs_f64();
        Ok((notes, timings))
    }

    pub fn transcribe_file(&mut self, path: &Path, opts: &Options, dump: &Dump) -> Result<(Vec<Note>, Timings)> {
        let t0 = Instant::now();
        let a = audio::load(path)?;
        let dec = t0.elapsed().as_secs_f64();
        let (notes, mut timings) = self.transcribe_audio(&a, opts, dump)?;
        timings.decode_audio_s = dec;
        timings.total_s += dec;
        Ok((notes, timings))
    }

    /// TransKun.transcribe(x, stepInSecond, segmentSizeInSecond=16,
    /// discardSecondHalf=False, mergeIncompleteEvent=True)
    pub fn transcribe_mono(&mut self, mono: &[f32], opts: &Options, timings: &mut Timings, dump: &Dump) -> Result<Vec<Note>> {
        let seg = Segmenter::new(mono, opts.segment_hop);
        let n_segments = seg.count();
        let n_frames = frames_per_segment();
        let start_frame_idx = (seg.pad_time_begin * FS as f64 / HOP_SIZE as f64).floor() as usize;
        let mut start_pos = vec![start_frame_idx; N_SYMBOLS];
        // round(segmentSize / hopSize), Python round-half-even
        let last_frame_idx = (seg.segment_size as f64 / HOP_SIZE as f64).round_ties_even() as usize;

        // eventsByType: dict keyed by pitch, insertion-ordered
        let mut by_type: Vec<(i32, Vec<Note>)> = Vec::new();
        let mut type_index: HashMap<i32, usize> = HashMap::new();

        for (k, start) in seg.starts().enumerate() {
            let s = seg.segment(start);
            let t0 = Instant::now();
            let feats = self.frontend.features(&s.samples);
            timings.frontend_s += t0.elapsed().as_secs_f64();
            dump.npy_f32(&format!("seg{k:02}_features"), &[1, n_frames, crate::config::N_MELS, crate::config::N_WINDOWS], &feats);

            let t0 = Instant::now();
            let out = self.backbone.run(feats)?;
            timings.backbone_s += t0.elapsed().as_secs_f64();
            if let Some(cb) = self.progress.as_mut() {
                cb(k + 1, n_segments);
            }
            if dump.enabled() {
                dump.npy_f32(&format!("seg{k:02}_score"), &[n_frames, n_frames, N_SYMBOLS], &out.score);
                dump.npy_f32(&format!("seg{k:02}_noise"), &[n_frames - 1, N_SYMBOLS], &out.noise);
                dump.npy_f32(&format!("seg{k:02}_ctx"), &[1, N_SYMBOLS, n_frames, CTX_DIM], &out.ctx);
            }

            let t0 = Instant::now();
            let (cur_events, last_p) = self.transcribe_frames(&out, &start_pos, last_frame_idx, k, dump);
            start_pos = last_p.iter().map(|&p| p.saturating_sub(seg.step_frames())).collect();

            for mut e in cur_events {
                e.start += s.begin_time;
                e.end += s.begin_time;
                e.start = e.start.max(0.0);
                e.end = e.end.max(e.start);

                if let Some(&ti) = type_index.get(&e.pitch) {
                    let list = &mut by_type[ti].1;
                    if let Some(last) = list.last_mut() {
                        if e.start < last.end {
                            if e.has_onset {
                                *last = e;
                            } else {
                                last.has_offset = e.has_offset;
                                last.end = e.end.max(last.end);
                            }
                            continue;
                        }
                    }
                }
                if e.has_onset {
                    let ti = *type_index.entry(e.pitch).or_insert_with(|| {
                        by_type.push((e.pitch, Vec::new()));
                        by_type.len() - 1
                    });
                    by_type[ti].1.push(e);
                }
            }
            timings.decode_s += t0.elapsed().as_secs_f64();
            timings.segments += 1;
        }

        for (_, list) in by_type.iter_mut() {
            if let Some(last) = list.last_mut() {
                last.has_offset = true;
            }
        }
        let all: Vec<Note> = by_type.into_iter().flat_map(|(_, l)| l).filter(|n| n.has_offset).collect();
        Ok(resolve_overlapping(all))
    }

    /// TransKun.transcribeFrames for one segment (nBatch = 1).
    fn transcribe_frames(
        &self,
        out: &BackboneOut,
        forced_start: &[usize],
        last_frame_idx: usize,
        k: usize,
        dump: &Dump,
    ) -> (Vec<Note>, Vec<usize>) {
        let t = frames_per_segment();
        let paths = crf::viterbi_backward(&out.score, &out.noise, t, N_SYMBOLS, Some(forced_start));
        if dump.enabled() {
            let p: Vec<Vec<[usize; 2]>> = paths.iter().map(|p| p.iter().map(|&(a, b)| [a, b]).collect()).collect();
            dump.json(&format!("seg{k:02}_paths"), &serde_json::json!({"forcedStartPos": forced_start, "paths": p}));
        }
        let n_all: usize = paths.iter().map(|p| p.len()).sum();
        if n_all == 0 {
            return (Vec::new(), vec![0; paths.len()]);
        }

        // fetchIntervalFeaturesBatch: ctx[sym][frame]
        let ctx_at = |sym: usize, frame: usize| &out.ctx[(sym * t + frame) * CTX_DIM..(sym * t + frame + 1) * CTX_DIM];
        let mut pairs = Vec::with_capacity(n_all);
        for (sym, p) in paths.iter().enumerate() {
            for &(a, b) in p {
                pairs.push((ctx_at(sym, a), ctx_at(sym, b)));
            }
        }
        let preds = heads::predict(&self.aux.velocity, &self.aux.refined_of, &pairs);
        if dump.enabled() {
            let mut attr = Vec::with_capacity(n_all * 3 * CTX_DIM);
            for (a, b) in &pairs {
                attr.extend_from_slice(a);
                attr.extend_from_slice(b);
                attr.extend(a.iter().zip(b.iter()).map(|(x, y)| x * y));
            }
            dump.npy_f32(&format!("seg{k:02}_attr"), &[n_all, 3 * CTX_DIM], &attr);
            let vl: Vec<f32> = preds.iter().flat_map(|(r, _)| r.vel_logits.iter().copied()).collect();
            dump.npy_f32(&format!("seg{k:02}_vel_logits"), &[n_all, 128], &vl);
            let of: Vec<f32> = preds.iter().flat_map(|(r, _)| r.of_out).collect();
            dump.npy_f32(&format!("seg{k:02}_of_out"), &[n_all, 4], &of);
        }

        let frame_dur = HOP_SIZE as f64 / FS as f64;
        let mut notes = Vec::with_capacity(n_all);
        let mut last_p = Vec::with_capacity(N_SYMBOLS);
        let mut n = 0usize;
        for (j, &pitch) in self.pitches.iter().enumerate() {
            let mut last_end = 0f64;
            let mut cur_last_p = 0usize;
            for &(a, b) in &paths[j] {
                let attr = preds[n].1;
                // Python: (int + float(fp32)) * frameDur, all f64
                let mut start = (a as f64 + attr.of_value[0] as f64) * frame_dur;
                let mut end = (b as f64 + attr.of_value[1] as f64) * frame_dur;
                let has_onset = a > 0 || attr.of_presence[0];
                let has_offset = b < last_frame_idx || attr.of_presence[1];
                start = start.max(last_end);
                end = end.max(start + 1e-8);
                last_end = end;
                notes.push(Note { start, end, pitch, velocity: attr.velocity, has_onset, has_offset });
                if has_offset {
                    cur_last_p = b;
                }
                n += 1;
            }
            last_p.push(cur_last_p);
        }
        sort_notes(&mut notes);
        (notes, last_p)
    }
}

/// Python `list.sort(key=lambda x: (x.start, x.end, x.pitch))` (stable).
pub fn sort_notes(v: &mut [Note]) {
    v.sort_by(|x, y| {
        x.start
            .partial_cmp(&y.start)
            .unwrap()
            .then(x.end.partial_cmp(&y.end).unwrap())
            .then(x.pitch.cmp(&y.pitch))
    });
}

/// transkun.Data.resolveOverlapping
pub fn resolve_overlapping(mut notes: Vec<Note>) -> Vec<Note> {
    sort_notes(&mut notes);
    let mut out: Vec<Note> = Vec::with_capacity(notes.len());
    let mut last_idx: HashMap<i32, usize> = HashMap::new();
    for n in notes {
        if let Some(&i) = last_idx.get(&n.pitch) {
            if out[i].end > n.start {
                out[i].end = n.start;
            }
        }
        last_idx.insert(n.pitch, out.len());
        out.push(n);
    }
    sort_notes(&mut out);
    let before = out.len();
    out.retain(|n| n.start < n.end);
    if out.len() != before {
        eprintln!("resolveOverlapping: dropped {} zero-length notes", before - out.len());
    }
    out
}

//! Audio decoding (symphonia) with the two sample scalings the Python path
//! uses:
//!
//! * unit scale, as soundfile / librosa.load return it (int16 / 2^15,
//!   int24 / 2^23, int32 / 2^31, (u8 - 128) / 2^7, float as is). Used by the
//!   loudness normaliser (`post`), which reads through librosa.
//! * readAudio scale (transkun, via pydub): `np.float32(ints) / 2**15`
//!   where `ints` are what pydub holds. Equal to unit scale for 16-bit PCM;
//!   pydub keeps 24/32-bit PCM at native integer range, biases u8 to s8,
//!   and routes other inputs through ffmpeg (lossy -> pcm_s16le, float WAV
//!   -> pcm_s32le). Apart from lossy->s16 quantisation these are exact
//!   power-of-two rescalings, which only reach the output through the
//!   `+ 1e-8` in the per-segment gain normalisation, but we mirror them.

use anyhow::{anyhow, bail, Context, Result};
use std::path::Path;
use symphonia::core::audio::{AudioBufferRef, Signal};
use symphonia::core::codecs::{self, DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

/// How the source samples were stored, which decides pydub's scale.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceKind {
    /// Integer PCM with this many bits (8 = unsigned).
    Int(u8),
    /// Float PCM (WAV/AIFF float).
    Float,
    /// Lossy codec decoded to float (MP3/AAC/Vorbis/Opus).
    Lossy,
}

/// Interleaved audio, `frames * channels` samples, unit scale.
#[derive(Debug, Clone)]
pub struct Audio {
    pub sample_rate: u32,
    pub channels: usize,
    pub samples: Vec<f32>,
    pub kind: SourceKind,
}

impl Audio {
    pub fn frames(&self) -> usize {
        self.samples.len().checked_div(self.channels).unwrap_or(0)
    }

    /// Samples as transkun's readAudio returns them (see module docs).
    pub fn readaudio_scaled(&self) -> Vec<f32> {
        let f = |mul: f32| self.samples.iter().map(|&x| x * mul).collect::<Vec<f32>>();
        match self.kind {
            SourceKind::Int(16) => self.samples.clone(),
            SourceKind::Int(24) => f(256.0),
            SourceKind::Int(32) => f(65536.0),
            SourceKind::Int(8) => f(1.0 / 256.0),
            SourceKind::Int(_) => self.samples.clone(),
            SourceKind::Float => f(65536.0),
            SourceKind::Lossy => self.samples.iter().map(|&x| quant_s16(x)).collect(),
        }
    }

    /// `audio.mean(axis=1)` on a float32 (frames, channels) array: numpy
    /// reduces the short channel axis sequentially, then divides by C in f32.
    pub fn downmix(samples: &[f32], channels: usize) -> Vec<f32> {
        if channels == 1 {
            return samples.to_vec();
        }
        let cf = channels as f32;
        samples
            .chunks_exact(channels)
            .map(|fr| {
                let mut s = fr[0];
                for &v in &fr[1..] {
                    s += v;
                }
                s / cf
            })
            .collect()
    }
}

/// ffmpeg's flt -> s16 (av_clip_int16(lrintf(x * 32768))), back to / 2^15.
#[inline]
pub fn quant_s16(x: f32) -> f32 {
    (x * 32768.0).round_ties_even().clamp(-32768.0, 32767.0) / 32768.0
}

fn kind_for(codec: codecs::CodecType, bits: Option<u32>) -> SourceKind {
    use codecs::*;
    match codec {
        CODEC_TYPE_PCM_F32LE | CODEC_TYPE_PCM_F32BE | CODEC_TYPE_PCM_F64LE | CODEC_TYPE_PCM_F64BE => {
            SourceKind::Float
        }
        CODEC_TYPE_MP1 | CODEC_TYPE_MP2 | CODEC_TYPE_MP3 | CODEC_TYPE_AAC | CODEC_TYPE_VORBIS
        | CODEC_TYPE_OPUS => SourceKind::Lossy,
        _ => SourceKind::Int(bits.unwrap_or(16) as u8),
    }
}

fn push_buffer(buf: &AudioBufferRef<'_>, out: &mut Vec<f32>) -> Option<u8> {
    let spec = *buf.spec();
    let ch = spec.channels.count();
    let n = buf.frames();
    let base = out.len();
    out.resize(base + n * ch, 0.0);
    macro_rules! fill {
        ($b:expr, $conv:expr) => {{
            for c in 0..ch {
                for (i, &s) in $b.chan(c).iter().enumerate() {
                    out[base + i * ch + c] = $conv(s);
                }
            }
        }};
    }
    // soundfile/libsndfile float read normalisation
    match buf {
        AudioBufferRef::U8(b) => {
            fill!(b, |s: u8| (s as i32 - 128) as f32 / 128.0);
            Some(8)
        }
        AudioBufferRef::S8(b) => {
            fill!(b, |s: i8| s as f32 / 128.0);
            Some(8)
        }
        AudioBufferRef::U16(b) => {
            fill!(b, |s: u16| (s as i32 - 32768) as f32 / 32768.0);
            Some(16)
        }
        AudioBufferRef::S16(b) => {
            fill!(b, |s: i16| s as f32 / 32768.0);
            Some(16)
        }
        AudioBufferRef::U24(b) => {
            fill!(b, |s: symphonia::core::sample::u24| (s.inner() as i32 - (1 << 23)) as f32 / 8388608.0);
            Some(24)
        }
        AudioBufferRef::S24(b) => {
            fill!(b, |s: symphonia::core::sample::i24| s.inner() as f32 / 8388608.0);
            Some(24)
        }
        AudioBufferRef::U32(b) => {
            fill!(b, |s: u32| (s as i64 - (1i64 << 31)) as f32 / 2147483648.0);
            Some(32)
        }
        AudioBufferRef::S32(b) => {
            fill!(b, |s: i32| s as f32 / 2147483648.0);
            Some(32)
        }
        AudioBufferRef::F32(b) => {
            fill!(b, |s: f32| s);
            None
        }
        AudioBufferRef::F64(b) => {
            fill!(b, |s: f64| s as f32);
            None
        }
    }
}

/// Decode a whole file (WAV/FLAC/MP3/OGG/M4A/AIFF) to interleaved f32.
pub fn load(path: &Path) -> Result<Audio> {
    let file = std::fs::File::open(path).with_context(|| format!("open {}", path.display()))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .with_context(|| format!("unsupported or corrupt audio: {}", path.display()))?;
    let mut format = probed.format;
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or_else(|| anyhow!("no audio track in {}", path.display()))?;
    let track_id = track.id;
    let codec = track.codec_params.codec;
    let mut sample_rate = track.codec_params.sample_rate.unwrap_or(0);
    let mut channels = track.codec_params.channels.map(|c| c.count()).unwrap_or(0);
    let mut bits = track.codec_params.bits_per_sample;
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .context("no decoder for this codec")?;

    let mut samples = Vec::new();
    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(SymError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(SymError::ResetRequired) => break,
            Err(e) => return Err(e.into()),
        };
        if packet.track_id() != track_id {
            continue;
        }
        match decoder.decode(&packet) {
            Ok(buf) => {
                let spec = *buf.spec();
                if channels == 0 {
                    channels = spec.channels.count();
                }
                if sample_rate == 0 {
                    sample_rate = spec.rate;
                }
                if spec.channels.count() != channels {
                    bail!("channel count changed mid-stream");
                }
                if let Some(b) = push_buffer(&buf, &mut samples) {
                    bits.get_or_insert(b as u32);
                }
            }
            Err(SymError::DecodeError(_)) => continue,
            Err(e) => return Err(e.into()),
        }
    }
    if channels == 0 || sample_rate == 0 {
        bail!("could not determine channels / sample rate of {}", path.display());
    }
    Ok(Audio { sample_rate, channels, samples, kind: kind_for(codec, bits) })
}

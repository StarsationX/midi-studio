use anyhow::{bail, Context, Result};
use forge_rs::assets::AssetPaths;
use forge_rs::dump::Dump;
use forge_rs::demix::DemixParams;
use forge_rs::roformer::{self, Ep, Roformer, RoformerOptions};
use forge_rs::{audio, memlimit, midi, post, separate, Options, Transcriber};
use std::path::PathBuf;
use std::time::Instant;

const USAGE: &str = "\
forge-rs: Transkun v2 piano transcription (no Python)

USAGE:
  forge-rs transcribe <audio> <out.mid> [options]
  forge-rs separate <audio> <store_dir> [options]
                                    BS-Rofo-SW-Fixed 6-stem separation (MSST
                                    inference.py): <store_dir>/<name>/<instr>.wav
  forge-rs memcheck                 prove the memory cap refuses 9 GiB

OPTIONS:
  --models DIR        models dir (holds onnx/transkun_v2.onnx); default
                      %LOCALAPPDATA%\\midi-studio\\forge-env\\models
  --aux FILE          transkun_v2_aux.safetensors (default: next to the onnx)
  --ort-dylib FILE    onnxruntime.dll to load (default: ORT_DYLIB_PATH, exe dir,
                      then the forge-env's onnxruntime)
  --segment-hop S     segment hop seconds (default 8, segment size fixed at 16)
  --threads N         ORT intra-op threads (default: ORT's choice)
  --app               full transcribe.py pipeline: loudness-normalise first,
                      clean the MIDI after (30 ms / vel 20 / 21..108 / gamma .85)
  --notes-json FILE   write the raw transkun notes (full precision)
  --dump DIR          dump intermediates (features, ORT outputs, paths, heads)
  --mem-limit-gb G    job-object memory cap (default 7.5; 0 disables)

SEPARATE OPTIONS:
  --model FILE        bsrofo_sw_body.onnx (default: <models>/bs_rofo_sw/)
  --ep cpu|cuda       execution provider (default cpu); CUDA runs fp32 with
                      use_tf32=0 and needs onnxruntime-gpu 1.22's dll
  --cuda-dll-dir DIR  prepend DIR (cudart/cublas/cudnn/cufft) to the DLL search
  --msst-batch N      MSST inference.batch_size whose fade-window choice to
                      mirror (default 1 = stock config; song_to_midi uses 4 on
                      8 GB cards). The network still runs one chunk at a time.
  --general-mix FILE  also write song_to_midi's general_mix.wav (all stems but
                      drums/percussion summed, peak 0.98, 16-bit PCM)
  --exclude-vocals    general mix without vocals (EXCLUDE_VOCALS=1)
  --no-stems          skip writing the six stem WAVs
  --cpu-arena         keep ORT's CPU memory arena (~13% faster, ~2.2x peak RAM:
                      6.3 vs 2.8 GiB on a 20 s clip)
  --cuda-mem-gb G     CUDA arena cap (default 3.5; 0 = ORT default, which on
                      WDDM drives process commit to ~6.9 GiB)
";

fn main() {
    if let Err(e) = run() {
        eprintln!("error: {e:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut pos = Vec::new();
    let mut models = None;
    let mut aux = None;
    let mut opts = Options::default();
    let mut app = false;
    let mut notes_json = None;
    let mut dump_dir = None;
    let mut mem_gb = 7.5f64;
    let mut rofo_model = None;
    let mut ep = Ep::Cpu;
    let mut cuda_dir: Option<PathBuf> = None;
    let mut msst_batch = 1usize;
    let mut general_mix: Option<PathBuf> = None;
    let mut exclude_vocals = false;
    let mut write_stems = true;
    let mut cpu_arena = false;
    let mut cuda_mem_gb = 3.5f64;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        let mut val = || it.next().cloned().with_context(|| format!("{a} needs a value"));
        match a.as_str() {
            "--models" => models = Some(PathBuf::from(val()?)),
            "--aux" => aux = Some(PathBuf::from(val()?)),
            "--ort-dylib" => opts.ort_dylib = Some(PathBuf::from(val()?)),
            "--segment-hop" => opts.segment_hop = val()?.parse()?,
            "--threads" => opts.intra_threads = Some(val()?.parse()?),
            "--app" => app = true,
            "--notes-json" => notes_json = Some(PathBuf::from(val()?)),
            "--dump" => dump_dir = Some(PathBuf::from(val()?)),
            "--mem-limit-gb" => mem_gb = val()?.parse()?,
            "--model" => rofo_model = Some(PathBuf::from(val()?)),
            "--ep" => {
                ep = match val()?.as_str() {
                    "cpu" => Ep::Cpu,
                    "cuda" => Ep::Cuda { device_id: 0 },
                    o => bail!("--ep {o}: expected cpu or cuda"),
                }
            }
            "--cuda-dll-dir" => cuda_dir = Some(PathBuf::from(val()?)),
            "--msst-batch" => msst_batch = val()?.parse()?,
            "--general-mix" => general_mix = Some(PathBuf::from(val()?)),
            "--exclude-vocals" => exclude_vocals = true,
            "--no-stems" => write_stems = false,
            "--cpu-arena" => cpu_arena = true,
            "--cuda-mem-gb" => cuda_mem_gb = val()?.parse()?,
            "-h" | "--help" => {
                print!("{USAGE}");
                return Ok(());
            }
            s if s.starts_with("--") => bail!("unknown option {s}\n\n{USAGE}"),
            _ => pos.push(a.clone()),
        }
    }

    if mem_gb > 0.0 {
        let lim = memlimit::apply((mem_gb * (1u64 << 30) as f64) as usize)?;
        eprintln!("[memcap] job memory limit {:.2} GiB", lim as f64 / (1u64 << 30) as f64);
    }

    match pos.first().map(String::as_str) {
        Some("memcheck") => {
            let nine = 9usize << 30;
            if memlimit::can_allocate(nine) {
                bail!("9 GiB allocation succeeded: the memory cap is NOT active");
            }
            println!("OK: 9 GiB allocation refused under the cap");
            if !memlimit::can_allocate(512 << 20) {
                bail!("0.5 GiB allocation failed");
            }
            eprintln!("[memcap] {}", memlimit::peaks());
            Ok(())
        }
        Some("separate") => {
            let [_, input, store] = pos.as_slice() else {
                bail!("separate needs <audio> <store_dir>

{USAGE}");
            };
            if let Some(d) = &cuda_dir {
                // CUDA EP deps (cudart64_12, cublas64_12, cudnn64_9, ...) load
                // through the standard search, which includes PATH.
                let path = std::env::var_os("PATH").unwrap_or_default();
                let mut v = vec![d.clone()];
                v.extend(std::env::split_paths(&path));
                std::env::set_var("PATH", std::env::join_paths(v)?);
            }
            let model_path = match &rofo_model {
                Some(p) => p.clone(),
                None => roformer::default_model_path(models.as_deref())?,
            };
            let t_all = Instant::now();
            let ropts = RoformerOptions { ep, intra_threads: opts.intra_threads, ort_dylib: opts.ort_dylib.clone(), cpu_arena, cuda_mem_limit_gb: Some(cuda_mem_gb) };
            let mut rofo = Roformer::load(&model_path, &ropts)?;
            let load_s = t_all.elapsed().as_secs_f64();
            eprintln!("Separator: BS-Rofo-SW-Fixed body {} on {:?}, loaded in {load_s:.2}s", model_path.display(), ep);
            eprintln!("[memcap] after load: {}", memlimit::peaks());
            let t0 = Instant::now();
            let mix = separate::load_mix(std::path::Path::new(input))?;
            let decode_s = t0.elapsed().as_secs_f64();
            let mut p = DemixParams::bs_rofo_sw();
            p.batch_size = msst_batch.max(1);
            eprintln!(
                "Mix: {} samples x 2 @ 44100 Hz ({:.2}s); chunk {} overlap {} batch-window {}",
                mix[0].len(),
                mix[0].len() as f64 / 44100.0,
                p.chunk_size,
                p.num_overlap,
                p.batch_size
            );
            let t0 = Instant::now();
            let (stems, chunks) = separate::separate_mix(&mut rofo, &mix, &p, true)?;
            let demix_s = t0.elapsed().as_secs_f64();
            let t0 = Instant::now();
            let name = std::path::Path::new(input).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "mix".into());
            if write_stems {
                for p in separate::write_stems(std::path::Path::new(store), &name, &stems)? {
                    eprintln!("  wrote {}", p.display());
                }
            }
            if let Some(gm) = &general_mix {
                if let Some(d) = gm.parent().filter(|d| !d.as_os_str().is_empty()) {
                    std::fs::create_dir_all(d)?;
                }
                let m = separate::mix_pitched(&stems, &separate::default_excludes(exclude_vocals));
                separate::write_wav_pcm16(gm, &m, roformer::SAMPLE_RATE)?;
                eprintln!("  wrote {}", gm.display());
            }
            let write_s = t0.elapsed().as_secs_f64();
            eprintln!(
                "[timing] wall {:.2}s = load {load_s:.2} + decode {decode_s:.2} + demix {demix_s:.2} ({chunks} chunks, {:.2}s/chunk) + write {write_s:.2}",
                t_all.elapsed().as_secs_f64(),
                demix_s / chunks.max(1) as f64
            );
            eprintln!("[memcap] {}", memlimit::peaks());
            Ok(())
        }
        Some("transcribe") => {
            let [_, input, output] = pos.as_slice() else {
                bail!("transcribe needs <audio> <out.mid>\n\n{USAGE}");
            };
            let paths = AssetPaths::resolve(models.as_deref(), aux.as_deref())?;
            for p in std::iter::once(std::path::Path::new(output)).chain(notes_json.as_deref()) {
                if let Some(d) = p.parent().filter(|d| !d.as_os_str().is_empty()) {
                    std::fs::create_dir_all(d).with_context(|| format!("create {}", d.display()))?;
                }
            }
            let dump = match &dump_dir {
                Some(d) => Dump::to(d)?,
                None => Dump::none(),
            };
            let t_all = Instant::now();
            let mut tr = Transcriber::new(&paths, &opts)?;
            eprintln!("Backbone: ONNX Runtime CPU ({}), models loaded in {:.2}s", paths.onnx.display(), tr.load_s);
            let t0 = Instant::now();
            let mut a = audio::load(std::path::Path::new(input))?;
            let decode_s = t0.elapsed().as_secs_f64();
            if app {
                a = post::loudness_normalize(&a, &post::NormalizeOpts::default());
            }
            let (notes, mut timings) = tr.transcribe_audio(&a, &opts, &dump)?;
            timings.decode_audio_s = decode_s;
            timings.load_models_s = tr.load_s;
            eprintln!("Transcribed {} events in {:.2}s", notes.len(), timings.total_s);
            if let Some(p) = &notes_json {
                std::fs::write(p, serde_json::to_string(&serde_json::json!({"notes": notes, "timings": timings}))?)?;
            }
            if app {
                let piano = midi::piano_from_notes(&notes)?;
                let (before, after, cleaned) = post::clean_midi(&piano, &post::CleanOpts::default());
                std::fs::write(output, midi::piano_to_bytes(cleaned.as_ref())?)?;
                eprintln!("MIDI cleanup: {before} -> {after} notes (dropped {})", before - after);
            } else {
                midi::write(&notes, std::path::Path::new(output))?;
            }
            eprintln!("MIDI: {output}");
            eprintln!(
                "[timing] wall {:.2}s = load {:.2} + audio {:.2} + resample {:.2} + frontend {:.2} + backbone {:.2} + decode/heads {:.2} ({} segments)",
                t_all.elapsed().as_secs_f64(),
                timings.load_models_s,
                timings.decode_audio_s,
                timings.resample_s,
                timings.frontend_s,
                timings.backbone_s,
                timings.decode_s,
                timings.segments
            );
            eprintln!("[memcap] {}", memlimit::peaks());
            Ok(())
        }
        _ => {
            print!("{USAGE}");
            Ok(())
        }
    }
}

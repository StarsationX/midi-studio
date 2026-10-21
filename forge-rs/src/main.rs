use anyhow::{bail, Context, Result};
use forge_rs::assets::AssetPaths;
use forge_rs::dump::Dump;
use forge_rs::{audio, memlimit, midi, post, Options, Transcriber};
use std::path::PathBuf;
use std::time::Instant;

const USAGE: &str = "\
forge-rs: Transkun v2 piano transcription (no Python)

USAGE:
  forge-rs transcribe <audio> <out.mid> [options]
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

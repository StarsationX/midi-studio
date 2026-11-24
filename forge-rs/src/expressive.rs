use super::{expressive_dynamics as dynamics, expressive_model, expressive_stems, Args, Knobs};
use crate::{expressive_arrange, expressive_vocal};
use anyhow::{bail, Context, Result};
use serde_json::json;
use std::io::Write;
use std::path::{Path, PathBuf};

#[path = "expressive_attacks.rs"]
mod attacks;
#[path = "expressive_treble_recovery.rs"]
mod treble_recovery;
#[path = "expressive_tenor.rs"]
mod tenor;
#[path = "expressive_strum.rs"]
mod strum;
#[path = "expressive_partials.rs"]
mod partials;

pub(super) fn run(args: &Args, knobs: &Knobs, source: &Path, output: &Path) -> Result<()> {
    if !output.extension().is_some_and(|s| s.eq_ignore_ascii_case("mid")) {
        bail!("Medley output must be a .mid file");
    }
    println!("[1/6] Prepare vocal model");
    let game = expressive_model(args.models.as_deref())?;
    let evidence = expressive_stems::extract(args, knobs, source)?;
    let bass = evidence.bass_line;
    let mut tempos = evidence.mixture_tempos;
    if tempos.is_empty() {
        tempos = expressive_arrange::tempo_map(&evidence.drums, evidence.sample_rate);
    }
    if tempos.is_empty() {
        tempos = expressive_arrange::tempo_map(&evidence.bass, evidence.sample_rate);
    }
    drop((evidence.bass, evidence.drums));
    println!("[4/6] Detect vocal melody");
    let threads = args.threads.or_else(|| std::env::var("OMP_NUM_THREADS").ok()?.parse().ok()).unwrap_or(4).clamp(1, 8);
    let lead = expressive_vocal::transcribe_vocals(&evidence.vocals, evidence.sample_rate, &game, threads)?;
    println!("Detected {} vocal notes.", lead.len());
    drop(evidence.vocals);
    println!("[5/6] Voice the piano arrangement");
    let mut midi = expressive_arrange::arrange_with_instruments(&lead, &evidence.instrumental, &evidence.backing,
        &evidence.harmony.notes, &evidence.harmony.registers, Some(&bass.notes), evidence.duration, &tempos);
    attacks::align(&mut midi, &evidence.instrumental_wave, &lead, &evidence.piano_passages);
    expressive_arrange::arrange_piano_passages(&mut midi, &evidence.backing, &evidence.piano_passages, &evidence.sustain);
    bass.articulate(&mut midi, &evidence.piano_passages);
    attacks::restore_held_keys(&mut midi, &evidence.instrumental, &evidence.backing, &lead, &evidence.piano_passages, &evidence.instrumental_wave);
    if let [right, _] = midi.instruments.as_mut_slice() {
        attacks::join_splits(&mut right.notes, &evidence.backing, &lead, &evidence.piano_passages,
            &evidence.instrumental_wave, &evidence.guitar_wave, &evidence.guitar_isolated);
    }
    treble_recovery::apply(&mut midi, &evidence.instrumental, &evidence.backing, &lead, &evidence.piano_passages, &evidence.instrumental_wave);
    tenor::apply(&mut midi, &evidence.backing, &evidence.instrumental_wave, &evidence.piano_passages, &evidence.guitar_isolated);
    strum::apply(&mut midi, &evidence.instrumental, &evidence.backing, &lead, &evidence.piano_passages, &evidence.instrumental_wave);
    attacks::hold_lower(&mut midi, &evidence.backing, &evidence.piano_passages, &evidence.instrumental_wave);
    dynamics::shape(&mut midi, &evidence.pitched_power, &evidence.piano_passages, &evidence.pitched_mix, &evidence.recording);
    attacks::accent_repeats(&mut midi, &evidence.instrumental_wave, &evidence.instrumental, &lead, &evidence.piano_passages);
    let count = midi.note_count();
    if count == 0 { bail!("No playable notes were detected in the selected audio"); }
    println!("[6/6] Save piano MIDI");
    let output = publish(&midi.to_bytes()?, output)?;
    let names: serde_json::Map<_, _> = midi.instruments.iter()
        .enumerate().map(|(index, track)| (index.to_string(), json!(track.name))).collect();
    println!("RESULT|{}", json!({
        "midiPath": output, "candidates": {"clean": output}, "candidateCounts": {"clean": count},
        "sourceAudio": source, "channelNames": names, "engine": "rust", "pipeline": "expressive",
        "tempoChanges": tempos.iter().map(|(time, bpm)| json!({"time":time,"bpm":bpm})).collect::<Vec<_>>()
    }));
    println!("DONE");
    Ok(())
}

fn publish(bytes: &[u8], requested: &Path) -> Result<PathBuf> {
    let dir = requested.parent().context("Missing MIDI output directory")?;
    std::fs::create_dir_all(dir)?;
    let mut temp = tempfile::NamedTempFile::new_in(dir)?;
    temp.write_all(bytes)?;
    temp.flush()?;
    let stem = requested.file_stem().context("Missing MIDI output name")?.to_string_lossy();
    for n in 1..=10000 {
        let path = if n == 1 { requested.to_owned() } else { dir.join(format!("{stem} ({n}).mid")) };
        if path.with_extension("midstudio.json").exists() { continue; }
        match temp.persist_noclobber(&path) {
            Ok(_) => return Ok(path),
            Err(e) if e.error.kind() == std::io::ErrorKind::AlreadyExists => temp = e.file,
            Err(e) => return Err(e.error).with_context(|| format!("Save {}", path.display())),
        }
    }
    bail!("No unused file name is available in {}", dir.display())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn publish_preserves_an_existing_export_and_project() {
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("Piano.mid");
        publish(b"old", &out).unwrap();
        std::fs::write(dir.path().join("Piano (2).midstudio.json"), b"project").unwrap();
        let second = publish(b"new", &out).unwrap();
        assert_eq!(second.file_name().unwrap(), "Piano (3).mid");
        assert_eq!(std::fs::read(out).unwrap(), b"old");
        assert_eq!(std::fs::read(second).unwrap(), b"new");
    }
}

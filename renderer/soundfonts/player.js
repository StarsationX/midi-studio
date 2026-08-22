// Lightweight offline player for the bundled FluidR3 General MIDI samples.
(() => {
  'use strict';

  const ROOT = '../soundfonts/FluidR3_GM/';
  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const PRESETS = Object.freeze({
    grand_piano: { label: 'Grand Piano', file: 'acoustic_grand_piano', gain: 0.72, attack: 0.004, release: 0.45 },
    bright_piano: { label: 'Bright Piano', file: 'bright_acoustic_piano', gain: 0.62, attack: 0.003, release: 0.38 },
    electric_piano: { label: 'Electric Piano', file: 'electric_piano_1', gain: 0.72, attack: 0.006, release: 0.55 },
    music_box: { label: 'Music Box', file: 'music_box', gain: 0.58, attack: 0.002, release: 0.7 },
    vibraphone: { label: 'Vibraphone', file: 'vibraphone', gain: 0.65, attack: 0.004, release: 0.8 },
    strings: { label: 'String Ensemble', file: 'string_ensemble_1', gain: 0.52, attack: 0.08, release: 0.7 },
    synth_lead: { label: 'Synth Lead', file: 'lead_2_sawtooth', gain: 0.5, attack: 0.008, release: 0.25 },
    synth_drum: { label: 'Synth Drum', file: 'synth_drum', gain: 0.62, attack: 0.002, release: 0.2 },
  });

  const scriptLoads = new Map();
  const decoded = new Map();

  function midiToName(value) {
    const midi = Math.max(0, Math.min(127, Math.round(Number(value) || 0)));
    return `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
  }

  function nameToMidi(name) {
    const match = /^([A-G])(#?)(-?\d+)$/.exec(name);
    if (!match) return null;
    const semitones = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
    return (Number(match[3]) + 1) * 12 + semitones[match[1]] + (match[2] ? 1 : 0);
  }

  function loadScript(presetKey) {
    const preset = PRESETS[presetKey] || PRESETS.grand_piano;
    if (window.MIDI && window.MIDI.Soundfont && window.MIDI.Soundfont[preset.file]) {
      return Promise.resolve(window.MIDI.Soundfont[preset.file]);
    }
    if (scriptLoads.has(preset.file)) return scriptLoads.get(preset.file);
    const promise = new Promise((resolve, reject) => {
      window.MIDI = window.MIDI || {};
      window.MIDI.Soundfont = window.MIDI.Soundfont || {};
      const script = document.createElement('script');
      script.src = `${ROOT}${preset.file}-mp3.js`;
      script.onload = () => {
        const bank = window.MIDI.Soundfont[preset.file];
        if (bank) resolve(bank);
        else reject(new Error(`${preset.label} samples did not load.`));
      };
      script.onerror = () => reject(new Error(`${preset.label} samples were not found.`));
      document.head.appendChild(script);
    });
    scriptLoads.set(preset.file, promise);
    return promise;
  }

  function dataUriBuffer(uri) {
    const encoded = String(uri || '').split(',')[1] || '';
    const bytes = atob(encoded);
    const buffer = new ArrayBuffer(bytes.length);
    const view = new Uint8Array(buffer);
    for (let i = 0; i < bytes.length; i += 1) view[i] = bytes.charCodeAt(i);
    return buffer;
  }

  function sampleForPitch(bank, pitch) {
    const exact = midiToName(pitch);
    if (bank[exact]) return { name: exact, pitch: Math.round(pitch) };
    let best = null;
    for (const name of Object.keys(bank)) {
      const samplePitch = nameToMidi(name);
      if (samplePitch === null) continue;
      if (!best || Math.abs(samplePitch - pitch) < Math.abs(best.pitch - pitch)) best = { name, pitch: samplePitch };
    }
    return best;
  }

  async function prepare(context, presetKey, pitches, onProgress) {
    const key = PRESETS[presetKey] ? presetKey : 'grand_piano';
    const bank = await loadScript(key);
    if (!decoded.has(key)) decoded.set(key, new Map());
    const cache = decoded.get(key);
    const samples = new Map();
    for (const pitch of new Set(pitches.map((value) => Math.max(0, Math.min(127, Math.round(value)))))) {
      const sample = sampleForPitch(bank, pitch);
      if (sample) samples.set(sample.name, sample);
    }
    let complete = 0;
    for (const sample of samples.values()) {
      if (!cache.has(sample.name)) {
        cache.set(sample.name, await context.decodeAudioData(dataUriBuffer(bank[sample.name])));
      }
      complete += 1;
      if (onProgress) onProgress(complete, samples.size);
    }
    // Decoded audio is much larger than the source. Keep the two most recently used instruments.
    decoded.delete(key);
    decoded.set(key, cache);
    while (decoded.size > 2) decoded.delete(decoded.keys().next().value);
    return { key, label: PRESETS[key].label, samples: samples.size };
  }

  function play(context, presetKey, pitch, startTime, duration, velocity, destination) {
    const key = PRESETS[presetKey] ? presetKey : 'grand_piano';
    const preset = PRESETS[key];
    const bank = window.MIDI && window.MIDI.Soundfont && window.MIDI.Soundfont[preset.file];
    const sample = bank && sampleForPitch(bank, pitch);
    const buffer = sample && decoded.get(key) && decoded.get(key).get(sample.name);
    if (!buffer) return null;

    const source = context.createBufferSource();
    const envelope = context.createGain();
    const peak = preset.gain * Math.pow(Math.max(1, Math.min(127, Number(velocity) || 80)) / 127, 1.25);
    const hold = Math.max(0.06, Number(duration) || 0.2);
    const releaseAt = startTime + hold;
    source.buffer = buffer;
    source.playbackRate.value = Math.pow(2, (Number(pitch) - sample.pitch) / 12);
    envelope.gain.setValueAtTime(0.0001, startTime);
    envelope.gain.linearRampToValueAtTime(Math.max(0.0002, peak), startTime + preset.attack);
    envelope.gain.setValueAtTime(Math.max(0.0002, peak), releaseAt);
    envelope.gain.exponentialRampToValueAtTime(0.0001, releaseAt + preset.release);
    source.connect(envelope).connect(destination || context.destination);
    source.start(startTime);
    source.stop(releaseAt + preset.release + 0.05);
    return source;
  }

  window.MidiStudioSoundfonts = { presets: PRESETS, prepare, play };
})();

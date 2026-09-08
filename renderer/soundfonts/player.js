// Lightweight offline player for the bundled FluidR3 General MIDI samples.
//
// Banks are loaded by INJECTING A SCRIPT (`<script src="...-mp3.js">`), which is
// why renderer/audition/index.html deliberately keeps a looser CSP than the
// other panels. Do not "fix" that: it is invariant 30.
//
// Three measured costs were fixed here and must not come back:
//   1. every mp3 data: URI was decoded with atob() and then copied into a
//      Uint8Array one character at a time in JS. A bank is a few MB of base64,
//      so that loop ran millions of times per instrument change;
//   2. decodeAudioData was awaited one sample at a time, serialising ~40
//      independent decodes that the browser is happy to run at once;
//   3. sampleForPitch() did Object.keys(bank) + a full linear scan on EVERY
//      note played. It is now a 128-entry table built once per bank.
// The 2-instrument LRU (decoded audio is far larger than its mp3 source) and
// the caller's token-based cancellation are unchanged on purpose.
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

  const scriptLoads = new Map();   // preset file -> in-flight bank promise
  const decoded = new Map();       // preset key -> Map(sample name -> AudioBuffer)
  const inflight = new Map();      // preset key -> Map(sample name -> promise)
  const tables = new Map();        // preset file -> 128-entry pitch -> sample

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
    // A failed load must not be cached as the answer forever: a retry after a
    // transient failure should get a fresh script element.
    promise.catch(() => { if (scriptLoads.get(preset.file) === promise) scriptLoads.delete(preset.file); });
    scriptLoads.set(preset.file, promise);
    return promise;
  }

  // The mp3 arrives as a data: URI. fetch() hands the bytes over in one move
  // inside the browser; the old atob + per-character copy was the single
  // hottest thing in an instrument change.
  async function toArrayBuffer(uri) {
    const text = String(uri || '');
    try {
      const response = await fetch(text);
      return await response.arrayBuffer();
    } catch (_) {
      // CSP or an exotic URI: still bulk, still one pass, no per-byte JS loop
      // written by hand.
      const encoded = text.slice(text.indexOf(',') + 1);
      return Uint8Array.from(atob(encoded), (ch) => ch.charCodeAt(0)).buffer;
    }
  }

  // One 128-entry lookup per bank, built the first time the bank is seen.
  // Every pitch resolves to the nearest sample the bank actually ships.
  function tableFor(file, bank) {
    const cached = tables.get(file);
    if (cached) return cached;
    const available = [];
    for (const name of Object.keys(bank)) {
      const pitch = nameToMidi(name);
      if (pitch !== null) available.push({ name, pitch });
    }
    available.sort((a, b) => a.pitch - b.pitch);
    const table = new Array(128).fill(null);
    if (available.length) {
      for (let pitch = 0; pitch < 128; pitch += 1) {
        const exact = midiToName(pitch);
        if (bank[exact]) { table[pitch] = { name: exact, pitch }; continue; }
        let best = available[0];
        for (const candidate of available) {
          if (Math.abs(candidate.pitch - pitch) < Math.abs(best.pitch - pitch)) best = candidate;
        }
        table[pitch] = best;
      }
    }
    tables.set(file, table);
    return table;
  }

  function clampPitch(value) {
    return Math.max(0, Math.min(127, Math.round(Number(value) || 0)));
  }

  // Decode only the samples this song needs, all at once, reporting progress as
  // each one settles. `pitches` may be an array, a Set or anything iterable.
  async function prepare(context, presetKey, pitches, onProgress) {
    const key = PRESETS[presetKey] ? presetKey : 'grand_piano';
    const preset = PRESETS[key];
    const bank = await loadScript(key);
    const table = tableFor(preset.file, bank);
    if (!decoded.has(key)) decoded.set(key, new Map());
    if (!inflight.has(key)) inflight.set(key, new Map());
    const cache = decoded.get(key);
    const pending = inflight.get(key);

    const needed = new Set();
    for (const value of pitches) {
      const sample = table[clampPitch(value)];
      if (sample) needed.add(sample.name);
    }

    const total = needed.size;
    let ready = 0;
    if (onProgress) onProgress(0, total);
    const jobs = [];
    for (const name of needed) {
      if (cache.has(name)) { ready += 1; if (onProgress) onProgress(ready, total); continue; }
      let job = pending.get(name);
      if (!job) {
        job = toArrayBuffer(bank[name])
          .then((bytes) => context.decodeAudioData(bytes))
          .then((buffer) => { cache.set(name, buffer); return buffer; })
          .finally(() => { if (pending.get(name) === job) pending.delete(name); });
        pending.set(name, job);
      }
      jobs.push(job.then(() => { ready += 1; if (onProgress) onProgress(ready, total); }));
    }
    await Promise.all(jobs);

    // Decoded audio is much larger than the source. Keep the two most recently
    // used instruments: re-inserting moves this key to the end of the Map.
    decoded.delete(key);
    decoded.set(key, cache);
    while (decoded.size > 2) {
      const oldest = decoded.keys().next().value;
      decoded.delete(oldest);
      inflight.delete(oldest);
    }
    return { key, label: preset.label, samples: total };
  }

  function play(context, presetKey, pitch, startTime, duration, velocity, destination) {
    const key = PRESETS[presetKey] ? presetKey : 'grand_piano';
    const preset = PRESETS[key];
    const bank = window.MIDI && window.MIDI.Soundfont && window.MIDI.Soundfont[preset.file];
    if (!bank) return null;
    const cache = decoded.get(key);
    if (!cache) return null;
    const sample = tableFor(preset.file, bank)[clampPitch(pitch)];
    const buffer = sample && cache.get(sample.name);
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

  // True when this pitch can be played from a decoded sample right now, so the
  // caller can pick the fallback synth without allocating anything first.
  function has(presetKey, pitch) {
    const key = PRESETS[presetKey] ? presetKey : 'grand_piano';
    const preset = PRESETS[key];
    const bank = window.MIDI && window.MIDI.Soundfont && window.MIDI.Soundfont[preset.file];
    const cache = decoded.get(key);
    if (!bank || !cache) return false;
    const sample = tableFor(preset.file, bank)[clampPitch(pitch)];
    return !!(sample && cache.has(sample.name));
  }

  window.MidiStudioSoundfonts = { presets: PRESETS, prepare, play, has };
})();

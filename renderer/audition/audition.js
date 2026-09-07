// audition.js — Self MIDI, the internal listener.
//
// The Player sends keystrokes to another application. Self MIDI plays the music
// HERE, through Web Audio, with the sampled FluidR3 banks. So this reads as a
// music player and a library browser, not as a second Player.
//
// The three things in this file that must never be "simplified":
//
//   1. Playback is a LOOKAHEAD scheduler. Every note is pinned to an absolute
//      Web Audio clock time ~1.5s ahead of now (invariant 26). A late or
//      throttled wake-up therefore costs nothing. Never fire notes per frame.
//   2. The seamless loop rolls audioStart FORWARD. It never calls seek(), which
//      is what put the gap back in.
//   3. Canvas backing stores are only reallocated when the pixel size actually
//      changed — Draw.fitCanvas owns that, and reassigning width/height per
//      frame clears the surface and stalls playback (invariant 27).
//
// Everything visual is a CONTRACT primitive. Everything drawn goes through the
// Draw scheduler, so it parks off screen and floors at 30fps while playing.
(() => {
  'use strict';

  const api = window.api;
  const review = window.review;
  const studio = window.studio;
  const libraryApi = window.library;
  const soundfonts = window.MidiStudioSoundfonts;
  const T = window.Bus.TYPES;

  const FRAME = 'audition';        // frame key on the bus
  const OWNER = 'selfmidi';        // transport owner name

  const $ = (id) => document.getElementById(id);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const lower = (s) => String(s || '').toLowerCase();

  // §9.6: paint on input (rAF-coalesced), persist on change (trailing debounce).
  function coalesce(fn) {
    let armed = false, args = null;
    return (...a) => {
      args = a;
      if (armed) return;
      armed = true;
      requestAnimationFrame(() => { armed = false; fn(...args); });
    };
  }
  function debounce(fn, ms) {
    let t = 0, last = null;
    const w = (...a) => {
      last = a;
      clearTimeout(t);
      t = setTimeout(() => { t = 0; const p = last; last = null; fn(...p); }, ms);
    };
    w.flush = () => { if (!t) return; clearTimeout(t); t = 0; const p = last; last = null; if (p) fn(...p); };
    w.cancel = () => { clearTimeout(t); t = 0; last = null; };
    w.pending = () => !!t;
    return w;
  }

  // A published command descriptor carries `enabled` as a boolean SNAPSHOT
  // (bus.js cannot post a function), and the mirror to the shell is only
  // scheduled after a register. So every gate this panel evaluates lazily —
  // "a file is loaded", "the queue is not empty", "a loop range exists" — has
  // to be re-published when it moves, or Ctrl+K shows the command greyed out
  // forever. Coalesced: a burst of state changes costs one publish.
  const republishCommands = debounce(() => {
    if (window.Commands && window.Commands.publish) window.Commands.publish();
  }, 40);

  // ==========================================================================
  // 1. PREFS  (localStorage, with the midi-player legacy migration)
  // ==========================================================================
  const PREFS_KEY = 'midi-studio.audition.v1';
  const OLD_PREFS_KEY = 'midi-forge.preview-prefs.v1';
  const META_KEY = 'midi-studio.audition.meta.v1';
  const PLAYER_KEY = 'midi-player.settings.v3';
  const SOUND_MIGRATION = { soft: 'grand_piano', bright: 'synth_lead', pure: 'electric_piano', chip: 'music_box' };

  const defaults = {
    volume: 65, instrument: 'grand_piano', speed: 1, pitch: 0, sustain: true,
    loop: false, autoplay: false, recent: [], lastMidiPath: '', lastProjectPath: '',
    // new in the rewrite
    queue: [], history: [], bookmarks: {}, repeat: 'off',
    navTab: 'library', navSource: 'all', navSort: 'recent', railTab: 'queue', infoOpen: true,
  };
  let prefs = { ...defaults };
  try {
    // The old key is read FIRST and the new one layered on top: dropping this
    // silently resets a returning user's volume, instrument and sustain.
    const old = JSON.parse(localStorage.getItem(OLD_PREFS_KEY) || '{}');
    prefs = {
      ...prefs,
      volume: Number(old.midiVolume) || prefs.volume,
      instrument: SOUND_MIGRATION[old.sound] || old.sound || prefs.instrument,
      speed: Number(old.speed) || prefs.speed,
      pitch: Number(old.pitch) || 0,
      sustain: old.sustain !== false,
      loop: !!old.loop,
      lastMidiPath: old.lastMidiPath || '',
      lastProjectPath: old.lastProjectPath || '',
    };
    prefs = { ...prefs, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') };
  } catch (_) { /* private mode, or corrupt JSON */ }
  if (!soundfonts || !soundfonts.presets[prefs.instrument]) prefs.instrument = 'grand_piano';
  if (!Array.isArray(prefs.recent)) prefs.recent = [];
  if (!Array.isArray(prefs.queue)) prefs.queue = [];
  if (!Array.isArray(prefs.history)) prefs.history = [];
  if (!prefs.bookmarks || typeof prefs.bookmarks !== 'object') prefs.bookmarks = {};
  if (['off', 'all', 'one'].indexOf(prefs.repeat) < 0) prefs.repeat = 'off';

  function savePrefsNow() {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (_) {}
  }
  const savePrefs = debounce(savePrefsNow, 220);

  // A tiny cache of what we learned by actually opening a file, so a queue row
  // can show a real length instead of an em dash forever. Never parsed in a
  // render path, never guessed: only written after a successful load.
  let meta = {};
  try { meta = JSON.parse(localStorage.getItem(META_KEY) || '{}') || {}; } catch (_) { meta = {}; }
  const saveMeta = debounce(() => {
    const keys = Object.keys(meta);
    if (keys.length > 400) for (const k of keys.slice(0, keys.length - 400)) delete meta[k];
    try { localStorage.setItem(META_KEY, JSON.stringify(meta)); } catch (_) {}
  }, 400);
  function rememberMeta(path, doc) {
    if (!path || !doc) return;
    delete meta[lower(path)];                       // re-insert: newest last
    meta[lower(path)] = { duration: Number(doc.duration) || 0, notes: doc.notes.length };
    saveMeta();
  }
  const metaFor = (path) => meta[lower(path)] || null;

  // ==========================================================================
  // 2. THE TWO SHARED STORES
  //    Favorites is ONE store with the Library tab (CONTRACT §11.12):
  //    ui.libraryFavorites in settings, written whole, announced on the bus.
  //    Named playlists are ui.playlists, same rules. Settings REPLACES arrays.
  // ==========================================================================
  let favOrder = [];                 // absolute paths, original case, user order
  let favSet = new Set();            // lowercased, for the case-insensitive test
  let playlists = [];                // [{id, name, paths[]}]

  function rebuildFavSet() { favSet = new Set(favOrder.map(lower)); }

  // Write FIRST, announce after. `library:changed {reason:'favorites'}` is the
  // only notification for this shared store (CONTRACT §11.12), and a frame that
  // reacts to it by re-reading getUi().libraryFavorites must not be handed the
  // pre-toggle array — there is no second notification to correct it with.
  let favWrite = Promise.resolve();
  const writeFavs = debounce(() => {
    const announce = () => window.Bus.send(T.LIBRARY_CHANGED, { reason: 'favorites' });
    if (!studio || !studio.setUi) { announce(); return; }
    favWrite = Promise.resolve(studio.setUi({ libraryFavorites: favOrder.slice() }))
      .then(announce, announce);
  }, 260);
  let playlistWrite = Promise.resolve();
  const writePlaylists = debounce(() => {
    if (!studio || !studio.setUi) return;
    playlistWrite = Promise.resolve(studio.setUi({
      playlists: playlists.map((p) => ({ id: p.id, name: p.name, paths: p.paths.slice() })),
    })).catch(() => {});
  }, 260);

  // Both debounced writers read favOrder / playlists at FIRE time, so a re-read
  // that lands first would overwrite the local change and then be written back
  // out as if it had never happened. Flush anything pending and wait for it.
  async function settleStores() {
    if (writeFavs.pending()) writeFavs.flush();
    if (writePlaylists.pending()) writePlaylists.flush();
    try { await favWrite; } catch (_) {}
    try { await playlistWrite; } catch (_) {}
  }

  async function readStores() {
    await settleStores();
    if (!studio || !studio.getUi) return;
    let ui = null;
    try { ui = await studio.getUi(); } catch (_) { return; }
    if (!ui) return;
    favOrder = Array.isArray(ui.libraryFavorites) ? ui.libraryFavorites.filter((p) => typeof p === 'string' && p) : [];
    rebuildFavSet();
    playlists = (Array.isArray(ui.playlists) ? ui.playlists : [])
      .filter((p) => p && typeof p.name === 'string')
      .map((p) => ({
        id: String(p.id || p.name),
        name: String(p.name),
        paths: Array.isArray(p.paths) ? p.paths.filter((x) => typeof x === 'string' && x) : [],
      }));
  }

  const isFav = (path) => favSet.has(lower(path));
  function toggleFav(path) {
    if (!path) return;
    if (isFav(path)) favOrder = favOrder.filter((p) => lower(p) !== lower(path));
    else favOrder = [path, ...favOrder];
    rebuildFavSet();
    // writeFavs announces on the bus once the write has landed. Every frame
    // already listens for library:changed, so no new bus type.
    writeFavs();
    syncFavUI();
    renderSources();
    if (navSource === 'fav' || navTab === 'favorites') renderFiles();
    else fileList.refresh();
  }

  // The Player's own playlist is read straight out of its localStorage (one
  // origin, one store — the same fact resize.js depends on). Read-only: the
  // Player owns writing it.
  function playerPlaylist() {
    try {
      const s = JSON.parse(localStorage.getItem(PLAYER_KEY) || '{}');
      return Array.isArray(s.playlist) ? s.playlist.filter((p) => typeof p === 'string' && /\.midi?$/i.test(p)) : [];
    } catch (_) { return []; }
  }

  // ==========================================================================
  // 3. STATE
  // ==========================================================================
  const LOOKAHEAD = 1.5;   // seconds of notes pinned to the audio clock
  const TICK_MS = 100;     // scheduler + transport report: 10Hz is the bar's floor
  const SOUND_WINDOW = 5;  // seconds back to look for a still-sounding note
  const KEYS_W = 38;       // drawn keyboard strip, css px

  const player = {
    token: 0, documents: {}, candidate: '', project: null, midiPath: '', projectPath: '',
    duration: 0, position: 0, playing: false, audioStart: 0, cursor: 0, timer: 0,
    context: null, master: null, voices: new Set(),
    instrumentToken: 0, instrumentReady: '', instrumentFailed: false,
    version: 0,
  };

  // The four values the audio scheduler used to read out of the DOM for EVERY
  // scheduled note. They are mirrored here and maintained by the same handlers
  // that used to be the only writers, and they are seeded from the restored
  // prefs at boot — without that the first note plays at the wrong volume.
  const ctl = {
    volume: clamp(Number(prefs.volume) || 0, 0, 100),
    sustain: prefs.sustain !== false,
    transpose: clamp(Math.round(Number(prefs.pitch) || 0), -24, 24),
    instrument: prefs.instrument,
    speed: clamp(Number(prefs.speed) || 1, 0.25, 2),
  };
  const loop = { on: !!prefs.loop, a: 0, b: 0 };
  let repeat = prefs.repeat;
  let spaceTransport = true;
  let navTab = ['library', 'playlists', 'favorites'].indexOf(prefs.navTab) >= 0 ? prefs.navTab : 'library';
  let navSource = prefs.navSource || 'all';
  let railTab = prefs.railTab === 'history' ? 'history' : 'queue';
  let loadRequested = false;

  const currentDocument = () => player.documents[player.candidate] || null;
  function currentPath() {
    const doc = currentDocument();
    return (doc && doc.path) || player.midiPath || '';
  }
  const instrumentLabel = (key = ctl.instrument) =>
    (soundfonts && soundfonts.presets[key] ? soundfonts.presets[key].label : 'Grand Piano');

  // ==========================================================================
  // 4. GM PROGRAM NAMES (for the MIDI information disclosure)
  // ==========================================================================
  const GM = ('Acoustic Grand Piano,Bright Acoustic Piano,Electric Grand Piano,Honky-tonk Piano,Electric Piano 1,'
    + 'Electric Piano 2,Harpsichord,Clavinet,Celesta,Glockenspiel,Music Box,Vibraphone,Marimba,Xylophone,'
    + 'Tubular Bells,Dulcimer,Drawbar Organ,Percussive Organ,Rock Organ,Church Organ,Reed Organ,Accordion,'
    + 'Harmonica,Tango Accordion,Acoustic Guitar (nylon),Acoustic Guitar (steel),Electric Guitar (jazz),'
    + 'Electric Guitar (clean),Electric Guitar (muted),Overdriven Guitar,Distortion Guitar,Guitar Harmonics,'
    + 'Acoustic Bass,Electric Bass (finger),Electric Bass (pick),Fretless Bass,Slap Bass 1,Slap Bass 2,'
    + 'Synth Bass 1,Synth Bass 2,Violin,Viola,Cello,Contrabass,Tremolo Strings,Pizzicato Strings,Orchestral Harp,'
    + 'Timpani,String Ensemble 1,String Ensemble 2,Synth Strings 1,Synth Strings 2,Choir Aahs,Voice Oohs,'
    + 'Synth Voice,Orchestra Hit,Trumpet,Trombone,Tuba,Muted Trumpet,French Horn,Brass Section,Synth Brass 1,'
    + 'Synth Brass 2,Soprano Sax,Alto Sax,Tenor Sax,Baritone Sax,Oboe,English Horn,Bassoon,Clarinet,Piccolo,'
    + 'Flute,Recorder,Pan Flute,Blown Bottle,Shakuhachi,Whistle,Ocarina,Lead 1 (square),Lead 2 (sawtooth),'
    + 'Lead 3 (calliope),Lead 4 (chiff),Lead 5 (charang),Lead 6 (voice),Lead 7 (fifths),Lead 8 (bass+lead),'
    + 'Pad 1 (new age),Pad 2 (warm),Pad 3 (polysynth),Pad 4 (choir),Pad 5 (bowed),Pad 6 (metallic),Pad 7 (halo),'
    + 'Pad 8 (sweep),FX 1 (rain),FX 2 (soundtrack),FX 3 (crystal),FX 4 (atmosphere),FX 5 (brightness),'
    + 'FX 6 (goblins),FX 7 (echoes),FX 8 (sci-fi),Sitar,Banjo,Shamisen,Koto,Kalimba,Bagpipe,Fiddle,Shanai,'
    + 'Tinkle Bell,Agogo,Steel Drums,Woodblock,Taiko Drum,Melodic Tom,Synth Drum,Reverse Cymbal,'
    + 'Guitar Fret Noise,Breath Noise,Seashore,Bird Tweet,Telephone Ring,Helicopter,Applause,Gunshot').split(',');

  // Krumhansl-Schmuckler over the pitch-class histogram. The loader carries no
  // key signature and we do not change the Python engine, so this is offered as
  // an estimate and labelled as one — never as a fact.
  const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  const PITCH_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  function estimateKey(notes) {
    if (!notes || notes.length < 12) return '';
    const hist = new Array(12).fill(0);
    for (const note of notes) {
      if (Number(note.channel) === 9) continue;               // drums carry no key
      const weight = Math.max(0.05, Math.min(4, Number(note.end) - Number(note.start)));
      hist[((Number(note.pitch) % 12) + 12) % 12] += weight;
    }
    let total = 0;
    for (const v of hist) total += v;
    if (total <= 0) return '';
    const mean = total / 12;
    let best = null;
    for (let root = 0; root < 12; root += 1) {
      for (const [profile, mode] of [[MAJOR_PROFILE, 'major'], [MINOR_PROFILE, 'minor']]) {
        let pMean = 0;
        for (const v of profile) pMean += v;
        pMean /= 12;
        let num = 0, da = 0, db = 0;
        for (let i = 0; i < 12; i += 1) {
          const x = hist[(root + i) % 12] - mean;
          const y = profile[i] - pMean;
          num += x * y; da += x * x; db += y * y;
        }
        const score = da && db ? num / Math.sqrt(da * db) : 0;
        if (!best || score > best.score) best = { score, root, mode };
      }
    }
    if (!best || best.score < 0.2) return '';
    return `${PITCH_NAMES[best.root]} ${best.mode}`;
  }

  // ==========================================================================
  // 5. AUDIO
  // ==========================================================================
  function ensureAudio() {
    if (!player.context) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      player.context = new Ctor();
    }
    if (!player.master) {
      player.master = player.context.createGain();
      player.master.connect(player.context.destination);
    }
    player.master.gain.value = ctl.volume / 100;
    return player.context;
  }

  // Voices are pruned on the scheduler tick instead of carrying an 'ended'
  // listener each: at a few hundred notes a second that was a listener
  // allocation per note.
  function registerVoice(node, endsAt) { player.voices.add({ node, endsAt }); }
  function pruneVoices() {
    if (!player.context) return;
    const now = player.context.currentTime;
    for (const voice of player.voices) if (voice.endsAt <= now) player.voices.delete(voice);
  }
  function clearVoices() {
    for (const voice of player.voices) { try { voice.node.stop(); } catch (_) {} }
    player.voices.clear();
  }

  function playFallback(note, pitch, duration, when) {
    const context = player.context;
    const now = Math.max(when || 0, context.currentTime);
    const oscillator = context.createOscillator();
    const envelope = context.createGain();
    const velocity = clamp(Number(note.velocity) || 80, 1, 127) / 127;
    const drum = Number(note.channel) === 9 || ctl.instrument === 'synth_drum';
    let length = duration;
    let peak = 0.11 * velocity;
    if (drum) {
      const notePitch = Number(note.pitch);
      length = [42, 44, 46, 49, 51].includes(notePitch) ? 0.08 : notePitch <= 36 ? 0.18 : 0.12;
      oscillator.type = notePitch <= 36 ? 'sine' : notePitch === 38 || notePitch === 40 ? 'sawtooth' : 'square';
      oscillator.frequency.setValueAtTime(notePitch <= 36 ? 120 : notePitch <= 40 ? 190 : 3200, now);
      oscillator.frequency.exponentialRampToValueAtTime(notePitch <= 36 ? 45 : notePitch <= 40 ? 90 : 900, now + length);
      peak = 0.09 * velocity;
    } else {
      oscillator.type = 'triangle';
      oscillator.frequency.value = 440 * Math.pow(2, (pitch - 69) / 12);
    }
    envelope.gain.setValueAtTime(0.0001, now);
    envelope.gain.linearRampToValueAtTime(Math.max(0.0002, peak), now + 0.008);
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + length);
    oscillator.connect(envelope).connect(player.master || context.destination);
    registerVoice(oscillator, now + length + 0.05);
    oscillator.start(now);
    oscillator.stop(now + length + 0.02);
  }

  function playNote(note, when) {
    if (!player.context || ctl.volume <= 0) return;          // volume 0 schedules nothing
    const speed = ctl.speed;
    let duration = clamp((Number(note.end) - Number(note.start)) / speed, 0.04, 2.5);
    const pitch = Number(note.pitch) + ctl.transpose;
    const drum = Number(note.channel) === 9 || ctl.instrument === 'synth_drum';
    if (ctl.sustain && !drum) duration = clamp(duration + 1.25 / speed, 0.2, 5);
    const at = Math.max(when, player.context.currentTime);
    if (player.instrumentReady === ctl.instrument) {
      const source = soundfonts.play(player.context, ctl.instrument, pitch, at, duration, note.velocity, player.master);
      if (source) { registerVoice(source, at + duration + 1.2); return; }
    }
    playFallback(note, pitch, duration, at);
  }

  function invalidateInstrument() {
    player.instrumentToken += 1;
    player.instrumentReady = '';
    player.instrumentFailed = false;
    delete $('instrument').dataset.ready;
    setInstrumentStatus(`${instrumentLabel()} · Loads on play`);
  }

  function setInstrumentStatus(message) {
    const el = $('instrument-status');
    const text = message || `${instrumentLabel()} · Ready`;
    if (el.textContent !== text) el.textContent = text;
    el.title = text;
  }

  async function prepareInstrument() {
    const doc = currentDocument();
    const key = ctl.instrument;
    if (!doc || !soundfonts || !soundfonts.presets[key]) return false;
    if (player.instrumentReady === key) return true;
    const token = ++player.instrumentToken;
    // Build the distinct transposed pitch set directly: prepare() only ever
    // wanted the set, and doc.notes.map() allocated a full parallel array.
    const pitches = new Set();
    for (const note of doc.notes) pitches.add(clamp(Number(note.pitch) + ctl.transpose, 0, 127));
    setInstrumentStatus(`Loading ${instrumentLabel(key)}…`);
    let announced = false;
    let lastPct = -1;
    let lastSend = 0;
    try {
      await soundfonts.prepare(ensureAudio(), key, pitches, (ready, total) => {
        if (token !== player.instrumentToken) return;
        setInstrumentStatus(`Loading ${instrumentLabel(key)}… ${ready}/${total}`);
        // A determinate job long enough to be worth a strip row (§11.3). Sent at
        // most 10Hz and only on an integer change: the strip is rAF-coalesced and
        // only rewrites its text when the integer moves, so more buys nothing.
        if (total <= 8) return;
        const pct = Math.round(ready / Math.max(1, total) * 100);
        const now = performance.now();
        if (pct === lastPct || (now - lastSend < 100 && pct < 100)) return;
        lastPct = pct;
        lastSend = now;
        announced = true;
        window.Bus.send(T.FRAME_BUSY, {
          frame: FRAME, busy: true, percent: pct, label: `Loading ${instrumentLabel(key)} samples`,
        });
      });
      if (token !== player.instrumentToken || key !== ctl.instrument) return false;
      player.instrumentReady = key;
      player.instrumentFailed = false;
      $('instrument').dataset.ready = key;
      setInstrumentStatus('');
      return true;
    } catch (error) {
      if (token !== player.instrumentToken) return false;
      player.instrumentFailed = true;
      setInstrumentStatus(`${instrumentLabel(key)} unavailable · Basic fallback`);
      window.Bus.send(T.UI_STATUS, {
        frame: FRAME, severity: 'warn',
        text: `Self MIDI: ${instrumentLabel(key)} samples did not load (${error && error.message ? error.message : 'unknown error'}). Using the fallback synth.`,
      });
      return false;
    } finally {
      if (announced) window.Bus.send(T.FRAME_BUSY, { frame: FRAME, busy: false });
    }
  }

  // ==========================================================================
  // 6. THE SCHEDULER
  // ==========================================================================
  function songTime() {
    if (!player.playing || !player.context) return player.position;
    return clamp((player.context.currentTime - player.audioStart) * ctl.speed, 0, player.duration);
  }

  // Notes are start-ordered, so the cursor is a binary search, not a scan from
  // index 0 on every seek.
  function cursorFor(from) {
    const doc = currentDocument();
    if (!doc) return 0;
    const notes = doc.notes;
    let lo = 0, hi = notes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (Number(notes[mid].start) < from) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  // The window playback repeats over: an explicit A-B range, or the whole song
  // when Repeat is set to one. `on:false` means play to the end and stop.
  function region() {
    const dur = player.duration;
    if (loop.on && loop.b - loop.a >= 0.25 && dur > 0) {
      return { a: clamp(loop.a, 0, dur), b: clamp(loop.b, 0, dur), on: true };
    }
    if (repeat === 'one' && dur > 0.25) return { a: 0, b: dur, on: true };
    return { a: 0, b: dur, on: false };
  }

  function scheduleAhead() {
    const doc = currentDocument();
    if (!player.playing || !doc || !player.context) return;
    const notes = doc.notes;
    const speed = ctl.speed;
    const r = region();
    // A while-loop, not recursion: a tight loop region used to re-enter this
    // function once per wrap.
    for (let guard = 0; guard < 8; guard += 1) {
      const horizon = (player.context.currentTime + LOOKAHEAD - player.audioStart) * speed;
      const limit = r.on ? Math.min(horizon, r.b) : horizon;
      while (player.cursor < notes.length && Number(notes[player.cursor].start) <= limit) {
        const note = notes[player.cursor];
        player.cursor += 1;
        playNote(note, player.audioStart + Number(note.start) / speed);
      }
      if (r.on) {
        // Roll the timeline forward instead of seeking, so the loop has no gap.
        if (player.context.currentTime < player.audioStart + r.b / speed) break;
        player.audioStart += (r.b - r.a) / speed;
        player.cursor = cursorFor(r.a);
        continue;
      }
      if (player.context.currentTime >= player.audioStart + player.duration / speed) {
        if (!advanceQueue()) stop();
      }
      break;
    }
    pruneVoices();
  }

  function tick() {
    scheduleAhead();
    player.position = songTime();
    setClock();
    reportState();
    // While parked (another tab is showing, or the window is minimised) the
    // Draw scheduler arms nothing, so this tick is the only position update.
    if (rollHandle) rollHandle.invalidate();
  }

  function startTimer() {
    clearInterval(player.timer);
    player.timer = setInterval(tick, TICK_MS);
  }
  function stopTimer() { clearInterval(player.timer); player.timer = 0; }

  // ==========================================================================
  // 7. TRANSPORT
  // ==========================================================================
  function songLabel() {
    const doc = currentDocument();
    if (doc && doc.name) return doc.name;
    if (player.project && player.project.name) return player.project.name;
    return 'Nothing loaded';
  }
  function subLine() {
    const bits = [instrumentLabel()];
    if (ctl.speed !== 1) bits.push(`${ctl.speed}x`);
    if (loop.on && loop.b > loop.a) bits.push(`Loop ${window.Fmt.clock(loop.a)}–${window.Fmt.clock(loop.b)}`);
    return bits.join(' · ');
  }
  function statusName() {
    if (!currentDocument() || !player.duration) return 'blocked';
    if (player.playing) return 'playing';
    return player.position > 0.01 ? 'paused' : 'idle';
  }
  function capsNow() {
    const doc = currentDocument();
    return {
      seek: true,
      rate: true,
      loop: true,
      queue: prefs.queue.length > 1 || (prefs.queue.length === 1 && lower(prefs.queue[0]) !== lower(currentPath())),
      repeat,
      transpose: ctl.transpose,
      volume: ctl.volume / 100,
      sub: subLine(),
      target: 'In app',
      notes: doc ? doc.notes.length : 0,
      blockedWhy: doc ? 'No notes' : 'No file',
    };
  }

  let handle = null;
  let lastReportAt = 0;
  const impl = {
    play() { void startPlayback(); },
    pause() { pause(); },
    stop() { stop(); },
    toggle() { void togglePlay(); },
    seek(seconds) { seek(seconds); },
    rate(multiplier) { setSpeed(multiplier); },
    setLoop(value) {
      if (value && Number.isFinite(Number(value.a)) && Number.isFinite(Number(value.b))) {
        setRange(Number(value.a), Number(value.b));
        setLoopOn(true);
      } else {
        setLoopOn(false);
      }
    },
    next() { nextTrack(); },
    prev() { prevTrack(); },
    position() { return songTime(); },
    park() {
      // Stop the clock, let go of Space, stop reporting. Two owners means two
      // clocks and two Space handlers fighting over one keypress.
      pause();
      handle = null;
      if (rollHandle) rollHandle.setLive(false);
    },
  };

  const isOwner = () => !!handle && window.Transport.owner() === OWNER;

  function claimTransport() {
    if (!window.Transport) return;
    handle = window.Transport.claim(OWNER, impl, capsNow());
    reportState(true);
  }
  function ensureOwner() {
    if (!isOwner()) claimTransport();
  }

  function reportState(force) {
    if (!handle) return;
    const now = performance.now();
    if (!force && now - lastReportAt < TICK_MS - 12) return;
    lastReportAt = now;
    const r = region();
    handle.update({
      status: statusName(),
      position: songTime(),
      duration: player.duration,
      rate: ctl.speed,
      // caps is REPLACED wholesale by the merge, never merged: always the
      // whole object (CONTRACT §7.2).
      caps: capsNow(),
      loop: loop.on && r.on ? { a: r.a, b: r.b } : null,
      label: songLabel(),
      dirty: false,
    });
  }

  async function startPlayback() {
    const doc = currentDocument();
    if (!doc || !player.duration) return;
    if (player.playing) return;
    if (player.position >= player.duration - 0.01) seek(0);
    ensureOwner();
    ensureAudio();
    try { await player.context.resume(); } catch (_) {}
    const before = player.instrumentToken;
    await prepareInstrument();
    // The guard against a play started while the user was switching instrument
    // or transpose: if the token moved and the instrument neither loaded nor
    // failed, somebody else is mid-flight and owns the outcome.
    if (before !== player.instrumentToken && player.instrumentReady !== ctl.instrument && !player.instrumentFailed) return;
    player.playing = true;
    player.audioStart = player.context.currentTime - player.position / ctl.speed;
    player.cursor = cursorFor(player.position);
    scheduleAhead();
    startTimer();
    if (rollHandle) { rollHandle.setLive(true); rollHandle.invalidate(); }
    reportState(true);
    pushHistory(currentPath());
  }

  function pause() {
    if (!player.playing) {
      reportState(true);
      return;
    }
    player.position = songTime();
    player.playing = false;
    stopTimer();
    clearVoices();
    if (rollHandle) { rollHandle.setLive(false); rollHandle.invalidate(); }
    setClock();
    reportState(true);
  }

  async function togglePlay() {
    if (player.playing) { pause(); return; }
    await startPlayback();
  }

  function seek(seconds) {
    player.position = clamp(Number(seconds) || 0, 0, player.duration || 0);
    player.cursor = cursorFor(player.position);
    if (player.context) player.audioStart = player.context.currentTime - player.position / ctl.speed;
    clearVoices();
    setClock();
    if (rollHandle) rollHandle.invalidate();
    reportState(true);
  }

  function stop() { pause(); seek(0); }

  function setSpeed(value) {
    const next = clamp(Math.round((Number(value) || 1) * 100) / 100, 0.25, 2);
    if (next === ctl.speed) { syncSpeedUI(); return; }
    ctl.speed = next;
    prefs.speed = next;
    savePrefs();
    // Re-base audioStart against the audio clock; the instrument is untouched.
    // songTime() is the live position — player.position is only refreshed at
    // 10Hz by tick(), so re-basing from it jumps the song up to 100ms back.
    seek(songTime());
    syncSpeedUI();
    reportState(true);
  }

  function setTranspose(value) {
    const next = clamp(Math.round(Number(value) || 0), -24, 24);
    if (next === ctl.transpose) {
      syncTransposeUI();
      return;
    }
    pause();
    ctl.transpose = next;
    prefs.pitch = next;
    savePrefs();
    // The required sample set changes, so the loaded instrument is stale.
    invalidateInstrument();
    syncTransposeUI();
    reportState(true);
    if (player.context && currentDocument()) void prepareInstrument();
  }

  function setVolume(value) {
    ctl.volume = clamp(Math.round(Number(value) || 0), 0, 100);
    prefs.volume = ctl.volume;
    if (player.master) player.master.gain.value = ctl.volume / 100;
    const out = $('volume-value');
    const text = `${ctl.volume}%`;
    if (out.textContent !== text) out.textContent = text;
    const range = $('volume');
    range.style.setProperty('--p', String(ctl.volume / 100));
    if (range.value !== String(ctl.volume)) range.value = String(ctl.volume);
  }

  function setRepeat(mode) {
    repeat = ['off', 'all', 'one'].indexOf(mode) >= 0 ? mode : 'off';
    prefs.repeat = repeat;
    savePrefs();
    reportState(true);
  }

  // ==========================================================================
  // 8. QUEUE / HISTORY / RECENT
  // ==========================================================================
  function queueIndexOf(path) {
    const key = lower(path);
    return prefs.queue.findIndex((p) => lower(p) === key);
  }
  function addToQueue(path, { silent } = {}) {
    if (!path) return;
    if (queueIndexOf(path) < 0) prefs.queue = [...prefs.queue, path];
    savePrefs();
    renderRail();
    reportState(true);
    republishCommands();
    if (!silent) {
      window.Bus.send(T.UI_TOAST, {
        severity: 'ok', title: 'Added to the queue', key: 'selfmidi-queue',
        message: `${window.Fmt.basename(path)} · ${window.Fmt.count(prefs.queue.length, 'song')}`,
      });
    }
  }
  function removeFromQueue(path) {
    prefs.queue = prefs.queue.filter((p) => lower(p) !== lower(path));
    savePrefs();
    renderRail();
    reportState(true);
    republishCommands();
  }

  function stepQueue(delta) {
    if (!prefs.queue.length) return null;
    let index = queueIndexOf(currentPath());
    if (index < 0) index = delta > 0 ? -1 : prefs.queue.length;
    let next = index + delta;
    if (next >= prefs.queue.length) next = repeat === 'all' ? 0 : -1;
    if (next < 0 && delta < 0) next = repeat === 'all' ? prefs.queue.length - 1 : -1;
    if (next < 0 || next >= prefs.queue.length) return null;
    return prefs.queue[next];
  }
  function nextTrack() {
    const path = stepQueue(1);
    if (path) void loadAudition(path, '', { play: true });
  }
  function prevTrack() {
    const path = stepQueue(-1);
    if (path) void loadAudition(path, '', { play: true });
  }
  // Called at the natural end of a track only. Loading is not playing, but the
  // end of the previous track is one of the four explicit asks (invariant 17).
  function advanceQueue() {
    if (queueIndexOf(currentPath()) < 0 && repeat !== 'all') return false;
    const path = stepQueue(1);
    if (!path) return false;
    void loadAudition(path, '', { play: true });
    return true;
  }

  // The 10-item MRU has always been written; only its UI was lost.
  function addRecent(midiPath, projectPath, label) {
    const key = projectPath || midiPath;
    if (!key) return;
    prefs.recent = [
      { midiPath: midiPath || '', projectPath: projectPath || '', label: label || window.Fmt.basename(key), at: Date.now() },
      ...prefs.recent.filter((item) => lower(item.projectPath || item.midiPath) !== lower(key)),
    ].slice(0, 10);
    renderRecent();
    renderSources();
  }
  function pushHistory(path) {
    if (!path) return;
    const last = prefs.history[0];
    if (last && lower(last.path) === lower(path) && Date.now() - Number(last.at || 0) < 20000) return;
    prefs.history = [{ path, at: Date.now() }, ...prefs.history.filter((h) => lower(h.path) !== lower(path))].slice(0, 100);
    savePrefs();
    renderRail();
  }

  // ==========================================================================
  // 9. BOOKMARKS  (new; persisted per file path alongside recent)
  // ==========================================================================
  function marksFor(path) {
    const list = prefs.bookmarks[lower(path)];
    return Array.isArray(list) ? list : [];
  }
  function writeMarks(path, list) {
    const key = lower(path);
    if (!key) return;
    // The delete is what makes the re-insert move the key to the END of the
    // insertion order. Assigning to a key that already exists does NOT reorder
    // it, so without this the eviction below would drop the file the user is
    // working on and keep ones untouched for months (same shape as rememberMeta).
    delete prefs.bookmarks[key];
    if (list.length) prefs.bookmarks[key] = list.slice(0, 24);
    // Keep the store from growing without a bound: 60 files' worth is plenty
    // and the oldest key is now genuinely the least recently written.
    const keys = Object.keys(prefs.bookmarks);
    if (keys.length > 60) for (const k of keys.slice(0, keys.length - 60)) delete prefs.bookmarks[k];
    savePrefs();
    renderMarks();
  }
  function addMark() {
    const path = currentPath();
    if (!path || !player.duration) return;
    const at = Math.round(songTime() * 1000) / 1000;
    const typed = $('mark-name').value.trim();
    const list = marksFor(path).filter((m) => Math.abs(Number(m.t) - at) > 0.05);
    list.push({ t: at, name: typed || `Mark ${list.length + 1}` });
    list.sort((a, b) => Number(a.t) - Number(b.t));
    $('mark-name').value = '';
    writeMarks(path, list);
  }
  function removeMark(index) {
    const path = currentPath();
    const list = marksFor(path).slice();
    list.splice(index, 1);
    writeMarks(path, list);
  }

  function renderMarks() {
    const host = $('marks');
    const path = currentPath();
    const list = marksFor(path);
    $('marks-count').textContent = String(list.length);
    $('marks-empty').hidden = list.length > 0;
    host.textContent = '';
    list.forEach((mark, index) => {
      const row = document.createElement('div');
      row.className = 'lrow sm-mark';
      const main = document.createElement('span');
      main.className = 'lrow-main';
      const name = document.createElement('span');
      name.className = 'lrow-name';
      name.textContent = mark.name;
      main.appendChild(name);
      const time = document.createElement('span');
      time.className = 'lrow-meta sm-mark-time';
      time.textContent = window.Fmt.clock(mark.t);
      const actions = document.createElement('span');
      actions.className = 'lrow-actions';
      const jump = document.createElement('button');
      jump.type = 'button';
      jump.className = 'btn btn-icon is-sm is-bare';
      jump.setAttribute('aria-label', `Jump to ${mark.name} at ${window.Fmt.clock(mark.t)}`);
      jump.innerHTML = window.Icon.svg('play', 11);
      jump.addEventListener('click', () => seek(Number(mark.t)));
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn btn-icon is-sm is-bare';
      del.setAttribute('aria-label', `Remove ${mark.name}`);
      del.innerHTML = window.Icon.svg('close', 11);
      del.addEventListener('click', () => removeMark(index));
      actions.append(jump, del);
      row.append(main, time, actions);
      host.appendChild(row);
    });
  }

  // ==========================================================================
  // 10. LOOP A-B
  //  NOTE: CONTRACT §12 #9 specifies a SHARED range-selection widget at
  //  renderer/shared/range.js and it does not exist yet. This is the first
  //  consumer; the hit-testing below deliberately keeps invariant 20's
  //  proportional edge rule and the 3px deadzone so it lifts out verbatim.
  // ==========================================================================
  function setRange(a, b) {
    const dur = player.duration || 0;
    let lo = clamp(Number(a) || 0, 0, dur);
    let hi = clamp(Number(b) || 0, 0, dur);
    if (hi < lo) { const t = lo; lo = hi; hi = t; }
    loop.a = lo;
    loop.b = hi;
    syncLoopUI();
    if (rollHandle) rollHandle.invalidate();
    reportState(true);
    republishCommands();
  }
  function clearRange() {
    loop.a = 0;
    loop.b = 0;
    setLoopOn(false);
    syncLoopUI();
    if (rollHandle) rollHandle.invalidate();
    republishCommands();
  }
  function setLoopOn(on) {
    loop.on = !!on;
    prefs.loop = loop.on;
    savePrefs();
    $('loop-on').setAttribute('aria-checked', loop.on ? 'true' : 'false');
    syncLoopUI();
    if (rollHandle) rollHandle.invalidate();
    reportState(true);
  }
  // Setting A with no usable B means "from here to the end"; setting B with no
  // usable A means "from the start to here". Neither can produce an empty range.
  function setPointA() {
    const a = songTime();
    setRange(a, loop.b > a + 0.25 ? loop.b : player.duration);
  }
  function setPointB() {
    const b = songTime();
    setRange(loop.a < b - 0.25 ? loop.a : 0, b);
  }

  function syncLoopUI() {
    $('loop-a').value = window.Fmt.clock(loop.a);
    $('loop-b').value = window.Fmt.clock(loop.b);
    const has = loop.b - loop.a >= 0.25;
    const hint = $('loop-hint');
    const text = !has
      ? 'Drag across the roll, or set A and B.'
      : loop.on
        ? `Looping ${window.Fmt.duration(loop.b - loop.a)}`
        : `${window.Fmt.duration(loop.b - loop.a)} range · loop is off`;
    if (hint.textContent !== text) hint.textContent = text;
    $('loop-set-b').disabled = !player.duration;
    $('loop-set-a').disabled = !player.duration;
  }

  // ==========================================================================
  // 11. THE ROLL  (one Draw consumer, one cached static layer)
  // ==========================================================================
  const rollHost = $('roll-host');
  const rollCanvas = $('note-roll');
  const lanes = $('roll-lanes');
  rollHost.style.setProperty('--sm-keys', `${KEYS_W}px`);

  const layer = new window.Draw.LayerCache();
  let rollHandle = null;
  let zoom = null;

  const colours = {
    bg: '#0f1013', grid: '#22242a', octave: '#3a3d45', time: '#2b2e36',
    text3: '#868a92', accent: '#b8e62e', line: '#2b2e36', surface2: '#25272d', text: '#e8e9ea',
  };
  function readColours() {
    const Tokens = window.Tokens;
    colours.bg = Tokens.get('bg-2', '#0f1013');
    colours.grid = Tokens.get('line', '#22242a');
    colours.octave = Tokens.get('line-2', '#3a3d45');
    colours.time = Tokens.get('line', '#2b2e36');
    colours.text3 = Tokens.get('text-3', '#868a92');
    colours.accent = Tokens.get('accent', '#b8e62e');
    colours.surface2 = Tokens.get('surface-2', '#25272d');
    colours.text = Tokens.get('text', '#e8e9ea');
    colours.accentSoft = Tokens.rgba('accent', 0.12);
    colours.accentEdge = Tokens.rgba('accent', 0.55);
  }
  readColours();

  const laneWidth = () => Math.max(1, rollHost.clientWidth - KEYS_W);

  function pitchBounds() {
    const doc = currentDocument();
    if (!doc || !doc.notes.length) return { low: 48, high: 72, range: 24, bottom: 47 };
    // Computed once per document in setCandidate(), never per draw: the old
    // version spread a fresh array through Math.min/Math.max every frame.
    const low = doc.__low, high = doc.__high;
    const range = Math.max(12, high - low + 3);
    return { low, high, range, bottom: low - 1 };
  }

  function firstVisibleNote(notes, from) {
    // Notes are start-ordered. Step back a little so a long note that started
    // before the window still draws.
    let lo = 0, hi = notes.length;
    const target = from - 30;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (Number(notes[mid].start) < target) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  function paintStatic(ctx, info) {
    const w = info.w, h = info.h;
    const doc = currentDocument();
    ctx.fillStyle = colours.bg;
    ctx.fillRect(0, 0, w, h);
    if (!doc || !doc.notes.length || !player.duration) return;

    const laneW = Math.max(1, w - KEYS_W);
    const { range, bottom } = pitchBounds();
    const yFor = (pitch) => h - (pitch - bottom) / range * h;
    const span = zoom.span(), from = zoom.start();
    const xFor = (time) => KEYS_W + (time - from) / span * laneW;

    // Pitch grid: two paths, not one stroke per semitone.
    const semis = new Path2D();
    const octaves = new Path2D();
    for (let pitch = bottom; pitch <= bottom + range; pitch += 1) {
      const y = Math.round(yFor(pitch)) + 0.5;
      const path = pitch % 12 === 0 ? octaves : semis;
      path.moveTo(KEYS_W, y);
      path.lineTo(w, y);
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = colours.grid;
    ctx.stroke(semis);
    ctx.strokeStyle = colours.octave;
    ctx.stroke(octaves);

    // Time grid: one path plus the labels.
    const gridSeconds = span > 240 ? 30 : span > 90 ? 10 : span > 30 ? 5 : span > 10 ? 1 : 0.5;
    const ticks = new Path2D();
    ctx.font = `11px ${window.Tokens.get('font-mono', 'monospace')}`;
    ctx.textBaseline = 'alphabetic';
    const labels = [];
    for (let at = Math.floor(from / gridSeconds) * gridSeconds; at <= from + span + 1e-6; at += gridSeconds) {
      if (at < from - 1e-6) continue;
      const x = Math.round(xFor(at)) + 0.5;
      ticks.moveTo(x, 0);
      ticks.lineTo(x, h);
      if (x + 38 < w) labels.push([window.Fmt.clock(at), x + 4]);
    }
    ctx.strokeStyle = colours.time;
    ctx.stroke(ticks);
    ctx.fillStyle = colours.text3;
    for (const [text, x] of labels) ctx.fillText(text, x, 13);

    // Notes: culled to the visible window, entered by binary search and left
    // as soon as the window is passed.
    const notes = doc.notes;
    const until = from + span;
    const noteH = Math.max(3, h / range - 2);
    ctx.fillStyle = colours.accent;
    ctx.globalAlpha = 0.82;
    for (let i = firstVisibleNote(notes, from); i < notes.length; i += 1) {
      const note = notes[i];
      const start = Number(note.start);
      if (start > until) break;
      const end = Number(note.end);
      if (end < from) continue;
      const x = xFor(start);
      const width = Math.max(2, (end - start) / span * laneW);
      ctx.fillRect(x, yFor(Number(note.pitch) + 1), width, noteH);
    }
    ctx.globalAlpha = 1;

    drawKeyboard(ctx, h, range, bottom, yFor);
  }

  function drawKeyboard(ctx, h, range, bottom, yFor) {
    const BLACK = [1, 3, 6, 8, 10];
    ctx.fillStyle = colours.surface2;
    ctx.fillRect(0, 0, KEYS_W, h);
    const rowH = h / range;
    for (let pitch = bottom + 1; pitch <= bottom + range; pitch += 1) {
      const y = yFor(pitch + 1);
      const isBlack = BLACK.indexOf(((pitch % 12) + 12) % 12) >= 0;
      ctx.fillStyle = isBlack ? colours.bg : colours.text3;
      ctx.globalAlpha = isBlack ? 1 : 0.32;
      ctx.fillRect(0, y, KEYS_W - 5, Math.max(1, rowH - 1));
      ctx.globalAlpha = 1;
      // The 9px label is the one sanctioned exception to the 12px type floor
      // (invariant 31): a C marker on a 4px key row cannot be 12px.
      if (pitch % 12 === 0 && rowH > 7) {
        ctx.font = `9px ${window.Tokens.get('font-mono', 'monospace')}`;
        ctx.fillStyle = colours.text3;
        ctx.fillText(window.Fmt.note(pitch), 3, y + Math.min(rowH - 1, 8));
      }
    }
    ctx.fillStyle = colours.line;
    ctx.fillRect(KEYS_W - 1, 0, 1, h);
  }

  // Which notes are sounding right now: a bounded walk from a binary-searched
  // index, never a scan of the whole song.
  function soundingNotes(position) {
    const doc = currentDocument();
    const out = [];
    if (!doc) return out;
    const notes = doc.notes;
    let i = cursorFor(position - SOUND_WINDOW);
    for (; i < notes.length; i += 1) {
      const start = Number(notes[i].start);
      if (start > position) break;
      if (Number(notes[i].end) > position) out.push(notes[i]);
      if (out.length > 64) break;
    }
    return out;
  }

  // A hidden ancestor (the loading state replaces the song block) leaves the
  // host with no box. Painting then would allocate a 1x1 backing store, and the
  // IntersectionObserver cannot ask for a repaint afterwards because visibility
  // never actually changed - so the roll would stay blank. Bail out instead and
  // let the ResizeObserver below call us back the moment there is a box again.
  const hasBox = (el) => el.clientWidth > 1 && el.clientHeight > 1;

  function drawRoll() {
    if (!hasBox(rollHost)) return;
    const doc = currentDocument();
    const fit = window.Draw.fitCanvas(rollCanvas, rollHost.clientWidth, rollHost.clientHeight);
    const ctx = fit.ctx, w = fit.w, h = fit.h;
    if (fit.resized) layer.invalidate();
    if (!doc || !player.duration) {
      ctx.fillStyle = colours.bg;
      ctx.fillRect(0, 0, w, h);
      return;
    }
    const position = player.playing ? songTime() : player.position;
    if (player.playing) zoom.follow(position);

    const span = zoom.span(), from = zoom.start();
    const version = [
      player.version, doc.notes.length, from.toFixed(3), span.toFixed(3), w, h, window.Tokens.themeKey(),
    ].join('#');
    layer.paint(w, h, version, paintStatic);
    layer.blit(ctx, 0, 0);

    const laneW = Math.max(1, w - KEYS_W);
    const { range, bottom } = pitchBounds();
    const yFor = (pitch) => h - (pitch - bottom) / range * h;
    const xFor = (time) => KEYS_W + (time - from) / span * laneW;
    const noteH = Math.max(3, h / range - 2);

    ctx.save();
    ctx.beginPath();
    ctx.rect(KEYS_W, 0, laneW, h);
    ctx.clip();

    // the loop / selection band
    const band = drag.active && drag.moved
      ? { a: Math.min(drag.a, drag.b), b: Math.max(drag.a, drag.b) }
      : { a: loop.a, b: loop.b };
    if (band.b - band.a > 0.001) {
      const xa = xFor(band.a), xb = xFor(band.b);
      ctx.fillStyle = colours.accentSoft;
      ctx.fillRect(xa, 0, Math.max(1, xb - xa), h);
      ctx.strokeStyle = colours.accentEdge;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(xa) + 0.5, 0); ctx.lineTo(Math.round(xa) + 0.5, h);
      ctx.moveTo(Math.round(xb) + 0.5, 0); ctx.lineTo(Math.round(xb) + 0.5, h);
      ctx.stroke();
      ctx.font = `11px ${window.Tokens.get('font-mono', 'monospace')}`;
      ctx.fillStyle = colours.accent;
      ctx.fillText('A', xa + 3, h - 5);
      ctx.textAlign = 'right';
      ctx.fillText('B', xb - 3, h - 5);
      ctx.textAlign = 'left';
    }

    // bookmarks
    const marks = marksFor(currentPath());
    if (marks.length) {
      ctx.strokeStyle = colours.text3;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const mark of marks) {
        const x = Math.round(xFor(Number(mark.t))) + 0.5;
        ctx.moveTo(x, 0);
        ctx.lineTo(x, 7);
      }
      ctx.stroke();
    }

    // currently sounding notes, at full accent
    const sounding = soundingNotes(position);
    if (sounding.length) {
      ctx.fillStyle = colours.accent;
      for (const note of sounding) {
        const start = Number(note.start), end = Number(note.end);
        ctx.fillRect(xFor(start), yFor(Number(note.pitch) + 1),
          Math.max(2, (end - start) / span * laneW), noteH);
      }
    }

    // the playhead
    const playX = Math.round(xFor(position)) + 0.5;
    ctx.strokeStyle = colours.accent;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(playX, 0);
    ctx.lineTo(playX, h);
    ctx.stroke();
    ctx.fillStyle = colours.accent;
    ctx.fillRect(playX - 2.5, 0, 5, 3);
    ctx.restore();

    // sounding keys light up on the keyboard, outside the clip
    if (sounding.length) {
      const rowH = h / range;
      ctx.fillStyle = colours.accent;
      for (const note of sounding) {
        ctx.fillRect(0, yFor(Number(note.pitch) + 1), KEYS_W - 5, Math.max(1, rowH - 1));
      }
    }

    // Playback keeps the consumer dirty, through the scheduler: never a bare
    // rAF loop. Draw arms nothing at all while parked or off screen.
    if (player.playing) rollHandle.invalidate();
  }

  function windowLabel() {
    const el = $('roll-window');
    const text = zoom.zoomed()
      ? `${window.Fmt.clock(zoom.start())} + ${window.Fmt.duration(zoom.span())}`
      : 'Whole song';
    if (el.textContent !== text) el.textContent = text;
  }

  let lastClock = '';
  function setClock() {
    const position = player.playing ? songTime() : player.position;
    const text = `${window.Fmt.clock(position)} / ${window.Fmt.clock(player.duration)}`;
    // Fmt.clock truncates to whole seconds, so this block runs at 1Hz even
    // though setClock itself is called at 10Hz.
    if (text !== lastClock) {
      lastClock = text;
      $('roll-clock').textContent = text;
      lanes.setAttribute('aria-valuenow', String(Math.round(position)));
      lanes.setAttribute('aria-valuetext', window.Fmt.clock(position));
    }
    const max = String(Math.round(player.duration));
    if (lanes.getAttribute('aria-valuemax') !== max) lanes.setAttribute('aria-valuemax', max);
  }

  // ---- roll gestures ------------------------------------------------------
  const drag = { active: false, moved: false, pointer: 0, x0: 0, left: 0, width: 1, edge: null, a: 0, b: 0 };

  const timeAtX = (x) => zoom.start() + clamp(x / drag.width, 0, 1) * zoom.span();

  // One bounding rect for the whole gesture AND for hovering (CONTRACT §12 #29).
  // A getBoundingClientRect per pointermove is a forced layout 60-120 times a
  // second on the thread that is scheduling notes. Invalidated by the coalesced
  // resize handler, which is also what a divider commit and a panel toggle go
  // through, and re-measured fresh on every pointerdown.
  let lanesRect = null;
  function lanesGeom() {
    if (!lanesRect) lanesRect = window.Draw.measure(lanes);
    return lanesRect;
  }
  const forgetLanesRect = () => { lanesRect = null; };

  // Invariant 20: the edge zone is PROPORTIONAL. A fixed 8px zone made almost
  // every short selection resize instead of move.
  function edgeAt(x) {
    if (loop.b - loop.a <= 0.001) return null;
    const w = drag.width;
    const xa = (loop.a - zoom.start()) / zoom.span() * w;
    const xb = (loop.b - zoom.start()) / zoom.span() * w;
    const width = xb - xa;
    if (!(width > 14)) return null;
    const zone = Math.min(8, width * 0.3);
    if (Math.abs(x - xb) < zone) return 'b';
    if (Math.abs(x - xa) < zone) return 'a';
    return null;
  }

  const paintDrag = coalesce(() => { if (rollHandle) rollHandle.invalidate(); });

  lanes.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !player.duration) return;
    lanesRect = null;
    const rect = lanesGeom();                     // cached for the whole gesture
    drag.active = true;
    drag.moved = false;
    drag.pointer = event.pointerId;
    drag.left = rect.left;
    drag.width = Math.max(1, rect.w);
    drag.x0 = event.clientX - rect.left;
    drag.edge = edgeAt(drag.x0);
    drag.a = loop.a;
    drag.b = loop.b;
    lanes.setPointerCapture(event.pointerId);
    lanes.focus();
    event.preventDefault();
  });

  lanes.addEventListener('pointermove', (event) => {
    if (!drag.active) {
      if (event.buttons) return;
      const rect = lanesGeom();
      drag.width = Math.max(1, rect.w);
      const edge = edgeAt(event.clientX - rect.left);
      if (edge) lanes.dataset.grab = 'edge'; else delete lanes.dataset.grab;
      return;
    }
    const x = event.clientX - drag.left;
    if (!drag.moved && Math.abs(x - drag.x0) < 3) return;    // 3px deadzone
    drag.moved = true;
    const t = timeAtX(x);
    // Dragging one edge past the other swaps them (setRange normalises, and the
    // band below is drawn from the sorted pair). Clamping instead collapsed the
    // range to zero width and silently turned the loop off.
    if (drag.edge === 'a') { drag.a = t; drag.b = loop.b; }
    else if (drag.edge === 'b') { drag.a = loop.a; drag.b = t; }
    else {
      const t0 = timeAtX(drag.x0);
      drag.a = Math.min(t0, t);
      drag.b = Math.max(t0, t);
    }
    paintDrag();
  });

  function endDrag(event, cancelled) {
    if (!drag.active) return;
    drag.active = false;
    try { lanes.releasePointerCapture(drag.pointer); } catch (_) {}
    if (cancelled) { paintDrag(); return; }
    if (!drag.moved) {
      // An unmoved click is a seek, never a zero-width selection.
      seek(timeAtX(event.clientX - drag.left));
      return;
    }
    setRange(drag.a, drag.b);
  }
  lanes.addEventListener('pointerup', (event) => endDrag(event, false));
  lanes.addEventListener('pointercancel', (event) => endDrag(event, true));

  lanes.addEventListener('keydown', (event) => {
    if (!player.duration) return;
    const step = event.shiftKey ? 1 : 5;
    let handled = true;
    if (event.key === 'ArrowLeft') seek(player.position - step);
    else if (event.key === 'ArrowRight') seek(player.position + step);
    else if (event.key === 'Home') seek(0);
    else if (event.key === 'End') seek(player.duration);
    else if (event.key === 'PageUp') seek(player.position - 30);
    else if (event.key === 'PageDown') seek(player.position + 30);
    else handled = false;
    if (handled) { event.preventDefault(); event.stopPropagation(); }
  });

  // ==========================================================================
  // 12. ALBUM ART  (generated: a MIDI carries no cover)
  // ==========================================================================
  const artHost = $('art-host');
  const artCanvas = $('art-canvas');
  let artHandle = null;

  function hash32(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    return h;
  }
  function initials(name) {
    const parts = String(name || '').split(/[\s_\-.]+/).filter(Boolean);
    if (!parts.length) return '··';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  // A deterministic, symmetric block field in graphite only. The accent is
  // functional in this app, so a generated placeholder does not get to use it.
  // The hero and every list thumbnail paint the SAME field, so a song is the
  // same picture wherever it appears -- which is what the artwork in the ref is
  // doing for a file that carries no cover of its own.
  function paintField(ctx, w, h, seed) {
    ctx.fillStyle = window.Tokens.get('bg-2', '#0f1013');
    ctx.fillRect(0, 0, w, h);
    const cells = 8;
    const cw = w / cells, ch = h / cells;
    for (let y = 0; y < cells; y += 1) {
      for (let x = 0; x < cells / 2; x += 1) {
        // one nibble per cell: three of the four values paint, so the field is
        // dense enough to read as a cover at 196px and still as a mark at 34px
        const bit = (seed >>> ((y * 5 + x * 3) % 29)) & 3;
        if (!bit) continue;
        ctx.fillStyle = bit === 1 ? window.Tokens.rgba('line-2', 0.55)
          : bit === 2 ? window.Tokens.rgba('surface-3', 0.95)
            : window.Tokens.rgba('text-3', 0.2);
        ctx.fillRect(Math.floor(x * cw), Math.floor(y * ch), Math.ceil(cw), Math.ceil(ch));
        ctx.fillRect(Math.floor((cells - 1 - x) * cw), Math.floor(y * ch), Math.ceil(cw), Math.ceil(ch));
      }
    }
  }

  // One list thumbnail. Called from a row render, never from a loop: it is a
  // few dozen rects on a 34px canvas and VList reuses the node underneath it.
  const THUMB = 34;
  function paintThumb(canvas, path) {
    if (!canvas) return;
    const fit = window.Draw.fitCanvas(canvas, THUMB, THUMB);
    const ctx = fit.ctx, w = fit.w, h = fit.h;
    ctx.clearRect(0, 0, w, h);
    if (!path) {
      ctx.fillStyle = window.Tokens.get('surface-2', '#25272d');
      ctx.fillRect(0, 0, w, h);
      return;
    }
    paintField(ctx, w, h, hash32(lower(path)));
  }

  function drawArt() {
    if (!hasBox(artHost)) return;
    const fit = window.Draw.fitCanvas(artCanvas, artHost.clientWidth, artHost.clientHeight);
    const ctx = fit.ctx, w = fit.w, h = fit.h;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = window.Tokens.get('bg-2', '#0f1013');
    ctx.fillRect(0, 0, w, h);
    const path = currentPath();
    if (!path) return;
    paintField(ctx, w, h, hash32(lower(path)));
    const band = Math.max(30, Math.round(h * 0.19));
    ctx.fillStyle = window.Tokens.rgba('bg-2', 0.72);
    ctx.fillRect(0, h / 2 - band / 2, w, band);
    ctx.font = `700 ${Math.max(17, Math.round(h * 0.13))}px ${window.Tokens.get('font-mono', 'monospace')}`;
    ctx.fillStyle = window.Tokens.get('text-2', '#9b9ea6');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(initials(songLabel()), w / 2, h / 2 + 1);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }

  // ==========================================================================
  // 13. SONG METADATA  (setSongMeta on load, setClock per tick)
  // ==========================================================================
  function sourceOf(path) {
    const dir = lower(window.Fmt.dirname(path));
    if (libraryDirs.length && dir.startsWith(lower(libraryDirs[0]))) return 'Forge output';
    if (libraryDirs.length > 1 && dir.startsWith(lower(libraryDirs[1]))) return 'MIDI Studio folder';
    return 'Your folder';
  }

  function setSongMeta() {
    const doc = currentDocument();
    const path = currentPath();
    const has = !!doc;
    $('sm-song').hidden = !has;
    $('sm-state').hidden = has;
    if (!has) {
      document.title = 'Self MIDI';
      renderMarks();
      return;
    }
    document.title = `${doc.name} · Self MIDI`;

    $('song-title').textContent = doc.name || window.Fmt.stem(path);
    $('song-title').title = doc.name || '';
    const folder = window.Fmt.basename(window.Fmt.dirname(path)) || 'Unfiled';
    $('song-artist').textContent = folder;
    $('song-artist').title = window.Fmt.dirname(path);

    const names = Object.keys(player.documents);
    const bits = [sourceOf(path)];
    if (names.length > 1) bits.push(`${player.candidate} of ${names.length} versions`);
    if (player.projectPath) bits.push('MIDI Studio project');
    bits.push(window.Fmt.shortPath(path, 56));
    $('song-sub').textContent = bits.join(' · ');
    $('song-sub').title = path;

    // tags: derived facts only. Tags as USER data belong to the Library tab.
    const tags = [];
    // The file extension is a machine value, so it keeps the mono tag. Every
    // other tag is a word and is set as one.
    tags.push({ text: window.Fmt.ext(path).toUpperCase() || 'MID', kind: 'is-mono' });
    const drums = doc.__drums;
    tags.push({ text: drums ? 'Drums' : 'Melodic', kind: '' });
    if (doc.bpmEstimated) tags.push({ text: 'Tempo estimated', kind: 'is-warn' });
    if (isFav(path)) tags.push({ text: 'Favorite', kind: 'is-accent' });
    if (names.length > 1) tags.push({ text: `${names.length} versions`, kind: '' });
    const host = $('song-tags');
    host.textContent = '';
    for (const tag of tags) {
      const el = document.createElement('span');
      el.className = `tag${tag.kind ? ` ${tag.kind}` : ''}`;
      el.textContent = tag.text;
      host.appendChild(el);
    }

    // Short enough to survive a narrow column; the long form is the tooltip.
    $('stat-format').textContent = player.projectPath ? 'Project' : 'MIDI file';
    $('stat-format').title = player.projectPath
      ? 'A MIDI Studio project: the MIDI, its versions and the settings that made them.'
      : 'A plain MIDI file.';
    $('stat-notes').textContent = `${doc.notes.length.toLocaleString()} notes`;
    $('stat-length').textContent = window.Fmt.clock(player.duration);
    $('stat-tempo').textContent = doc.bpmEstimated
      ? `${window.Fmt.bpm(doc.bpm)} BPM (est.)` : `${window.Fmt.bpm(doc.bpm)} BPM`;
    $('stat-tempo').title = doc.bpmEstimated
      ? 'Estimated from the note onsets: this file has no tempo track.'
      : 'From the file\'s tempo track.';

    // MIDI information
    const channels = doc.__channels;
    $('info-tracks').textContent = channels.length
      ? channels.map((c) => `Ch ${c.channel + 1}: ${window.Fmt.count(c.count, 'note')}`).join(',  ')
      : '—';
    $('info-instruments').textContent = doc.__instruments.length ? doc.__instruments.join(', ') : '—';
    // The loader does not read the time-signature track and we do not change the
    // Python engine: an em dash, never a made-up 4/4.
    $('info-time').textContent = '—';
    $('info-time').title = 'Not read by the MIDI loader.';
    $('info-key').textContent = doc.__key ? `${doc.__key} (estimated)` : '—';
    $('info-key').title = doc.__key ? 'Estimated from the pitch-class histogram.' : '';

    renderMarks();
    syncFavUI();
    if (artHandle) artHandle.invalidate();
  }

  function syncFavUI() {
    const path = currentPath();
    const button = $('favorite');
    button.disabled = !path;
    button.setAttribute('aria-checked', path && isFav(path) ? 'true' : 'false');
  }

  function enableActions(enabled) {
    for (const id of ['act-queue', 'act-editor', 'act-player', 'act-reveal', 'back', 'forward', 'song-menu']) {
      $(id).disabled = !enabled;
    }
    $('mark-add').disabled = !enabled;
    $('roll-reset').disabled = !enabled;
  }

  // ==========================================================================
  // 14. LOADING
  // ==========================================================================
  function setState(kind, title, message) {
    const el = $('sm-state');
    el.classList.toggle('is-error', kind === 'error');
    el.classList.toggle('is-loading', kind === 'loading');
    $('sm-state-title').textContent = title;
    $('sm-state-msg').textContent = message;
    $('state-open').hidden = kind === 'loading';
    $('sm-song').hidden = true;
    el.hidden = false;
    // Every hasFile-gated command just changed state.
    republishCommands();
  }

  function setCandidate(name) {
    if (!player.documents[name]) return;
    pause();
    player.candidate = name;
    const doc = currentDocument();

    // Everything the draw path would otherwise recompute per frame is computed
    // once, here, and cached on the document.
    let duration = Number(doc.duration) || 0;
    let low = 127, high = 0, drums = 0;
    const counts = new Map();
    for (const note of doc.notes) {
      const pitch = Number(note.pitch);
      if (pitch < low) low = pitch;
      if (pitch > high) high = pitch;
      const end = Number(note.end);
      if (end > duration) duration = end;
      const channel = Number(note.channel) || 0;
      counts.set(channel, (counts.get(channel) || 0) + 1);
      if (channel === 9) drums += 1;
    }
    if (low > high) { low = 48; high = 72; }
    doc.__low = low;
    doc.__high = high;
    doc.__drums = doc.notes.length > 0 && drums > doc.notes.length * 0.6;
    doc.__channels = [...counts.entries()]
      .map(([channel, count]) => ({ channel, count }))
      .sort((a, b) => b.count - a.count);
    const programs = doc.programs || {};
    const seen = new Set();
    doc.__instruments = doc.__channels.map(({ channel }) => {
      if (channel === 9) return 'Drum kit';
      const program = Number(programs[channel] ?? programs[String(channel)] ?? 0);
      return GM[clamp(program, 0, 127)] || `Program ${program}`;
    }).filter((name) => (seen.has(name) ? false : (seen.add(name), true)));
    doc.__key = estimateKey(doc.notes);

    player.duration = duration;
    player.position = 0;
    player.cursor = 0;
    player.version += 1;
    // A new song has no A-B range yet. Loop ON with no range keeps its legacy
    // meaning - repeat the whole song - instead of silently doing nothing, and
    // the stored preference is left alone.
    loop.a = 0;
    loop.b = loop.on ? player.duration : 0;
    syncLoopUI();
    zoom.reset();
    invalidateInstrument();
    rememberMeta(doc.path || currentPath(), doc);
    setSongMeta();
    setClock();
    windowLabel();
    layer.invalidate();
    if (rollHandle) rollHandle.invalidate();
    reportState(true);
  }

  async function loadAudition(midiPath, projectPath, options = {}) {
    loadRequested = true;
    const token = ++player.token;
    stop();
    player.documents = {};
    player.candidate = '';
    player.duration = 0;
    enableActions(false);
    setState('loading', 'Opening', window.Fmt.basename(projectPath || midiPath) || 'Reading the file…');

    const source = projectPath || midiPath;
    if (!source || !review || !review.load) {
      setState('error', 'MIDI preview is unavailable', 'The renderer could not reach the MIDI loader.');
      return false;
    }
    let result;
    try { result = await review.load(source); }
    catch (error) { result = { ok: false, error: error && error.message }; }
    // Guards out-of-order async completion: a second load started while the
    // first was still in the main process must win.
    if (token !== player.token) return false;
    if (!result || !result.ok || !result.data || !Object.keys(result.data.documents || {}).length) {
      setState('error', 'Could not open this MIDI',
        (result && result.error) || 'The file could not be read. It may have moved or be a different format.');
      window.Bus.send(T.UI_STATUS, {
        frame: FRAME, severity: 'err',
        text: `Self MIDI: ${(result && result.error) || 'could not open'} — ${source}`,
      });
      reportState(true);
      return false;
    }

    player.documents = result.data.documents;
    player.project = result.data.project || null;
    player.midiPath = midiPath || '';
    player.projectPath = projectPath || result.data.projectPath || '';

    const names = Object.keys(player.documents);
    const select = $('candidate');
    select.textContent = '';
    for (const name of names) {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name[0].toUpperCase() + name.slice(1);
      select.appendChild(option);
    }
    // Hidden entirely with fewer than two versions: they are versions of one
    // song, not three songs.
    $('candidate-field').hidden = names.length < 2;
    const preferred = player.project && player.project.selectedCandidate;
    select.value = names.includes(preferred) ? preferred : names[0];
    setCandidate(select.value);
    enableActions(true);

    // >60% channel-9 notes is a drum kit, but only override while the saved
    // instrument is still the default: never fight a deliberate choice.
    if (currentDocument().__drums && prefs.instrument === 'grand_piano' && ctl.instrument === 'grand_piano') {
      ctl.instrument = 'synth_drum';
      prefs.instrument = 'synth_drum';
      $('instrument').value = 'synth_drum';
      invalidateInstrument();
    }

    prefs.lastMidiPath = midiPath || '';
    prefs.lastProjectPath = player.projectPath;
    addRecent(midiPath, player.projectPath, (player.project && player.project.name) || currentDocument().name);
    savePrefs();
    fileList.refresh();
    renderRail();
    // Loading a file is NOT an explicit play, so it must never steal the bar
    // from a Player that is mid-song (CONTRACT §7, invariant 41). Take the
    // transport only when nobody holds it — the same guard the boot block uses.
    // startPlayback() claims on the explicit-play path.
    if (!isOwner() && window.Transport && !window.Transport.owner()) claimTransport();
    reportState(true);
    republishCommands();

    // Tri-state: true always plays (a library click), false never plays
    // (session restore), undefined defers to the Autoplay switch.
    if (options.play === true || (options.play !== false && prefs.autoplay)) await startPlayback();
    return true;
  }

  // ==========================================================================
  // 15. LEFT RAIL: sources, playlists, files
  // ==========================================================================
  let allFiles = [];
  let libraryTruncated = false;
  let libraryDirs = [];
  let sortedCache = null;
  let sortKey = ['recent', 'name', 'folder'].indexOf(prefs.navSort) >= 0 ? prefs.navSort : 'recent';

  const relativeDir = (dir) => String(dir || '').split(/[\\/]/).filter(Boolean).slice(-2).join('\\');

  // Sorted ONCE per sort-order change, not once per keystroke. The old version
  // re-sorted up to 4000 entries on every character typed.
  function sortedFiles() {
    if (sortedCache) return sortedCache;
    const files = allFiles.slice();
    if (sortKey === 'name') files.sort((a, b) => a.name.localeCompare(b.name));
    else if (sortKey === 'folder') files.sort((a, b) => a.dir.localeCompare(b.dir) || a.name.localeCompare(b.name));
    else files.sort((a, b) => b.modified - a.modified);
    sortedCache = files;
    return files;
  }
  function invalidateSort() { sortedCache = null; }

  const byPath = new Map();
  function entryFor(path) {
    const found = byPath.get(lower(path));
    if (found) return found;
    return { path, name: window.Fmt.stem(path), dir: window.Fmt.dirname(path), modified: 0, missing: true };
  }

  function sourceList() {
    if (navTab === 'favorites') return favOrder.map(entryFor);
    if (navTab === 'playlists') {
      if (navSource === 'player-queue') return playerPlaylist().map(entryFor);
      const list = playlists.find((p) => p.id === String(navSource).replace(/^pl:/, ''));
      return list ? list.paths.map(entryFor) : [];
    }
    if (navSource === 'added') return sortedFilesByDate().slice(0, 150);
    if (navSource === 'played') {
      return prefs.recent.map((item) => entryFor(item.midiPath || item.projectPath)).filter((e) => e.path);
    }
    if (navSource === 'fav') return favOrder.map(entryFor);
    return sortedFiles();
  }
  let dateCache = null;
  function sortedFilesByDate() {
    if (!dateCache) dateCache = allFiles.slice().sort((a, b) => b.modified - a.modified);
    return dateCache;
  }

  function renderFiles() {
    const query = $('nav-search').value.trim().toLowerCase();
    $('nav-search-wrap').classList.toggle('has-value', !!query);
    let files = sourceList();
    if (query) {
      const terms = query.split(/\s+/);
      files = files.filter((file) => {
        const hay = `${file.name} ${file.dir}`.toLowerCase();
        return terms.every((term) => hay.includes(term));
      });
    }
    fileList.setItems(files);
    const total = allFiles.length;
    const label = total
      ? `${files.length}${files.length === total ? '' : `/${total}`}${libraryTruncated ? '+' : ''}`
      : '0';
    $('nav-count').textContent = label;
    $('nav-count').title = libraryTruncated
      ? `The scan stopped at ${total} files, so this is not your whole library.`
      : `${total} MIDI files indexed`;
    const empty = $('nav-empty');
    empty.hidden = files.length > 0;
    $('nav-files').hidden = files.length === 0;
    if (!files.length) {
      $('nav-empty-title').textContent = query ? 'Nothing matches' : total ? 'Nothing here yet' : 'No MIDI files yet';
      $('nav-empty-msg').textContent = query
        ? 'Try fewer words, or clear the search.'
        : total
          ? 'This view is empty. Add songs to it, or switch back to All MIDI Files.'
          : 'Forge results land here automatically, or add a folder you keep MIDI in.';
    }
  }
  const renderFilesSoon = debounce(renderFiles, 120);

  function pickRow(id, label, sub, count, active) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `lrow sm-pick${active ? ' is-selected' : ''}`;
    row.dataset.pick = id;
    row.setAttribute('aria-pressed', active ? 'true' : 'false');
    const main = document.createElement('span');
    main.className = 'lrow-main';
    const name = document.createElement('span');
    name.className = 'lrow-name';
    name.textContent = label;
    main.appendChild(name);
    if (sub) {
      const s = document.createElement('span');
      s.className = 'lrow-sub';
      s.textContent = sub;
      main.appendChild(s);
    }
    const meta = document.createElement('span');
    meta.className = 'lrow-meta';
    meta.textContent = count;
    row.append(main, meta);
    return row;
  }

  function renderSources() {
    const host = $('nav-sources');
    host.textContent = '';
    const total = allFiles.length ? `${allFiles.length}${libraryTruncated ? '+' : ''}` : '0';
    const rows = [
      ['all', 'All MIDI Files', total],
      ['added', 'Recently Added', String(Math.min(150, allFiles.length))],
      ['played', 'Recently Played', String(prefs.recent.length)],
      ['fav', 'Favorites', String(favOrder.length)],
    ];
    for (const [id, label, count] of rows) {
      host.appendChild(pickRow(id, label, '', count, navTab === 'library' && navSource === id));
    }
    $('nav-count-favorites').textContent = String(favOrder.length);
    $('nav-count-playlists').textContent = String(playlists.length + 1);
  }

  function renderPlaylists() {
    const host = $('nav-playlists');
    host.textContent = '';
    const pq = playerPlaylist();
    host.appendChild(pickRow('player-queue', 'Player Queue', 'From the MIDI Player',
      String(pq.length), navTab === 'playlists' && navSource === 'player-queue'));
    for (const list of playlists) {
      host.appendChild(pickRow(`pl:${list.id}`, list.name, '',
        String(list.paths.length), navTab === 'playlists' && navSource === `pl:${list.id}`));
    }
    if (!playlists.length) {
      const note = document.createElement('p');
      note.className = 'field-hint';
      note.style.padding = '4px 10px 0';
      note.textContent = 'No playlists yet. Build the queue, then Save as Playlist.';
      host.appendChild(note);
    }
    $('nav-count-playlists').textContent = String(playlists.length + 1);
  }

  function setNavTab(tab) {
    navTab = tab;
    prefs.navTab = tab;
    for (const button of document.querySelectorAll('[data-nav]')) {
      const on = button.dataset.nav === tab;
      button.setAttribute('aria-selected', on ? 'true' : 'false');
      button.tabIndex = on ? 0 : -1;
    }
    $('nav-pane').setAttribute('aria-labelledby', `nav-tab-${tab}`);
    $('chooser-library').hidden = tab !== 'library';
    $('chooser-playlists').hidden = tab !== 'playlists';
    $('chooser-favorites').hidden = tab !== 'favorites';
    if (tab === 'favorites') $('fav-note').textContent = window.Fmt.count(favOrder.length, 'song');
    if (tab === 'playlists' && !String(navSource).startsWith('pl:') && navSource !== 'player-queue') {
      navSource = playlists.length ? `pl:${playlists[0].id}` : 'player-queue';
    }
    if (tab === 'library' && (String(navSource).startsWith('pl:') || navSource === 'player-queue')) navSource = 'all';
    prefs.navSource = navSource;
    savePrefs();
    renderSources();
    renderPlaylists();
    renderFiles();
  }

  function setNavSource(id) {
    navSource = id;
    prefs.navSource = id;
    savePrefs();
    renderSources();
    renderPlaylists();
    renderFiles();
  }

  async function refreshLibrary() {
    if (!libraryApi || !libraryApi.list) return;
    let result;
    try { result = await libraryApi.list(); } catch (_) { return; }
    allFiles = (result && result.files) || [];
    libraryTruncated = !!(result && result.truncated);
    libraryDirs = (result && result.dirs) || [];
    byPath.clear();
    for (const file of allFiles) byPath.set(lower(file.path), file);
    invalidateSort();
    dateCache = null;
    renderSources();
    renderFiles();
  }

  // ---- the file VList -----------------------------------------------------
  const rowHeightBig = () => window.Tokens.num('h-row-lg', 40);
  // The queue row carries artwork, so it is taller than a file row -- but it is
  // still derived from the token, so it still follows the density switch.
  const rowHeightRail = () => rowHeightBig() + 10;

  const fileList = window.VList($('nav-files'), {
    rowHeight: rowHeightBig(),
    overscan: 8,
    selectable: true,
    ariaLabel: 'MIDI files',
    key: (item) => item.path,
    createRow() {
      const node = document.createElement('div');
      node.className = 'lrow is-lg';
      node.innerHTML = '<span class="lrow-main"><span class="lrow-name"></span><span class="lrow-sub"></span></span>'
        + '<span class="lrow-meta"></span>'
        + `<span class="lrow-actions"><button class="btn btn-icon is-sm is-bare" type="button" data-action="fav" aria-pressed="false" aria-label="Favorite">${window.Icon.svg('check', 12)}</button></span>`;
      return node;
    },
    renderRow(node, item) {
      const main = node.firstChild;
      main.firstChild.textContent = item.name;
      // Newest-first is meaningless without a date to read it against.
      main.lastChild.textContent = item.missing
        ? `Missing · ${relativeDir(item.dir)}`
        : `${window.Fmt.when(item.modified)} · ${relativeDir(item.dir)}`;
      const cached = metaFor(item.path);
      node.children[1].textContent = cached && cached.duration ? window.Fmt.clock(cached.duration) : '—';
      const fav = node.children[2].firstChild;
      fav.setAttribute('aria-pressed', isFav(item.path) ? 'true' : 'false');
      fav.title = isFav(item.path) ? 'Remove from favorites' : 'Add to favorites';
      node.classList.toggle('is-playing', lower(item.path) === lower(currentPath()));
      node.classList.toggle('is-disabled', !!item.missing);
      node.title = item.path;
      node.setAttribute('aria-label', `${item.name}, ${relativeDir(item.dir)}`);
    },
    onClick(item) { void loadAudition(item.path, '', { play: true }); },
    onActivate(item) { void loadAudition(item.path, '', { play: true }); },
    onAction(action, item) {
      if (action === 'fav') toggleFav(item.path);
    },
    onContextMenu(item, index, event) {
      event.preventDefault();
      rowMenu(item.path, item.name, event);
    },
  });

  function rowMenu(path, name, event) {
    const items = [
      { group: name },
      { label: 'Play here', key: 'Enter', icon: 'play', run: () => loadAudition(path, '', { play: true }) },
      { label: 'Add to Queue', icon: 'plus', run: () => addToQueue(path) },
      { sep: true },
      { label: 'Favorite', checked: isFav(path), run: () => toggleFav(path) },
    ];
    if (playlists.length) {
      items.push({ sep: true }, { group: 'Add to playlist' });
      for (const list of playlists) {
        items.push({ label: list.name, run: () => addToPlaylist(list.id, path) });
      }
    }
    items.push(
      { sep: true },
      { label: 'Open in Editor', icon: 'send', run: () => window.Bus.send(T.NAV_OPEN_EDITOR, { midiPath: path }) },
      { label: 'Send to Player', icon: 'send', run: () => window.Bus.send(T.NAV_OPEN_PLAYER, { midiPath: path }) },
      { label: 'Show in Folder', icon: 'folder', run: () => window.Bus.send(T.FILE_REVEAL, { path }) },
    );
    window.Menu.open(items, {
      x: event.clientX, y: event.clientY, ariaLabel: name, returnFocusTo: event.currentTarget || fileList.host,
    });
  }

  function addToPlaylist(id, path) {
    const list = playlists.find((p) => p.id === id);
    if (!list || !path) return;
    if (!list.paths.some((p) => lower(p) === lower(path))) list.paths = [...list.paths, path];
    writePlaylists();
    renderPlaylists();
    if (navSource === `pl:${id}`) renderFiles();
    window.Bus.send(T.UI_TOAST, { severity: 'ok', title: `Added to ${list.name}`, key: 'selfmidi-pl' });
  }

  // ==========================================================================
  // 16. RIGHT RAIL: queue / history / recently played
  // ==========================================================================
  const railList = window.VList($('rail-list'), {
    rowHeight: rowHeightRail(),
    overscan: 6,
    selectable: true,
    ariaLabel: 'Queue',
    key: (item, index) => `${item.path}#${index}`,
    createRow() {
      const node = document.createElement('div');
      node.className = 'lrow is-lg sm-qrow';
      node.innerHTML = '<span class="lrow-index"></span>'
        + '<span class="sm-thumb"><canvas aria-hidden="true"></canvas></span>'
        + '<span class="lrow-main"><span class="lrow-name"></span><span class="lrow-sub"></span></span>'
        + '<span class="lrow-meta"></span>'
        + `<span class="lrow-actions"><button class="btn btn-icon is-sm is-bare" type="button" data-action="menu" aria-label="More actions">${window.Icon.svg('dots', 14)}</button>`
        + `<button class="btn btn-icon is-sm is-bare" type="button" data-action="drop" aria-label="Remove from the queue">${window.Icon.svg('close', 12)}</button></span>`;
      return node;
    },
    renderRow(node, item, index) {
      const playing = lower(item.path) === lower(currentPath());
      const lead = node.firstChild;
      // The playing row says so with a mark, not only with the accent.
      if (playing) { lead.innerHTML = window.Icon.svg('play', 11); lead.classList.add('is-playing'); }
      else { lead.textContent = String(index + 1); lead.classList.remove('is-playing'); }
      paintThumb(node.children[1].firstChild, item.path);
      const main = node.children[2];
      main.firstChild.textContent = item.name;
      main.lastChild.textContent = item.sub;
      const cached = metaFor(item.path);
      node.children[3].textContent = cached && cached.duration ? window.Fmt.clock(cached.duration) : '—';
      node.children[4].lastChild.hidden = railTab !== 'queue';
      node.classList.toggle('is-playing', playing);
      node.title = item.path;
      node.setAttribute('aria-label', `${item.name}, ${item.sub}`);
    },
    onClick(item) { void loadAudition(item.path, '', { play: true }); },
    onActivate(item) { void loadAudition(item.path, '', { play: true }); },
    onAction(action, item, index, event) {
      if (action === 'drop' && railTab === 'queue') removeFromQueue(item.path);
      else if (action === 'menu') rowMenu(item.path, item.name, event);
    },
    onContextMenu(item, index, event) {
      event.preventDefault();
      rowMenu(item.path, item.name, event);
    },
  });

  function renderRail() {
    const isQueue = railTab === 'queue';
    const rows = isQueue
      ? prefs.queue.map((path) => {
        const entry = entryFor(path);
        return { path, name: entry.name, sub: relativeDir(entry.dir) || 'Unfiled' };
      })
      : prefs.history.map((item) => {
        const entry = entryFor(item.path);
        return { path: item.path, name: entry.name, sub: window.Fmt.when(item.at) };
      });
    railList.setItems(rows);
    railList.host.setAttribute('aria-label', isQueue ? 'Queue' : 'History');
    $('queue-count').textContent = String(prefs.queue.length);
    $('history-count').textContent = String(prefs.history.length);
    $('rail-list').hidden = rows.length === 0;
    const empty = $('rail-empty');
    empty.hidden = rows.length > 0;
    $('rail-empty-title').textContent = isQueue ? 'Queue is empty' : 'No history yet';
    $('rail-empty-msg').textContent = isQueue
      ? 'Right-click a song and Add to Queue to line it up.'
      : 'Everything you play here shows up in this list.';
    $('rail-save').disabled = isQueue ? prefs.queue.length === 0 : prefs.history.length === 0;
    $('rail-clear').disabled = isQueue ? prefs.queue.length === 0 : prefs.history.length === 0;
    renderRecent();
  }

  function setRailTab(tab) {
    railTab = tab === 'history' ? 'history' : 'queue';
    prefs.railTab = railTab;
    savePrefs();
    for (const button of document.querySelectorAll('[data-rail]')) {
      const on = button.dataset.rail === railTab;
      button.setAttribute('aria-selected', on ? 'true' : 'false');
      button.tabIndex = on ? 0 : -1;
    }
    $('rail-pane').setAttribute('aria-labelledby', `rail-tab-${railTab}`);
    renderRail();
  }

  function renderRecent() {
    const host = $('recent-list');
    host.textContent = '';
    const rows = prefs.recent.slice(0, 6);
    $('recent-empty').hidden = rows.length > 0;
    for (const item of rows) {
      const path = item.midiPath || item.projectPath;
      if (!path) continue;
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'lrow is-lg sm-qrow';
      if (lower(path) === lower(currentPath())) row.classList.add('is-playing');
      row.title = path;
      const thumb = document.createElement('span');
      thumb.className = 'sm-thumb';
      const canvas = document.createElement('canvas');
      canvas.setAttribute('aria-hidden', 'true');
      thumb.appendChild(canvas);
      const main = document.createElement('span');
      main.className = 'lrow-main';
      const name = document.createElement('span');
      name.className = 'lrow-name';
      name.textContent = item.label || window.Fmt.stem(path);
      main.appendChild(name);
      if (item.at) {
        const when = document.createElement('span');
        when.className = 'lrow-sub';
        when.textContent = window.Fmt.when(item.at);
        main.appendChild(when);
      }
      const meta = document.createElement('span');
      meta.className = 'lrow-meta';
      const cached = metaFor(path);
      meta.textContent = cached && cached.duration ? window.Fmt.clock(cached.duration) : '';
      row.append(thumb, main, meta);
      paintThumb(canvas, path);
      row.addEventListener('click', () => loadAudition(item.midiPath || '', item.projectPath || '', { play: true }));
      row.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        rowMenu(path, name.textContent, event);
      });
      host.appendChild(row);
    }
  }

  // ==========================================================================
  // 17. THE NAME SHEET  (new playlist / save as playlist)
  // ==========================================================================
  let namePurpose = null;
  let nameReturn = null;
  function openNameSheet(purpose, title, value) {
    namePurpose = purpose;
    nameReturn = document.activeElement;
    $('name-title').textContent = title;
    $('name-input').value = value || '';
    const scrim = $('name-scrim');
    scrim.hidden = false;
    requestAnimationFrame(() => {
      scrim.classList.add('is-open');
      $('name-input').focus();
      $('name-input').select();
    });
  }
  function closeNameSheet() {
    const scrim = $('name-scrim');
    if (scrim.hidden) return;
    scrim.classList.remove('is-open');
    namePurpose = null;
    setTimeout(() => { scrim.hidden = true; }, window.Tokens.ms('motion-fast', 120));
    if (nameReturn && nameReturn.focus) nameReturn.focus();
    nameReturn = null;
  }
  function commitNameSheet() {
    const name = $('name-input').value.trim();
    if (!name) { $('name-input').classList.add('is-invalid'); return; }
    $('name-input').classList.remove('is-invalid');
    const id = `p${Date.now().toString(36)}`;
    if (namePurpose === 'new') {
      playlists = [...playlists, { id, name, paths: [] }];
    } else if (namePurpose === 'save') {
      const paths = railTab === 'queue' ? prefs.queue.slice() : prefs.history.map((h) => h.path);
      playlists = [...playlists, { id, name, paths }];
    }
    writePlaylists();
    closeNameSheet();
    setNavTab('playlists');
    setNavSource(`pl:${id}`);
    window.Bus.send(T.UI_TOAST, { severity: 'ok', title: `Playlist "${name}" created`, key: 'selfmidi-pl' });
  }

  // Focus trap: the sheet is the only thing that may be reached while it is up.
  $('name-scrim').addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeNameSheet(); return; }
    if (event.key === 'Enter' && event.target === $('name-input')) { event.preventDefault(); commitNameSheet(); return; }
    if (event.key !== 'Tab') return;
    const focusable = [...$('name-dlg').querySelectorAll('button, input')].filter((el) => !el.disabled);
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  $('name-scrim').addEventListener('pointerdown', (event) => {
    if (event.target === $('name-scrim')) closeNameSheet();
  });
  $('name-x').addEventListener('click', closeNameSheet);
  $('name-cancel').addEventListener('click', closeNameSheet);
  $('name-ok').addEventListener('click', commitNameSheet);

  // ==========================================================================
  // 18. CONTROL SYNC
  // ==========================================================================
  function syncSpeedUI() {
    const input = $('speed-value');
    // Two decimals, like the ref -- but never while the field has focus, or a
    // half-typed "1.2" would be rewritten to "1.20" under the caret.
    const shown = Number(ctl.speed).toFixed(2);
    if (document.activeElement !== input && input.value !== shown) input.value = shown;
    for (const button of $('speed-presets').children) {
      const on = Number(button.dataset.value) === ctl.speed;
      button.setAttribute('aria-checked', on ? 'true' : 'false');
      button.tabIndex = on ? 0 : -1;
    }
    if (!$('speed-presets').querySelector('[aria-checked="true"]')) {
      $('speed-presets').firstElementChild.tabIndex = 0;
    }
  }
  function syncTransposeUI() {
    const input = $('pitch-value');
    if (input.value !== String(ctl.transpose)) input.value = String(ctl.transpose);
    for (const button of $('pitch-presets').children) {
      const on = Number(button.dataset.value) === ctl.transpose;
      button.setAttribute('aria-checked', on ? 'true' : 'false');
      button.tabIndex = on ? 0 : -1;
    }
    if (!$('pitch-presets').querySelector('[aria-checked="true"]')) {
      $('pitch-presets').firstElementChild.tabIndex = 0;
    }
  }

  // Roving tabindex + arrow keys with wrap, for both radiogroups.
  function wireRadioGroup(host, onPick) {
    host.addEventListener('click', (event) => {
      const button = event.target.closest('[role="radio"]');
      if (button) onPick(Number(button.dataset.value));
    });
    host.addEventListener('keydown', (event) => {
      const buttons = [...host.children];
      const at = buttons.indexOf(document.activeElement);
      if (at < 0) return;
      let next = at;
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (at + 1) % buttons.length;
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (at - 1 + buttons.length) % buttons.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = buttons.length - 1;
      else if (event.key === ' ' || event.key === 'Enter') { onPick(Number(buttons[at].dataset.value)); event.preventDefault(); return; }
      else return;
      event.preventDefault();
      buttons[next].focus();
      onPick(Number(buttons[next].dataset.value));
    });
  }

  function wireSwitch(id, get, set) {
    const button = $(id);
    button.addEventListener('click', () => set(button.getAttribute('aria-checked') !== 'true'));
    button.setAttribute('aria-checked', get() ? 'true' : 'false');
  }

  // ==========================================================================
  // 19. WIRING
  // ==========================================================================
  zoom = window.TimelineZoom(lanes, () => player.duration, () => {
    windowLabel();
    if (rollHandle) rollHandle.invalidate();
  });

  rollHandle = window.Draw.register({
    key: 'audition:roll',
    el: rollHost,
    idleMs: 400,
    draw: drawRoll,
  });
  artHandle = window.Draw.register({ key: 'audition:art', el: artHost, idleMs: 1000, draw: drawArt });

  // Cached colours are re-read only when the theme actually changes: never
  // getComputedStyle in a paint path.
  const stopTokens = window.Tokens.onChange(() => {
    readColours();
    layer.invalidate();
    rollHandle.invalidate();
    artHandle.invalidate();
    // The thumbnails are painted from the same tokens but live in list rows,
    // so they are repainted by re-rendering those rows, not by the scheduler.
    railList.refresh();
    renderRecent();
  });

  const redrawSoon = coalesce(() => {
    layer.invalidate();
    rollHandle.invalidate();
    artHandle.invalidate();
  });
  // The cached lanes rect is dropped SYNCHRONOUSLY here, not inside the
  // coalesced repaint: a pointermove can be dispatched before the next frame.
  const onLayoutChange = () => { forgetLanesRect(); redrawSoon(); };
  // resize.js dispatches a synthetic window resize on every divider commit,
  // because canvases only re-measure on that event.
  window.addEventListener('resize', onLayoutChange);
  // Scrolling the body moves the roll without resizing it.
  $('sm-body').addEventListener('scroll', forgetLanesRect, { passive: true });
  // And one observer for the two canvas hosts, so a layout change nothing else
  // reports (the song block being shown after a load, a card wrapping) still
  // produces exactly one coalesced repaint.
  const sizeWatch = typeof ResizeObserver === 'function' ? new ResizeObserver(onLayoutChange) : null;
  if (sizeWatch) { sizeWatch.observe(rollHost); sizeWatch.observe(artHost); }

  const openPicker = async () => {
    const files = api && api.pickMidi ? await api.pickMidi() : [];
    if (files && files[0]) await loadAudition(files[0], '', { play: prefs.autoplay });
  };
  $('open-midi').addEventListener('click', openPicker);
  $('state-open').addEventListener('click', openPicker);

  $('candidate').addEventListener('change', (event) => setCandidate(event.target.value));

  $('instrument').value = ctl.instrument;
  $('instrument').addEventListener('change', async (event) => {
    pause();
    ctl.instrument = event.target.value;
    prefs.instrument = ctl.instrument;
    savePrefs();
    invalidateInstrument();
    reportState(true);
    if (player.context && currentDocument()) await prepareInstrument();
  });

  wireSwitch('sustain', () => ctl.sustain, (on) => {
    ctl.sustain = on;
    prefs.sustain = on;
    savePrefs();
    $('sustain').setAttribute('aria-checked', on ? 'true' : 'false');
    // Clear sounding voices so the change is audible immediately.
    clearVoices();
  });
  wireSwitch('autoplay', () => !!prefs.autoplay, (on) => {
    prefs.autoplay = on;
    savePrefs();
    $('autoplay').setAttribute('aria-checked', on ? 'true' : 'false');
  });
  wireSwitch('loop-on', () => loop.on, (on) => {
    if (on && loop.b - loop.a < 0.25 && player.duration > 0.5) {
      // Turning Loop on with no range means "loop the whole song".
      setRange(0, player.duration);
    }
    setLoopOn(on);
  });

  // Paint on input, persist on change (§9.6). setVolume writes the audio gain
  // live, so a drag is heard without restarting playback.
  const persistVolume = debounce(() => { savePrefsNow(); reportState(true); }, 200);
  $('volume').addEventListener('input', (event) => { setVolume(event.target.value); persistVolume(); });
  $('volume').addEventListener('change', () => persistVolume.flush());

  $('speed-down').addEventListener('click', () => setSpeed(ctl.speed - 0.05));
  $('speed-up').addEventListener('click', () => setSpeed(ctl.speed + 0.05));
  $('speed-value').addEventListener('change', (event) => setSpeed(event.target.value));
  wireRadioGroup($('speed-presets'), setSpeed);

  $('pitch-down').addEventListener('click', () => setTranspose(ctl.transpose - 1));
  $('pitch-up').addEventListener('click', () => setTranspose(ctl.transpose + 1));
  $('pitch-value').addEventListener('change', (event) => setTranspose(event.target.value));
  wireRadioGroup($('pitch-presets'), setTranspose);

  $('loop-set-a').addEventListener('click', setPointA);
  $('loop-set-b').addEventListener('click', setPointB);
  $('loop-reset').addEventListener('click', clearRange);
  for (const id of ['loop-a', 'loop-b']) {
    $(id).addEventListener('change', () => {
      const a = window.Fmt.parseClock($('loop-a').value);
      const b = window.Fmt.parseClock($('loop-b').value);
      if (a === null || b === null) { syncLoopUI(); return; }
      setRange(a, b);
    });
  }

  $('mark-add').addEventListener('click', addMark);
  $('mark-name').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); addMark(); }
  });

  // The bottom transport has Previous/Next, not -5/+5, so the two skip controls
  // keep a home here as well as on the arrow keys.
  $('back').addEventListener('click', () => seek(songTime() - 5));
  $('forward').addEventListener('click', () => seek(songTime() + 5));

  $('favorite').addEventListener('click', () => toggleFav(currentPath()));
  $('song-menu').addEventListener('click', (event) => {
    const path = currentPath();
    if (path) rowMenu(path, songLabel(), event);
  });
  $('roll-reset').addEventListener('click', () => zoom.reset());

  $('info-head').addEventListener('click', () => {
    const open = $('info-head').getAttribute('aria-expanded') === 'true';
    $('info-head').setAttribute('aria-expanded', open ? 'false' : 'true');
    $('info-body').hidden = open;
    prefs.infoOpen = !open;
    savePrefs();
  });

  // left rail
  $('nav-search').addEventListener('input', renderFilesSoon);
  $('nav-search-clear').addEventListener('click', () => {
    $('nav-search').value = '';
    renderFilesSoon.cancel();
    renderFiles();
    $('nav-search').focus();
  });
  $('nav-sort').addEventListener('change', (event) => {
    sortKey = event.target.value;
    prefs.navSort = sortKey;
    savePrefs();
    invalidateSort();
    renderFiles();
  });
  $('nav-rescan').addEventListener('click', () => { void refreshLibrary(); });
  $('nav-add').addEventListener('click', async () => {
    if (!libraryApi || !libraryApi.addFolder) return;
    const result = await libraryApi.addFolder();
    if (result && result.ok) await refreshLibrary();
  });
  $('nav-new-playlist').addEventListener('click', () => openNameSheet('new', 'New playlist', ''));
  $('nav-sources').addEventListener('click', (event) => {
    const row = event.target.closest('[data-pick]');
    if (row) setNavSource(row.dataset.pick);
  });
  $('nav-playlists').addEventListener('click', (event) => {
    const row = event.target.closest('[data-pick]');
    if (row) setNavSource(row.dataset.pick);
  });
  $('nav-playlists').addEventListener('contextmenu', (event) => {
    const row = event.target.closest('[data-pick]');
    if (!row || !row.dataset.pick.startsWith('pl:')) return;
    event.preventDefault();
    const id = row.dataset.pick.slice(3);
    const list = playlists.find((p) => p.id === id);
    if (!list) return;
    window.Menu.open([
      { group: list.name },
      { label: 'Add every song to the queue', icon: 'plus', run: () => { for (const p of list.paths) addToQueue(p, { silent: true }); renderRail(); } },
      { sep: true },
      { label: 'Delete playlist', danger: true, run: () => {
        playlists = playlists.filter((p) => p.id !== id);
        writePlaylists();
        if (navSource === `pl:${id}`) navSource = 'player-queue';
        renderPlaylists();
        renderSources();
        renderFiles();
      } },
    ], { x: event.clientX, y: event.clientY, ariaLabel: list.name });
  });

  // tab groups
  function wireTabs(selector, pick) {
    for (const button of document.querySelectorAll(selector)) {
      button.addEventListener('click', () => pick(button.dataset.nav || button.dataset.rail));
    }
    const host = document.querySelector(selector).parentElement;
    host.addEventListener('keydown', (event) => {
      const buttons = [...host.querySelectorAll('[role="tab"]')];
      const at = buttons.indexOf(document.activeElement);
      if (at < 0) return;
      let next = at;
      if (event.key === 'ArrowRight') next = (at + 1) % buttons.length;
      else if (event.key === 'ArrowLeft') next = (at - 1 + buttons.length) % buttons.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = buttons.length - 1;
      else return;
      event.preventDefault();
      buttons[next].focus();
      pick(buttons[next].dataset.nav || buttons[next].dataset.rail);
    });
  }
  wireTabs('[data-nav]', setNavTab);
  wireTabs('[data-rail]', setRailTab);

  // right rail
  $('rail-clear').addEventListener('click', () => {
    if (railTab === 'queue') prefs.queue = []; else prefs.history = [];
    savePrefs();
    renderRail();
    reportState(true);
    republishCommands();
  });
  $('rail-save').addEventListener('click', () => openNameSheet('save',
    railTab === 'queue' ? 'Save the queue as a playlist' : 'Save the history as a playlist',
    railTab === 'queue' ? 'My queue' : 'Recently played'));
  $('recent-all').addEventListener('click', () => { setRailTab('history'); $('rail-list').focus(); });

  $('act-queue').addEventListener('click', () => addToQueue(currentPath()));
  $('act-editor').addEventListener('click', () => {
    const path = currentPath();
    if (!path) return;
    window.Bus.send(T.NAV_OPEN_EDITOR, { projectPath: player.projectPath || '', midiPath: path });
  });
  $('act-player').addEventListener('click', () => {
    const path = currentPath();
    if (path) window.Bus.send(T.NAV_OPEN_PLAYER, { midiPath: path });
  });
  $('act-reveal').addEventListener('click', () => {
    const path = currentPath();
    if (path) window.Bus.send(T.FILE_REVEAL, { path });
  });

  // ---- keys ---------------------------------------------------------------
  const isFormControl = (target) => !!target
    && (/^(INPUT|SELECT|BUTTON|TEXTAREA)$/.test(target.tagName) || target.isContentEditable);

  window.addEventListener('keydown', (event) => {
    if (event.defaultPrevented) return;                 // VList and the roll got it
    if (!$('name-scrim').hidden) return;                // the sheet owns the keyboard
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    if (event.key === 'Escape') {
      if (window.Menu.isOpen()) return;                 // Menu captures Escape itself
      fileList.clearSelection();
      railList.clearSelection();
      return;
    }
    if (isFormControl(event.target)) return;
    // Space and Home only reach a panel, never the shell, and only the transport
    // owner may act on them (CONTRACT §11.7).
    if (event.code === 'Space') {
      if (!isOwner() || !spaceTransport) return;
      event.preventDefault();
      window.Transport.toggle();
      return;
    }
    if (event.key === 'Home') {
      if (!isOwner()) return;
      event.preventDefault();
      window.Transport.stop();
      return;
    }
    if (event.key === 'ArrowLeft') { event.preventDefault(); seek(songTime() - 5); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); seek(songTime() + 5); }
  });

  // ---- drag and drop ------------------------------------------------------
  let dragDepth = 0;
  const setVeil = (on) => {
    if (on) document.documentElement.dataset.drop = 'on';
    else delete document.documentElement.dataset.drop;
  };
  document.addEventListener('dragenter', (event) => {
    event.preventDefault();
    dragDepth += 1;
    setVeil(true);
  });
  document.addEventListener('dragover', (event) => event.preventDefault());
  document.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) setVeil(false);
  });
  document.addEventListener('drop', (event) => {
    event.preventDefault();
    dragDepth = 0;
    setVeil(false);
    const files = event.dataTransfer && event.dataTransfer.files;
    const file = files && files[0];
    const path = file && review && review.getDroppedFilePath ? review.getDroppedFilePath(file) : '';
    if (/\.midstudio\.json$/i.test(path)) void loadAudition('', path, { play: prefs.autoplay });
    else if (/\.midi?$/i.test(path)) void loadAudition(path, '', { play: prefs.autoplay });
    else if (path) {
      // Anything else is somebody else's file: let the shell's router decide.
      window.Bus.send(T.FILE_DROPPED, { paths: [path], kind: 'unknown', frame: FRAME });
    }
  });

  // ==========================================================================
  // 20. COMMANDS  (every action is in Ctrl+K)
  // ==========================================================================
  window.Commands.setScope(FRAME);
  const hasFile = () => !!currentDocument();
  const unregister = window.Commands.registerAll([
    { id: 'selfmidi.open', label: 'Open a MIDI file', keywords: ['listen', 'browse', 'file'], group: 'Self MIDI', run: openPicker },
    { id: 'selfmidi.play', label: 'Play or pause', keys: 'Space', group: 'Self MIDI', enabled: hasFile, run: () => togglePlay() },
    { id: 'selfmidi.stop', label: 'Stop', keys: 'Home', group: 'Self MIDI', enabled: hasFile, run: stop },
    { id: 'selfmidi.back', label: 'Back 5 seconds', keys: 'Left', group: 'Self MIDI', enabled: hasFile, run: () => seek(songTime() - 5) },
    { id: 'selfmidi.forward', label: 'Forward 5 seconds', keys: 'Right', group: 'Self MIDI', enabled: hasFile, run: () => seek(songTime() + 5) },
    { id: 'selfmidi.next', label: 'Next in the queue', group: 'Self MIDI', enabled: () => prefs.queue.length > 0, run: nextTrack },
    { id: 'selfmidi.prev', label: 'Previous in the queue', group: 'Self MIDI', enabled: () => prefs.queue.length > 0, run: prevTrack },
    { id: 'selfmidi.favorite', label: 'Favorite this song', keywords: ['star', 'like'], group: 'Self MIDI', enabled: hasFile, run: () => toggleFav(currentPath()) },
    { id: 'selfmidi.addQueue', label: 'Add this song to the queue', group: 'Self MIDI', enabled: hasFile, run: () => addToQueue(currentPath()) },
    { id: 'selfmidi.clearQueue', label: 'Clear the queue', group: 'Self MIDI', enabled: () => prefs.queue.length > 0, run: () => { prefs.queue = []; savePrefs(); renderRail(); reportState(true); republishCommands(); } },
    { id: 'selfmidi.newPlaylist', label: 'New playlist', group: 'Self MIDI', run: () => openNameSheet('new', 'New playlist', '') },
    { id: 'selfmidi.savePlaylist', label: 'Save the queue as a playlist', group: 'Self MIDI', enabled: () => prefs.queue.length > 0, run: () => openNameSheet('save', 'Save the queue as a playlist', 'My queue') },
    { id: 'selfmidi.loopA', label: 'Set the loop A point here', group: 'Self MIDI', enabled: hasFile, run: setPointA },
    { id: 'selfmidi.loopB', label: 'Set the loop B point here', group: 'Self MIDI', enabled: hasFile, run: setPointB },
    { id: 'selfmidi.loopClear', label: 'Clear the loop range', group: 'Self MIDI', enabled: () => loop.b > loop.a, run: clearRange },
    { id: 'selfmidi.bookmark', label: 'Bookmark this spot', group: 'Self MIDI', enabled: hasFile, run: addMark },
    { id: 'selfmidi.resetZoom', label: 'Reset the piano-roll zoom', group: 'Self MIDI', enabled: hasFile, run: () => zoom.reset() },
    { id: 'selfmidi.sendPlayer', label: 'Send this song to the Player', keywords: ['keystrokes', 'roblox'], group: 'Self MIDI', enabled: hasFile, run: () => window.Bus.send(T.NAV_OPEN_PLAYER, { midiPath: currentPath() }) },
    { id: 'selfmidi.sendEditor', label: 'Open this song in the Editor', group: 'Self MIDI', enabled: hasFile, run: () => window.Bus.send(T.NAV_OPEN_EDITOR, { projectPath: player.projectPath || '', midiPath: currentPath() }) },
    { id: 'selfmidi.reveal', label: 'Show this song in the folder', group: 'Self MIDI', enabled: hasFile, run: () => window.Bus.send(T.FILE_REVEAL, { path: currentPath() }) },
    // The four the bottom transport drives (§11.4). They take an argument from
    // the bar; run without one they do nothing rather than guess.
    { id: 'selfmidi.repeat', label: 'Repeat mode (from the transport)', group: 'Self MIDI', run: (arg) => { if (typeof arg === 'string') setRepeat(arg); } },
    { id: 'selfmidi.transpose', label: 'Transpose (from the transport)', group: 'Self MIDI', run: (arg) => { if (Number.isFinite(Number(arg))) setTranspose(Number(arg)); } },
    { id: 'selfmidi.volume', label: 'Volume (from the transport)', group: 'Self MIDI', run: (arg) => { if (Number.isFinite(Number(arg))) { setVolume(Number(arg) * 100); persistVolume(); } } },
  ]);

  // ==========================================================================
  // 21. BUS
  // ==========================================================================
  const offs = [];
  offs.push(window.Bus.on(T.NAV_OPEN_SELFMIDI, (p) => {
    if (!p) return;
    if (p.midiPath || p.projectPath) void loadAudition(p.midiPath || '', p.projectPath || '', { play: p.play });
  }));
  offs.push(window.Bus.on(T.NAV_ACTIVATED, (p) => {
    if (!p || p.tab !== FRAME) return;
    // The Space-toggles-transport preference is not mirrored onto the bus, and
    // nav:activated always precedes the user pressing a key in this tab.
    if (studio && studio.getUi) {
      studio.getUi().then((ui) => { spaceTransport = !ui || ui.spaceTransport !== false; }).catch(() => {});
    }
    void refreshLibrary();
  }));
  offs.push(window.Bus.on(T.LIBRARY_CHANGED, async (p) => {
    if (p && p.reason === 'favorites') {
      await readStores();
      syncFavUI();
      renderSources();
      if (navTab === 'favorites' || navSource === 'fav') renderFiles();
      else fileList.refresh();
      return;
    }
    await refreshLibrary();
  }));
  offs.push(window.Bus.on(T.FILE_OPEN, (p) => {
    // Only our own hand-offs: flash the row the file came from.
    if (!p || p.from !== FRAME || !p.path) return;
    const index = fileList.indexOfKey(p.path);
    if (index < 0) return;
    fileList.scrollToIndex(index, 'nearest');
    const node = fileList.nodeAt(index);
    if (!node) return;
    node.classList.add('is-flash');
    setTimeout(() => node.classList.remove('is-flash'), 420);
  }));
  offs.push(window.Bus.on(T.TRANSPORT_OWNER, (p) => {
    if (!p) return;
    if (p.owner !== OWNER) { handle = null; return; }
  }));

  window.addEventListener('midi-studio:density', () => {
    fileList.rowHeight(rowHeightBig());
    railList.rowHeight(rowHeightRail());
  });
  offs.push(window.Bus.on(T.UI_DENSITY, () => {
    fileList.rowHeight(rowHeightBig());
    railList.rowHeight(rowHeightRail());
  }));

  // ==========================================================================
  // 22. TEARDOWN
  // ==========================================================================
  window.addEventListener('pagehide', () => {
    stopTimer();
    clearVoices();
    savePrefs.flush();
    writeFavs.flush();
    writePlaylists.flush();
    saveMeta.flush();
    persistVolume.cancel();
    renderFilesSoon.cancel();
    republishCommands.cancel();
    for (const off of offs) { try { off(); } catch (_) {} }
    try { unregister(); } catch (_) {}
    try { stopTokens(); } catch (_) {}
    if (sizeWatch) sizeWatch.disconnect();
    if (rollHandle) rollHandle.dispose();
    if (artHandle) artHandle.dispose();
    layer.dispose();
    fileList.destroy();
    railList.destroy();
    if (handle) { try { handle.release(); } catch (_) {} }
    if (player.context) { try { void player.context.close(); } catch (_) {} }
  });

  // ==========================================================================
  // 23. BOOT
  // ==========================================================================
  setVolume(ctl.volume);
  syncSpeedUI();
  syncTransposeUI();
  syncLoopUI();
  $('sustain').setAttribute('aria-checked', ctl.sustain ? 'true' : 'false');
  $('autoplay').setAttribute('aria-checked', prefs.autoplay ? 'true' : 'false');
  $('loop-on').setAttribute('aria-checked', loop.on ? 'true' : 'false');
  $('nav-sort').value = sortKey;
  $('info-head').setAttribute('aria-expanded', prefs.infoOpen ? 'true' : 'false');
  $('info-body').hidden = !prefs.infoOpen;
  setInstrumentStatus(`${instrumentLabel()} · Loads on play`);
  enableActions(false);
  setState('empty', 'Nothing loaded',
    'Open a MIDI file, drop one here, or pick a song from your library. Self MIDI plays it inside the app.');
  setNavTab(navTab);
  setRailTab(railTab);
  renderMarks();
  setClock();
  windowLabel();
  rollHandle.invalidate();
  artHandle.invalidate();

  // Legacy cross-frame contract. Once frame:ready is out the shell uses the bus
  // and never calls this, but a shell that has not been updated still can.
  window.loadAudition = (midiPath, projectPath, options) => loadAudition(midiPath, projectPath, options || {});

  window.Bus.send(T.FRAME_READY, { frame: FRAME, title: 'Self MIDI' });

  (async () => {
    await readStores();
    syncFavUI();
    renderSources();
    renderPlaylists();
    if (studio && studio.getUi) {
      try {
        const ui = await studio.getUi();
        spaceTransport = !ui || ui.spaceTransport !== false;
      } catch (_) {}
    }
    await refreshLibrary();
    renderRail();

    // Take the transport only when nobody has it: switching to this tab must
    // never park a Player that is mid-song.
    try {
      const snapshot = await window.Transport.sync();
      if (!snapshot || !snapshot.owner) claimTransport();
    } catch (_) {
      if (!window.Transport.owner()) claimTransport();
    }

    // Session restore never autoplays. Skip it if a hand-off already arrived:
    // the queued nav:open-selfmidi is flushed the moment frame:ready lands.
    if (!loadRequested && (prefs.lastProjectPath || prefs.lastMidiPath)) {
      await loadAudition(prefs.lastMidiPath, prefs.lastProjectPath, { play: false });
    }
  })();
})();

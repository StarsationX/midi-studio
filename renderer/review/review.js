/* review.js — the Editor tab (frame key `review`).
   ==========================================================================
   A real piano-roll editor over the `midi_document.py` document model.

   The load-bearing invariants, all verified by the code below:

   * The roll canvas stays VIEWPORT-SIZED and #roll-extent supplies the scroll
     range. A five-minute song at default zoom is ~24,000px, past Chromium's
     16,384px canvas cap, and the tail of a long song simply never drew.
     Pointer x/y are converted back into content space; the ruler and the pinned
     key strip are drawn LAST, outside the clip.
   * The resize-edge hit zone is proportional: width > 14 && right-x <
     min(8, width*0.3). A fixed 8px zone made almost every 1/16 note resize.
   * A plain click never dirties the project and never pushes history: the
     transaction opens on the first >=2px move and is discarded on release
     unless a field actually differs.
   * Undo/redo is keyed by note id, never index, and ids survive every restore.
     Patches carry the changed fields only, so a 120k-note document does not pay
     a full array clone per keystroke. `unterminated` and every unknown field
     round-trip because notes are mutated in place, never rebuilt from a list.
   * doc.bpm may be an onset-derived guess (doc.bpmEstimated). It is surfaced
     with an override, saved back, and the warning says why it matters.
   * Opening a plain .mid leaves projectPath empty; main's fromProject gate then
     refuses to overwrite the user's own file.
   * Renaming clears project.candidates so the next Save writes new files.
   * maxEnd/maxShort are tracked with a loop. Math.max(...spread) throws
     RangeError past ~100k arguments, so it hard-failed a large transcription.
   * Geometry-invalidating relayout is split from repaint-only. The zoom slider,
     a velocity change, a nudge and a delete no longer reallocate two canvases.
   * Notes stay sorted by start; playback advances a cursor (binary search on
     seek) and drawing binary-searches the first visible note.
   * Autorepeat arrow keys coalesce into ONE undo entry per key-hold.
   * Every colour is read once through Tokens and re-read on theme change; there
     is no getComputedStyle in a paint loop.
   ========================================================================== */
(() => {
  'use strict';

  const FRAME = 'review';
  const R = window.review || {};
  const Bus = window.Bus, T = Bus.TYPES, Transport = window.Transport, Commands = window.Commands;
  const Draw = window.Draw, Tokens = window.Tokens, Fmt = window.Fmt, Menu = window.Menu;
  const $ = (id) => document.getElementById(id);
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const disposers = [];
  // setPointerCapture throws when the pointer has already gone (a cancelled
  // gesture, a synthetic event); losing capture is never worth an exception.
  const capture = (el, id) => { try { el.setPointerCapture(id); } catch (_) { /* no live pointer */ } };
  const onEl = (el, type, fn, opts) => {
    if (!el) return;
    el.addEventListener(type, fn, opts);
    disposers.push(() => el.removeEventListener(type, fn, opts));
  };

  // One rAF per burst, last value wins. For painting only.
  function coalesce(fn) {
    let armed = false, args = null;
    return (...a) => {
      args = a;
      if (armed) return;
      armed = true;
      requestAnimationFrame(() => { armed = false; fn(...args); });
    };
  }
  // Trailing edge, last value wins. For writes. flush() INVOKES, cancel() drops.
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

  // ==========================================================================
  // 1. constants
  // ==========================================================================
  const KEY_W = 60;
  const TOP_H = 26;
  let ROW_H = 14;
  const MIN_LEN = 0.02;
  const HIST_CAP = 80;
  // Headroom the automation lane leaves above a full-velocity bar. ONE constant,
  // because the draw and the pointer read-back have to be exact inverses: they
  // used to divide by different spans, so a value set by dragging never landed
  // where the bar was drawn.
  const LANE_PAD = 6;
  // A note this long is treated as a special case by the visibility scan below.
  const LONG_SEC = 2;
  const PEAK_BUCKETS = 4096;
  const LOOKAHEAD = 0.14;     // seconds of notes scheduled ahead of the audio clock
  const CLOCK_MS = 25;

  const GM = ('Acoustic Grand|Bright Acoustic|Electric Grand|Honky-tonk|Electric Piano 1|Electric Piano 2|' +
    'Harpsichord|Clavinet|Celesta|Glockenspiel|Music Box|Vibraphone|Marimba|Xylophone|Tubular Bells|Dulcimer|' +
    'Drawbar Organ|Percussive Organ|Rock Organ|Church Organ|Reed Organ|Accordion|Harmonica|Tango Accordion|' +
    'Nylon Guitar|Steel Guitar|Jazz Guitar|Clean Guitar|Muted Guitar|Overdriven Guitar|Distortion Guitar|Guitar Harmonics|' +
    'Acoustic Bass|Finger Bass|Pick Bass|Fretless Bass|Slap Bass 1|Slap Bass 2|Synth Bass 1|Synth Bass 2|' +
    'Violin|Viola|Cello|Contrabass|Tremolo Strings|Pizzicato Strings|Orchestral Harp|Timpani|' +
    'String Ensemble 1|String Ensemble 2|Synth Strings 1|Synth Strings 2|Choir Aahs|Voice Oohs|Synth Voice|Orchestra Hit|' +
    'Trumpet|Trombone|Tuba|Muted Trumpet|French Horn|Brass Section|Synth Brass 1|Synth Brass 2|' +
    'Soprano Sax|Alto Sax|Tenor Sax|Baritone Sax|Oboe|English Horn|Bassoon|Clarinet|' +
    'Piccolo|Flute|Recorder|Pan Flute|Blown Bottle|Shakuhachi|Whistle|Ocarina|' +
    'Square Lead|Sawtooth Lead|Calliope Lead|Chiff Lead|Charang Lead|Voice Lead|Fifths Lead|Bass + Lead|' +
    'New Age Pad|Warm Pad|Polysynth Pad|Choir Pad|Bowed Pad|Metallic Pad|Halo Pad|Sweep Pad|' +
    'Rain FX|Soundtrack FX|Crystal FX|Atmosphere FX|Brightness FX|Goblins FX|Echoes FX|Sci-Fi FX|' +
    'Sitar|Banjo|Shamisen|Koto|Kalimba|Bagpipe|Fiddle|Shanai|' +
    'Tinkle Bell|Agogo|Steel Drums|Woodblock|Taiko Drum|Melodic Tom|Synth Drum|Reverse Cymbal|' +
    'Guitar Fret Noise|Breath Noise|Seashore|Bird Tweet|Telephone Ring|Helicopter|Applause|Gunshot').split('|');

  // Desaturated track hues: identity only. The accent stays the one functional
  // colour (selection, playhead, playback, primary action, success).
  const TRACK_HUES = ['#6f8ea3', '#8a7fa8', '#7fa38b', '#a3907f', '#7f96a8', '#a37f95',
    '#95a37f', '#7fa3a0', '#a89b7f', '#8f8fa8', '#a37f7f', '#7fa37f',
    '#a8a07f', '#7f8fa3', '#9c7fa3', '#7f9ca3'];

  const SCALES = {
    chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    major: [0, 2, 4, 5, 7, 9, 11],
    minor: [0, 2, 3, 5, 7, 8, 10],
    hminor: [0, 2, 3, 5, 7, 8, 11],
    dorian: [0, 2, 3, 5, 7, 9, 10],
    mixolydian: [0, 2, 4, 5, 7, 9, 10],
    pentaMaj: [0, 2, 4, 7, 9],
    pentaMin: [0, 3, 5, 7, 10],
    blues: [0, 3, 5, 6, 7, 10]
  };
  const PITCH_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  // ==========================================================================
  // 2. state
  // ==========================================================================
  let projectPath = '';
  let project = null;
  let documents = {};
  let candidate = '';
  let notes = [];
  const byId = new Map();
  let sortDirty = false, extentDirty = true;
  // Bumped by setNotes() (the one place the note array is replaced) and by the
  // two places that add/remove an id in the live `selected` Set. Together with
  // that Set's identity they are the whole invalidation key for selectedNotes().
  let notesEpoch = 0, selVersion = 0;
  // See window.__review at the bottom of the file.
  const Seam = { forcePython: false, loadedVia: '', snapshot: null };
  let maxEnd = 0, maxShort = 0.5;
  let longNotes = [];      // notes longer than LONG_SEC, kept out of the back-scan
  let notesVersion = 0;

  let selected = new Set();
  let clipboard = [];
  let noteSeq = 0;

  let hist = Object.create(null);
  let fut = Object.create(null);
  let tx = null;
  let txCommit = null;               // debounced commit for autorepeat gestures

  let zoom = 85;
  let pitchLow = 48, pitchHigh = 96;
  let duration = 0, projectDuration = 0;
  let loopA = 0, loopB = 0, loopOn = false;
  let playhead = 0;
  let dirty = false;
  let tool = 'select';
  let lane = 'velocity';
  let snapOn = true, linkOn = true, followOn = true, midiOn = true, audioOn = false;
  let muted = new Set(), soloed = new Set();
  let tracks = [];
  let sx = 0, sy = 0;                // cached scroll offsets
  let sounding = new Set();          // pitches currently sounding, for the roll

  let playing = false, rate = 1, volume = 0.85;
  let clockTimer = 0, cursor = 0, schedTo = -1, reportTick = 0;
  let audioOffset = 0;
  let ctxAudio = null, master = null;
  let sampledReady = false, samplePrepare = null;
  let peaks = null, peaksVersion = 0, peaksSpan = 0;
  let spaceTransport = true;
  let ownTransport = null, caps = null;

  const soundfonts = window.MidiStudioSoundfonts || null;
  const INSTRUMENT = 'grand_piano';
  const audio = $('audio');

  const doc = () => documents[candidate] || null;
  const loaded = () => !!doc();

  // ==========================================================================
  // 3. theme colours — read once, re-read on theme change, never in a loop
  // ==========================================================================
  const C = {};
  const chanShades = new Map();

  function mix(a, b, t) {
    const p = Tokens.parseColor(a) || [0, 0, 0, 1];
    const q = Tokens.parseColor(b) || [0, 0, 0, 1];
    const r = Math.round(p[0] + (q[0] - p[0]) * t);
    const g = Math.round(p[1] + (q[1] - p[1]) * t);
    const bl = Math.round(p[2] + (q[2] - p[2]) * t);
    return 'rgb(' + r + ',' + g + ',' + bl + ')';
  }
  function ramp(from, to, n) {
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = mix(from, to, n === 1 ? 1 : i / (n - 1));
    return out;
  }

  function readTokens() {
    C.bg = Tokens.get('bg-2');
    C.surface = Tokens.get('surface');
    C.surface2 = Tokens.get('surface-2');
    C.surface3 = Tokens.get('surface-3');
    C.line = Tokens.get('line');
    C.line2 = Tokens.get('line-2');
    C.text = Tokens.get('text');
    C.text2 = Tokens.get('text-2');
    C.text3 = Tokens.get('text-3');
    C.accent = Tokens.get('accent');
    C.accent2 = Tokens.get('accent-2');
    C.accentDeep = Tokens.get('accent-deep');
    C.accentInk = Tokens.get('accent-ink');
    C.warn = Tokens.get('warn');

    C.rowWhite = mix(C.bg, C.surface, 0.5);
    C.rowBlack = mix(C.bg, '#000000', 0.28);
    C.rowLine = Tokens.rgba('line-2', 0.28);
    C.gridSub = Tokens.rgba('line-2', 0.20);
    C.gridBeat = Tokens.rgba('line-2', 0.5);
    C.gridBar = Tokens.rgba('line-2', 0.92);
    C.ruler = Tokens.get('surface');
    C.rulerText = Tokens.get('text-3');
    // A real keyboard: near-white keys, a dark bed behind the short black ones,
    // a grey seam only where two white keys actually touch (E|F and B|C).
    C.keyWhite = mix(C.text, '#ffffff', 0.30);
    C.keyBlack = mix(C.bg, '#000000', 0.45);
    C.keyBed = mix(C.surface2, C.bg, 0.5);
    C.keySeam = mix(C.keyWhite, '#000000', 0.34);
    C.keyLabel = mix(C.keyWhite, '#000000', 0.62);
    C.keyLine = Tokens.get('edge');
    C.laneScale = Tokens.rgba('text-2', 0.9);
    C.laneHalo = Tokens.rgba('bg-2', 0.92);
    C.loopFill = Tokens.rgba('accent', 0.09);
    C.loopEdge = Tokens.rgba('accent', 0.55);
    C.marqFill = Tokens.rgba('accent', 0.10);
    C.marqEdge = Tokens.rgba('accent', 0.7);
    C.peak = mix(C.text3, C.line2, 0.35);
    C.tick = mix(C.text3, C.text2, 0.5);
    C.mono = Tokens.get('font-mono');
    C.body = Tokens.get('font-body');

    // The note field is the accent, as in the reference: a velocity ramp from a
    // sunken deep-accent at pianissimo to the full accent at fortissimo. The two
    // states that have to be separable ON TOP of that field therefore leave the
    // hue behind - selection goes to white, a sounding note to near-white - so
    // neither is "the same green, slightly different", which is the failure mode
    // a coloured note body creates for a coloured selection.
    const dim = mix(C.accentDeep, C.bg, 0.26);
    C.noteShades = ramp(dim, C.accent, 8);
    C.selShades = ramp(mix(C.accent, '#ffffff', 0.45), '#ffffff', 8);
    C.soundShades = ramp(mix(C.accent2, '#ffffff', 0.35), mix(C.accent2, '#ffffff', 0.75), 8);
    C.noteStroke = Tokens.rgba('edge', 0.55);
    C.gripSel = C.accentInk;
    C.gripPlain = Tokens.rgba('edge', 0.9);
    chanShades.clear();
  }

  function shadesFor(ch, state) {
    if (state === 1) return C.selShades;
    if (state === 2) return C.soundShades;
    if (tracks.length < 2) return C.noteShades;
    let s = chanShades.get(ch);
    if (!s) {
      const hue = TRACK_HUES[ch % TRACK_HUES.length];
      // 0.22, not a half-and-half blend: enough to tell two channels apart,
      // little enough that the roll still reads as one accent-coloured field.
      s = C.noteShades.map((v) => mix(v, hue, 0.18));
      chanShades.set(ch, s);
    }
    return s;
  }
  const shadeIdx = (vel) => clamp((vel - 1) >> 4, 0, 7);

  // ==========================================================================
  // 4. document index: sorted notes, id map, extent
  // ==========================================================================
  function setNotes(arr) {
    const d = doc();
    if (!d) { notes = []; notesEpoch++; byId.clear(); sortDirty = false; extentDirty = true; return; }
    d.notes = arr;
    notes = arr;
    notesEpoch++;
    byId.clear();
    for (let i = 0; i < arr.length; i++) byId.set(arr[i].id, arr[i]);
    sortDirty = true;
    extentDirty = true;
  }
  function ensureSorted() {
    if (!sortDirty) return;
    // sortDirty means "something touched a note", not "the order broke", and
    // most of the paths that set it do not break it: the loader hands over an
    // already-sorted array, a velocity/channel edit and the undo of one leave
    // start and pitch alone, and a move-drag over the WHOLE document translates
    // every note by the same delta and so preserves the order exactly. One
    // linear scan reading the fields directly is 5.6x cheaper than making TimSort
    // re-establish the same fact through a JS comparator (0.57ms against 3.19ms
    // over 120k notes), and when the order HAS broken the scan exits at the
    // first inversion and costs ~0.3ms on top of the sort. Measured at 120k in
    // the real panel: undo 24.6ms -> 19.6ms mean, redo 32.8ms -> 19.9ms.
    if (!sortedAlready()) notes.sort((a, b) => (a.start - b.start) || (a.pitch - b.pitch));
    sortDirty = false;
  }
  function sortedAlready() {
    for (let i = 1; i < notes.length; i++) {
      const a = notes[i - 1], b = notes[i];
      if (a.start > b.start || (a.start === b.start && a.pitch > b.pitch)) return false;
    }
    return true;
  }
  // A loop, never Math.max(...spread): the spread throws RangeError past ~100k
  // arguments, so one very large transcription hard-failed on its first refresh.
  function ensureExtent() {
    if (!extentDirty) return;
    let e = 0, l = 0;
    longNotes = [];
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      if (n.end > e) e = n.end;
      const len = n.end - n.start;
      if (len > LONG_SEC) longNotes.push(n);
      else if (len > l) l = len;
    }
    maxEnd = e;
    maxShort = l > 0 ? l : 0.5;
    extentDirty = false;
  }
  function noteMoved(n) {                 // cheap incremental extent widening
    if (n.end > maxEnd) maxEnd = n.end;
    const len = n.end - n.start;
    if (len > LONG_SEC) { if (longNotes.indexOf(n) < 0) longNotes.push(n); }
    else if (len > maxShort) maxShort = len;
    sortDirty = true;
  }
  // Every note overlapping [from, to], in one place.
  //
  // Notes are sorted by start, so a binary search finds the first note that can
  // still reach into the window -- but only if the back-off distance is small.
  // One song-length note makes that distance the whole song, and the loader
  // produces exactly that for every note whose note_off was missing (it closes
  // them at the end of the file). So long notes live in a tiny side list and the
  // back-scan only has to cover the longest SHORT note. Measured on a
  // 120k-note transcription with one song-length note: 15.9ms -> 0.9ms p99 at
  // the tail of the song.
  // TRIED AND REVERTED: skipping the re-sort mid-gesture and finding the window
  // with a linear pass instead. The premise was that a drag re-sorts the whole
  // array on every repaint, so 30fps would cost 30 sorts a second. It does not:
  // a drag displaces each note by the same delta, which leaves the array NEARLY
  // sorted, and TimSort walks a nearly-sorted array in close to linear time. The
  // measurement said so -- three paired 120k runs, drag repaint frame 7.63/11.8/
  // 6.00ms with the sort against 11.7/10.1/6.85ms with the linear pass, i.e. no
  // improvement inside a run-to-run spread that is bigger than the effect. The
  // sorted path is the simpler one and keeps the draw order exactly, so it stays.
  function forOverlapping(from, to, fn) {
    ensureSorted();
    ensureExtent();
    for (let k = 0; k < longNotes.length; k++) {
      const n = longNotes[k];
      if ((n.end - n.start) <= LONG_SEC) continue;       // shrunk since; the scan has it
      if (n.end >= from && n.start <= to) fn(n);
    }
    for (let i = lowerBound(from - maxShort); i < notes.length; i++) {
      const n = notes[i];
      if (n.start > to) break;
      if ((n.end - n.start) > LONG_SEC) continue;        // drawn above
      if (n.end >= from) fn(n);
    }
  }
  // first index whose start >= t (binary search over the sorted array)
  function lowerBound(t) {
    let lo = 0, hi = notes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (notes[mid].start < t) lo = mid + 1; else hi = mid;
    }
    return lo;
  }
  const audible = (ch) => (soloed.size ? soloed.has(ch) : !muted.has(ch));

  // ==========================================================================
  // 5. history: field-level patches keyed by note id
  // ==========================================================================
  const FIELDS = ['pitch', 'start', 'end', 'velocity', 'channel'];
  function grab(n) { return { pitch: n.pitch, start: n.start, end: n.end, velocity: n.velocity, channel: n.channel }; }
  function same(a, b) {
    for (let i = 0; i < FIELDS.length; i++) if (a[FIELDS[i]] !== b[FIELDS[i]]) return false;
    return true;
  }
  function assign(n, v) { for (let i = 0; i < FIELDS.length; i++) n[FIELDS[i]] = v[FIELDS[i]]; }

  function beginTx(label, key) {
    if (tx && key && tx.key === key) { tx.label = label; return tx; }
    if (tx) commitTx();
    tx = { label, key: key || '', changed: new Map(), added: [], removed: [], meta: null, cand: candidate };
    return tx;
  }
  function snap(n) {                     // record the prior fields once per note
    if (!tx || tx.changed.has(n.id)) return;
    tx.changed.set(n.id, grab(n));
  }
  function snapAllSelected() { for (const n of notes) if (selected.has(n.id)) snap(n); }
  function txAdd(n) { if (tx) tx.added.push(n); }
  function txRemove(n) { if (tx) tx.removed.push(n); }
  function txMeta(before, after) { if (tx) tx.meta = { before, after }; }

  function commitTx() {
    const t = tx;
    tx = null;
    if (!t) return false;
    const changed = [];
    t.changed.forEach((a, id) => {
      const n = byId.get(id);
      if (!n) return;
      const b = grab(n);
      if (!same(a, b)) changed.push({ id, a, b });
    });
    if (!changed.length && !t.added.length && !t.removed.length && !t.meta) return false;
    const entry = { label: t.label, at: Date.now(), changed, added: t.added, removed: t.removed, meta: t.meta };
    const stack = hist[t.cand] || (hist[t.cand] = []);
    stack.push(entry);
    if (stack.length > HIST_CAP) stack.shift();
    fut[t.cand] = [];
    setDirty(true);
    bumpNotes();
    return true;
  }
  function abortTx() {
    const t = tx;
    tx = null;
    if (!t) return;
    // put every touched note back: this is the path a cancelled gesture takes
    t.changed.forEach((a, id) => { const n = byId.get(id); if (n) assign(n, a); });
    if (t.added.length) {
      const drop = new Set(t.added.map((n) => n.id));
      setNotes(notes.filter((n) => !drop.has(n.id)));
    }
    if (t.removed.length) setNotes(notes.concat(t.removed));
    bumpNotes();
  }

  function applyEntry(entry, dir) {
    const d = doc();
    if (!d) return false;
    if (dir < 0) {
      if (entry.added.length) {
        const drop = new Set(entry.added.map((n) => n.id));
        setNotes(notes.filter((n) => !drop.has(n.id)));
      }
      if (entry.removed.length) setNotes(notes.concat(entry.removed));
      for (const c of entry.changed) { const n = byId.get(c.id); if (n) assign(n, c.a); }
      if (entry.meta) applyMeta(entry.meta.before);
    } else {
      if (entry.removed.length) {
        const drop = new Set(entry.removed.map((n) => n.id));
        setNotes(notes.filter((n) => !drop.has(n.id)));
      }
      if (entry.added.length) setNotes(notes.concat(entry.added));
      for (const c of entry.changed) { const n = byId.get(c.id); if (n) assign(n, c.b); }
      if (entry.meta) applyMeta(entry.meta.after);
    }
    sortDirty = true;
    extentDirty = true;
    // Only an add or a remove can strand a selected id. A field-only entry (a
    // velocity edit and its undo, the common case) cannot, and rebuilding the
    // Set for it costs a 120k-element spread, a filter and a fresh Set for
    // nothing.
    return entry.added.length > 0 || entry.removed.length > 0;
  }
  // Drop ids whose note is gone, without allocating when none are.
  function pruneSelection() {
    let stale = false;
    for (const id of selected) if (!byId.has(id)) { stale = true; break; }
    if (!stale) return;
    const next = new Set();
    for (const id of selected) if (byId.has(id)) next.add(id);
    selected = next;
  }
  function applyMeta(m) {
    if (!m) return;
    for (const d of Object.values(documents)) {
      if (m.bpm !== undefined) d.bpm = m.bpm;
      if (m.bpmEstimated !== undefined) d.bpmEstimated = m.bpmEstimated;
    }
  }

  function undo() {
    if (tx) commitTx();
    const stack = hist[candidate] || [];
    if (!stack.length) return;
    const entry = stack.pop();
    if (applyEntry(entry, -1)) pruneSelection();
    (fut[candidate] || (fut[candidate] = [])).push(entry);
    setDirty(true);
    relayout();
    say('Undid ' + entry.label);
  }
  function redo() {
    if (tx) commitTx();
    const stack = fut[candidate] || [];
    if (!stack.length) return;
    const entry = stack.pop();
    if (applyEntry(entry, 1)) pruneSelection();
    (hist[candidate] || (hist[candidate] = [])).push(entry);
    setDirty(true);
    relayout();
    say('Redid ' + entry.label);
  }
  // Travel to an arbitrary point in the stack (the History tab's click target).
  function travelTo(index) {
    if (tx) commitTx();
    const h = hist[candidate] || (hist[candidate] = []);
    const f = fut[candidate] || (fut[candidate] = []);
    let membership = false;
    while (h.length > index + 1) { const e = h.pop(); membership = applyEntry(e, -1) || membership; f.push(e); }
    while (h.length < index + 1 && f.length) { const e = f.pop(); membership = applyEntry(e, 1) || membership; h.push(e); }
    if (membership) pruneSelection();
    setDirty(true);
    relayout();
    // The only undo path whose caller is a History row click, so the re-render
    // belongs here: `is-future` and `is-cursor` are derived from the stack depth
    // and would otherwise keep describing the pre-travel state.
    renderHistory();
  }

  // Wrap a whole discrete operation. Returns true when it changed something.
  function edit(label, fn) {
    beginTx(label, '');
    fn();
    return commitTx();
  }

  // ==========================================================================
  // 6. geometry
  // ==========================================================================
  const bpm = () => {
    const d = doc();
    const v = d ? Number(d.bpm) : 0;
    return Number.isFinite(v) && v >= 20 && v <= 400 ? v : 120;
  };
  const gridDiv = () => Number($('grid').value) || 16;
  const gridStep = () => (60 / bpm()) * (4 / gridDiv());
  const qStep = () => (60 / bpm()) * (4 / (Number($('q-grid').value) || 16));
  function snapT(t) {
    if (!snapOn) return t;
    const step = gridStep();
    return step > 0 ? Math.round(t / step) * step : t;
  }
  const xForTime = (t) => KEY_W + t * zoom;
  const timeForX = (x) => clamp((x - KEY_W) / zoom, 0, duration);
  const yForPitch = (p) => TOP_H + (pitchHigh - p) * ROW_H;
  const pitchForY = (y) => clamp(pitchHigh - Math.floor((y - TOP_H) / ROW_H), 0, 127);
  const contentW = () => Math.ceil(KEY_W + duration * zoom + 160);
  const contentH = () => TOP_H + (pitchHigh - pitchLow + 1) * ROW_H;

  function calcBounds() {
    if (!notes.length) { pitchLow = 48; pitchHigh = 96; return; }
    let lo = 127, hi = 0;
    for (let i = 0; i < notes.length; i++) {
      const p = notes[i].pitch;
      if (p < lo) lo = p;
      if (p > hi) hi = p;
    }
    pitchLow = clamp(lo - 3, 0, 72);
    pitchHigh = clamp(hi + 3, pitchLow + 35, 127);
  }

  function widenDuration() {
    ensureExtent();
    const d = doc();
    const own = Math.max(Number(d && d.duration) || 0, maxEnd, 0.1);
    if (d) d.duration = own;
    // Widened, never shrunk within a session: the source audio may run past the
    // last note, and deleting the last note should not resize the timeline.
    duration = Math.max(duration, projectDuration, own);
    if (loopB <= loopA) { loopA = 0; loopB = duration; }
  }

  // ==========================================================================
  // 7. draw scheduling
  // ==========================================================================
  const rollCanvas = $('roll'), waveCanvas = $('wave'), autoCanvas = $('auto');
  const rollScroll = $('roll-scroll'), rollExtent = $('roll-extent');
  const waveHost = $('wave-host'), autoHost = $('auto-host');
  const waveLayer = new Draw.LayerCache({ alpha: false });

  const rollH = Draw.register({ key: 'review:roll', el: rollScroll, draw: drawRoll });
  const waveH = Draw.register({ key: 'review:wave', el: waveHost, draw: drawWave });
  const autoH = Draw.register({ key: 'review:auto', el: autoHost, draw: drawAuto });
  disposers.push(() => { rollH.dispose(); waveH.dispose(); autoH.dispose(); waveLayer.dispose(); });

  // ---- live drawing --------------------------------------------------------
  //
  // draw.js gives a consumer that has not said it is animating a 250ms idle
  // clamp, so the Editor's canvases repainted FOUR TIMES A SECOND during a
  // scroll, a zoom, a marquee or a note drag -- measured at 4.0 fps at every
  // document size, against 27-30 fps during playback, which was the only path
  // that called setLive. The picture was a quarter of a second behind the hand
  // for the whole gesture. Player, Forge and Audition already do this.
  //
  // A REFCOUNT, not a flag: playback and a gesture overlap constantly (scrubbing
  // while a song plays), and whichever finished first used to be able to drop
  // the other back to 4 fps. Nothing here changes the frame BUDGET -- the user's
  // data-drawms, the game raise, the unfocused clamp and the playback floor all
  // still apply exactly as before; this only stops the Editor asking for less
  // than the budget it already has.
  let liveRefs = 0;
  function liveOn() {
    if (++liveRefs === 1) { rollH.setLive(true); waveH.setLive(true); autoH.setLive(true); }
  }
  function liveOff() {
    if (liveRefs > 0 && --liveRefs === 0) { rollH.setLive(false); waveH.setLive(false); autoH.setLive(false); }
  }
  // A discrete gesture -- a wheel tick, a scroll event, a slider input -- has no
  // release to hang the reference off, so it holds one for a short window that
  // each new event extends. One timer, one reference, so a burst that overlaps
  // another cannot leave the roll live forever.
  let burstHeld = false, burstTimer = 0;
  function liveBurst() {
    if (!burstHeld) { burstHeld = true; liveOn(); }
    if (burstTimer) clearTimeout(burstTimer);
    burstTimer = setTimeout(() => { burstTimer = 0; burstHeld = false; liveOff(); }, 220);
  }
  disposers.push(() => {
    if (burstTimer) clearTimeout(burstTimer);
    burstTimer = 0;
    burstHeld = false;
    liveRefs = 0;
  });

  function paint() { rollH.invalidate(); autoH.invalidate(); }
  function paintAll() { rollH.invalidate(); autoH.invalidate(); waveH.invalidate(); }
  function bumpNotes() { notesVersion++; waveLayer.invalidate(); }

  // The expensive path: bounds + extent + content width changed. Everything
  // that only changes pixels calls paint() instead. Today's editor ran this on
  // every velocity change, delete, nudge and transpose.
  function relayout() {
    if (!loaded()) { paintAll(); syncSelection(); return; }
    ensureSorted();
    calcBounds();
    widenDuration();
    const w = contentW(), h = contentH();
    rollExtent.style.width = w + 'px';
    rollExtent.style.height = h + 'px';
    bumpNotes();
    paintAll();
    // Every structural edit path funnels through here, so the readouts, the note
    // fields and the gating are refreshed in ONE place: a dblclick-added note, a
    // paste, a delete, an undo and a take switch all change the selection, and
    // each of them used to leave the inspector showing the previous one.
    syncSelection();
    syncHeadMeta();
    reportTransport(true);
  }
  const relayoutSoon = coalesce(relayout);

  function drawRoll() {
    const host = rollScroll;
    const vw = host.clientWidth, vh = host.clientHeight;
    if (vw < 4 || vh < 4) return;
    const fit = Draw.fitCanvas(rollCanvas, vw, vh);
    const ctx = fit.ctx, w = fit.w, h = fit.h;
    ensureSorted();

    const ox = sx, oy = sy;
    const fromTime = Math.max(0, (ox + KEY_W - KEY_W) / zoom - 0.001);
    const toTime = (ox + w) / zoom;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, w, h);

    // ---- pitch row bands ---------------------------------------------------
    const firstRow = Math.max(0, Math.floor((oy - TOP_H) / ROW_H));
    const rows = pitchHigh - pitchLow + 1;
    const lastRow = Math.min(rows - 1, Math.ceil((oy + h - TOP_H) / ROW_H));
    for (let r = firstRow; r <= lastRow; r++) {
      const p = pitchHigh - r;
      const y = TOP_H + r * ROW_H - oy;
      const black = p % 12 === 1 || p % 12 === 3 || p % 12 === 6 || p % 12 === 8 || p % 12 === 10;
      ctx.fillStyle = black ? C.rowBlack : C.rowWhite;
      ctx.fillRect(KEY_W, y, w - KEY_W, ROW_H);
      if (p % 12 === 0) {
        ctx.fillStyle = C.rowLine;
        ctx.fillRect(KEY_W, y + ROW_H - 1, w - KEY_W, 1);
      }
    }

    // ---- everything that must not paint over the pinned strips -------------
    ctx.save();
    ctx.beginPath();
    ctx.rect(KEY_W, TOP_H, Math.max(0, w - KEY_W), Math.max(0, h - TOP_H));
    ctx.clip();

    // grid: subdivisions, beats, bars. Bounds hoisted out of the loop.
    const beat = 60 / bpm();
    const sub = beat * (4 / gridDiv());
    if (sub * zoom >= 3) {
      const stop = Math.min(duration + sub, toTime + sub);
      const startIndex = Math.max(0, Math.floor(fromTime / sub));
      let subIndex = startIndex;
      const perBeat = Math.max(1, Math.round(beat / sub));
      const perBar = perBeat * 4;
      for (let t = startIndex * sub; t <= stop; t += sub, subIndex++) {
        const x = Math.round(xForTime(t) - ox) + 0.5;
        if (x < KEY_W) continue;
        if (x > w) break;
        const isBar = subIndex % perBar === 0;
        const isBeat = subIndex % perBeat === 0;
        ctx.fillStyle = isBar ? C.gridBar : isBeat ? C.gridBeat : C.gridSub;
        ctx.fillRect(x, TOP_H, 1, h - TOP_H);
      }
    }

    // notes: only the ones that overlap the window (see forOverlapping)
    const y0 = TOP_H, y1 = h;
    forOverlapping(fromTime, toTime, (n) => {
      const ok = audible(n.channel);
      const y = yForPitch(n.pitch) - oy + 1;
      if (y + ROW_H < y0 || y > y1) return;
      const left = xForTime(n.start) - ox;
      const right = xForTime(n.end) - ox;
      const width = Math.max(2, right - left);
      const state = selected.has(n.id) ? 1 : (sounding.has(n.pitch) && ok ? 2 : 0);
      ctx.globalAlpha = ok ? 1 : 0.22;
      ctx.fillStyle = shadesFor(n.channel, state)[shadeIdx(n.velocity)];
      ctx.fillRect(left, y, width, ROW_H - 2);
      if (width > 3) {
        ctx.strokeStyle = C.noteStroke;
        ctx.lineWidth = 1;
        ctx.strokeRect(Math.round(left) + 0.5, Math.round(y) + 0.5, Math.round(width) - 1, ROW_H - 3);
      }
      // the resize grip tick, so the proportional edge zone is discoverable
      if (width > 14) {
        ctx.fillStyle = state === 1 ? C.gripSel : C.gripPlain;
        ctx.fillRect(left + width - 3, y + 1, 2, ROW_H - 4);
      }
      if (n.unterminated) {
        ctx.fillStyle = C.warn;
        ctx.fillRect(left + width - 1, y, 1, ROW_H - 2);
      }
      ctx.globalAlpha = 1;
    });

    // marquee (kept in content space, converted back here)
    if (marquee && marquee.moved) {
      const x0 = Math.min(marquee.x0, marquee.x1) - ox, x1 = Math.max(marquee.x0, marquee.x1) - ox;
      const my0 = Math.min(marquee.y0, marquee.y1) - oy, my1 = Math.max(marquee.y0, marquee.y1) - oy;
      ctx.fillStyle = C.marqFill;
      ctx.fillRect(x0, my0, x1 - x0, my1 - my0);
      ctx.strokeStyle = C.marqEdge;
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(x0) + 0.5, Math.round(my0) + 0.5, Math.round(x1 - x0), Math.round(my1 - my0));
    }

    // loop range shading
    if (loopOn && loopB > loopA) {
      const lx0 = xForTime(loopA) - ox, lx1 = xForTime(loopB) - ox;
      ctx.fillStyle = C.loopFill;
      ctx.fillRect(lx0, TOP_H, lx1 - lx0, h - TOP_H);
    }

    // playhead
    const px = Math.round(xForTime(playhead) - ox) + 0.5;
    if (px >= KEY_W && px <= w) {
      ctx.strokeStyle = C.accent;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px, TOP_H);
      ctx.lineTo(px, h);
      ctx.stroke();
    }
    ctx.restore();

    // ---- the two pinned strips, drawn LAST, outside the clip ---------------
    drawRuler(ctx, w, ox);
    drawKeys(ctx, h, oy);

    // corner block over the ruler/keys join
    ctx.fillStyle = C.surface;
    ctx.fillRect(0, 0, KEY_W, TOP_H);
    ctx.fillStyle = C.line;
    ctx.fillRect(0, TOP_H - 1, KEY_W, 1);
    ctx.fillRect(KEY_W - 1, 0, 1, TOP_H);

    if (followOn && playing) followPlayhead();
  }

  function drawRuler(ctx, w, ox) {
    ctx.fillStyle = C.ruler;
    ctx.fillRect(KEY_W, 0, w - KEY_W, TOP_H);
    ctx.fillStyle = C.line;
    ctx.fillRect(KEY_W, TOP_H - 1, w - KEY_W, 1);
    const beat = 60 / bpm();
    const barSec = beat * 4;
    if (barSec * zoom < 8) return;
    const first = Math.max(0, Math.floor((ox / zoom) / barSec));
    ctx.font = '600 11px ' + C.mono;
    ctx.textBaseline = 'middle';
    for (let bar = first; ; bar++) {
      const t = bar * barSec;
      const x = Math.round(xForTime(t) - ox) + 0.5;
      if (x > w) break;
      if (x >= KEY_W) {
        ctx.fillStyle = C.line2;
        ctx.fillRect(x, 6, 1, TOP_H - 7);
        ctx.fillStyle = C.rulerText;
        ctx.fillText(String(bar + 1), x + 4, TOP_H / 2);
      }
      if (barSec * zoom >= 46) {
        for (let b = 1; b < 4; b++) {
          const bx = Math.round(xForTime(t + b * beat) - ox) + 0.5;
          if (bx >= KEY_W && bx <= w) {
            ctx.fillStyle = C.rowLine;
            ctx.fillRect(bx, TOP_H - 6, 1, 5);
          }
        }
      }
    }
    // playhead head, so the position reads on the ruler too
    const px = Math.round(xForTime(playhead) - ox);
    if (px >= KEY_W - 5 && px <= w + 5) {
      ctx.fillStyle = C.accent;
      ctx.beginPath();
      ctx.moveTo(px - 4, 1);
      ctx.lineTo(px + 4, 1);
      ctx.lineTo(px, 8);
      ctx.closePath();
      ctx.fill();
    }
  }

  // A keyboard, not a column of stubs: every row is a full-width white key and
  // the five black keys of the octave are laid SHORT on top of it, which is the
  // only way the black/white pattern reads as a keyboard at one row per pitch.
  function drawKeys(ctx, h, oy) {
    ctx.fillStyle = C.keyBed;
    ctx.fillRect(0, 0, KEY_W, h);
    const rows = pitchHigh - pitchLow + 1;
    const firstRow = Math.max(0, Math.floor((oy - TOP_H) / ROW_H));
    const lastRow = Math.min(rows - 1, Math.ceil((oy + h - TOP_H) / ROW_H));
    const blackW = Math.round(KEY_W * 0.6);
    ctx.font = '600 11px ' + C.mono;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    for (let r = firstRow; r <= lastRow; r++) {
      const p = pitchHigh - r;
      const y = TOP_H + r * ROW_H - oy;
      const cls = ((p % 12) + 12) % 12;
      const black = cls === 1 || cls === 3 || cls === 6 || cls === 8 || cls === 10;
      const lit = sounding.has(p);
      ctx.fillStyle = lit && !black ? C.accent : C.keyWhite;
      ctx.fillRect(0, y, KEY_W - 1, ROW_H);
      // the seam is drawn only where two white keys really meet: F|E and C|B
      if (cls === 5 || cls === 0) {
        ctx.fillStyle = C.keySeam;
        ctx.fillRect(0, y + ROW_H - 1, KEY_W - 1, 1);
      }
      if (black) {
        ctx.fillStyle = lit ? C.accentDeep : C.keyBlack;
        ctx.fillRect(0, y, blackW, ROW_H - 1);
      } else if (cls === 0) {
        ctx.fillStyle = lit ? C.accentInk : C.keyLabel;
        ctx.fillText(Fmt.note(p), KEY_W - 5, y + ROW_H / 2 + 0.5);
      }
    }
    ctx.textAlign = 'left';
    ctx.fillStyle = C.line;
    ctx.fillRect(KEY_W - 1, 0, 1, h);
  }

  // ---- overview strip -------------------------------------------------------
  let zoomWave = null;
  function waveWindow() {
    if (zoomWave) return { start: zoomWave.start(), span: zoomWave.span() };
    return { start: 0, span: Math.max(1, duration) };
  }
  function drawWave() {
    const vw = waveHost.clientWidth, vh = waveHost.clientHeight;
    if (vw < 4 || vh < 4) return;
    const fit = Draw.fitCanvas(waveCanvas, vw, vh);
    const ctx = fit.ctx, w = fit.w, h = fit.h;
    const win = waveWindow();
    const version = [notesVersion, peaksVersion, win.start.toFixed(3), win.span.toFixed(3),
      duration.toFixed(2), Tokens.themeKey()].join('|');
    waveLayer.paint(w, h, version, (lc, info) => paintWaveStatic(lc, info.w, info.h, win));
    waveLayer.blit(ctx, 0, 0);

    // loop range + playhead are the only per-frame parts
    const xf = (t) => (t - win.start) / win.span * w;
    const whole = loopA <= 0.001 && loopB >= duration - 0.001;
    if (loopB > loopA && !(whole && !loopOn)) {
      const a = xf(loopA), b = xf(loopB);
      if (loopOn) {
        ctx.fillStyle = C.loopFill;
        ctx.fillRect(a, 0, b - a, h);
      }
      ctx.fillStyle = loopOn ? C.loopEdge : C.rowLine;
      ctx.fillRect(Math.round(a), 0, 1, h);
      ctx.fillRect(Math.round(b) - 1, 0, 1, h);
    }
    const px = Math.round(xf(playhead)) + 0.5;
    if (px >= 0 && px <= w) {
      ctx.strokeStyle = C.accent;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, h);
      ctx.stroke();
    }
  }

  function paintWaveStatic(ctx, w, h, win) {
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, w, h);
    const mid = Math.round(h * 0.46);
    if (peaks && peaks.length) {
      ctx.fillStyle = C.rowLine;
      ctx.fillRect(0, mid, w, 1);
    }

    if (peaks && peaks.length && peaksSpan > 0) {
      const amp = h * 0.4;
      ctx.strokeStyle = C.peak;
      ctx.lineWidth = 1;
      ctx.beginPath();
      const n = peaks.length / 2;
      for (let x = 0; x < w; x++) {
        const t0 = win.start + (x / w) * win.span;
        const t1 = win.start + ((x + 1) / w) * win.span;
        let i0 = Math.floor((t0 / peaksSpan) * n);
        let i1 = Math.ceil((t1 / peaksSpan) * n);
        i0 = clamp(i0, 0, n - 1);
        i1 = clamp(i1, i0 + 1, n);
        let lo = 1, hi = -1;
        for (let i = i0; i < i1; i++) {
          const a = peaks[i * 2], b = peaks[i * 2 + 1];
          if (a < lo) lo = a;
          if (b > hi) hi = b;
        }
        if (hi < lo) continue;
        ctx.moveTo(x + 0.5, mid - hi * amp);
        ctx.lineTo(x + 0.5, mid - lo * amp);
      }
      ctx.stroke();
    }

    // note-onset density map, culled to the window and one rect per column
    ensureSorted();
    const cols = new Float32Array(w);
    const from = win.start, to = win.start + win.span;
    let i = lowerBound(from);
    for (; i < notes.length; i++) {
      const n = notes[i];
      if (n.start > to) break;
      if (!audible(n.channel)) continue;
      const x = Math.floor((n.start - from) / win.span * w);
      if (x >= 0 && x < w) cols[x] += 1;
    }
    let peakCount = 1;
    for (let x = 0; x < w; x++) if (cols[x] > peakCount) peakCount = cols[x];
    const hasAudio = !!(peaks && peaks.length);
    const base = h - 1;
    const maxBar = hasAudio ? Math.max(5, h * 0.30) : Math.max(6, h * 0.62);
    ctx.fillStyle = C.tick;
    for (let x = 0; x < w; x++) {
      if (!cols[x]) continue;
      const bh = Math.max(2, (cols[x] / peakCount) * maxBar);
      ctx.fillRect(x, base - bh, 1, bh);
    }
    if (!peaks && !notes.length) {
      ctx.fillStyle = C.text3;
      ctx.font = '500 12px ' + C.body;
      ctx.textBaseline = 'middle';
      ctx.fillText('No overview yet', 8, h / 2);
    } else if (!peaks) {
      ctx.fillStyle = C.text3;
      ctx.font = '500 12px ' + C.body;
      ctx.textBaseline = 'top';
      ctx.fillText('Note density — no source audio in this project', 8, 6);
    }
  }

  // ---- automation lane ------------------------------------------------------
  // The lane canvas begins where the picker column ends, but the roll's content
  // begins after its keyboard, so everything the lane plots is drawn back by the
  // difference: a velocity stem stands under its own note, and laneApply's
  // read-back adds the same number so the two stay exact inverses.
  const laneOx = () => Math.max(0, autoHost.offsetLeft - rollScroll.offsetLeft);

  function drawAuto() {
    const vw = autoHost.clientWidth, vh = autoHost.clientHeight;
    if (vw < 4 || vh < 4) return;
    const fit = Draw.fitCanvas(autoCanvas, vw, vh);
    const ctx = fit.ctx, w = fit.w, h = fit.h;
    const shift = laneOx();
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, w, h);

    // guide lines at the four velocities everybody reads for. The scale sits
    // BEHIND the bars: the picker owns the gutter the numbers used to have, and
    // a shifted-out gutter would have cost the lane its alignment with the roll.
    ctx.font = '600 11px ' + C.mono;
    ctx.textBaseline = 'middle';
    const span = Math.max(1, h - LANE_PAD);
    const scale = [];
    for (const v of [32, 64, 96, 127]) {
      const y = Math.round(h - (v / 127) * span) - 0.5;
      ctx.fillStyle = C.gridSub;
      ctx.fillRect(0, y, w, 1);
      scale.push([String(v), y]);
    }
    // The picker owns the gutter the scale used to have, and a shifted gutter
    // would have cost the lane its alignment with the roll, so the numbers are
    // drawn LAST, over the bars, with a halo that survives a dense passage.
    const drawScale = () => {
      ctx.lineWidth = 3;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = C.laneHalo;
      ctx.fillStyle = C.laneScale;
      for (const s of scale) { ctx.strokeText(s[0], 5, s[1]); ctx.fillText(s[0], 5, s[1]); }
      ctx.lineWidth = 1;
    };

    if (lane !== 'velocity' || !loaded()) {
      drawScale();
      ctx.fillStyle = C.text3;
      ctx.font = '500 12px ' + C.body;
      ctx.fillText(loaded() ? 'No data in this lane' : '', 34, h / 2);
      return;
    }

    ensureSorted();
    ensureExtent();
    const ox = sx + shift;
    const fromTime = Math.max(0, (ox - KEY_W) / zoom);
    const toTime = (ox + w - KEY_W) / zoom;
    const onlySel = linkOn && selected.size > 0;
    // The lane plots ONSETS, so the plain lower bound is exact here.
    let i = lowerBound(fromTime);
    for (; i < notes.length; i++) {
      const n = notes[i];
      if (n.start > toTime) break;
      if (!audible(n.channel)) continue;
      const x = Math.round(xForTime(n.start) - ox);
      if (x < -8 || x > w) continue;
      const sel = selected.has(n.id);
      if (onlySel && !sel) { ctx.globalAlpha = 0.22; } else { ctx.globalAlpha = 1; }
      const bh = (n.velocity / 127) * span;
      const wSt = Math.max(2, Math.min(4, zoom * (n.end - n.start)));
      ctx.fillStyle = sel ? C.accent : shadesFor(n.channel, 0)[shadeIdx(n.velocity)];
      ctx.fillRect(x, h - bh, wSt, bh);
      ctx.fillRect(x - 1, h - bh - 2, wSt + 2, 3);
      ctx.globalAlpha = 1;
    }
    drawScale();
    // playhead
    const px = Math.round(xForTime(playhead) - ox) + 0.5;
    if (px >= 0 && px <= w) {
      ctx.strokeStyle = C.accent;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, h);
      ctx.stroke();
    }
  }

  // ==========================================================================
  // 8. scroll, resize, follow
  // ==========================================================================
  const onScroll = coalesce(() => {
    sx = rollScroll.scrollLeft;
    sy = rollScroll.scrollTop;
    liveBurst();                        // a scroll is an animation, not an idle view
    paint();
  });
  onEl(rollScroll, 'scroll', onScroll, { passive: true });

  function followPlayhead(force) {
    if (!loaded()) return;
    if (!force && !followOn) return;
    const x = xForTime(playhead);
    const view = rollScroll.clientWidth;
    if (x < sx + KEY_W + 24 || x > sx + view - 60) {
      const next = clamp(x - view * 0.35, 0, Math.max(0, contentW() - view));
      if (Math.abs(next - sx) > 1) { sx = next; rollScroll.scrollLeft = next; }
    }
    if (zoomWave) zoomWave.follow(playhead);
  }

  const onResize = coalesce(() => { relayout(); });
  // resize.js dispatches a window resize when a divider is committed, so this is
  // also the collapse/divider path: the cached canvas rect has to go, or the next
  // right-click hit-tests against the viewport origin the roll used to have.
  onEl(window, 'resize', () => { rollRect = null; onResize(); });

  // Coming back on screen: re-measure and repaint, or a divider dragged while we
  // were parked leaves a stale canvas until the next playhead pixel change.
  onEl(window, 'midi-studio:onscreen', () => { rollRect = null; relayout(); });
  // Density is handled on ONE channel: the bus (the Bus.on(T.UI_DENSITY)
  // registration in section 23). The shell fires `midi-studio:density` into this
  // frame AND sends `ui:density`, and answering both ran a full relayout twice per
  // toggle. The bus is the half kept, because it is the only one the shell replays
  // on frame:ready and `data-density` is stamped onto our root AFTER our scripts
  // have run - a frame that booted under compact learns about it no other way.
  // Tokens keeps its own `midi-studio:*` listeners regardless.
  disposers.push(Tokens.onChange(() => { readTokens(); bumpNotes(); paintAll(); }));

  // ==========================================================================
  // 9. audio preview  (shared/audio.js does not exist yet — see the return note)
  // ==========================================================================
  function ctx() {
    if (!ctxAudio) {
      ctxAudio = new AudioContext();
      master = ctxAudio.createGain();
      master.gain.value = volume;
      master.connect(ctxAudio.destination);
    }
    return ctxAudio;
  }
  function ensureSamples() {
    if (!soundfonts || sampledReady) return samplePrepare || Promise.resolve(sampledReady);
    if (samplePrepare) return samplePrepare;
    const d = doc();
    if (!d) return Promise.resolve(false);
    const set = new Set();
    for (let i = 0; i < notes.length; i++) set.add(notes[i].pitch);
    const pitches = set.size ? [...set] : [60];
    samplePrepare = soundfonts.prepare(ctx(), INSTRUMENT, pitches)
      .then(() => { sampledReady = true; return true; })
      .catch(() => false)
      .finally(() => { samplePrepare = null; });
    return samplePrepare;
  }
  // `at` is an AudioContext timestamp; 0 means "right now".
  function playNote(n, at, force) {
    if (!force && !midiOn) return;
    if (!audible(n.channel)) return;
    const c = ctx();
    const when = at || c.currentTime;
    const len = clamp((n.end - n.start) / rate, 0.05, 4);
    if (sampledReady && soundfonts) {
      const src = soundfonts.play(c, INSTRUMENT, n.pitch, when, len, n.velocity, master);
      if (src) { markSounding(n.pitch, len, (when - c.currentTime) * 1000); return; }
    } else ensureSamples();
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = 'triangle';
    osc.frequency.value = 440 * Math.pow(2, (n.pitch - 69) / 12);
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime((n.velocity / 127) * 0.12, when + 0.008);
    g.gain.exponentialRampToValueAtTime(0.001, when + Math.max(0.05, len));
    osc.connect(g).connect(master || c.destination);
    osc.start(when);
    osc.stop(when + len + 0.02);
    osc.onended = () => { try { g.disconnect(); } catch (_) { /* already gone */ } };
    markSounding(n.pitch, len, (when - c.currentTime) * 1000);
  }
  // The lookahead scheduler hands notes to Web Audio up to LOOKAHEAD ahead, so
  // the highlight has to be timed too or the roll lights up before you hear it.
  const timers = new Set();
  const offAt = new Map();
  function later(fn, ms) {
    const t = setTimeout(() => { timers.delete(t); fn(); }, Math.max(0, ms));
    timers.add(t);
    return t;
  }
  function markSounding(pitch, len, delayMs) {
    const on = () => {
      sounding.add(pitch);
      const prev = offAt.get(pitch);
      if (prev) { clearTimeout(prev); timers.delete(prev); }
      offAt.set(pitch, later(() => { sounding.delete(pitch); offAt.delete(pitch); paint(); },
        Math.min(1200, Math.max(90, len * 1000))));
      paint();
    };
    if (delayMs > 8) later(on, delayMs); else on();
  }
  function clearSounding() {
    timers.forEach((t) => clearTimeout(t));
    timers.clear();
    offAt.clear();
    sounding.clear();
  }
  disposers.push(clearSounding);

  // ==========================================================================
  // 10. peaks (decode + min/max buckets; shared/peaks.js does not exist yet)
  // ==========================================================================
  async function loadPeaks() {
    peaks = null;
    peaksSpan = 0;
    peaksVersion++;
    const source = project && (project.sourceAudio || project.previewAudio);
    $('t-audio').disabled = !source;
    if (!source) {
      audio.removeAttribute('src');
      audioOn = false;
      $('t-audio').setAttribute('aria-checked', 'false');
      bumpNotes();
      paintAll();
      return;
    }
    audio.src = R.fileUrl ? R.fileUrl(source) : source;
    audioOn = true;
    $('t-audio').setAttribute('aria-checked', 'true');
    try {
      const res = await fetch(audio.src);
      const buf = await ctx().decodeAudioData(await res.arrayBuffer());
      const timingEnd = Number(project.timing && project.timing.end);
      const available = Math.max(0, buf.duration - audioOffset);
      projectDuration = Number.isFinite(timingEnd)
        ? Math.max(duration, timingEnd - audioOffset)
        : Math.max(duration, available);
      const ch = buf.getChannelData(0);
      const startSample = Math.floor(audioOffset * buf.sampleRate);
      const endSample = Math.min(ch.length, Math.ceil((audioOffset + projectDuration) * buf.sampleRate));
      const span = Math.max(1, endSample - startSample);
      const stride = Math.max(1, Math.floor(span / PEAK_BUCKETS));
      const out = new Float32Array(PEAK_BUCKETS * 2);
      let bucket = 0;
      for (let i = startSample; i < endSample && bucket < PEAK_BUCKETS; i += stride, bucket++) {
        let lo = 1, hi = -1;
        const stop = Math.min(endSample, i + stride);
        for (let s = i; s < stop; s++) {
          const v = ch[s];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        out[bucket * 2] = lo > hi ? 0 : lo;
        out[bucket * 2 + 1] = hi < lo ? 0 : hi;
      }
      peaks = out.subarray(0, bucket * 2);
      peaksSpan = projectDuration > 0 ? projectDuration : 1;
      peaksVersion++;
      relayout();
    } catch (_) {
      say('Original audio is unavailable; the MIDI preview still works.', 'warn');
      $('t-audio').disabled = true;
      audioOn = false;
      $('t-audio').setAttribute('aria-checked', 'false');
      paintAll();
    }
  }

  // ==========================================================================
  // 11. playback
  // ==========================================================================
  const usingAudio = () => audioOn && !!audio.src && !$('t-audio').disabled;
  let clockBase = 0, songBase = 0;

  function songTime() {
    if (!playing) return playhead;
    if (usingAudio() && !audio.paused) return Math.max(0, audio.currentTime - audioOffset);
    return songBase + (ctx().currentTime - clockBase) * rate;
  }
  function boundary() { return loopOn && loopB > loopA ? loopB : duration; }

  function seek(t, fromTransport) {
    playhead = clamp(t, 0, Math.max(0, duration));
    songBase = playhead;
    if (ctxAudio) clockBase = ctxAudio.currentTime;
    cursor = lowerBound(playhead);
    schedTo = playhead;
    if (usingAudio()) { try { audio.currentTime = audioOffset + playhead; } catch (_) { /* not seekable yet */ } }
    followPlayhead(!fromTransport);
    updateClock();
    paintAll();
    reportTransport(true);
  }

  function scheduleAhead() {
    const now = songTime();
    const upto = Math.min(boundary(), now + LOOKAHEAD);
    if (upto <= schedTo) return;
    ensureSorted();
    const c = ctx();
    const cNow = c.currentTime;
    if (cursor > notes.length) cursor = notes.length;
    while (cursor < notes.length && notes[cursor].start <= upto) {
      const n = notes[cursor++];
      if (n.start <= schedTo) continue;
      const at = cNow + Math.max(0, (n.start - now) / rate);
      playNote(n, at, false);
    }
    schedTo = upto;
  }

  function clockTick() {
    if (!playing) return;
    const now = songTime();
    const b = boundary();
    if (now >= b - 0.001) {
      if (loopOn && loopB > loopA) {
        seek(loopA, true);
        if (usingAudio()) audio.play().catch(() => {});
      } else { stopPlayback(); return; }
    } else {
      playhead = now;
      scheduleAhead();
    }
    updateClock();
    paintAll();
    if ((reportTick++ % 2) === 0) reportTransport(false);
  }

  async function startPlayback() {
    if (!loaded() || playing) return;
    claimTransport();
    if (playhead >= duration - 0.01) seek(loopOn ? loopA : 0, true);
    playing = true;
    ensureSamples();
    const c = ctx();
    try { await c.resume(); } catch (_) { /* already running */ }
    clockBase = c.currentTime;
    songBase = playhead;
    cursor = lowerBound(playhead);
    schedTo = playhead;
    if (usingAudio()) {
      audio.playbackRate = rate;
      try { audio.currentTime = audioOffset + playhead; } catch (_) { /* not ready */ }
      audio.play().catch(() => {});
    }
    clearInterval(clockTimer);
    clockTimer = setInterval(clockTick, CLOCK_MS);
    liveOn();                          // released by pausePlayback()
    reportTransport(true);
    syncUi();
  }
  function pausePlayback() {
    if (!playing) return;
    playhead = songTime();
    playing = false;
    clearInterval(clockTimer);
    clockTimer = 0;
    audio.pause();
    clearSounding();
    liveOff();                         // taken by startPlayback()
    reportTransport(true);
    paintAll();
    syncUi();
  }
  function stopPlayback() {
    pausePlayback();
    seek(0, true);
    reportTransport(true);
  }

  // ==========================================================================
  // 12. transport ownership
  // ==========================================================================
  function buildCaps() {
    caps = { seek: true, rate: true, loop: true, queue: false, volume,
      sub: candidate ? candidate + ' take' : '', notes: notes.length };
    if (!loaded()) caps.blockedWhy = 'No file';
    return caps;
  }
  const impl = {
    play: () => { startPlayback(); },
    pause: () => pausePlayback(),
    stop: () => stopPlayback(),
    toggle: () => { if (playing) pausePlayback(); else startPlayback(); },
    seek: (s) => seek(Number(s) || 0, true),
    rate: (r) => setRate(Number(r) || 1),
    setLoop: (l) => {
      if (l && Number.isFinite(l.a) && Number.isFinite(l.b) && l.b > l.a) {
        loopA = clamp(l.a, 0, duration); loopB = clamp(l.b, 0, duration); loopOn = true;
      } else loopOn = false;
      syncUi(); paintAll(); reportTransport(true);
    },
    position: () => (playing ? songTime() : playhead),
    park: () => {
      pausePlayback();
      ownTransport = null;
      syncUi();
    }
  };
  function claimTransport() {
    if (!loaded()) return;
    if (ownTransport && Transport.isOwner('editor')) return;
    ownTransport = Transport.claim('editor', impl, buildCaps());
    reportTransport(true);
  }
  function maybeClaim() {
    if (!loaded()) return;
    const s = Transport.state();
    // never yank the bar out from under a panel that is actually making sound
    if (s.owner && s.owner !== 'editor' && (s.status === 'playing' || s.status === 'counting')) return;
    claimTransport();
  }
  function reportTransport(force) {
    if (!ownTransport || !Transport.isOwner('editor')) return;
    ownTransport.update({
      status: playing ? 'playing' : (loaded() ? (playhead > 0 ? 'paused' : 'idle') : 'blocked'),
      position: playing ? songTime() : playhead,
      duration,
      rate,
      loop: loopOn && loopB > loopA ? { a: loopA, b: loopB } : null,
      label: (project && project.name) || (doc() && doc().name) || 'Untitled',
      dirty,
      caps: buildCaps()
    });
    if (force) { /* an edge, sent out of cadence */ }
  }
  function setRate(r) {
    rate = clamp(r, 0.25, 4);
    if (playing) {
      songBase = songTime();
      if (ctxAudio) clockBase = ctxAudio.currentTime;
      if (usingAudio()) audio.playbackRate = rate;
    }
    reportTransport(true);
  }
  function setVolume(v) {
    volume = clamp(Number(v) || 0, 0, 1);
    if (master) master.gain.value = volume;
    audio.volume = volume;
    reportTransport(true);
  }

  // ==========================================================================
  // 13. status, dirty, busy
  // ==========================================================================
  const STATUS = { ready: ['Ready', ''], loading: ['Loading', ''], saving: ['Saving', ''],
    saved: ['Saved', 'ok'], unsaved: ['Unsaved', 'warn'], failed: ['Failed', 'err'],
    exported: ['Exported', 'ok'], empty: ['No file', ''] };
  function setStatus(key) {
    const s = STATUS[key] || STATUS.ready;
    $('status-txt').textContent = s[0];
    const pill = $('status-pill');
    pill.className = 'pill' + (s[1] ? ' is-' + s[1] : '');
    $('status-dot').className = 'dot' + (s[1] === 'ok' ? ' ok' : s[1] === 'warn' ? ' warn' : s[1] === 'err' ? ' err' : '');
  }
  function say(text, kind) {
    const el = $('detail');
    el.textContent = text || '';
    el.className = 'ed-detail' + (kind === 'err' ? ' is-err' : kind === 'ok' ? ' is-ok' : '');
    if (kind === 'err') Bus.send(T.UI_STATUS, { frame: FRAME, text, severity: 'err' });
  }
  const pushBusy = debounce(() => {
    const name = (project && project.name) || (doc() && doc().name) || 'untitled';
    Bus.send(T.FRAME_BUSY, { frame: FRAME, busy: dirty,
      label: dirty ? name + ' · ' + notes.length + ' notes' : name });
  }, 180);
  function setDirty(v) {
    const next = !!v;
    if (next !== dirty) {
      dirty = next;
      $('dirty-pill').hidden = !dirty;
      setStatus(dirty ? 'unsaved' : (loaded() ? 'saved' : 'empty'));
    }
    pushBusy();
    reportTransport(true);
    syncUi();
  }

  // ==========================================================================
  // 14. open / save / export
  // ==========================================================================
  async function chooseFile() {
    if (!R.pick) return;
    const picked = await R.pick();
    if (picked) openPath(picked);
  }

  // Back to the state the panel boots in. Any branch that drops the open
  // document lands here, or the roll keeps painting a song nobody has open and
  // the header keeps offering to save it.
  function resetToEmpty() {
    pausePlayback();
    projectPath = '';
    project = null;
    documents = {};
    candidate = '';
    setNotes([]);                 // candidate is gone, so this clears notes + byId
    longNotes = [];               // setNotes' no-document path leaves the extent alone
    maxEnd = 0;
    maxShort = 0.5;
    rollExtent.style.width = '';  // relayout() early-returns when nothing is loaded,
    rollExtent.style.height = ''; // so the previous song's scroll range has to go here
    hist = Object.create(null);
    fut = Object.create(null);
    tx = null;
    selected = new Set();
    muted = new Set();
    soloed = new Set();
    tracks = [];
    playhead = 0;
    duration = 0;
    projectDuration = 0;
    audioOffset = 0;
    loopA = 0;
    loopB = 0;
    loopOn = false;
    sampledReady = false;
    sx = 0; sy = 0;
    rollScroll.scrollLeft = 0;
    rollScroll.scrollTop = 0;
    $('proj-name').value = '';
    $('proj-name').disabled = true;
    $('empty').hidden = false;
    syncBpm();
    buildTracks();
    renderSources();
    renderMarkers();
    renderHistory();
    setDirty(false);
    setStatus('empty');
    loadPeaks();                  // project is null, so this takes the no-source path
    relayout();
  }

  // ---- reading a document --------------------------------------------------
  //
  // The Editor used to open a file by asking main to spawn
  // python-engine/midi_document.py, which parsed the MIDI with mido, printed
  // 5MB of JSON, and handed it back over an IPC hop that structured-cloned the
  // whole document and then had contextBridge deep-copy it a second time.
  // Measured on a 50,000-note transcription: 2102ms of python plus 238ms of IPC
  // before a single note could be drawn; 5259ms and 666ms at 120k.
  //
  // Nothing in that pipeline needs to happen outside the frame that is going to
  // hold the document, so the bytes are read straight off disk and parsed here
  // (renderer/shared/midi-parse.js, 25ms at 50k, 69ms at 120k) and the document
  // never crosses a process boundary at all.
  //
  // THE PYTHON LOADER IS STILL THE CONTRACT. It is still the writer, and it is
  // still the reader for anything the JS parser will not swear to: the parser
  // throws on SMPTE divisions, malformed chunks, System Common status bytes and
  // every other construct where it and mido could disagree, and readDocument()
  // falls back automatically. A file that used to open still opens; the worst
  // case is that it opens at the old speed. tools/run-tests.js asserts the two
  // readers agree field for field, note for note, over every fixture.
  const MidiParse = window.MidiParse;

  async function readBytes(p) {
    // review.fileUrl is the preload's pathToFileURL, so a path with spaces,
    // '#' or non-ASCII characters in it survives; the review frame is a
    // file:// document, so this is a same-scheme read and never touches the
    // network.
    const res = await fetch(R.fileUrl(p));
    if (!res.ok) throw new Error('could not read ' + p);
    return new Uint8Array(await res.arrayBuffer());
  }

  // The same envelope electron/main.js loadReviewFile() builds, from the same
  // inputs. Any failure at all throws, and readDocument() then hands the WHOLE
  // file to python rather than half-answering: main skips a project candidate
  // whose file is missing and fails on one that is corrupt, and reproducing that
  // distinction here would be two behaviours to keep in step instead of one.
  async function readDocumentFast(filePath) {
    if (/\.midi?$/i.test(filePath)) {
      const document = MidiParse.parse(await readBytes(filePath), filePath);
      return {
        projectPath: '',
        project: { format: 'midi-studio-project', version: 1, name: MidiParse.stem(filePath),
          sourceAudio: '', selectedCandidate: 'clean', candidates: { clean: filePath } },
        documents: { clean: document },
      };
    }
    const res = await fetch(R.fileUrl(filePath));
    if (!res.ok) throw new Error('could not read ' + filePath);
    const project = JSON.parse(await res.text());
    if (!project || project.format !== 'midi-studio-project' || typeof project.candidates !== 'object'
        || !project.candidates) throw new Error('This is not a MIDI Studio project.');
    const documents = {};
    for (const [name, midiPath] of Object.entries(project.candidates)) {
      documents[name] = MidiParse.parse(await readBytes(midiPath), midiPath);
    }
    if (!Object.keys(documents).length) throw new Error('The project MIDI files could not be found.');
    return { projectPath: filePath, project, documents };
  }

  async function readDocument(filePath) {
    if (MidiParse && R.fileUrl && !Seam.forcePython) {
      try {
        const data = await readDocumentFast(filePath);
        Seam.loadedVia = 'js';
        return { ok: true, data };
      } catch (error) {
        // Not an error the user should see: the python loader is about to try
        // the same file, and it is the one whose verdict counts.
        console.info('[review] renderer parse declined, using the python loader:', error && error.message);
      }
    }
    Seam.loadedVia = 'python';
    return R.load(filePath);
  }

  async function openPath(filePath) {
    if (!filePath) return;
    if (dirty && !window.confirm('Discard unsaved note edits and open another file?')) return;
    setStatus('loading');
    say('Opening ' + Fmt.basename(filePath) + '…');
    const result = await readDocument(filePath);
    if (!result || !result.ok) {
      setStatus('failed');
      say((result && result.error) || 'Could not open that file.', 'err');
      Bus.send(T.UI_TOAST, { severity: 'err', title: 'Editor could not open the file',
        message: (result && result.error) || filePath, key: 'editor-open' });
      return;
    }
    pausePlayback();
    projectPath = result.data.projectPath || '';
    project = result.data.project;
    documents = result.data.documents || {};
    noteSeq = 0;
    for (const d of Object.values(documents)) {
      const arr = d.notes || (d.notes = []);
      for (let i = 0; i < arr.length; i++) if (!arr[i].id) arr[i].id = 'n' + (i + 1);
    }
    if (!Object.keys(documents).length) {
      // The state above is already committed, so this branch cannot just return:
      // it would leave the previous song on the roll with Save, Export and Listen
      // still enabled over a document that is no longer open.
      resetToEmpty();
      setStatus('failed');
      say('That project has no MIDI takes in it.', 'err');
      Bus.send(T.UI_TOAST, { severity: 'err', title: 'Nothing to edit',
        message: Fmt.basename(filePath) + ' has no MIDI takes in it.', key: 'editor-open' });
      return;
    }
    candidate = documents[project.selectedCandidate] ? project.selectedCandidate : Object.keys(documents)[0];
    hist = Object.create(null);
    fut = Object.create(null);
    tx = null;
    selected = new Set();
    muted = new Set();
    soloed = new Set();
    playhead = 0;
    duration = 0;
    projectDuration = 0;
    audioOffset = Math.max(0, Number(project.timing && project.timing.start) || 0);
    setNotes(doc() ? doc().notes : []);
    ensureSorted();
    ensureExtent();
    projectDuration = Math.max(Number(doc() && doc().duration) || 0, maxEnd);
    duration = projectDuration;
    loopA = 0;
    loopB = duration;
    loopOn = false;
    $('proj-name').value = (project.name || (doc() && doc().name) || 'Untitled');
    $('proj-name').disabled = false;
    $('empty').hidden = true;
    syncBpm();
    sampledReady = false;
    buildTracks();
    renderSources();
    renderMarkers();
    renderHistory();
    setDirty(false);
    setStatus('saved');
    say('Opened ' + (projectPath || (doc() && doc().path) || filePath));
    sx = 0; sy = 0;
    rollScroll.scrollLeft = 0;
    rollScroll.scrollTop = 0;
    relayout();
    // AFTER the picture, deliberately. ensureSamples() constructs the
    // AudioContext, which OPENS THE AUDIO DEVICE: 108ms for the first one in the
    // process and 13ms for the first one in each renderer, and it used to sit
    // between the click and the first pixel of the newly opened song -- 65-78%
    // of all the JS on the open path at 2k notes. Nothing about drawing a piano
    // roll needs an audio device. The samples still load, still finish long
    // before a note can be auditioned, and playNote()/startPlayback() both call
    // ensureSamples() themselves if they somehow get there first, so no audio
    // behaviour and no first-note latency changes.
    // Two frames, not later(): the second rAF runs once the first has been
    // composited, and later() enrols its timer in the set clearSounding()
    // cancels, which would silently drop this.
    requestAnimationFrame(() => requestAnimationFrame(() => { ensureSamples(); }));
    maybeClaim();
    await loadPeaks();
  }

  async function saveAll() {
    if (!project || !loaded()) return null;
    if (tx) commitTx();
    setStatus('saving');
    const result = await R.saveProject({ projectPath, project, documents, selectedCandidate: candidate });
    if (!result || !result.ok) {
      if (result && result.canceled) { setStatus(dirty ? 'unsaved' : 'saved'); return null; }
      setStatus('failed');
      say((result && result.error) || 'Save failed.', 'err');
      Bus.send(T.UI_TOAST, { severity: 'err', title: 'Save failed',
        message: (result && result.error) || '', key: 'editor-save' });
      return null;
    }
    projectPath = result.projectPath;
    project = result.project;
    setDirty(false);
    setStatus('saved');
    say('Saved ' + projectPath, 'ok');
    Bus.send(T.LIBRARY_CHANGED, { reason: 'editor-save' });
    renderSources();
    return result;
  }

  async function exportMidi() {
    if (!loaded()) return;
    if (tx) commitTx();
    const result = await R.exportMidi({ name: ((project && project.name) || 'melody') + '_' + candidate, document: doc() });
    if (result && result.ok) { setStatus('exported'); say('Exported ' + result.path, 'ok'); }
    else if (result && !result.canceled) { setStatus('failed'); say(result.error || 'Export failed.', 'err'); }
  }

  function candidateMidi() {
    return (project && project.candidates && project.candidates[candidate]) || '';
  }
  async function listenSelfMidi() {
    if (!loaded()) return;
    if (dirty && !(await saveAll())) return;
    const midiPath = candidateMidi();
    if (!midiPath) { say('Save the project first — this take has no file yet.', 'warn'); return; }
    Bus.send(T.NAV_OPEN_SELFMIDI, { midiPath, projectPath, play: true });
  }
  async function sendToPlayer(play) {
    if (!loaded()) return;
    if ((dirty || !projectPath) && !(await saveAll())) return;
    const midiPath = candidateMidi();
    if (!midiPath) { say('Save the project first — this take has no file yet.', 'warn'); return; }
    Bus.send(T.NAV_OPEN_PLAYER, play ? { midiPath, play: true } : { midiPath });
  }

  // ==========================================================================
  // 15. edit operations
  // ==========================================================================
  // The selection in DOCUMENT ORDER. One velocity commit used to walk the whole
  // note array three separate times for this (setSelectionField, syncNoteFields
  // and selectionStats each called it), so at 120k notes a single slider drag
  // was a chain of 50-73ms long tasks.
  //
  // The memo is keyed on everything that can change the answer and nothing else:
  // the identity of the `selected` Set (every reassignment makes a new one), an
  // explicit counter for the two places that mutate one in place, and the
  // epoch setNotes() bumps when the note array itself is replaced. Notes are
  // mutated in PLACE for a field edit, so the same objects stay correct.
  // The returned array is shared and must be treated as read-only.
  let selCacheSet = null, selCacheVer = -1, selCacheEpoch = -1, selCacheList = null;
  function selectedNotes() {
    if (selCacheList && selCacheSet === selected && selCacheVer === selVersion
        && selCacheEpoch === notesEpoch) return selCacheList;
    const out = [];
    for (let i = 0; i < notes.length; i++) if (selected.has(notes[i].id)) out.push(notes[i]);
    selCacheSet = selected; selCacheVer = selVersion; selCacheEpoch = notesEpoch;
    selCacheList = out;
    return out;
  }
  function targets() { return selected.size ? selectedNotes() : notes.slice(); }
  const plural = (n, one) => n + ' ' + one + (n === 1 ? '' : 's');

  function deleteSelected() {
    if (!selected.size) return;
    const n = selected.size;
    edit('Delete ' + plural(n, 'note'), () => {
      const drop = new Set(selected);
      for (const note of notes) if (drop.has(note.id)) txRemove(note);
      setNotes(notes.filter((note) => !drop.has(note.id)));
      selected = new Set();
    });
    relayout();
    say('Deleted ' + plural(n, 'note'));
  }

  function addNoteAt(t, pitch, len) {
    const start = clamp(snapT(t), 0, Math.max(0, duration - MIN_LEN));
    const note = { id: 'add' + (++noteSeq), pitch: clamp(pitch, 0, 127), start,
      end: Math.max(start + MIN_LEN, start + len), velocity: 96, channel: defaultChannel() };
    setNotes(notes.concat([note]));
    txAdd(note);
    noteMoved(note);
    return note;
  }
  function defaultChannel() {
    if (soloed.size) return [...soloed][0];
    for (const t of tracks) if (!muted.has(t.channel)) return t.channel;
    return 0;
  }

  function transpose(amount) {
    const list = selected.size ? selectedNotes() : [];
    if (!list.length) return;
    beginTx('Transpose ' + plural(list.length, 'note'), 'transpose');
    for (const n of list) { snap(n); n.pitch = clamp(n.pitch + amount, 0, 127); }
    if (list[0]) playNote(list[0], 0, true);
    armGestureCommit();
    calcBounds();
    relayoutSoon();
    syncNoteFields();
  }

  function nudge(dir, fine) {
    const list = selected.size ? selectedNotes() : [];
    if (!list.length) return;
    const step = (fine ? 0.001 : (snapOn ? gridStep() : 0.01)) * dir;
    beginTx('Nudge ' + plural(list.length, 'note'), 'nudge');
    for (const n of list) {
      snap(n);
      const len = n.end - n.start;
      n.start = clamp(n.start + step, 0, Math.max(0, duration - MIN_LEN));
      n.end = n.start + len;
      noteMoved(n);
    }
    armGestureCommit();
    relayoutSoon();
  }

  // One undo entry per key-hold: an OS autorepeat used to push a full document
  // clone per repeat and blow the 80-entry cap in about two seconds.
  function armGestureCommit() {
    if (!txCommit) txCommit = debounce(() => { commitTx(); renderHistory(); syncUi(); }, 420);
    txCommit();
  }
  function flushGesture() {
    if (txCommit && txCommit.pending()) txCommit.flush();
  }

  function applyQuantize() {
    const strength = Number($('q-strength').value) / 100;
    const step = qStep();
    if (!(step > 0)) return;
    const list = targets();
    if (!list.length) return;
    edit('Quantize ' + plural(list.length, 'note'), () => {
      for (const n of list) {
        snap(n);
        const len = Math.max(MIN_LEN, n.end - n.start);
        const snapped = Math.round(n.start / step) * step;
        n.start = Math.max(0, n.start + (snapped - n.start) * strength);
        n.end = n.start + len;
        noteMoved(n);
      }
    });
    relayout();
    say('Quantized ' + plural(list.length, 'note') + ' at ' + Math.round(strength * 100) + '%');
  }

  function humanize() {
    const ms = Number($('q-human').value) || 0;
    if (ms <= 0) return;
    const list = targets();
    if (!list.length) return;
    edit('Humanize ' + plural(list.length, 'note'), () => {
      for (const n of list) {
        snap(n);
        const len = Math.max(MIN_LEN, n.end - n.start);
        n.start = Math.max(0, n.start + (Math.random() * 2 - 1) * ms / 1000);
        n.end = n.start + len;
        n.velocity = clamp(Math.round(n.velocity + (Math.random() * 2 - 1) * Math.min(18, ms)), 1, 127);
        noteMoved(n);
      }
    });
    relayout();
  }

  function removeOverlaps() {
    const list = targets();
    if (!list.length) return;
    const bykey = new Map();
    for (const n of list) {
      const k = n.channel + ':' + n.pitch;
      let a = bykey.get(k);
      if (!a) bykey.set(k, a = []);
      a.push(n);
    }
    let touched = 0;
    edit('Remove overlaps', () => {
      bykey.forEach((arr) => {
        arr.sort((a, b) => a.start - b.start);
        for (let i = 0; i < arr.length - 1; i++) {
          const a = arr[i], b = arr[i + 1];
          if (a.end > b.start - 0.001) {
            snap(a);
            a.end = Math.max(a.start + MIN_LEN, b.start - 0.001);
            touched++;
          }
        }
      });
    });
    relayout();
    say(touched ? 'Clipped ' + plural(touched, 'note') : 'No overlaps found');
  }

  function fixTiming() {
    const step = qStep();
    const list = targets();
    if (!list.length || !(step > 0)) return;
    edit('Fix timing', () => {
      for (const n of list) {
        snap(n);
        const len = Math.max(0.02, n.end - n.start);
        n.start = Math.max(0, Math.round(n.start / step) * step);
        n.end = n.start + Math.max(0.02, len);
        noteMoved(n);
      }
      // close the sub-8ms gaps the rounding leaves behind, per channel+pitch
      const bykey = new Map();
      for (const n of list) {
        const k = n.channel + ':' + n.pitch;
        let a = bykey.get(k);
        if (!a) bykey.set(k, a = []);
        a.push(n);
      }
      bykey.forEach((arr) => {
        arr.sort((a, b) => a.start - b.start);
        for (let i = 0; i < arr.length - 1; i++) {
          const a = arr[i], b = arr[i + 1];
          const gap = b.start - a.end;
          if (gap > 0 && gap < 0.008) { snap(a); a.end = b.start; }
          if (a.end > b.start) { snap(a); a.end = Math.max(a.start + 0.02, b.start); }
        }
      });
    });
    relayout();
    say('Timing fixed on ' + plural(list.length, 'note'));
  }

  function normalizeVelocity() {
    const list = targets();
    if (!list.length) return;
    let hi = 0, lo = 127;
    for (const n of list) { if (n.velocity > hi) hi = n.velocity; if (n.velocity < lo) lo = n.velocity; }
    const factor = hi > 0 ? 112 / hi : 1;
    edit('Normalize velocity', () => {
      for (const n of list) {
        snap(n);
        n.velocity = clamp(Math.round(hi === lo ? 96 : n.velocity * factor), 1, 127);
      }
    });
    paint();
    renderHistory();
    say('Velocities normalized (peak was ' + hi + ')');
  }

  function timeStretch() {
    const pct = Number($('stretch').value) || 100;
    const k = clamp(pct / 100, 0.1, 4);
    const list = targets();
    if (!list.length || Math.abs(k - 1) < 0.0005) return;
    let anchor = Infinity;
    for (const n of list) if (n.start < anchor) anchor = n.start;
    if (!Number.isFinite(anchor)) anchor = 0;
    edit('Time stretch ' + pct + '%', () => {
      for (const n of list) {
        snap(n);
        const len = (n.end - n.start) * k;
        n.start = anchor + (n.start - anchor) * k;
        n.end = n.start + Math.max(MIN_LEN, len);
        noteMoved(n);
      }
    });
    relayout();
  }

  function fitToScale() {
    const set = SCALES[$('scale').value] || SCALES.chromatic;
    const rootPc = Number($('root').value) || 0;
    const list = targets();
    if (!list.length) return;
    edit('Fit to scale', () => {
      for (const n of list) {
        snap(n);
        const pc = ((n.pitch - rootPc) % 12 + 12) % 12;
        if (set.indexOf(pc) >= 0) continue;
        let best = set[0], bestD = 99;
        for (const s of set) {
          const d = Math.min(Math.abs(s - pc), 12 - Math.abs(s - pc));
          if (d < bestD) { bestD = d; best = s; }
        }
        let delta = best - pc;
        if (delta > 6) delta -= 12;
        if (delta < -6) delta += 12;
        n.pitch = clamp(n.pitch + delta, 0, 127);
      }
    });
    calcBounds();
    relayout();
  }

  function copySelected(cut) {
    const list = selectedNotes();
    if (!list.length) return;
    let base = Infinity;
    for (const n of list) if (n.start < base) base = n.start;
    clipboard = list.map((n) => ({ pitch: n.pitch, velocity: n.velocity, channel: n.channel,
      start: n.start - base, length: Math.max(MIN_LEN, n.end - n.start) }));
    say(plural(list.length, 'note') + (cut ? ' cut' : ' copied'));
    if (cut) deleteSelected();
    syncUi();
  }
  function pasteClipboard(at) {
    if (!clipboard.length || !loaded()) return;
    const base = snapT(Number.isFinite(at) ? at : playhead);
    const fresh = [];
    edit('Paste ' + plural(clipboard.length, 'note'), () => {
      for (const c of clipboard) {
        const start = Math.max(0, base + c.start);
        const note = { id: 'add' + (++noteSeq), pitch: c.pitch, velocity: c.velocity, channel: c.channel,
          start, end: start + c.length };
        fresh.push(note);
        txAdd(note);
      }
      setNotes(notes.concat(fresh));
      selected = new Set(fresh.map((n) => n.id));
      extentDirty = true;
    });
    relayout();
    say('Pasted ' + plural(fresh.length, 'note'));
  }
  function duplicateSelection() {
    const list = selectedNotes();
    if (!list.length) return;
    let lo = Infinity, hi = -Infinity;
    for (const n of list) { if (n.start < lo) lo = n.start; if (n.end > hi) hi = n.end; }
    // Duplicate deliberately overwrites the Editor clipboard: it is a copy plus a
    // paste, and pretending otherwise would need a second clipboard.
    copySelected(false);
    pasteClipboard(lo + Math.max(hi - lo, 0.05));
  }

  function setSelectionField(field, value) {
    const list = selectedNotes();
    if (!list.length) return;
    beginTx('Set ' + field, 'field:' + field);
    for (const n of list) {
      snap(n);
      if (field === 'velocity') n.velocity = clamp(Math.round(value), 1, 127);
      else if (field === 'pitch') n.pitch = clamp(Math.round(value), 0, 127);
      else if (field === 'channel') n.channel = clamp(Math.round(value), 0, 15);
      else if (field === 'length') {
        n.end = n.start + Math.max(MIN_LEN, value);
        noteMoved(n);
      }
    }
    if (field === 'pitch' || field === 'channel') { calcBounds(); relayoutSoon(); } else paint();
  }

  // ==========================================================================
  // 16. roll pointer gestures
  // ==========================================================================
  let marquee = null, drag = null, rollRect = null;
  let rollGestureLive = false;          // see liveOn()/liveOff()

  function hitNote(x, y) {
    const t = (x - KEY_W) / zoom;
    let found = null;
    forOverlapping(t, t, (n) => {
      if (!audible(n.channel)) return;
      const left = xForTime(n.start), right = xForTime(n.end);
      if (left > x) return;
      const top = yForPitch(n.pitch);
      if (x <= Math.max(left + 5, right) && y >= top && y <= top + ROW_H) found = n;
    });
    if (!found) return null;
    // Proportional edge zone. A 1/16 note at the default zoom is ~10px wide, and
    // a fixed 8px zone made almost every short note resize instead of move.
    const left = xForTime(found.start), right = xForTime(found.end);
    const width = right - left;
    return { note: found, edge: width > 14 && (right - x) < Math.min(8, width * 0.3) };
  }

  function contentPt(ev) {
    if (!rollRect) rollRect = Draw.measure(rollCanvas);
    return { x: ev.clientX - rollRect.left + sx, y: ev.clientY - rollRect.top + sy };
  }

  onEl(rollCanvas, 'pointerdown', (ev) => {
    rollPointerDown(ev);
    // Whichever branch below started a gesture, it holds the roll live until
    // endPointer() or pointercancel. Taking the reference HERE, from the state
    // the handler left behind, is what makes "every gesture" true by
    // construction instead of by remembering to add a line to each branch.
    if ((marquee || drag) && !rollGestureLive) { rollGestureLive = true; liveOn(); }
  });

  function rollPointerDown(ev) {
    if (!loaded() || ev.button !== 0) return;
    rollCanvas.focus();
    rollRect = Draw.measure(rollCanvas);
    const p = contentPt(ev);
    if (p.x < KEY_W) {                       // key strip: audition the row
      const pitch = pitchForY(p.y);
      playNote({ pitch, velocity: 100, start: 0, end: 0.5, channel: defaultChannel() }, 0, true);
      return;
    }
    if (p.y < TOP_H) { seek(timeForX(p.x)); return; }   // ruler: scrub

    const hit = tool === 'box' ? null : hitNote(p.x, p.y);

    if (tool === 'erase') {
      capture(rollCanvas, ev.pointerId);
      drag = { kind: 'erase', ids: new Set() };
      if (hit) eraseAt(hit.note);
      return;
    }
    if (tool === 'draw' && !hit) {
      const len = snapOn ? gridStep() : Math.max(0.1, 8 / zoom);
      beginTx('Add note', '');
      const note = addNoteAt(timeForX(p.x), pitchForY(p.y), len);
      selected = new Set([note.id]);
      playNote(note, 0, true);
      capture(rollCanvas, ev.pointerId);
      drag = { kind: 'drawlen', note, x: p.x, y: p.y, dirtied: true };
      relayout();
      return;
    }

    if (!hit) {
      if (!ev.shiftKey && !ev.ctrlKey) selected = new Set();
      marquee = { x0: p.x, y0: p.y, x1: p.x, y1: p.y, moved: false, base: new Set(selected) };
      capture(rollCanvas, ev.pointerId);
      paint();
      syncSelection();
      return;
    }

    if (ev.shiftKey || ev.ctrlKey) {
      if (selected.has(hit.note.id)) selected.delete(hit.note.id);
      else { selected.add(hit.note.id); playNote(hit.note, 0, true); }
      selVersion++;                     // in-place: see selectedNotes()
      paint();
      syncSelection();
      return;
    }
    if (!selected.has(hit.note.id)) {
      selected = new Set([hit.note.id]);
      if (!hit.edge) playNote(hit.note, 0, true);
    }
    capture(rollCanvas, ev.pointerId);
    drag = { kind: hit.edge ? 'resize' : 'move', x: p.x, y: p.y, dirtied: false,
      originals: selectedNotes().map((n) => ({ n, start: n.start, end: n.end, pitch: n.pitch })) };
    paint();
    syncSelection();
  }

  function eraseAt(note) {
    if (!note || (drag && drag.ids.has(note.id))) return;
    if (!tx) beginTx('Erase notes', 'erase');
    drag.ids.add(note.id);
    txRemove(note);
    setNotes(notes.filter((n) => n.id !== note.id));
    selected.delete(note.id);
    selVersion++;                       // in-place: see selectedNotes()
    relayoutSoon();
  }

  onEl(rollCanvas, 'pointermove', (ev) => {
    if (!loaded()) return;
    if (!marquee && !drag) return;
    const p = contentPt(ev);
    if (marquee) {
      marquee.x1 = p.x;
      marquee.y1 = p.y;
      if (!marquee.moved && (Math.abs(p.x - marquee.x0) > 4 || Math.abs(p.y - marquee.y0) > 4)) marquee.moved = true;
      if (marquee.moved) {
        const t0 = timeForX(Math.min(marquee.x0, marquee.x1));
        const t1 = timeForX(Math.max(marquee.x0, marquee.x1));
        const p0 = pitchForY(Math.max(marquee.y0, marquee.y1));
        const p1 = pitchForY(Math.min(marquee.y0, marquee.y1));
        const next = new Set(marquee.base);
        forOverlapping(t0, t1, (n) => {
          if (!audible(n.channel)) return;
          if (n.pitch >= p0 && n.pitch <= p1) next.add(n.id);
        });
        selected = next;
        syncSelection();
      }
      paint();
      return;
    }
    if (drag.kind === 'erase') {
      const hit = hitNote(p.x, p.y);
      if (hit) eraseAt(hit.note);
      return;
    }
    if (drag.kind === 'drawlen') {
      const n = drag.note;
      snap(n);
      const t = Math.max(n.start + MIN_LEN, snapT(timeForX(p.x)));
      n.end = t;
      noteMoved(n);
      paint();
      return;
    }
    // the undo checkpoint is deferred to the first move that can change something
    if (!drag.dirtied && Math.abs(p.x - drag.x) < 2 && Math.abs(p.y - drag.y) < 2) return;
    if (!drag.dirtied) {
      drag.dirtied = true;
      const label = (drag.kind === 'resize' ? 'Resize ' : 'Move ') + plural(drag.originals.length, 'note');
      beginTx(label, '');
      for (const o of drag.originals) snap(o.n);
    }
    const dt = (p.x - drag.x) / zoom;
    const dp = pitchForY(p.y) - pitchForY(drag.y);
    for (const o of drag.originals) {
      const n = o.n;
      if (drag.kind === 'resize') {
        n.end = Math.max(n.start + MIN_LEN, snapT(o.end + dt));
      } else {
        const len = o.end - o.start;
        n.start = clamp(snapT(o.start + dt), 0, Math.max(0, duration - MIN_LEN));
        n.end = n.start + len;
        n.pitch = clamp(o.pitch + dp, 0, 127);
      }
      noteMoved(n);
    }
    paint();
    syncNoteFields();
  });

  function endPointer(ev) {
    // One release for every gesture shape below, taken in pointerdown.
    if (rollGestureLive) { rollGestureLive = false; liveOff(); }
    if (marquee) {
      const m = marquee;
      marquee = null;
      rollRect = null;
      if (!m.moved) seek(timeForX(m.x1));
      paint();
      syncSelection();
      return;
    }
    if (!drag) return;
    const d = drag;
    drag = null;
    rollRect = null;
    if (d.kind === 'erase' || d.kind === 'drawlen') {
      commitTx();
      relayout();
      renderHistory();
      return;
    }
    let changed = false;
    if (d.dirtied) {
      for (const o of d.originals) {
        if (o.n.start !== o.start || o.n.end !== o.end || o.n.pitch !== o.pitch) { changed = true; break; }
      }
    }
    if (!changed) { abortTx(); syncUi(); paint(); return; }
    if (d.kind === 'move' && d.originals.length && d.originals[0].n.pitch !== d.originals[0].pitch) {
      playNote(d.originals[0].n, 0, true);
    }
    commitTx();
    relayout();
    renderHistory();
  }
  onEl(rollCanvas, 'pointerup', endPointer);
  onEl(rollCanvas, 'pointercancel', (ev) => {
    // A cancelled gesture never reaches endPointer, and a live reference that is
    // never released is the one way this could keep asking for frames at rest.
    if (rollGestureLive) { rollGestureLive = false; liveOff(); }
    if (drag && drag.dirtied) abortTx();
    marquee = null; drag = null; rollRect = null; paint();
  });

  onEl(rollCanvas, 'dblclick', (ev) => {
    if (!loaded() || tool === 'erase') return;
    rollRect = Draw.measure(rollCanvas);   // outside the gesture that fills it
    const p = contentPt(ev);
    if (p.x < KEY_W || p.y < TOP_H) return;
    const len = snapOn ? gridStep() : (60 / bpm()) / 4;
    edit('Add note', () => {
      const note = addNoteAt(timeForX(p.x), pitchForY(p.y), len);
      selected = new Set([note.id]);
      playNote(note, 0, true);
    });
    relayout();
    renderHistory();
  });

  onEl(rollCanvas, 'contextmenu', (ev) => {
    if (!loaded()) return;
    ev.preventDefault();
    rollRect = Draw.measure(rollCanvas);   // pointerdown returns early on button 2
    const p = contentPt(ev);
    const hit = hitNote(p.x, p.y);
    if (hit && !selected.has(hit.note.id)) { selected = new Set([hit.note.id]); paint(); syncSelection(); }
    const has = selected.size > 0;
    Menu.open([
      { group: has ? plural(selected.size, 'note') + ' selected' : 'Piano roll' },
      { label: 'Cut', key: 'Ctrl+X', disabled: !has, run: () => copySelected(true) },
      { label: 'Copy', key: 'Ctrl+C', disabled: !has, run: () => copySelected(false) },
      { label: 'Paste at playhead', key: 'Ctrl+V', disabled: !clipboard.length, run: () => pasteClipboard(playhead) },
      { label: 'Duplicate', key: 'Ctrl+D', disabled: !has, run: duplicateSelection },
      { sep: true },
      { label: 'Quantize', disabled: !loaded(), run: applyQuantize },
      { label: 'Remove overlaps', disabled: !loaded(), run: removeOverlaps },
      { sep: true },
      { label: 'Set loop to selection', disabled: !has, run: loopToSelection },
      { label: 'Select all', key: 'Ctrl+A', run: selectAll },
      { sep: true },
      { label: 'Delete', key: 'Del', danger: true, disabled: !has, run: deleteSelected }
    ], { x: ev.clientX, y: ev.clientY, ariaLabel: 'Piano roll actions', returnFocusTo: rollCanvas });
  });

  // pointer-anchored wheel zoom
  onEl(rollScroll, 'wheel', (ev) => {
    if (!loaded()) return;
    if (ev.ctrlKey || ev.altKey || ev.metaKey) {
      ev.preventDefault();
      liveBurst();
      const rect = Draw.measure(rollScroll);
      const cx = ev.clientX - rect.left;
      const anchor = timeForX(cx + sx);
      setZoom(zoom * Math.exp(-ev.deltaY * 0.0016), anchor, cx);
      return;
    }
    if (ev.shiftKey && ev.deltaY) {
      ev.preventDefault();
      rollScroll.scrollLeft += ev.deltaY;
    }
  }, { passive: false });

  function setZoom(next, anchorTime, anchorX) {
    const lo = Number($('zoom').min), hi = Number($('zoom').max);
    const z = clamp(next, lo, hi);
    if (Math.abs(z - zoom) < 0.01) return;
    zoom = z;
    $('zoom').value = String(Math.round(z));
    $('zoom').style.setProperty('--p', String((z - lo) / (hi - lo)));
    // geometry only: no canvas backing store is touched by a zoom change
    ensureSorted();
    widenDuration();
    rollExtent.style.width = contentW() + 'px';
    if (Number.isFinite(anchorTime) && Number.isFinite(anchorX)) {
      const target = clamp(xForTime(anchorTime) - anchorX, 0, Math.max(0, contentW() - rollScroll.clientWidth));
      sx = target;
      rollScroll.scrollLeft = target;
    }
    paint();
  }
  function zoomFit() {
    const view = Math.max(120, rollScroll.clientWidth - KEY_W - 40);
    if (duration > 0) setZoom(view / duration, 0, 0);
    sx = 0;
    rollScroll.scrollLeft = 0;
    paint();
  }

  // ==========================================================================
  // 17. overview strip gestures (the range widget; shared/range.js is missing)
  // ==========================================================================
  zoomWave = window.TimelineZoom(waveHost, () => duration, coalesce(() => waveH.invalidate()));
  let waveDrag = null, waveRect = null;
  const waveTime = (clientX) => {
    if (!waveRect) waveRect = Draw.measure(waveHost);
    const w = Math.max(1, waveRect.w);
    const win = waveWindow();
    return clamp(win.start + ((clientX - waveRect.left) / w) * win.span, 0, duration);
  };
  const waveX = (t) => {
    const win = waveWindow();
    return (t - win.start) / win.span * Math.max(1, waveRect ? waveRect.w : 1);
  };

  onEl(waveHost, 'pointerdown', (ev) => {
    if (!loaded() || ev.button !== 0) return;
    waveRect = Draw.measure(waveHost);
    const t = waveTime(ev.clientX);
    const x = ev.clientX - waveRect.left;
    // proportional edge grab on the existing range, same rule as a note
    let mode = 'new';
    if (loopB > loopA) {
      const a = waveX(loopA), b = waveX(loopB), width = b - a;
      const zone = Math.min(8, Math.max(3, width * 0.3));
      if (Math.abs(x - a) <= zone) mode = 'a';
      else if (Math.abs(x - b) <= zone) mode = 'b';
    }
    waveDrag = { mode, x0: x, t0: t, moved: false, a: loopA, b: loopB };
    capture(waveHost, ev.pointerId);
    liveOn();                           // released by pointerup / pointercancel
  });
  onEl(waveHost, 'pointermove', (ev) => {
    if (!waveDrag) return;
    const t = waveTime(ev.clientX);
    const x = ev.clientX - waveRect.left;
    if (!waveDrag.moved && Math.abs(x - waveDrag.x0) < 3) return;
    waveDrag.moved = true;
    if (waveDrag.mode === 'a') { loopA = Math.min(t, waveDrag.b - 0.01); loopB = waveDrag.b; }
    else if (waveDrag.mode === 'b') { loopB = Math.max(t, waveDrag.a + 0.01); loopA = waveDrag.a; }
    else { loopA = Math.min(waveDrag.t0, t); loopB = Math.max(waveDrag.t0, t); }
    loopOn = true;
    setLoopUi();
    waveH.invalidate();
    paint();
  });
  onEl(waveHost, 'pointerup', (ev) => {
    if (!waveDrag) return;
    liveOff();
    const d = waveDrag;
    waveDrag = null;
    waveRect = null;
    if (!d.moved) seek(d.t0);
    else { reportTransport(true); say('Loop ' + Fmt.clock(loopA, { ms: true }) + ' → ' + Fmt.clock(loopB, { ms: true })); }
    syncUi();
  });
  onEl(waveHost, 'pointercancel', () => { if (waveDrag) liveOff(); waveDrag = null; waveRect = null; });
  onEl(waveHost, 'keydown', (ev) => {
    if (!loaded()) return;
    const step = ev.shiftKey ? 1 : 0.05;
    if (ev.key === 'ArrowLeft') { ev.preventDefault(); seek(playhead - step); }
    else if (ev.key === 'ArrowRight') { ev.preventDefault(); seek(playhead + step); }
  });
  waveHost.tabIndex = 0;
  waveHost.setAttribute('role', 'slider');
  waveHost.setAttribute('aria-label', 'Playback position and loop range');

  function loopToSelection() {
    const list = selectedNotes();
    if (!list.length) return;
    let lo = Infinity, hi = -Infinity;
    for (const n of list) { if (n.start < lo) lo = n.start; if (n.end > hi) hi = n.end; }
    loopA = Math.max(0, lo);
    loopB = Math.min(duration, hi);
    loopOn = true;
    setLoopUi();
    paintAll();
    reportTransport(true);
  }
  function setLoopUi() {
    $('range-readout').textContent = Fmt.clock(loopA, { ms: true }) + ' / ' + Fmt.clock(loopB, { ms: true });
    const b = $('t-loop');
    b.setAttribute('aria-pressed', loopOn ? 'true' : 'false');
  }

  // ==========================================================================
  // 18. automation lane gestures
  // ==========================================================================
  let autoDrag = false, autoRect = null;
  function laneApply(ev) {
    if (lane !== 'velocity' || !loaded()) return;
    // The CANVAS, not the host: .ed-auto .canvas-host carries a 1px top border, so
    // the host's border box is one pixel taller than the surface drawAuto plots on
    // and its origin is one pixel above it.
    if (!autoRect) autoRect = Draw.measure(autoCanvas);
    // + laneOx(): the exact inverse of the shift drawAuto plots with
    const x = ev.clientX - autoRect.left + sx + laneOx();
    const y = ev.clientY - autoRect.top;
    const h = Math.max(1, autoRect.h);
    // The exact inverse of drawAuto: the bar grows upward from y = h across
    // `span`, so the read-back divides by that same span, not by a different one.
    const span = Math.max(1, h - LANE_PAD);
    const vel = clamp(Math.round(((h - y) / span) * 127), 1, 127);
    const t = timeForX(x);
    const onlySel = linkOn && selected.size > 0;
    const window = Math.max(0.01, 4 / zoom);
    ensureSorted();
    let i = lowerBound(t - window);
    let hits = 0;
    for (; i < notes.length; i++) {
      const n = notes[i];
      if (n.start > t + window) break;
      if (!audible(n.channel)) continue;
      if (onlySel && !selected.has(n.id)) continue;
      if (n.start >= t - window && n.start <= t + window) {
        if (!tx) beginTx('Set velocity', 'lane');
        snap(n);
        n.velocity = vel;
        hits++;
      }
    }
    if (hits) { paint(); syncNoteFields(); }
  }
  onEl(autoHost, 'pointerdown', (ev) => {
    if (ev.button !== 0 || !loaded()) return;
    autoDrag = true;
    autoRect = Draw.measure(autoCanvas);
    capture(autoHost, ev.pointerId);
    liveOn();                           // released by pointerup / pointercancel
    laneApply(ev);
  });
  onEl(autoHost, 'pointermove', (ev) => { if (autoDrag) laneApply(ev); });
  onEl(autoHost, 'pointerup', () => {
    if (!autoDrag) return;
    liveOff();
    autoDrag = false;
    autoRect = null;
    commitTx();
    renderHistory();
    syncUi();
  });
  onEl(autoHost, 'pointercancel', () => { if (autoDrag) liveOff(); autoDrag = false; autoRect = null; abortTx(); });

  // ==========================================================================
  // 19. left panel: tracks + markers
  // ==========================================================================
  function buildTracks() {
    const counts = new Map();
    for (let i = 0; i < notes.length; i++) {
      const ch = notes[i].channel | 0;
      counts.set(ch, (counts.get(ch) || 0) + 1);
    }
    const programs = (doc() && doc().programs) || {};
    tracks = [...counts.keys()].sort((a, b) => a - b).map((ch) => {
      const prog = Number(programs[ch] !== undefined ? programs[ch] : programs[String(ch)]);
      const name = ch === 9 ? 'Drums' : (Number.isFinite(prog) ? GM[clamp(prog, 0, 127)] : 'Channel ' + (ch + 1));
      return { channel: ch, count: counts.get(ch), name, program: Number.isFinite(prog) ? prog : null };
    });
    chanShades.clear();
    renderTracks();
  }

  function renderTracks() {
    const host = $('tracks');
    host.textContent = '';
    $('tracks-count').textContent = String(tracks.length);
    // The tab's accessible name is an aria-label (it has to survive the rail
    // collapse), which overrides the .count badge -- so the number goes in it too.
    $('tab-tracks').setAttribute('aria-label', 'Tracks (' + tracks.length + ')');
    $('tracks-empty').hidden = tracks.length > 0;
    for (const t of tracks) {
      const row = document.createElement('div');
      row.className = 'lrow is-lg trk-row' +
        (muted.has(t.channel) || (soloed.size && !soloed.has(t.channel)) ? ' is-muted' : '');
      row.setAttribute('role', 'listitem');
      const hue = TRACK_HUES[t.channel % TRACK_HUES.length];
      row.innerHTML =
        '<span class="trk-swatch" style="--trk:' + hue + '" aria-hidden="true"></span>' +
        '<span class="lrow-main"><span class="lrow-name"></span><span class="lrow-sub"></span></span>' +
        '<span class="lrow-actions">' +
        '<button class="trk-btn is-mute" data-act="m" aria-pressed="false" title="Mute">M</button>' +
        '<button class="trk-btn" data-act="s" aria-pressed="false" title="Solo">S</button></span>';
      row.querySelector('.lrow-name').textContent = t.name;
      // The note count is the line the reference puts under the name; the patch
      // number is the part that does not survive a 248px rail, so it moves to the
      // row title rather than being clipped out of existence.
      row.querySelector('.lrow-sub').textContent =
        t.count.toLocaleString() + ' notes · Ch ' + (t.channel + 1);
      row.title = t.name + ' · channel ' + (t.channel + 1) +
        (t.program !== null ? ' · program ' + (t.program + 1) : '') +
        ' · ' + t.count.toLocaleString() + ' notes';
      const m = row.querySelector('[data-act="m"]');
      const s = row.querySelector('[data-act="s"]');
      m.setAttribute('aria-pressed', muted.has(t.channel) ? 'true' : 'false');
      m.setAttribute('aria-label', 'Mute ' + t.name);
      s.setAttribute('aria-pressed', soloed.has(t.channel) ? 'true' : 'false');
      s.setAttribute('aria-label', 'Solo ' + t.name);
      m.addEventListener('click', () => { toggleSet(muted, t.channel); afterTrackChange(); });
      s.addEventListener('click', () => { toggleSet(soloed, t.channel); afterTrackChange(); });
      row.addEventListener('click', (ev) => {
        if (ev.target.closest('.trk-btn')) return;
        selectChannel(t.channel, ev.shiftKey);
      });
      host.appendChild(row);
    }
  }
  function toggleSet(set, v) { if (set.has(v)) set.delete(v); else set.add(v); }
  function afterTrackChange() {
    // mute/solo filter rendering AND triggering: notes on a silenced channel are
    // dimmed, excluded from hit-testing and selection, and never scheduled.
    selected = new Set([...selected].filter((id) => { const n = byId.get(id); return n && audible(n.channel); }));
    renderTracks();
    bumpNotes();
    paintAll();
    syncSelection();
  }
  function selectChannel(ch, add) {
    const next = add ? new Set(selected) : new Set();
    for (const n of notes) if (n.channel === ch && audible(ch)) next.add(n.id);
    selected = next;
    paint();
    syncSelection();
    say(plural(selected.size, 'note') + ' selected on channel ' + (ch + 1));
  }

  function renderMarkers() {
    const host = $('markers');
    host.textContent = '';
    if (!loaded()) return;
    const rows = [
      { name: 'Take start', t: 0 },
      { name: 'Loop start', t: loopA },
      { name: 'Loop end', t: loopB },
      { name: 'Take end', t: duration }
    ];
    for (const r of rows) {
      const el = document.createElement('button');
      el.className = 'lrow';
      el.type = 'button';
      el.innerHTML = '<span class="lrow-main"><span class="lrow-name"></span></span><span class="lrow-meta"></span>';
      el.querySelector('.lrow-name').textContent = r.name;
      el.querySelector('.lrow-meta').textContent = Fmt.clock(r.t, { ms: true });
      el.setAttribute('aria-label', r.name + ' at ' + Fmt.clock(r.t, { ms: true }));
      el.addEventListener('click', () => seek(r.t));
      host.appendChild(el);
    }
  }

  // ==========================================================================
  // 20. right panel: sources, selection, history
  // ==========================================================================
  function renderSources() {
    const host = $('src-list');
    host.textContent = '';
    const names = Object.keys(documents);
    for (const name of names) {
      const d = documents[name];
      const row = document.createElement('button');
      row.className = 'lrow is-lg src-row' + (name === candidate ? ' is-selected' : '');
      row.type = 'button';
      row.setAttribute('aria-pressed', name === candidate ? 'true' : 'false');
      row.innerHTML = '<span class="lrow-main"><span class="lrow-name"></span>' +
        '<span class="lrow-sub"></span></span><span class="src-badges"></span>';
      row.querySelector('.lrow-name').textContent = name.charAt(0).toUpperCase() + name.slice(1);
      const sub = row.querySelector('.lrow-sub');
      sub.textContent = (d.notes ? d.notes.length : 0).toLocaleString() + ' notes · ' +
        Fmt.duration(Number(d.duration) || 0);
      // the inspector narrows to 232px: the line that gets clipped keeps its text
      sub.title = sub.textContent;
      const badges = row.querySelector('.src-badges');
      const mk = (text, cls) => {
        const s = document.createElement('span');
        s.className = 'tag' + (cls ? ' ' + cls : '');
        s.textContent = text;
        badges.appendChild(s);
      };
      if (name === candidate) mk('Open', 'is-accent');
      if (d.bpmEstimated) mk('BPM guess', 'is-warn');
      if ((hist[name] || []).length) mk((hist[name] || []).length + ' edits');
      if (!(project && project.candidates && project.candidates[name])) mk('Unsaved', 'is-warn');
      row.setAttribute('aria-label', name + ' take, ' + (d.notes ? d.notes.length : 0) + ' notes');
      row.addEventListener('click', () => switchCandidate(name));
      host.appendChild(row);
    }
    syncHeadMeta();
  }

  // The one line under the document name: what this document is, how big it is
  // and which take is open. It replaces the uppercase source chip that used to
  // sit beside the name and the pipeline footer's worth of the same facts.
  function syncHeadMeta() {
    const el = $('head-meta');
    if (!el) return;
    if (!loaded()) { el.textContent = 'MIDI Editor'; return; }
    const parts = ['MIDI Editor', notes.length.toLocaleString() + ' notes',
      Fmt.clock(duration)];
    if (tracks.length) {
      parts.push(tracks.length > 1 ? tracks[0].name + ' (multi-track)' : tracks[0].name);
    }
    const takes = Object.keys(documents);
    if (takes.length > 1) parts.push(candidate.charAt(0).toUpperCase() + candidate.slice(1) + ' take');
    el.textContent = parts.join(' · ');
  }

  function switchCandidate(name) {
    if (!documents[name] || name === candidate) return;
    if (tx) commitTx();
    pausePlayback();
    candidate = name;
    project.selectedCandidate = name;
    selected = new Set();
    playhead = 0;
    setNotes(documents[name].notes);
    ensureSorted();
    ensureExtent();
    duration = Math.max(projectDuration, Number(documents[name].duration) || 0, maxEnd);
    loopA = 0;
    loopB = duration;
    setDirty(dirty);
    syncBpm();
    buildTracks();
    renderSources();
    renderMarkers();
    renderHistory();
    relayout();
    say('Switched to the ' + name + ' take');
  }

  let histList = null;
  function renderHistory() {
    const h = hist[candidate] || [];
    const f = fut[candidate] || [];
    const items = [];
    items.push({ label: 'Opened', at: 0, index: -1, future: false });
    for (let i = 0; i < h.length; i++) items.push({ label: h[i].label, at: h[i].at, index: i, future: false });
    for (let i = f.length - 1; i >= 0; i--) items.push({ label: f[i].label, at: f[i].at, index: h.length + (f.length - i - 1), future: true });
    $('hist-depth').textContent = h.length + ' / ' + HIST_CAP;
    $('hist-scope').textContent = candidate ? candidate.toUpperCase() + ' HISTORY' : 'HISTORY';
    $('hist-empty').hidden = items.length > 1;
    if (!histList) {
      histList = window.VList($('hist-list'), {
        rowHeight: Tokens.num('h-row'),
        ariaLabel: 'Edit history',
        selectable: true,
        key: (it, i) => 'h' + i,
        createRow() {
          const n = document.createElement('div');
          n.className = 'lrow';
          n.innerHTML = '<span class="hist-icon"></span><span class="lrow-main">' +
            '<span class="lrow-name"></span></span><span class="lrow-meta"></span>';
          return n;
        },
        renderRow(node, it) {
          node.classList.toggle('is-future', !!it.future);
          node.classList.toggle('is-cursor', it.index === (hist[candidate] || []).length - 1);
          node.children[0].textContent = it.index < 0 ? '·' : String(it.index + 1);
          node.children[1].children[0].textContent = it.label;
          node.children[2].textContent = it.at ? Fmt.when(it.at) : '';
          node.setAttribute('aria-label', it.label + (it.future ? ' (undone)' : ''));
        },
        onActivate: (it) => travelTo(it.index),
        onClick: (it) => travelTo(it.index)
      });
      disposers.push(() => histList.destroy());
    }
    histList.setItems(items, { keepSelection: false });
  }

  function selectionStats() {
    const list = selectedNotes();
    const out = { count: list.length };
    if (!list.length) return out;
    let lo = Infinity, hi = -Infinity, pl = 127, ph = 0, vl = 127, vh = 1, len = 0;
    const chans = new Map();
    for (const n of list) {
      if (n.start < lo) lo = n.start;
      if (n.end > hi) hi = n.end;
      if (n.pitch < pl) pl = n.pitch;
      if (n.pitch > ph) ph = n.pitch;
      if (n.velocity < vl) vl = n.velocity;
      if (n.velocity > vh) vh = n.velocity;
      len += n.end - n.start;
      chans.set(n.channel, (chans.get(n.channel) || 0) + 1);
    }
    out.from = lo; out.to = hi; out.pitchLow = pl; out.pitchHigh = ph;
    out.velLow = vl; out.velHigh = vh; out.avgLen = len / list.length; out.chans = chans;
    return out;
  }

  function renderSelection() {
    const s = selectionStats();
    const host = $('sel-stats');
    host.textContent = '';
    const add = (k, v) => {
      const el = document.createElement('div');
      el.className = 'stat';
      el.innerHTML = '<span class="stat-k"></span><span class="stat-v"></span>';
      el.children[0].textContent = k;
      el.children[1].textContent = v;
      host.appendChild(el);
    };
    add('Selected', s.count.toLocaleString());
    add('Of', notes.length.toLocaleString());
    if (s.count) {
      add('From', Fmt.clock(s.from, { ms: true }));
      add('To', Fmt.clock(s.to, { ms: true }));
      add('Pitch', Fmt.note(s.pitchLow) + ' – ' + Fmt.note(s.pitchHigh));
      add('Velocity', s.velLow + ' – ' + s.velHigh);
      add('Avg length', Math.round(s.avgLen * 1000) + ' ms');
      add('Channels', String(s.chans.size));
    }
    const ch = $('sel-chans');
    ch.textContent = '';
    if (s.chans) {
      [...s.chans.keys()].sort((a, b) => a - b).forEach((c) => {
        const t = tracks.find((x) => x.channel === c);
        const row = document.createElement('div');
        row.className = 'lrow';
        row.setAttribute('role', 'listitem');
        row.innerHTML = '<span class="trk-swatch" style="--trk:' + TRACK_HUES[c % TRACK_HUES.length] +
          '" aria-hidden="true"></span><span class="lrow-main"><span class="lrow-name"></span></span>' +
          '<span class="lrow-meta"></span>';
        row.querySelector('.lrow-name').textContent = (t ? t.name : 'Channel ' + (c + 1));
        row.querySelector('.lrow-meta').textContent = s.chans.get(c).toLocaleString();
        ch.appendChild(row);
      });
    }
  }

  // ==========================================================================
  // 21. UI sync
  // ==========================================================================
  function syncBpm() {
    const d = doc();
    const el = $('bpm');
    el.disabled = !d;
    if (d) el.value = String(Number(d.bpm) || 120);
    $('bpm-warn-row').hidden = !(d && d.bpmEstimated);
  }

  function syncNoteFields() {
    const list = selectedNotes();
    const on = list.length > 0;
    for (const id of ['n-pitch', 'n-vel', 'n-vel-num', 'n-len', 'n-chan']) $(id).disabled = !on;
    $('n-hint').hidden = on;
    if (!on) {
      $('n-pitch').value = '';
      $('n-pitch-name').textContent = '—';
      $('n-vel-num').value = '';
      $('n-vel-out').textContent = '—';
      $('n-len').value = '';
      return;
    }
    const first = list[0];
    // ONE walk. This used to be four list.every() passes plus two reduce()
    // passes over the same array -- six traversals of a 120k-note selection per
    // commit, on top of the three selectedNotes() scans that fed them. The
    // values are identical; they are just computed together.
    const firstLen = first.end - first.start;
    let uPitch = true, uVel = true, uLen = true, uChan = true, sumVel = 0, sumLen = 0;
    for (let i = 0; i < list.length; i++) {
      const n = list[i], len = n.end - n.start;
      if (n.pitch !== first.pitch) uPitch = false;
      if (n.velocity !== first.velocity) uVel = false;
      if (len !== firstLen) uLen = false;
      if (n.channel !== first.channel) uChan = false;
      sumVel += n.velocity;
      sumLen += len;
    }
    $('n-pitch').value = uPitch ? String(first.pitch) : '';
    $('n-pitch-name').textContent = uPitch ? Fmt.note(first.pitch) : 'mixed';
    const vel = uVel ? first.velocity : Math.round(sumVel / list.length);
    $('n-vel').value = String(vel);
    $('n-vel').style.setProperty('--p', String((vel - 1) / 126));
    $('n-vel-out').textContent = String(vel);
    $('n-vel-num').value = String(vel);
    const len = Math.round((uLen ? firstLen : sumLen / list.length) * 1000);
    $('n-len').value = String(len);
    // uChan is computed for the same reason the original called uniform() here:
    // both branches yield first.channel, so a mixed selection shows the first
    // note's channel. Left exactly as it was.
    $('n-chan').value = String(uChan ? first.channel : first.channel);
  }

  // A marquee drag re-selects on every pointermove. The count is cheap and goes
  // out immediately; the O(selection) statistics, the note fields and the button
  // gating are coalesced into one frame, and the Selection tab is not computed at
  // all while it is hidden.
  const syncHeavy = coalesce(() => {
    syncNoteFields();
    if (!$('p-sel').hidden) renderSelection();
    if (!$('p-markers').hidden) renderMarkers();
  });
  function syncSelection() {
    $('sel-count').textContent = String(selected.size);
    autoH.invalidate();
    // Gating is a few dozen property writes and must land in the SAME task, or a
    // button the user can already see enabled is still disabled for one frame.
    syncUi();
    // The O(selection) statistics and the note fields are the expensive half.
    syncHeavy();
  }

  function syncUi() {
    const on = loaded();
    const has = selected.size > 0;
    const hasHist = (hist[candidate] || []).length > 0;
    const hasFut = (fut[candidate] || []).length > 0;
    const set = (id, dis) => { const el = $(id); if (el) el.disabled = !!dis; };
    ['a-save', 'a-saveplay', 'a-listen', 'zoom', 'grid', 'q-grid', 'q-strength', 'q-human',
      'q-apply', 'stretch', 'scale', 'root', 'x-stretch', 'x-scale', 'bpm', 't-midi', 't-loop',
      'c-human', 'c-overlap', 'c-timing', 'c-normvel', 's-all', 's-invert'].forEach((id) => set(id, !on));
    set('a-forge', !on);
    ['tr-dec', 'tr-val', 'tr-inc', 'tr-oct-down', 'tr-oct-up', 'x-dup', 'c-delete',
      's-copy', 's-cut', 's-none', 'nudge-back', 'nudge-fwd'].forEach((id) => set(id, !has));
    set('s-paste', !on || !clipboard.length);
    set('undo', !hasHist);
    set('redo', !hasFut);
    $('q-scope').textContent = has
      ? 'Applies to the ' + plural(selected.size, 'selected note') + '.'
      : 'Applies to every note — nothing is selected.';
    $('hist-depth').textContent = (hist[candidate] || []).length + ' / ' + HIST_CAP;
    $('lane-note').textContent = laneNote();
    setLoopUi();
    $('t-snap').setAttribute('aria-pressed', snapOn ? 'true' : 'false');
    $('q-snap').setAttribute('aria-checked', snapOn ? 'true' : 'false');
    $('q-snap-txt').textContent = snapOn ? 'On' : 'Off';
    $('t-link').setAttribute('aria-pressed', linkOn ? 'true' : 'false');
    $('t-follow').setAttribute('aria-pressed', followOn ? 'true' : 'false');
    $('t-midi').setAttribute('aria-pressed', midiOn ? 'true' : 'false');
    $('t-audio').setAttribute('aria-checked', audioOn ? 'true' : 'false');
    updateClock();
  }

  function laneNote() {
    if (!loaded()) return '';
    // Short, because it now sits over the lane itself. The long form is the
    // picker's title, on the four buttons the sentence is actually about.
    if (lane === 'velocity') {
      const ccs = countCcs();
      return notes.length.toLocaleString() + ' notes' +
        (ccs ? ' · ' + ccs + ' control changes preserved on save' : '');
    }
    return 'Not captured by transcription yet';
  }
  // Nothing is silently dropped on save: whatever the document carries beyond
  // notes (a future `controls` array included) round-trips untouched, because we
  // mutate notes in place and hand the whole document object back to main.
  function countCcs() {
    let n = 0;
    for (const d of Object.values(documents)) {
      if (Array.isArray(d.controls)) n += d.controls.length;
      else if (Array.isArray(d.cc)) n += d.cc.length;
    }
    return n;
  }

  function updateClock() {
    $('clock').textContent = Fmt.clockPad(playhead, { ms: true }) + ' / ' + Fmt.clockPad(duration, { ms: true });
    waveHost.setAttribute('aria-valuemin', '0');
    waveHost.setAttribute('aria-valuemax', String(Math.round(duration * 1000) / 1000));
    waveHost.setAttribute('aria-valuenow', String(Math.round(playhead * 1000) / 1000));
    waveHost.setAttribute('aria-valuetext', Fmt.clock(playhead, { ms: true }));
  }

  // ==========================================================================
  // 22. controls wiring
  // ==========================================================================
  function tabGroup(strip) {
    const buttons = [...strip.querySelectorAll('[role="tab"]')];
    const show = (btn) => {
      buttons.forEach((b) => {
        const sel = b === btn;
        b.setAttribute('aria-selected', sel ? 'true' : 'false');
        b.tabIndex = sel ? 0 : -1;
        const panel = $(b.dataset.panel);
        if (panel) panel.hidden = !sel;
      });
      onPanelShown(btn.dataset.panel);
    };
    buttons.forEach((b, i) => {
      b.addEventListener('click', () => show(b));
      b.addEventListener('keydown', (ev) => {
        let next = -1;
        if (ev.key === 'ArrowRight') next = (i + 1) % buttons.length;
        else if (ev.key === 'ArrowLeft') next = (i - 1 + buttons.length) % buttons.length;
        else if (ev.key === 'Home') next = 0;
        else if (ev.key === 'End') next = buttons.length - 1;
        if (next < 0) return;
        ev.preventDefault();
        buttons[next].focus();
        show(buttons[next]);
      });
    });
  }
  // A hidden panel has never been measured or filled: build it on the way in.
  // The VList in particular reads clientHeight, which is 0 while [hidden].
  function onPanelShown(id) {
    if (id === 'p-sel') renderSelection();
    else if (id === 'p-markers') renderMarkers();
    else if (id === 'p-hist') {
      renderHistory();
      if (histList) requestAnimationFrame(() => histList.refresh());
    }
  }
  document.querySelectorAll('.tabstrip[role="tablist"]').forEach(tabGroup);

  function radioGroup(host, onPick) {
    const buttons = [...host.querySelectorAll('[role="radio"]')];
    const pick = (btn) => {
      if (btn.disabled) return;
      buttons.forEach((b) => {
        const on = b === btn;
        b.setAttribute('aria-checked', on ? 'true' : 'false');
        b.tabIndex = on ? 0 : -1;
      });
      onPick(btn);
    };
    buttons.forEach((b, i) => {
      b.addEventListener('click', () => pick(b));
      b.addEventListener('keydown', (ev) => {
        let d = 0;
        if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') d = 1;
        else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') d = -1;
        if (!d) return;
        ev.preventDefault();
        let j = i;
        for (let k = 0; k < buttons.length; k++) {
          j = (j + d + buttons.length) % buttons.length;
          if (!buttons[j].disabled) break;
        }
        buttons[j].focus();
        pick(buttons[j]);
      });
    });
    return pick;
  }

  radioGroup($('tool-pick'), (b) => { tool = b.dataset.tool; $('roll-region').dataset.tool = tool; });
  radioGroup($('lane-pick'), (b) => { lane = b.dataset.lane; syncUi(); autoH.invalidate(); });

  // section disclosure
  document.querySelectorAll('.insp-sec-head').forEach((head) => {
    head.addEventListener('click', () => {
      const open = head.getAttribute('aria-expanded') === 'true';
      head.setAttribute('aria-expanded', open ? 'false' : 'true');
      const body = $(head.getAttribute('aria-controls'));
      if (body) body.hidden = open;
    });
  });

  onEl($('empty-open'), 'click', chooseFile);
  onEl($('a-save'), 'click', () => saveAll());
  onEl($('a-saveplay'), 'click', () => sendToPlayer(true));
  onEl($('a-listen'), 'click', listenSelfMidi);
  onEl($('a-forge'), 'click', () => Bus.send(T.NAV_ACTIVATE, { tab: 'forge', focus: true }));
  onEl($('a-more'), 'click', (ev) => {
    Menu.open([
      { label: 'Open file…', key: 'Ctrl+O', icon: 'folder', run: chooseFile },
      { label: 'Export MIDI…', icon: 'send', disabled: !loaded(), run: exportMidi },
      { label: 'Send to MIDI Player', icon: 'send', disabled: !loaded(), run: () => sendToPlayer(false) },
      { sep: true },
      { label: 'Reveal project in Explorer', disabled: !projectPath,
        run: () => Bus.send(T.FILE_REVEAL, { path: projectPath }) },
      { sep: true },
      { label: 'Fit the take on screen', key: 'Ctrl+0', disabled: !loaded(), run: zoomFit },
      { label: 'Reset the overview zoom', disabled: !loaded(), run: () => zoomWave.reset() }
    ], { anchor: $('a-more'), ariaLabel: 'Editor actions' });
  });
  onEl($('ov-reset'), 'click', () => zoomWave.reset());

  onEl($('proj-name'), 'change', () => {
    if (!project) return;
    const el = $('proj-name');
    const clean = String(el.value || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').trim().slice(0, 120);
    if (!clean) { el.value = project.name || 'Untitled'; return; }
    if (clean === project.name) { el.value = clean; return; }
    project.name = clean;
    el.value = clean;
    // The next Save must write NEW files rather than overwriting the ones the old
    // name pointed at.
    project.candidates = {};
    setDirty(true);
    renderSources();
    say('Renamed. Save project or Export MIDI writes under the new name.');
  });

  onEl($('undo'), 'click', () => { flushGesture(); undo(); renderHistory(); });
  onEl($('redo'), 'click', () => { flushGesture(); redo(); renderHistory(); });

  onEl($('z-in'), 'click', () => setZoom(zoom * 1.3, timeForX(sx + rollScroll.clientWidth / 2), rollScroll.clientWidth / 2));
  onEl($('z-out'), 'click', () => setZoom(zoom / 1.3, timeForX(sx + rollScroll.clientWidth / 2), rollScroll.clientWidth / 2));
  onEl($('z-fit'), 'click', zoomFit);
  const zoomPaint = coalesce((v) => setZoom(v, timeForX(sx + rollScroll.clientWidth / 2), rollScroll.clientWidth / 2));
  onEl($('zoom'), 'input', (ev) => { liveBurst(); zoomPaint(Number(ev.target.value)); });

  onEl($('grid'), 'change', () => { $('q-grid').value = $('grid').value; paint(); });
  onEl($('q-grid'), 'change', () => { $('grid').value = $('q-grid').value; paint(); });
  onEl($('t-snap'), 'click', () => { snapOn = !snapOn; syncUi(); });
  onEl($('q-snap'), 'click', () => { snapOn = !snapOn; syncUi(); });
  onEl($('t-link'), 'click', () => { linkOn = !linkOn; syncUi(); autoH.invalidate(); });
  onEl($('t-follow'), 'click', () => { followOn = !followOn; syncUi(); if (followOn) followPlayhead(true); });
  onEl($('t-midi'), 'click', () => { midiOn = !midiOn; syncUi(); });
  onEl($('t-loop'), 'click', () => {
    loopOn = !loopOn;
    if (loopOn && loopB <= loopA) { loopA = 0; loopB = duration; }
    syncUi();
    paintAll();
    reportTransport(true);
  });
  onEl($('t-audio'), 'click', () => {
    if ($('t-audio').disabled) return;
    audioOn = !audioOn;
    $('t-audio').setAttribute('aria-checked', audioOn ? 'true' : 'false');
    if (playing) {
      if (audioOn) {
        try { audio.currentTime = audioOffset + playhead; } catch (_) { /* not ready */ }
        audio.playbackRate = rate;
        audio.play().catch(() => {});
      } else {
        audio.pause();
        songBase = playhead;
        if (ctxAudio) clockBase = ctxAudio.currentTime;
      }
    }
    syncUi();
  });

  onEl($('bpm'), 'change', () => {
    const d = doc();
    if (!d) return false;
    const v = clamp(Number($('bpm').value) || 120, 20, 400);
    const before = { bpm: d.bpm, bpmEstimated: d.bpmEstimated };
    if (before.bpm === v && !d.bpmEstimated) { $('bpm').value = String(v); return; }
    edit('Set tempo ' + v + ' BPM', () => {
      txMeta(before, { bpm: v, bpmEstimated: false });
      applyMeta({ bpm: v, bpmEstimated: false });
    });
    syncBpm();
    relayout();
    renderSources();
    renderHistory();
    say('Tempo set to ' + Fmt.bpm(v) + ' BPM — the grid and Quantize now use it.');
  });

  onEl($('q-apply'), 'click', () => { applyQuantize(); renderHistory(); });
  onEl($('q-strength'), 'input', () => {
    const el = $('q-strength');
    el.style.setProperty('--p', String(Number(el.value) / 100));
    $('q-strength-out').textContent = Math.round(Number(el.value)) + '%';
  });
  onEl($('nudge-back'), 'click', () => { nudge(-1, false); flushGesture(); renderHistory(); });
  onEl($('nudge-fwd'), 'click', () => { nudge(1, false); flushGesture(); renderHistory(); });

  onEl($('tr-dec'), 'click', () => { transpose(-1); flushGesture(); renderHistory(); });
  onEl($('tr-inc'), 'click', () => { transpose(1); flushGesture(); renderHistory(); });
  onEl($('tr-oct-down'), 'click', () => { transpose(-12); flushGesture(); renderHistory(); });
  onEl($('tr-oct-up'), 'click', () => { transpose(12); flushGesture(); renderHistory(); });
  onEl($('tr-val'), 'change', () => {
    const v = clamp(Math.round(Number($('tr-val').value) || 0), -48, 48);
    $('tr-val').value = '0';
    if (v) { transpose(v); flushGesture(); renderHistory(); }
  });
  onEl($('x-stretch'), 'click', () => { timeStretch(); renderHistory(); });
  onEl($('x-scale'), 'click', () => { fitToScale(); renderHistory(); });
  onEl($('x-dup'), 'click', () => { duplicateSelection(); renderHistory(); });

  const velPaint = coalesce((v) => setSelectionField('velocity', v));
  onEl($('n-vel'), 'input', (ev) => {
    const v = Number(ev.target.value);
    ev.target.style.setProperty('--p', String((v - 1) / 126));
    $('n-vel-num').value = String(v);
    velPaint(v);
  });
  onEl($('n-vel'), 'change', (ev) => {
    // change fires in the same task as the last input, well inside the coalesced
    // paint, and a keyboard arrow produces NO input at all: apply here, then
    // close the transaction, or the final value of every drag is lost.
    setSelectionField('velocity', Number(ev.target.value));
    commitTx();
    renderHistory();
    syncUi();
  });
  onEl($('n-vel-num'), 'change', () => {
    const v = clamp(Math.round(Number($('n-vel-num').value) || 96), 1, 127);
    setSelectionField('velocity', v);
    commitTx();
    syncNoteFields();
    renderHistory();
  });
  onEl($('n-pitch'), 'change', () => {
    const v = Number($('n-pitch').value);
    if (!Number.isFinite(v)) return;
    setSelectionField('pitch', v);
    commitTx();
    syncNoteFields();
    renderHistory();
  });
  onEl($('n-len'), 'change', () => {
    const v = Number($('n-len').value);
    if (!Number.isFinite(v) || v <= 0) return;
    setSelectionField('length', v / 1000);
    commitTx();
    relayout();
    renderHistory();
  });
  onEl($('n-chan'), 'change', () => {
    setSelectionField('channel', Number($('n-chan').value) || 0);
    commitTx();
    buildTracks();
    renderHistory();
  });

  onEl($('c-human'), 'click', () => { humanize(); renderHistory(); });
  onEl($('c-overlap'), 'click', () => { removeOverlaps(); renderHistory(); });
  onEl($('c-timing'), 'click', () => { fixTiming(); renderHistory(); });
  onEl($('c-normvel'), 'click', () => { normalizeVelocity(); renderHistory(); });
  onEl($('c-delete'), 'click', () => { deleteSelected(); renderHistory(); });

  function selectAll() {
    const next = new Set();
    for (const n of notes) if (audible(n.channel)) next.add(n.id);
    selected = next;
    paint();
    syncSelection();
  }
  onEl($('s-all'), 'click', selectAll);
  onEl($('s-none'), 'click', () => { selected = new Set(); paint(); syncSelection(); });
  onEl($('s-invert'), 'click', () => {
    const next = new Set();
    for (const n of notes) if (audible(n.channel) && !selected.has(n.id)) next.add(n.id);
    selected = next;
    paint();
    syncSelection();
  });
  onEl($('s-copy'), 'click', () => copySelected(false));
  onEl($('s-cut'), 'click', () => { copySelected(true); renderHistory(); });
  onEl($('s-paste'), 'click', () => { pasteClipboard(playhead); renderHistory(); });

  // populate the two enumerated selects once
  (() => {
    const chan = $('n-chan');
    for (let i = 0; i < 16; i++) {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = 'Channel ' + (i + 1) + (i === 9 ? ' (drums)' : '');
      chan.appendChild(o);
    }
    const root = $('root');
    for (let i = 0; i < 12; i++) {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = PITCH_NAMES[i];
      root.appendChild(o);
    }
  })();

  // ==========================================================================
  // 23. drag and drop
  // ==========================================================================
  let dropDepth = 0;
  const isOurs = (p) => /\.(midstudio\.json|mid|midi)$/i.test(p);
  onEl(window, 'dragover', (ev) => { ev.preventDefault(); });
  onEl(window, 'dragenter', (ev) => { ev.preventDefault(); dropDepth++; $('ed').classList.add('is-over'); });
  onEl(window, 'dragleave', () => { if (--dropDepth <= 0) { dropDepth = 0; $('ed').classList.remove('is-over'); } });
  onEl(window, 'drop', (ev) => {
    ev.preventDefault();
    dropDepth = 0;
    $('ed').classList.remove('is-over');
    const files = [...(ev.dataTransfer ? ev.dataTransfer.files : [])];
    if (!files.length) return;
    const paths = files.map((f) => (R.getDroppedFilePath ? R.getDroppedFilePath(f) : f.name)).filter(Boolean);
    const mine = paths.find(isOurs);
    if (mine) { openPath(mine); return; }
    // not ours: one router decides where a dropped file belongs
    Bus.send(T.FILE_DROPPED, { paths, kind: 'unknown', frame: FRAME });
  });

  // ==========================================================================
  // 24. keyboard
  // ==========================================================================
  const inField = (el) => !!el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' || el.isContentEditable);

  onEl(window, 'keydown', (ev) => {
    if (inField(ev.target)) return;
    const mod = ev.ctrlKey || ev.metaKey;

    if (!mod && !ev.altKey) {
      if (ev.key === ' ') {
        if (spaceTransport && Transport.isOwner('editor')) { ev.preventDefault(); Transport.toggle(); }
        return;
      }
      if (ev.key === 'Home') {
        if (Transport.isOwner('editor')) { ev.preventDefault(); Transport.stop(); }
        return;
      }
      if (ev.key === 'Escape') {
        if (selected.size) { ev.preventDefault(); selected = new Set(); paint(); syncSelection(); }
        return;
      }
      if (ev.key === '1' || ev.key === '2' || ev.key === '3' || ev.key === '4') {
        const b = $('tool-pick').querySelectorAll('[role="radio"]')[Number(ev.key) - 1];
        if (b) { b.click(); b.focus(); }
        return;
      }
      if (ev.key === 's' || ev.key === 'S') { snapOn = !snapOn; syncUi(); return; }
      if (ev.key === 'l' || ev.key === 'L') { linkOn = !linkOn; syncUi(); autoH.invalidate(); return; }
      if (ev.key === 'Delete' || ev.key === 'Backspace') {
        ev.preventDefault();
        deleteSelected();
        renderHistory();
        return;
      }
      if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
        if (!selected.size) return;
        ev.preventDefault();
        transpose((ev.key === 'ArrowUp' ? 1 : -1) * (ev.shiftKey ? 12 : 1));
        return;
      }
      if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
        if (!selected.size) return;
        ev.preventDefault();
        nudge(ev.key === 'ArrowRight' ? 1 : -1, ev.shiftKey);
        return;
      }
    }

    if (!mod) return;
    const k = ev.key.toLowerCase();
    if (k === 'z' && !ev.shiftKey) { ev.preventDefault(); flushGesture(); undo(); renderHistory(); }
    else if ((k === 'z' && ev.shiftKey) || k === 'y') { ev.preventDefault(); flushGesture(); redo(); renderHistory(); }
    else if (k === 'a') { ev.preventDefault(); selectAll(); }
    else if (k === 's') { ev.preventDefault(); saveAll(); }
    else if (k === 'c') { ev.preventDefault(); copySelected(false); }
    else if (k === 'x') { ev.preventDefault(); copySelected(true); renderHistory(); }
    else if (k === 'v') { ev.preventDefault(); pasteClipboard(playhead); renderHistory(); }
    else if (k === 'd') { ev.preventDefault(); duplicateSelection(); renderHistory(); }
    else if (k === 'o') { ev.preventDefault(); chooseFile(); }
    else if (k === '0') { ev.preventDefault(); zoomFit(); }
    else if (k === '=' || k === '+') { ev.preventDefault(); $('z-in').click(); }
    else if (k === '-') { ev.preventDefault(); $('z-out').click(); }
  });
  // one undo entry per key-hold: the transaction closes when the key comes up
  onEl(window, 'keyup', (ev) => {
    if (ev.key.startsWith('Arrow')) flushGesture();
  });

  onEl(window, 'beforeunload', (ev) => {
    if (tx) commitTx();
    if (!dirty) return;
    ev.preventDefault();
    ev.returnValue = '';
  });
  onEl(window, 'pagehide', () => {
    clearInterval(clockTimer);
    for (const fn of disposers) { try { fn(); } catch (_) { /* going away anyway */ } }
    if (ctxAudio) { try { ctxAudio.close(); } catch (_) { /* already closed */ } }
  });

  // ==========================================================================
  // 25. commands, bus, boot
  // ==========================================================================
  Commands.setScope(FRAME);
  const cmds = [
    { id: 'editor.open', label: 'Open a project or MIDI file', keys: 'Ctrl+O', group: 'Editor',
      keywords: 'load file mid midstudio', run: chooseFile },
    { id: 'editor.save', label: 'Save project', keys: 'Ctrl+S', group: 'Editor',
      keywords: 'write disk', enabled: () => loaded(), run: () => saveAll() },
    { id: 'editor.savePlay', label: 'Save & Play in the MIDI Player', group: 'Editor',
      keywords: 'send play roblox', enabled: () => loaded(), run: () => sendToPlayer(true) },
    { id: 'editor.export', label: 'Export edited MIDI', group: 'Editor',
      keywords: 'write mid', enabled: () => loaded(), run: exportMidi },
    { id: 'editor.listen', label: 'Listen', group: 'Editor',
      keywords: 'audition preview hear', enabled: () => loaded(), run: listenSelfMidi },
    { id: 'editor.sendPlayer', label: 'Send to the MIDI Player', group: 'Editor',
      enabled: () => loaded(), run: () => sendToPlayer(false) },
    { id: 'editor.backToForge', label: 'Back to the Forge result', group: 'Editor',
      run: () => Bus.send(T.NAV_ACTIVATE, { tab: 'forge', focus: true }) },
    { id: 'editor.undo', label: 'Undo', keys: 'Ctrl+Z', group: 'Edit',
      enabled: () => (hist[candidate] || []).length > 0, run: () => { flushGesture(); undo(); renderHistory(); } },
    { id: 'editor.redo', label: 'Redo', keys: 'Ctrl+Y', group: 'Edit',
      enabled: () => (fut[candidate] || []).length > 0, run: () => { flushGesture(); redo(); renderHistory(); } },
    { id: 'editor.selectAll', label: 'Select all notes', keys: 'Ctrl+A', group: 'Edit',
      enabled: () => loaded(), run: selectAll },
    { id: 'editor.delete', label: 'Delete the selected notes', keys: 'Del', group: 'Edit',
      danger: true, enabled: () => selected.size > 0, run: () => { deleteSelected(); renderHistory(); } },
    { id: 'editor.copy', label: 'Copy the selection', keys: 'Ctrl+C', group: 'Edit',
      enabled: () => selected.size > 0, run: () => copySelected(false) },
    { id: 'editor.cut', label: 'Cut the selection', keys: 'Ctrl+X', group: 'Edit',
      enabled: () => selected.size > 0, run: () => { copySelected(true); renderHistory(); } },
    { id: 'editor.paste', label: 'Paste at the playhead', keys: 'Ctrl+V', group: 'Edit',
      enabled: () => clipboard.length > 0, run: () => { pasteClipboard(playhead); renderHistory(); } },
    { id: 'editor.duplicate', label: 'Duplicate the selection', keys: 'Ctrl+D', group: 'Edit',
      enabled: () => selected.size > 0, run: () => { duplicateSelection(); renderHistory(); } },
    { id: 'editor.quantize', label: 'Quantize', group: 'Edit',
      enabled: () => loaded(), run: () => { applyQuantize(); renderHistory(); } },
    { id: 'editor.humanize', label: 'Humanize', group: 'Edit',
      enabled: () => loaded(), run: () => { humanize(); renderHistory(); } },
    { id: 'editor.removeOverlaps', label: 'Remove overlapping notes', group: 'Edit',
      enabled: () => loaded(), run: () => { removeOverlaps(); renderHistory(); } },
    { id: 'editor.fixTiming', label: 'Fix timing', group: 'Edit',
      enabled: () => loaded(), run: () => { fixTiming(); renderHistory(); } },
    { id: 'editor.normalizeVelocity', label: 'Normalize velocity', group: 'Edit',
      enabled: () => loaded(), run: () => { normalizeVelocity(); renderHistory(); } },
    { id: 'editor.transposeUp', label: 'Transpose up a semitone', group: 'Transform',
      enabled: () => selected.size > 0, run: () => { transpose(1); flushGesture(); renderHistory(); } },
    { id: 'editor.transposeDown', label: 'Transpose down a semitone', group: 'Transform',
      enabled: () => selected.size > 0, run: () => { transpose(-1); flushGesture(); renderHistory(); } },
    { id: 'editor.octaveUp', label: 'Transpose up an octave', group: 'Transform',
      enabled: () => selected.size > 0, run: () => { transpose(12); flushGesture(); renderHistory(); } },
    { id: 'editor.octaveDown', label: 'Transpose down an octave', group: 'Transform',
      enabled: () => selected.size > 0, run: () => { transpose(-12); flushGesture(); renderHistory(); } },
    { id: 'editor.zoomIn', label: 'Zoom in', group: 'View', run: () => $('z-in').click() },
    { id: 'editor.zoomOut', label: 'Zoom out', group: 'View', run: () => $('z-out').click() },
    { id: 'editor.zoomFit', label: 'Fit the take on screen', keys: 'Ctrl+0', group: 'View', run: zoomFit },
    { id: 'editor.toggleSnap', label: 'Toggle grid snap', keys: 'S', group: 'View',
      run: () => { snapOn = !snapOn; syncUi(); } },
    { id: 'editor.toggleFollow', label: 'Toggle follow playhead', group: 'View',
      run: () => { followOn = !followOn; syncUi(); } },
    { id: 'editor.toggleLoop', label: 'Toggle the loop range', group: 'View',
      enabled: () => loaded(), run: () => $('t-loop').click() },
    { id: 'editor.loopSelection', label: 'Set the loop to the selection', group: 'View',
      enabled: () => selected.size > 0, run: loopToSelection },
    { id: 'editor.volume', label: 'Editor preview volume', group: 'Editor',
      keywords: 'gain loudness', run: (arg) => setVolume(Number(arg)) }
  ];
  disposers.push(Commands.registerAll(cmds));

  disposers.push(Bus.on(T.NAV_OPEN_EDITOR, (p) => {
    if (!p) return;
    const target = p.projectPath || p.midiPath;
    if (target) openPath(target);
  }));
  disposers.push(Bus.on(T.NAV_ACTIVATED, (p) => {
    if (!p || p.tab !== FRAME) return;
    readSpacePref();
    maybeClaim();
    relayout();
    rollCanvas.focus({ preventScroll: true });
  }));
  disposers.push(Bus.on(T.UI_DENSITY, () => {
    ROW_H = document.documentElement.dataset.density === 'compact' ? 12 : 14;
    if (histList) histList.rowHeight(Tokens.num('h-row'));
    relayout();
  }));
  disposers.push(Transport.onChange((snap) => {
    if (snap.owner !== 'editor' && playing) pausePlayback();
    if (snap.owner === 'editor' && Number.isFinite(snap.rate) && snap.rate !== rate) rate = snap.rate;
  }));

  function readSpacePref() {
    if (!window.studio || !window.studio.getUi) return;
    window.studio.getUi().then((ui) => {
      spaceTransport = !ui || ui.spaceTransport !== false;
    }).catch(() => {});
  }

  // Legacy delivery is retired the moment frame:ready lands, but the global is
  // cheap and keeps an older shell working.
  window.openReviewProject = openPath;

  // A test seam, and the only way benchmarks/editor-open-e2e.js and
  // tools/run-tests.js can prove the claim this panel's fast reader rests on:
  // open the SAME file both ways and diff the document the panel ends up
  // holding. `forcePython` also stays as the escape hatch if the renderer parse
  // ever has to be taken out of the loop without a rebuild.
  Seam.snapshot = () => {
    const d = doc();
    return d ? { name: d.name, path: d.path, bpm: d.bpm, bpmEstimated: d.bpmEstimated,
      duration: d.duration, programs: d.programs, notes: d.notes, via: Seam.loadedVia } : null;
  };
  window.__review = Seam;

  // ---- boot ----------------------------------------------------------------
  readTokens();
  ROW_H = document.documentElement.dataset.density === 'compact' ? 12 : 14;
  const z = $('zoom');
  z.style.setProperty('--p', String((zoom - Number(z.min)) / (Number(z.max) - Number(z.min))));
  z.value = String(zoom);
  $('q-strength').style.setProperty('--p', '1');
  setStatus('empty');
  setLoopUi();
  syncUi();
  renderSelection();
  renderHistory();
  readSpacePref();
  if (window.Icon) window.Icon.apply(document);
  if (window.Resize) window.Resize.apply(document);
  paintAll();
  Transport.sync().catch(() => {});
  Bus.send(T.FRAME_READY, { frame: FRAME, title: 'Editor' });
})();

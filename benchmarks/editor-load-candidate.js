// editor-load-candidate.js: is the Editor's open latency mido's fault, or the
// format's? This answers it with a number and a parity check, and CHANGES
// NOTHING in the app.
//
//   node benchmarks/editor-load-candidate.js
//   node benchmarks/editor-load-candidate.js --json benchmarks/editor-load-candidate.json
//
// loadMidiJs() below reproduces python-engine/midi_document.py load_midi's
// entire contract in JS -- merged-track playback order, mid-file tempo changes,
// FIFO note matching, the `unterminated` close-at-end-of-file rule, the
// (start, pitch) stable sort, stable n1..nN ids, `programs`, `duration`, `bpm`
// and the onset-derived `bpmEstimated` guess -- and the harness then diffs its
// output field-for-field against what `midi_document.py load` actually printed
// for the same file. Both the timing and the diff are reported, so the finding
// is "X ms, N fields differ", never "should be faster".
//
// This file is a MEASUREMENT. Nothing in electron/ or renderer/ imports it.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures');
const ENGINE = path.join(ROOT, 'python-engine');
const DOC = path.join(ENGINE, 'midi_document.py');

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const REPS = Number(flag('--reps', '5'));
const ONLY = flag('--only', '');
const JSON_AT = flag('--json', '');

const hr = () => Number(process.hrtime.bigint()) / 1e6;
function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const at = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, mean: s.reduce((a, b) => a + b, 0) / s.length,
    p50: at(0.5), p95: at(0.95), p99: at(0.99), max: s[s.length - 1] };
}
// python's round(x, 6) on a float, closely enough that a mismatch shows up in
// the parity diff rather than being papered over.
const r6 = (x) => Number(x.toFixed(6));

// ---------------------------------------------------------------------------
//  the candidate loader: midi_document.load_midi's contract, in JS
// ---------------------------------------------------------------------------
function loadMidiJs(buf, filePath) {
  if (buf.readUInt32BE(0) !== 0x4d546864) throw new Error('not a MIDI file');
  const headerLen = buf.readUInt32BE(4);
  let p = 8 + headerLen;
  const format = buf.readUInt16BE(8);
  const ntrk = buf.readUInt16BE(10);
  const division = buf.readUInt16BE(12);
  if (format === 2) throw new Error("can't merge tracks in type 2 (asynchronous) file");

  // Per-track absolute ticks, then ONE stable sort by tick over every track
  // concatenated in track order: mido's merge_tracks(), exactly.
  // A message is 4 numbers in flat arrays, so 120k notes cost no objects at all.
  let cap = 1 << 12, len = 0;
  let mTick = new Float64Array(cap), mKind = new Uint8Array(cap);
  let mA = new Int32Array(cap), mB = new Int32Array(cap);
  // kind: 1 note_on, 2 note_off, 3 set_tempo (A=tempo), 4 program_change, 0 other
  const grow = () => {
    cap *= 2;
    const t = new Float64Array(cap); t.set(mTick); mTick = t;
    const k = new Uint8Array(cap); k.set(mKind); mKind = k;
    const a = new Int32Array(cap); a.set(mA); mA = a;
    const b = new Int32Array(cap); b.set(mB); mB = b;
  };
  const push = (tick, kind, a, b) => {
    if (len === cap) grow();
    mTick[len] = tick; mKind[len] = kind; mA[len] = a; mB[len] = b; len++;
  };

  for (let t = 0; t < ntrk; t++) {
    if (buf.readUInt32BE(p) !== 0x4d54726b) throw new Error('bad track header');
    const tlen = buf.readUInt32BE(p + 4);
    p += 8;
    const end = p + tlen;
    let tick = 0, status = 0;
    while (p < end) {
      let v = 0, b8;
      do { b8 = buf[p++]; v = (v << 7) | (b8 & 0x7f); } while (b8 & 0x80);
      tick += v;
      const b0 = buf[p];
      if (b0 & 0x80) { status = b0; p++; }
      const type = status & 0xf0;
      const ch = status & 0x0f;
      if (status === 0xff) {
        const meta = buf[p++];
        let ml = 0, mb;
        do { mb = buf[p++]; ml = (ml << 7) | (mb & 0x7f); } while (mb & 0x80);
        if (meta === 0x51) push(tick, 3, (buf[p] << 16) | (buf[p + 1] << 8) | buf[p + 2], 0);
        p += ml;
      } else if (status === 0xf0 || status === 0xf7) {
        let ml = 0, mb;
        do { mb = buf[p++]; ml = (ml << 7) | (mb & 0x7f); } while (mb & 0x80);
        p += ml;
      } else if (type === 0x90) {
        const pitch = buf[p++], vel = buf[p++];
        push(tick, vel > 0 ? 1 : 2, ch, (pitch << 8) | vel);
      } else if (type === 0x80) {
        const pitch = buf[p++], vel = buf[p++];
        push(tick, 2, ch, (pitch << 8) | vel);
      } else if (type === 0xc0) {
        push(tick, 4, ch, buf[p++]);
      } else if (type === 0xd0) {
        p += 1;
      } else {
        p += 2;
      }
    }
    p = end;
  }

  // Stable sort by absolute tick. An index permutation keeps it allocation-light
  // and keeps the sort stable in the same way python's list.sort() is.
  const order = new Int32Array(len);
  for (let i = 0; i < len; i++) order[i] = i;
  const ord = Array.from(order).sort((a, b) => (mTick[a] - mTick[b]) || (a - b));

  // Playback order, with tempo applied AS IT OCCURS (mido's __iter__).
  let tempo = 500000, foundTempo = false, firstTempo = 500000;
  let timeSec = 0, lastTick = 0;
  const spq = division;
  const notes = [];
  const programs = {};
  // FIFO stack per (channel<<8|pitch), in insertion order, for the leftovers.
  const active = new Map();
  for (let i = 0; i < ord.length; i++) {
    const j = ord[i];
    const dt = mTick[j] - lastTick;
    lastTick = mTick[j];
    if (dt > 0) timeSec += (dt / spq) * (tempo / 1e6);
    const kind = mKind[j];
    if (kind === 3) {
      if (!foundTempo) { firstTempo = mA[j]; foundTempo = true; }
      tempo = mA[j];
    } else if (kind === 4) {
      if (programs[mA[j]] === undefined) programs[mA[j]] = mB[j];
    } else if (kind === 1) {
      const ch = mA[j], pitch = mB[j] >> 8, vel = mB[j] & 0xff;
      const key = (ch << 8) | pitch;
      let q = active.get(key);
      if (!q) { q = []; active.set(key, q); }
      q.push(timeSec, vel);
    } else if (kind === 2) {
      const ch = mA[j], pitch = mB[j] >> 8;
      const key = (ch << 8) | pitch;
      const q = active.get(key);
      if (q && q.length) {
        const start = q.shift(), velocity = q.shift();
        notes.push({ pitch, start: r6(start), end: r6(Math.max(start + 0.01, timeSec)),
          velocity, channel: ch });
      }
    }
  }
  // A note whose note_off never arrived: closed at the end of the file, flagged,
  // never dropped -- in the same insertion order python's dict iteration uses.
  active.forEach((q, key) => {
    const ch = key >> 8, pitch = key & 0xff;
    for (let i = 0; i < q.length; i += 2) {
      notes.push({ pitch, start: r6(q[i]), end: r6(Math.max(q[i] + 0.01, timeSec)),
        velocity: q[i + 1], channel: ch, unterminated: true });
    }
  });

  notes.sort((a, b) => (a.start - b.start) || (a.pitch - b.pitch));
  for (let i = 0; i < notes.length; i++) notes[i].id = 'n' + (i + 1);

  // midi.length is provably the same accumulated total this loop already has:
  // mido computes it by iterating the merged track and summing exactly these
  // deltas. See editor-load.js -- it is measured as its own phase there.
  let maxEnd = timeSec;
  for (let i = 0; i < notes.length; i++) if (notes[i].end > maxEnd) maxEnd = notes[i].end;

  const estimated = !foundTempo;
  let bpm = Math.round((60000000 / firstTempo) * 1000) / 1000;
  if (estimated) bpm = bpmFromOnsets(notes, bpm);

  return { path: path.resolve(filePath), name: path.basename(filePath, path.extname(filePath)),
    bpm, bpmEstimated: estimated, duration: r6(maxEnd), programs, notes };
}

// midi_document._bpm_from_onsets, same rules.
function bpmFromOnsets(notes, fallback) {
  const seen = new Set();
  for (let i = 0; i < notes.length; i++) seen.add(Number(notes[i].start.toFixed(4)));
  const uniq = [...seen].sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < uniq.length; i++) {
    const d = uniq[i] - uniq[i - 1];
    if (d >= 0.02 && d <= 2.0) gaps.push(d);
  }
  if (gaps.length < 6) return fallback;
  gaps.sort((a, b) => a - b);
  let bpm = 60.0 / (gaps[gaps.length >> 1] * 4.0);
  while (bpm < 90.0) bpm *= 2.0;
  while (bpm > 250.0) bpm /= 2.0;
  return Math.round(bpm * 100) / 100;
}

// ---------------------------------------------------------------------------
//  parity: diff against what the shipping loader actually printed
// ---------------------------------------------------------------------------
function diffDocs(py, js) {
  const out = { fields: [], notes: 0, worst: {} };
  for (const k of ['path', 'name', 'bpm', 'bpmEstimated', 'duration']) {
    if (JSON.stringify(py[k]) !== JSON.stringify(js[k])) out.fields.push(k + ': py=' + JSON.stringify(py[k]) + ' js=' + JSON.stringify(js[k]));
  }
  if (JSON.stringify(py.programs) !== JSON.stringify(js.programs)) out.fields.push('programs differ');
  if (py.notes.length !== js.notes.length) {
    out.fields.push('note count py=' + py.notes.length + ' js=' + js.notes.length);
    return out;
  }
  const worst = { start: 0, end: 0 };
  for (let i = 0; i < py.notes.length; i++) {
    const a = py.notes[i], b = js.notes[i];
    let bad = false;
    if (a.id !== b.id || a.pitch !== b.pitch || a.velocity !== b.velocity ||
        a.channel !== b.channel || !!a.unterminated !== !!b.unterminated) bad = true;
    const ds = Math.abs(a.start - b.start), de = Math.abs(a.end - b.end);
    if (ds > worst.start) worst.start = ds;
    if (de > worst.end) worst.end = de;
    if (ds > 1e-6 || de > 1e-6) bad = true;
    if (bad) out.notes++;
  }
  out.worst = worst;
  return out;
}

(function main() {
  const pyExe = [path.join(ENGINE, 'python', 'python.exe'), 'py', 'python'].find((c) => {
    try { return spawnSync(c, ['-c', 'pass'], { timeout: 20000 }).status === 0; } catch (_) { return false; }
  });

  const files = fs.readdirSync(FIXTURES).filter((n) => n.endsWith('.mid'))
    .filter((n) => !ONLY || n === ONLY)
    .sort((a, b) => fs.statSync(path.join(FIXTURES, a)).size - fs.statSync(path.join(FIXTURES, b)).size);

  const out = { at: new Date().toISOString(), files: {} };
  for (const f of files) {
    const full = path.join(FIXTURES, f);
    const buf = fs.readFileSync(full);
    let doc = null;
    const runs = [];
    for (let i = 0; i < REPS; i++) { const t = hr(); doc = loadMidiJs(buf, full); runs.push(hr() - t); }
    const s = stats(runs);

    let parity = null;
    if (pyExe) {
      const r = spawnSync(pyExe, [DOC, 'load', full], { cwd: ENGINE, maxBuffer: 512 * 1024 * 1024,
        windowsHide: true, encoding: 'utf-8', env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' }) });
      if (r.status === 0) { try { parity = diffDocs(JSON.parse(r.stdout.trim()), doc); } catch (e) { parity = { fields: ['parse: ' + e.message], notes: -1 }; } }
    }

    out.files[f] = { notes: doc.notes.length, js_load: s, parity };
    console.log('\n' + f + '  (' + doc.notes.length.toLocaleString() + ' notes)');
    console.log('    js full-contract load   mean ' + s.mean.toFixed(1).padStart(8) + '  p95 ' +
      s.p95.toFixed(1).padStart(8) + '  max ' + s.max.toFixed(1).padStart(8) + ' ms');
    if (parity) {
      const ok = !parity.fields.length && parity.notes === 0;
      console.log('    parity vs midi_document.py: ' + (ok ? 'IDENTICAL' :
        (parity.fields.join('; ') + (parity.notes ? '  |  ' + parity.notes + ' notes differ' : ''))));
      if (parity.worst) console.log('      worst |dt| start ' + parity.worst.start.toExponential(2) +
        '  end ' + parity.worst.end.toExponential(2) + ' s');
    }
  }
  if (JSON_AT) { fs.writeFileSync(JSON_AT, JSON.stringify(out, null, 2)); console.log('\nwrote ' + JSON_AT); }
})();

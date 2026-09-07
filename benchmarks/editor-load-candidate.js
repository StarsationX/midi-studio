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

const loadMidiJs = require('./editor-load-candidate-lib.js');

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

// editor-parse-parity.js: does renderer/shared/midi-parse.js return the SAME
// document python-engine/midi_document.py returns, and how long does each take?
//
//   node benchmarks/editor-parse-parity.js
//   node benchmarks/editor-parse-parity.js --json benchmarks/editor-parse-parity.json
//   node benchmarks/editor-parse-parity.js --dir some/corpus --reps 5
//
// The shared parser is the module the Editor actually ships (not a copy), loaded
// as a plain script. The python side is the real midi_document.py under the real
// bundled interpreter, invoked exactly as electron/main.js invokes it. The diff
// is field by field over every note: id, pitch, start, end, velocity, channel and
// the unterminated flag, plus bpm, bpmEstimated, duration, programs, name, path.
//
// tools/run-tests.js runs the same comparison as assertions; this file is the one
// that reports TIME as well, and can be pointed at a corpus of real files.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ENGINE = path.join(ROOT, 'python-engine');
const DOC = path.join(ENGINE, 'midi_document.py');

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const DIR = path.resolve(flag('--dir', path.join(__dirname, 'fixtures')));
const REPS = Number(flag('--reps', '5'));
const JSON_AT = flag('--json', '');

const MidiParse = require(path.join(ROOT, 'renderer', 'shared', 'midi-parse.js'));

const hr = () => Number(process.hrtime.bigint()) / 1e6;
function stats(s0) {
  const s = [...s0].sort((a, b) => a - b);
  const at = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, mean: s.reduce((a, b) => a + b, 0) / s.length,
    p50: at(0.5), p95: at(0.95), p99: at(0.99), max: s[s.length - 1] };
}

// `programs` key ORDER differs by construction (python dicts keep insertion
// order; a JS object with integer-like keys iterates numerically) and cannot
// matter: save_midi sorts them and review.js looks them up by key. Compare the
// mapping, not the ordering.
function samePrograms(a, b) {
  const ka = Object.keys(a || {}).sort(), kb = Object.keys(b || {}).sort();
  if (ka.length !== kb.length) return false;
  return ka.every((k, i) => kb[i] === k && Number(a[k]) === Number(b[k]));
}

function diff(py, js) {
  const out = [];
  for (const k of ['name', 'bpm', 'bpmEstimated', 'duration', 'path']) {
    if (JSON.stringify(py[k]) !== JSON.stringify(js[k])) {
      out.push(k + ': py=' + JSON.stringify(py[k]) + ' js=' + JSON.stringify(js[k]));
    }
  }
  if (!samePrograms(py.programs, js.programs)) out.push('programs differ');
  if (py.notes.length !== js.notes.length) {
    out.push('note count py=' + py.notes.length + ' js=' + js.notes.length);
    return { fields: out, notes: -1, worst: 0 };
  }
  let bad = 0, worst = 0;
  for (let i = 0; i < py.notes.length; i++) {
    const a = py.notes[i], b = js.notes[i];
    const ds = Math.abs(a.start - b.start), de = Math.abs(a.end - b.end);
    if (ds > worst) worst = ds;
    if (de > worst) worst = de;
    if (a.id !== b.id || a.pitch !== b.pitch || a.velocity !== b.velocity ||
        a.channel !== b.channel || !!a.unterminated !== !!b.unterminated ||
        a.start !== b.start || a.end !== b.end) bad++;
  }
  return { fields: out, notes: bad, worst };
}

(function main() {
  const pyExe = [path.join(ENGINE, 'python', 'python.exe'), 'py', 'python'].find((c) => {
    try { return spawnSync(c, ['-c', 'pass'], { timeout: 20000 }).status === 0; } catch (_) { return false; }
  });
  if (!pyExe) { console.error('no python found; parity cannot be checked'); process.exit(2); }

  const files = fs.readdirSync(DIR).filter((n) => /\.midi?$/i.test(n))
    .sort((a, b) => fs.statSync(path.join(DIR, a)).size - fs.statSync(path.join(DIR, b)).size);

  const out = { at: new Date().toISOString(), dir: DIR, files: {} };
  let failures = 0;
  for (const f of files) {
    const full = path.join(DIR, f);
    const buf = fs.readFileSync(full);
    let doc = null, jsRuns = [], jsErr = null;
    try {
      for (let i = 0; i < REPS; i++) { const t = hr(); doc = MidiParse.parse(buf, full); jsRuns.push(hr() - t); }
    } catch (e) { jsErr = String(e.message || e); }

    const pyRuns = [];
    let pyDoc = null, pyErr = null;
    for (let i = 0; i < Math.min(REPS, 3); i++) {
      const t = hr();
      const r = spawnSync(pyExe, [DOC, 'load', full], { cwd: ENGINE, maxBuffer: 512 * 1024 * 1024,
        windowsHide: true, encoding: 'utf-8', env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' }) });
      pyRuns.push(hr() - t);
      if (r.status !== 0) { pyErr = (r.stderr || '').trim(); break; }
      try { pyDoc = JSON.parse(r.stdout.trim()); } catch (e) { pyErr = 'bad json: ' + e.message; break; }
    }

    const rec = { notes: doc ? doc.notes.length : -1, jsErr, pyErr,
      js: jsRuns.length ? stats(jsRuns) : null, py: pyRuns.length ? stats(pyRuns) : null, parity: null };
    console.log('\n' + f + (doc ? '  (' + doc.notes.length.toLocaleString() + ' notes)' : ''));
    if (rec.js && rec.py) {
      console.log('    js  ' + rec.js.mean.toFixed(1).padStart(8) + ' mean  ' + rec.js.p95.toFixed(1).padStart(8) +
        ' p95  ' + rec.js.max.toFixed(1).padStart(8) + ' max ms');
      console.log('    py  ' + rec.py.mean.toFixed(1).padStart(8) + ' mean  ' + rec.py.p95.toFixed(1).padStart(8) +
        ' p95  ' + rec.py.max.toFixed(1).padStart(8) + ' max ms      (' + (rec.py.mean / rec.js.mean).toFixed(0) + 'x)');
    }
    if (jsErr) { console.log('    js REFUSED: ' + jsErr + '  (the Editor falls back to python for this file)'); }
    if (pyErr) { console.log('    py FAILED: ' + pyErr); }
    if (doc && pyDoc) {
      rec.parity = diff(pyDoc, doc);
      const ok = !rec.parity.fields.length && rec.parity.notes === 0;
      if (!ok) failures++;
      console.log('    parity: ' + (ok ? 'IDENTICAL'
        : rec.parity.fields.join('; ') + (rec.parity.notes ? '  |  ' + rec.parity.notes + ' notes differ' : '')));
    }
    out.files[f] = rec;
  }
  if (JSON_AT) { fs.writeFileSync(JSON_AT, JSON.stringify(out, null, 2)); console.log('\nwrote ' + JSON_AT); }
  console.log('\n' + (failures ? failures + ' file(s) NOT identical' : 'all files identical'));
  process.exit(failures ? 1 : 0);
})();

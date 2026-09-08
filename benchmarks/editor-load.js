// editor-load.js: where the Editor's open latency actually goes.
//
//   node benchmarks/editor-load.js
//   node benchmarks/editor-load.js --json benchmarks/editor-load.json
//   node benchmarks/editor-load.js --reps 5 --only huge-50k.mid
//
// The Editor opens a document through electron/main.js runMidiDocument(), which
// spawns python-engine/midi_document.py, reads its stdout through a pipe and
// JSON.parses the result. This measures every one of those segments separately,
// on the same fixtures benchmarks/bench.js uses, so "1943 ms" stops being one
// number and becomes a list of things that can each be attacked or ruled out:
//
//   interpreter_boot      spawn python -c pass, nothing else
//   import_mido           the import, inside the child
//   MidiFile_parse        mido reading the file into message objects
//   iterate_merge         mido merging tracks and converting ticks -> seconds
//   build_note_dicts      the loader's own note-dict loop
//   sort / assign_ids / midi_length / bpm_from_onsets
//   json_dumps            serialising the document in python
//   spawn_to_first_byte   process start until the first stdout byte reaches us
//   pipe_drain            first stdout byte until the child exits (transfer)
//   json_parse            JSON.parse of the payload in the Node/renderer heap
//
// The in-child phases come from benchmarks/py-load-profile.py, which carries a
// parity check against the shipping loader. If parity is false the numbers are
// printed with a warning instead of being trusted.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures');
const ENGINE = path.join(ROOT, 'python-engine');
const DOC = path.join(ENGINE, 'midi_document.py');
const PROFILE = path.join(__dirname, 'py-load-profile.py');

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const REPS = Number(flag('--reps', '5'));
const ONLY = flag('--only', '');
const JSON_AT = flag('--json', '');

function findPython() {
  const cands = [path.join(ENGINE, 'python', 'python.exe'), 'py', 'python'];
  for (const c of cands) {
    try { if (spawnSync(c, ['-c', 'pass'], { timeout: 20000 }).status === 0) return c; } catch (_) { /* next */ }
  }
  return null;
}

function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const at = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, mean: s.reduce((a, b) => a + b, 0) / s.length,
    p50: at(0.5), p95: at(0.95), p99: at(0.99), max: s[s.length - 1] };
}
const hr = () => Number(process.hrtime.bigint()) / 1e6;

// One real run of exactly what electron/main.js runMidiDocument('load') does,
// with the pipe segmented.
function runLoadOnce(py, file) {
  return new Promise((resolve, reject) => {
    const t0 = hr();
    let firstByte = 0, bytes = 0;
    const chunks = [];
    const child = spawn(py, [DOC, 'load', file], {
      cwd: ENGINE, windowsHide: true,
      env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' }),
    });
    child.stdout.on('data', (d) => {
      if (!firstByte) firstByte = hr();
      bytes += d.length;
      chunks.push(d);
    });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('exit', (code) => {
      const tExit = hr();
      if (code !== 0) { reject(new Error(err.trim() || 'exit ' + code)); return; }
      const text = Buffer.concat(chunks).toString('utf-8');
      const tParse0 = hr();
      const doc = JSON.parse(text.trim());
      const tParse1 = hr();
      resolve({
        total: tParse1 - t0,
        spawn_to_first_byte: firstByte - t0,
        pipe_drain: tExit - firstByte,
        json_parse: tParse1 - tParse0,
        bytes,
        notes: doc.notes.length,
      });
    });
  });
}

(async () => {
  const py = findPython();
  if (!py) { console.error('no python found'); process.exit(1); }

  const files = fs.readdirSync(FIXTURES).filter((n) => n.endsWith('.mid'))
    .filter((n) => !ONLY || n === ONLY)
    .sort((a, b) => fs.statSync(path.join(FIXTURES, a)).size - fs.statSync(path.join(FIXTURES, b)).size);

  const boot = [];
  for (let i = 0; i < REPS; i++) {
    const t = hr(); spawnSync(py, ['-c', 'pass'], { windowsHide: true }); boot.push(hr() - t);
  }
  const bootStats = stats(boot);
  console.log('\npython interpreter boot: mean ' + bootStats.mean.toFixed(1) + 'ms  max ' +
    bootStats.max.toFixed(1) + 'ms  (' + py + ')');

  const out = { at: new Date().toISOString(), python: py, interpreter_boot: bootStats, files: {} };
  const parseMidi = require('./midi-parse-ref.js');

  for (const f of files) {
    const full = path.join(FIXTURES, f);
    const reps = fs.statSync(full).size > 500000 ? Math.max(3, Math.min(REPS, 4)) : REPS;

    // --- the real IPC hop, segmented ---
    const seg = { total: [], spawn_to_first_byte: [], pipe_drain: [], json_parse: [] };
    let bytes = 0, notes = 0;
    for (let i = 0; i < reps; i++) {
      const r = await runLoadOnce(py, full);
      for (const k of Object.keys(seg)) seg[k].push(r[k]);
      bytes = r.bytes; notes = r.notes;
    }

    // --- what happens inside the child, phase by phase ---
    let phases = null, parity = null;
    const pr = spawnSync(py, [PROFILE, full, '--reps', String(Math.min(3, reps))],
      { cwd: ROOT, maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: 'utf-8' });
    if (pr.status === 0) {
      try { const j = JSON.parse(String(pr.stdout).trim()); phases = j.phases; parity = j.parity; } catch (_) { /* fall through */ }
    } else if (pr.stderr) {
      console.log('  (profile failed: ' + String(pr.stderr).trim().split('\n').pop() + ')');
    }

    // --- the same file parsed in JS, for the ratio ---
    const jsRuns = [];
    const buf = fs.readFileSync(full);
    let jsNotes = 0;
    for (let i = 0; i < Math.max(reps, 5); i++) {
      const t = hr(); jsNotes = parseMidi(buf).length; jsRuns.push(hr() - t);
    }

    const row = {
      notes, jsonBytes: bytes, jsNotes,
      segments: Object.fromEntries(Object.entries(seg).map(([k, v]) => [k, stats(v)])),
      childPhases: phases, childParity: parity,
      js_parse: stats(jsRuns),
    };
    out.files[f] = row;

    console.log('\n' + f + '  (' + notes.toLocaleString() + ' notes, ' + (bytes / 1e6).toFixed(2) + ' MB json)');
    if (parity === false) console.log('  !! phase breakdown FAILED parity against midi_document.load_midi -- do not trust it');
    const p = (label, s) => console.log('    ' + label.padEnd(26) + ' mean ' + s.mean.toFixed(1).padStart(8) +
      '  p95 ' + s.p95.toFixed(1).padStart(8) + '  max ' + s.max.toFixed(1).padStart(8) + ' ms');
    p('TOTAL open (main proc)', row.segments.total);
    p('  spawn -> first byte', row.segments.spawn_to_first_byte);
    p('  pipe drain', row.segments.pipe_drain);
    p('  JSON.parse', row.segments.json_parse);
    if (phases) {
      const order = ['import_mido', 'MidiFile_parse', 'iterate_merge_to_seconds', 'build_note_dicts',
        'sort', 'assign_ids', 'midi_length', 'bpm_from_onsets', 'json_dumps'];
      for (const k of order) {
        if (phases[k]) console.log('      in-child ' + k.padEnd(26) + phases[k].mean.toFixed(1).padStart(8) + ' ms');
      }
    }
    p('  JS parse, same file', row.js_parse);
  }

  if (JSON_AT) {
    fs.writeFileSync(JSON_AT, JSON.stringify(out, null, 2));
    console.log('\nwrote ' + JSON_AT);
  }
})().catch((e) => { console.error(e); process.exit(1); });

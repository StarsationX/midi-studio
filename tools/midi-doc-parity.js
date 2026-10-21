// tools/midi-doc-parity.js: python-engine/midi_document.py (mido) against its
// Rust port (src-tauri/src/midi_doc.rs, via the midi-document CLI), byte for
// byte.
//
//   node tools/midi-doc-parity.js [--dir <folder>]... [--rs <midi-document.exe>]
//
// For every .mid in benchmarks/fixtures, _gentest and each --dir, plus a set of
// synthetic files built to hit the constructs the two readers could disagree
// on, it checks:
//   load    both print the same JSON document, byte for byte (or both refuse)
//   save    the python document written by each side is the same .mid bytes
//   cross   python's export of python's doc == Rust's export of Rust's doc
// and a set of hand-written documents exercises the writer's coercion rules
// (strings for numbers, clamps, missing fields, bad programs).
//
// Nothing is written outside a fresh temp folder. Exit 1 on any difference.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..');
const ENGINE = path.join(ROOT, 'python-engine');
const DOC_PY = path.join(ENGINE, 'midi_document.py');

const argv = process.argv.slice(2);
const dirs = [path.join(ROOT, 'benchmarks', 'fixtures'), path.join(ROOT, '_gentest')];
let rsExe = process.env.MIDI_DOC_RS || '';
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--dir') dirs.push(argv[++i]);
  else if (argv[i] === '--rs') rsExe = argv[++i];
}

const py = [path.join(ENGINE, 'python', 'python.exe'), 'py', 'python'].find((c) => {
  try { return cp.spawnSync(c, ['-c', 'import mido'], { timeout: 30000 }).status === 0; } catch (_) { return false; }
});
if (!py) { console.error('no python with mido: nothing to compare against'); process.exit(2); }
if (!rsExe) {
  for (const prof of ['release', 'debug']) {
    const p = path.join(ROOT, 'src-tauri', 'target', prof, 'midi-document.exe');
    if (fs.existsSync(p)) { rsExe = p; break; }
  }
}
if (!rsExe) {
  const b = cp.spawnSync('cargo', ['build', '--bin', 'midi-document', '--features', 'parity-cli'], { cwd: path.join(ROOT, 'src-tauri'), stdio: 'inherit' });
  if (b.status !== 0) process.exit(2);
  rsExe = path.join(ROOT, 'src-tauri', 'target', 'debug', 'midi-document.exe');
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'midi-doc-parity-'));
const env = Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' });
const run = (exe, args, input) => {
  const r = cp.spawnSync(exe, args, { cwd: ENGINE, input, env, maxBuffer: 1 << 30, windowsHide: true });
  // print() on Windows ends the line with \r\n, the Rust CLI with \n.
  return { ok: r.status === 0, out: r.stdout.toString('utf-8').replace(/\r?\n$/, ''), err: r.stderr.toString('utf-8').trim() };
};
const pyRun = (action, file, input) => run(py, [DOC_PY, action, file], input);
const rsRun = (action, file, input) => run(rsExe, [action, file], input);

let failures = 0;
let checks = 0;
const report = (ok, label, why) => {
  checks++;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (why ? '  [' + why + ']' : ''));
};

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

// ---- synthetic files: the constructs where two readers could disagree ------
const vlq = (n) => { const o = [n & 0x7f]; n = Math.floor(n / 128); while (n > 0) { o.unshift((n & 0x7f) | 0x80); n = Math.floor(n / 128); } return o; };
const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const be16 = (n) => [(n >>> 8) & 255, n & 255];
const smf = (format, division, tracks, opts = {}) => {
  let out = [0x4d, 0x54, 0x68, 0x64].concat(be32(6), be16(format), be16(opts.ntrk === undefined ? tracks.length : opts.ntrk), be16(division));
  for (const evts of tracks) {
    let body = [];
    for (const e of evts) body = body.concat(vlq(e[0]), e.slice(1));
    if (!opts.noEot) body = body.concat(vlq(0), [0xff, 0x2f, 0x00]);
    out = out.concat([0x4d, 0x54, 0x72, 0x6b], be32(body.length + (opts.lenFudge || 0)), body);
  }
  return Buffer.from(out);
};
const ON = (ch, p, v) => [0x90 | ch, p, v];
const OFF = (ch, p) => [0x80 | ch, p, 0];
const guessed = [];
for (let i = 0; i < 40; i++) { guessed.push([i ? 120 : 0].concat(ON(0, 60 + (i % 5), 90))); guessed.push([60].concat(OFF(0, 60 + (i % 5)))); }
const dense = [];
for (let i = 0; i < 3000; i++) { dense.push([(i * 7) % 13].concat(ON(i % 3, 40 + (i % 48), 1 + (i % 127)))); dense.push([(i * 5) % 11 + 1].concat(OFF(i % 3, 40 + (i % 48)))); }
const synthetic = {
  'trailing-silence': smf(0, 480, [[[0].concat(ON(0, 60, 100)), [480].concat(OFF(0, 60)), [960, 0xb0, 7, 100]]]),
  'unterminated': smf(0, 480, [[[0].concat(ON(0, 60, 100)), [240].concat(ON(0, 64, 90)), [480].concat(OFF(0, 64))]]),
  'running-status-meta': smf(0, 480, [[[0, 0x90, 60, 100], [0, 64, 100], [0, 67, 100], [0, 0xff, 0x06, 0x02, 0x68, 0x69], [480, 60, 0], [0, 64, 0], [0, 67, 0]]]),
  'two-track-tempo': smf(1, 384, [
    [[0, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20], [0, 0xc0, 0x18], [0].concat(ON(0, 60, 100)), [300].concat(OFF(0, 60)),
      [100, 0xff, 0x51, 0x03, 0x05, 0x16, 0x15], [0].concat(ON(0, 62, 100)), [700].concat(OFF(0, 62))],
    [[0, 0xc1, 0x30], [150].concat(ON(1, 67, 80)), [275].concat(OFF(1, 67)), [13].concat(ON(1, 69, 70)), [901].concat(OFF(1, 69))],
  ]),
  'no-tempo': smf(0, 480, [guessed]),
  'dense-3ch': smf(0, 96, [dense]),
  'same-pitch-overlap-fifo': smf(0, 480, [[[0].concat(ON(0, 60, 90)), [10].concat(ON(0, 60, 80)), [10].concat(OFF(0, 60)), [10].concat(OFF(0, 60)), [10].concat(OFF(0, 60))]]),
  'sysex-and-running-status': smf(0, 480, [[[0, 0xf0, 0x03, 0x7e, 0x01, 0xf7], [0, 0x90, 60, 100], [100, 0xf7, 0x01, 0x05], [0, 62, 100], [100, 0x80, 60, 0], [0, 62, 0]]]),
  'running-status-after-sysex': smf(0, 480, [[[0, 0xf0, 0x02, 0x01, 0xf7], [0, 0x02, 0x01, 0x02], [0].concat(ON(0, 60, 1)), [9].concat(OFF(0, 60))]]),
  'system-common-quarter-frame': smf(0, 480, [[[0].concat(ON(0, 60, 100)), [5, 0xf1, 0x21], [0, 0x33], [5, 0xf2, 0x01, 0x02], [40].concat(OFF(0, 60))]]),
  'realtime-clock-in-file': smf(0, 480, [[[0].concat(ON(0, 60, 100)), [5, 0xf8], [40].concat(OFF(0, 60))]]),
  'undefined-status-f4': smf(0, 480, [[[0].concat(ON(0, 60, 100)), [5, 0xf4], [40].concat(OFF(0, 60))]]),
  'running-status-after-realtime': smf(0, 480, [[[0].concat(ON(0, 60, 100)), [5, 0xf8], [0, 0x40], [40].concat(OFF(0, 60))]]),
  'smpte-division': (() => { const b = smf(0, 480, [[[0].concat(ON(0, 60, 100)), [80].concat(OFF(0, 60))]]); b[12] = 0xe7; b[13] = 0x28; return b; })(),
  'zero-division': smf(0, 0, [[[0].concat(ON(0, 60, 100)), [80].concat(OFF(0, 60))]]),
  'zero-division-no-deltas': smf(0, 0, [[[0].concat(ON(0, 60, 100)), [0].concat(OFF(0, 60))]], { noEot: true }),
  'type-2': smf(2, 480, [[[0].concat(ON(0, 60, 100)), [10].concat(OFF(0, 60))]]),
  'eot-mid-track': smf(1, 480, [[[0].concat(ON(0, 60, 100)), [50, 0xff, 0x2f, 0x00], [30].concat(OFF(0, 60))], [[200, 0xb0, 1, 1]]]),
  'no-eot': smf(0, 480, [[[0].concat(ON(0, 60, 100)), [80].concat(OFF(0, 60))]], { noEot: true }),
  'short-tempo-meta': smf(0, 480, [[[0, 0xff, 0x51, 0x02, 0x07, 0xa1], [0].concat(ON(0, 60, 100)), [80].concat(OFF(0, 60))]]),
  'long-tempo-meta': smf(0, 480, [[[0, 0xff, 0x51, 0x04, 0x07, 0xa1, 0x20, 0x99], [0].concat(ON(0, 60, 100)), [80].concat(OFF(0, 60))]]),
  'zero-tempo': smf(0, 480, [[[0, 0xff, 0x51, 0x03, 0, 0, 0], [0].concat(ON(0, 60, 100)), [80].concat(OFF(0, 60))]]),
  'bad-key-signature': smf(0, 480, [[[0, 0xff, 0x59, 0x02, 0x09, 0x00], [0].concat(ON(0, 60, 100)), [80].concat(OFF(0, 60))]]),
  'good-key-time-smpte-meta': smf(0, 480, [[[0, 0xff, 0x59, 0x02, 0xfd, 0x01], [0, 0xff, 0x58, 0x04, 6, 3, 24, 8], [0, 0xff, 0x54, 0x05, 0x41, 0, 0, 0, 0], [0, 0xff, 0x00, 0x00], [0, 0xff, 0x7f, 0x01, 0x05], [0, 0xff, 0x08, 0x01, 0x41], [0].concat(ON(0, 60, 100)), [80].concat(OFF(0, 60))]]),
  'bad-smpte-rate': smf(0, 480, [[[0, 0xff, 0x54, 0x05, 0xa1, 0, 0, 0, 0], [0].concat(ON(0, 60, 100)), [80].concat(OFF(0, 60))]]),
  'seqnum-one-byte': smf(0, 480, [[[0, 0xff, 0x00, 0x01, 0x05], [0].concat(ON(0, 60, 100)), [80].concat(OFF(0, 60))]]),
  'data-byte-over-127': smf(0, 480, [[[0, 0x90, 60, 0x90], [80].concat(OFF(0, 60))]]),
  'sysex-byte-over-127': smf(0, 480, [[[0, 0xf0, 0x03, 0x01, 0x85, 0xf7], [0].concat(ON(0, 60, 100)), [80].concat(OFF(0, 60))]]),
  'track-overruns-chunk': smf(0, 480, [[[0].concat(ON(0, 60, 100)), [80].concat(OFF(0, 60))]], { lenFudge: -2 }),
  'more-tracks-declared': smf(1, 480, [[[0].concat(ON(0, 60, 100)), [80].concat(OFF(0, 60))]], { ntrk: 2 }),
  'fewer-tracks-declared': smf(1, 480, [[[0].concat(ON(0, 60, 100)), [80].concat(OFF(0, 60))], [[0].concat(ON(1, 70, 100)), [80].concat(OFF(1, 70))]], { ntrk: 1 }),
  'program-first-wins': smf(0, 480, [[[0, 0xc9, 0x00], [0, 0xc2, 0x05], [0, 0xc9, 0x10], [0].concat(ON(9, 36, 100)), [20].concat(OFF(9, 36))]]),
  'big-delta': smf(0, 480, [[[0].concat(ON(0, 60, 100)), [0x0fffffff].concat(OFF(0, 60))]]),
  'not-a-midi': Buffer.from('RIFF....this is not a midi file'),
  'header-only': smf(0, 480, []),
};

const files = [];
for (const d of dirs) {
  if (!d || !fs.existsSync(d)) continue;
  for (const n of fs.readdirSync(d).sort()) if (/\.midi?$/i.test(n)) files.push(path.join(d, n));
}
const synthDir = path.join(tmp, 'synthetic');
fs.mkdirSync(synthDir);
for (const [name, buf] of Object.entries(synthetic)) {
  const f = path.join(synthDir, name + '.mid');
  fs.writeFileSync(f, buf);
  files.push(f);
}

// ---- load / save / cross -----------------------------------------------------
let i = 0;
let notes = 0;
for (const f of files) {
  const label = path.relative(ROOT, f).startsWith('..') ? f : path.relative(ROOT, f);
  const a = pyRun('load', f);
  const b = rsRun('load', f);
  if (!a.ok || !b.ok) {
    report(a.ok === b.ok, 'load  ' + label, a.ok === b.ok ? 'both refuse: py "' + a.err.split('\n').pop() + '" / rs "' + b.err + '"'
      : (a.ok ? 'python loads it, rust refuses: ' + b.err : 'rust loads it, python refuses: ' + a.err.split('\n').pop()));
    continue;
  }
  const d = firstDiff(a.out, b.out);
  const doc = JSON.parse(a.out);
  notes += doc.notes.length;
  report(d < 0, 'load  ' + label, d < 0 ? doc.notes.length + ' notes, ' + a.out.length + ' bytes identical'
    : 'first difference at char ' + d + ': py …' + a.out.slice(Math.max(0, d - 40), d + 40) + '… rs …' + b.out.slice(Math.max(0, d - 40), d + 40) + '…');

  const n = ++i;
  const outPy = path.join(tmp, n + '-py.mid');
  const outRs = path.join(tmp, n + '-rs.mid');
  const outRs2 = path.join(tmp, n + '-rs-own.mid');
  const sp = pyRun('save', outPy, a.out);
  const sr = rsRun('save', outRs, a.out);
  const sr2 = rsRun('save', outRs2, b.out);
  if (!sp.ok || !sr.ok || !sr2.ok) {
    report(false, 'save  ' + label, 'py ' + (sp.ok ? 'ok' : sp.err) + ' / rs ' + (sr.ok ? 'ok' : sr.err));
    continue;
  }
  const bp = fs.readFileSync(outPy), br = fs.readFileSync(outRs), br2 = fs.readFileSync(outRs2);
  const sd = firstDiff(bp, br);
  report(sd < 0, 'save  ' + label, sd < 0 ? bp.length + ' bytes identical' : 'first differing byte ' + sd + ' (' + bp.length + ' vs ' + br.length + ' bytes)');
  report(Buffer.compare(bp, br2) === 0, 'cross ' + label, 'python(load→save) vs rust(load→save)');
  // Reading the exports back: the two readers agree on the second generation
  // too (path and name differ only because the files do).
  const again = rsRun('load', outRs2);
  const againPy = pyRun('load', outPy);
  const strip = (s) => s.replace(/^\{"path": "(?:[^"\\]|\\.)*", "name": "(?:[^"\\]|\\.)*", /, '{');
  report(again.ok && againPy.ok && strip(again.out) === strip(againPy.out),
    'regen ' + label, 'reloading both exports gives the same document');
}

// ---- the writer's coercion rules on hand-written documents ------------------
const docs = {
  'strings-for-numbers': { bpm: '174.5', programs: { '1': '7' }, notes: [{ pitch: '61', start: '0.25', end: '0.75', velocity: '80', channel: '1' }] },
  'clamps-and-defaults': { notes: [{ pitch: 200, start: -1, velocity: 0, channel: 22 }, { pitch: -5, start: 0.5, end: 0.4, channel: null }, {}] },
  'bpm-out-of-range-low': { bpm: 3, notes: [{ pitch: 60, start: 0, end: 1 }] },
  'bpm-out-of-range-high': { bpm: 9000, notes: [{ pitch: 60, start: 1.5, end: 2.5 }] },
  'bpm-nan-string': { bpm: 'nan', notes: [{ pitch: 60, start: 0, end: 1 }] },
  'float-pitch-truncates': { notes: [{ pitch: 60.9, start: 0.123456789, end: 0.9876543, velocity: 99.99 }] },
  'programs-filtered-and-sorted': { programs: { '9': 0, '3': 128, '16': 4, '0': 5, '2': 1 }, notes: [] },
  'programs-bad-key': { programs: { x: 1 }, notes: [] },
  'notes-null': { notes: null },
  'note-not-object': { notes: [5] },
  'pitch-null': { notes: [{ pitch: null }] },
  'empty-document': {},
  'bool-fields': { bpm: true, notes: [{ pitch: true, start: false, end: true, velocity: true, channel: true }] },
  'simultaneous-ordering': { notes: [{ pitch: 64, start: 1, end: 2 }, { pitch: 60, start: 1, end: 2 }, { pitch: 62, start: 0, end: 1 }, { pitch: 60, start: 0, end: 1 }] },
  'tick-rounding-ties': { bpm: 120, notes: Array.from({ length: 64 }, (_, k) => ({ pitch: 60 + (k % 12), start: k * 0.0005208333333333333, end: k * 0.0015625 + 0.01 })) },
  'not-an-object': [1, 2, 3],
};
for (const [name, d] of Object.entries(docs)) {
  const text = JSON.stringify(d);
  const outPy = path.join(tmp, 'doc-' + name + '-py.mid');
  const outRs = path.join(tmp, 'doc-' + name + '-rs.mid');
  const sp = pyRun('save', outPy, text);
  const sr = rsRun('save', outRs, text);
  if (!sp.ok || !sr.ok) {
    report(sp.ok === sr.ok, 'doc   ' + name, sp.ok === sr.ok ? 'both refuse: py "' + sp.err.split('\n').pop() + '" / rs "' + sr.err + '"'
      : 'py ' + (sp.ok ? 'ok' : sp.err.split('\n').pop()) + ' / rs ' + (sr.ok ? 'ok' : sr.err));
    continue;
  }
  const bp = fs.readFileSync(outPy), br = fs.readFileSync(outRs);
  const sd = firstDiff(bp, br);
  report(sd < 0, 'doc   ' + name, sd < 0 ? bp.length + ' bytes identical' : 'first differing byte ' + sd);
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
console.log('\n' + (checks - failures) + '/' + checks + ' checks identical, ' + files.length + ' files, ' + notes.toLocaleString() + ' notes'
  + '  (python ' + py + ', rust ' + path.relative(ROOT, rsExe) + ')');
process.exit(failures ? 1 : 0);

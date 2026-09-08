// bench.js: repeatable numbers for the paths users actually wait on.
//
//   node benchmarks/bench.js                 run everything, print a table
//   node benchmarks/bench.js --json out.json also write a machine-readable file
//   node benchmarks/bench.js --only midi     run one group
//
// Every measurement reports mean / p95 / p99 / max, not just the mean: a tail
// stall is what a user notices, and an average hides it completely.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures');

// ---- stats -----------------------------------------------------------------
function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const at = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return {
    n: s.length,
    mean: s.reduce((a, b) => a + b, 0) / s.length,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: s[s.length - 1],
  };
}

function time(fn) {
  const t = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - t) / 1e6;
}

async function timeAsync(fn) {
  const t = process.hrtime.bigint();
  await fn();
  return Number(process.hrtime.bigint() - t) / 1e6;
}

// ---- a minimal MIDI reader, so the renderer-side cost is measurable ---------
// The app loads MIDI through python-engine/midi_document.py, but the note-array
// shape it returns is what every canvas then walks. This parser produces the
// same shape so parse and traversal can be measured apart from Python startup.
function parseMidi(buf) {
  let p = 0;
  const u32 = () => { const v = buf.readUInt32BE(p); p += 4; return v; };
  const u16 = () => { const v = buf.readUInt16BE(p); p += 2; return v; };
  const vlq = () => { let v = 0, b; do { b = buf[p++]; v = (v << 7) | (b & 0x7f); } while (b & 0x80); return v; };

  if (buf.readUInt32BE(0) !== 0x4d546864) throw new Error('not a MIDI file');
  p = 8;
  u16();                       // format
  const ntrk = u16();
  const division = u16();

  const notes = [];
  let tempo = 500000;          // us per quarter, the MIDI default
  for (let t = 0; t < ntrk; t++) {
    if (u32() !== 0x4d54726b) throw new Error('bad track header');
    const len = u32();
    const end = p + len;
    let tick = 0, status = 0;
    const active = new Map();  // (channel<<8|pitch) -> [tick, velocity]
    while (p < end) {
      tick += vlq();
      let b = buf[p];
      if (b & 0x80) { status = b; p++; } // else running status
      const type = status & 0xf0;
      const ch = status & 0x0f;
      if (status === 0xff) {
        const meta = buf[p++]; const mlen = vlq();
        if (meta === 0x51) tempo = (buf[p] << 16) | (buf[p + 1] << 8) | buf[p + 2];
        p += mlen;
      } else if (status === 0xf0 || status === 0xf7) {
        p += vlq();
      } else if (type === 0x90 || type === 0x80) {
        const pitch = buf[p++], vel = buf[p++];
        const key = (ch << 8) | pitch;
        if (type === 0x90 && vel > 0) {
          active.set(key, [tick, vel]);
        } else {
          const on = active.get(key);
          if (on) {
            active.delete(key);
            const sec = (tk) => (tk / division) * (tempo / 1e6);
            notes.push({ pitch, start: sec(on[0]), end: sec(tick), velocity: on[1], channel: ch });
          }
        }
      } else if (type === 0xc0 || type === 0xd0) {
        p += 1;
      } else {
        p += 2;
      }
    }
    p = end;
  }
  notes.sort((a, b) => a.start - b.start);
  return notes;
}

// ---- groups ----------------------------------------------------------------
const GROUPS = {};

GROUPS.midi = async () => {
  const out = [];
  for (const f of fs.readdirSync(FIXTURES).filter((n) => n.endsWith('.mid'))) {
    const buf = fs.readFileSync(path.join(FIXTURES, f));
    let notes = null;
    const runs = [];
    const reps = buf.length > 500000 ? 8 : 30;
    for (let i = 0; i < reps; i++) runs.push(time(() => { notes = parseMidi(buf); }));
    out.push({ name: `parse ${f}`, notes: notes.length, unit: 'ms', ...stats(runs) });

    // What a canvas pays to find the visible slice. Linear scan is what the
    // current editor and visualiser do; binary search is what they should do.
    const win = [notes.length ? notes[Math.floor(notes.length / 2)].start : 0, 0];
    win[1] = win[0] + 4;
    const lin = [];
    for (let i = 0; i < 200; i++) {
      lin.push(time(() => {
        let c = 0;
        for (const n of notes) if (n.end >= win[0] && n.start <= win[1]) c++;
        if (c < 0) throw new Error('unreachable');
      }));
    }
    out.push({ name: `visible-scan (linear) ${f}`, notes: notes.length, unit: 'ms', ...stats(lin) });

    const bin = [];
    const starts = notes.map((n) => n.start);
    for (let i = 0; i < 200; i++) {
      bin.push(time(() => {
        let lo = 0, hi = starts.length;
        while (lo < hi) { const m = (lo + hi) >> 1; if (starts[m] < win[0]) lo = m + 1; else hi = m; }
        let c = 0;
        for (let j = lo; j < starts.length && starts[j] <= win[1]; j++) c++;
        if (c < 0) throw new Error('unreachable');
      }));
    }
    out.push({ name: `visible-scan (binary) ${f}`, notes: notes.length, unit: 'ms', ...stats(bin) });
  }
  return out;
};

GROUPS.library = async () => {
  // The library scan is synchronous in the main process today, so its cost is
  // the whole app freezing. Measure sync vs async over the same tree.
  const roots = [ROOT];
  const SKIP = new Set(['node_modules', '.git', 'dist', '__pycache__']);

  const walkSync = (dir, depth, acc) => {
    if (depth > 6) return acc;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return acc; }
    for (const e of ents) {
      if (SKIP.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walkSync(full, depth + 1, acc);
      else { try { acc.push({ path: full, size: fs.statSync(full).size }); } catch (_) {} }
    }
    return acc;
  };

  const walkAsync = async (dir, depth, acc) => {
    if (depth > 6) return acc;
    let ents;
    try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (_) { return acc; }
    const files = [], dirs = [];
    for (const e of ents) {
      if (SKIP.has(e.name)) continue;
      (e.isDirectory() ? dirs : files).push(path.join(dir, e.name));
    }
    // Batched stats: the win is issuing them together, not one await per file.
    const stat = await Promise.all(files.map((f) => fs.promises.stat(f).catch(() => null)));
    for (let i = 0; i < files.length; i++) if (stat[i]) acc.push({ path: files[i], size: stat[i].size });
    for (const d of dirs) await walkAsync(d, depth + 1, acc);
    return acc;
  };

  const out = [];
  let count = 0;
  const sync = [];
  for (let i = 0; i < 5; i++) sync.push(time(() => { count = walkSync(roots[0], 0, []).length; }));
  out.push({ name: `scan sync (${count} files)`, unit: 'ms', ...stats(sync) });

  const asy = [];
  for (let i = 0; i < 5; i++) asy.push(await timeAsync(async () => { await walkAsync(roots[0], 0, []); }));
  out.push({ name: `scan async batched (${count} files)`, unit: 'ms', ...stats(asy) });

  // Search over the indexed names, which is what the Library tab does per keystroke.
  const index = walkSync(roots[0], 0, []).map((f) => ({
    path: f.path,
    norm: path.basename(f.path).toLowerCase(),
  }));
  const naive = [];
  for (let i = 0; i < 200; i++) {
    naive.push(time(() => {
      const q = 'mid';
      const r = index.filter((e) => e.norm.includes(q));
      if (r.length < 0) throw new Error('unreachable');
    }));
  }
  out.push({ name: `search ${index.length} entries`, unit: 'ms', ...stats(naive) });
  return out;
};

GROUPS.python = async () => {
  // Python startup is paid on every Editor open. Worth knowing exactly.
  const py = [
    path.join(ROOT, 'python-engine', 'python', 'python.exe'),
    'py', 'python',
  ].find((c) => {
    try { return spawnSync(c, ['-c', 'pass'], { timeout: 20000 }).status === 0; } catch (_) { return false; }
  });
  if (!py) return [{ name: 'python not found', unit: 'ms', n: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0 }];

  const out = [];
  const boot = [];
  for (let i = 0; i < 5; i++) boot.push(time(() => spawnSync(py, ['-c', 'pass'])));
  out.push({ name: `python bare startup (${path.basename(py)})`, unit: 'ms', ...stats(boot) });

  const doc = path.join(ROOT, 'python-engine', 'midi_document.py');
  if (fs.existsSync(doc)) {
    for (const f of ['normal.mid', 'huge-50k.mid']) {
      const fx = path.join(FIXTURES, f);
      if (!fs.existsSync(fx)) continue;
      const runs = [];
      let bytes = 0, ok = true;
      for (let i = 0; i < 3; i++) {
        runs.push(time(() => {
          const r = spawnSync(py, [doc, 'load', fx], { maxBuffer: 512 * 1024 * 1024 });
          if (r.status !== 0) ok = false;
          bytes = r.stdout ? r.stdout.length : 0;
        }));
      }
      out.push({ name: `midi_document load ${f}${ok ? '' : ' (FAILED)'}`, jsonBytes: bytes, unit: 'ms', ...stats(runs) });
    }
  }
  return out;
};

// ---- run -------------------------------------------------------------------
(async () => {
  const argv = process.argv.slice(2);
  const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;
  const jsonAt = argv.includes('--json') ? argv[argv.indexOf('--json') + 1] : null;

  if (!fs.existsSync(FIXTURES)) {
    console.error(`no fixtures at ${FIXTURES}; run benchmarks/make-fixtures.js first`);
    process.exit(1);
  }

  const results = {};
  for (const [name, fn] of Object.entries(GROUPS)) {
    if (only && only !== name) continue;
    process.stdout.write(`\n${name.toUpperCase()}\n`);
    let rows;
    try {
      rows = await fn();
    } catch (err) {
      console.error(`  ${name} failed: ${err.message}`);
      continue;
    }
    results[name] = rows;
    const w = Math.max(...rows.map((r) => r.name.length));
    for (const r of rows) {
      const f = (v) => String(v.toFixed(v < 10 ? 3 : 1)).padStart(9);
      console.log(
        `  ${r.name.padEnd(w)}  mean${f(r.mean)}  p95${f(r.p95)}  p99${f(r.p99)}  max${f(r.max)}  ${r.unit}` +
        (r.notes ? `  (${r.notes} notes)` : '') +
        (r.jsonBytes ? `  (${(r.jsonBytes / 1e6).toFixed(1)} MB json)` : '')
      );
    }
  }

  if (jsonAt) {
    fs.writeFileSync(jsonAt, JSON.stringify({ at: new Date().toISOString(), node: process.version, results }, null, 2));
    console.log(`\nwrote ${jsonAt}`);
  }
})();

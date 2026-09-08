// editor-open-e2e.js: what the Editor's OPEN actually costs, end to end, in a
// real window -- from the moment openPath() is called to the moment the piano
// roll has drawn the document's first pixel.
//
//   npx electron benchmarks/editor-open-e2e.js
//   npx electron benchmarks/editor-open-e2e.js --json benchmarks/editor-open-e2e.json
//   npx electron benchmarks/editor-open-e2e.js --only 50k --reps 5
//
// Unlike benchmarks/editor-interact.js, whose review:load stub answers from
// memory (it is measuring the RENDERER, deliberately), this harness wires the
// REAL loader: loadReviewFile()/runMidiDocument() are reproduced verbatim from
// electron/main.js, so `review:load` spawns the real python-engine interpreter,
// runs the real midi_document.py, drains the real pipe, JSON.parses in main and
// hands the objects across the real contextBridge. That is the number the user
// waits for.
//
// It measures both arms in ONE run, back to back on the same window and the
// same fixture, so a machine that is busy is busy for both:
//
//   python   window.__review.forcePython = true -> the review:load round trip
//   fast     the shipped path -> fetch(file://) + the shared JS parser
//
// and it asserts PARITY between the two documents the page actually ended up
// holding (every note field, every id, the unterminated flag, bpm, bpmEstimated,
// programs, duration), so a faster number can never be bought with a different
// document.
//
// One window at a time; it is destroyed in a finally.
'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures');
const ENGINE = path.join(ROOT, 'python-engine');

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const JSON_AT = flag('--json', '');
const ONLY = flag('--only', '');
const REPS = Number(flag('--reps', '4'));
const SIZE = flag('--size', '1600x1000').split('x').map(Number);

const CASES = [
  { name: '2k', file: 'normal.mid' },
  { name: '10k', file: 'big-10k.mid' },
  { name: '50k', file: 'huge-50k.mid' },
  { name: '120k', file: 'massive-120k.mid' },
].filter((c) => !ONLY || c.file === ONLY || c.name === ONLY);

// ---------------------------------------------------------------------------
//  the REAL loader, verbatim from electron/main.js (188-231)
// ---------------------------------------------------------------------------
function runMidiDocument(action, midiPath, document) {
  return new Promise((resolve, reject) => {
    const py = path.join(ENGINE, 'python', 'python.exe');
    const script = path.join(ENGINE, 'midi_document.py');
    let stdout = '', stderr = '';
    let child;
    try {
      child = spawn(py, [script, action, midiPath], {
        cwd: ENGINE, windowsHide: process.platform === 'win32',
        env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' }),
      });
    } catch (error) { reject(error); return; }
    child.stdout.setEncoding('utf-8'); child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.setEncoding('utf-8'); child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) { reject(new Error(stderr.trim() || `MIDI helper exited with code ${code}`)); return; }
      try { resolve(JSON.parse(stdout.trim())); } catch { reject(new Error('MIDI helper returned invalid data.')); }
    });
    if (action === 'save') child.stdin.end(JSON.stringify(document || {}));
  });
}

async function loadReviewFile(filePath) {
  const document = await runMidiDocument('load', filePath);
  return {
    projectPath: '',
    project: { format: 'midi-studio-project', version: 1, name: path.basename(filePath, path.extname(filePath)),
      sourceAudio: '', selectedCandidate: 'clean', candidates: { clean: filePath } },
    documents: { clean: document },
  };
}

const HANDLERS = {
  'app:getUi': () => ({ ok: true, ui: {} }),
  'app:settings': () => ({ ok: true, settings: {} }),
  'settings:get': () => ({ ok: true, value: null }),
  'settings:set': () => ({ ok: true }),
  'review:pick': () => '',
  'review:load': async (p) => {
    try { return { ok: true, data: await loadReviewFile(String(p || '')) }; }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  },
  'review:saveProject': () => ({ ok: false, canceled: true }),
  'review:exportMidi': () => ({ ok: false, canceled: true }),
  'library:list': () => ({ dirs: [], extra: [], files: [], truncated: false }),
  'shell:openPath': () => ({ ok: true }),
};

app.on('window-all-closed', () => { /* the runner decides when to exit */ });
process.on('uncaughtException', (e) => { process.stderr.write('FATAL ' + ((e && e.stack) || e) + '\n'); });
process.on('unhandledRejection', (e) => { process.stderr.write('REJECT ' + ((e && e.stack) || e) + '\n'); });

function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const at = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, mean: s.reduce((a, b) => a + b, 0) / s.length,
    p50: at(0.5), p95: at(0.95), p99: at(0.99), max: s[s.length - 1] };
}
const f1 = (x) => (x === undefined || x === null ? '   --  ' : x.toFixed(1).padStart(8));

// ---------------------------------------------------------------------------
//  the in-page probe
// ---------------------------------------------------------------------------
// openReviewProject() resolves when its own work is done, but the roll draws on
// the NEXT animation frame, so the click-to-picture number has to be closed by
// the canvas itself. clearRect is the roll's first operation every repaint.
const INSTALL = `(() => {
  if (window.__E) return 'already';
  const E = { drawn: null };
  window.__E = E;
  const rc = document.getElementById('roll').getContext('2d');
  const cr = rc.clearRect;
  rc.clearRect = function (a, b, c, d) {
    if (E.drawn === null) E.drawn = performance.now();
    return cr.call(this, a, b, c, d);
  };
  E.open = async (p, forcePython) => {
    if (window.__review) window.__review.forcePython = !!forcePython;
    E.drawn = null;
    const t0 = performance.now();
    await window.openReviewProject(p);
    const done = performance.now();
    // wait for the roll to actually put ink down (bounded, so a failure reports)
    const deadline = performance.now() + 20000;
    while (E.drawn === null && performance.now() < deadline) {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    }
    return { openMs: done - t0, paintMs: (E.drawn === null ? -1 : E.drawn - t0) };
  };
  // The document the page is actually holding, for the parity assertion.
  E.doc = () => (window.__review && window.__review.snapshot ? window.__review.snapshot() : null);
  return 'ok';
})()`;

async function boot() {
  // VISIBLE and FOCUSED on purpose. draw.js clamps an unfocused window's frame
  // budget to 250ms (its input 2), so a hidden harness window quantises every
  // first-paint number to a multiple of 250ms and hides the thing being
  // measured. Focused is also the case a user is actually in when they open a
  // file in the Editor.
  const win = new BrowserWindow({
    width: SIZE[0], height: SIZE[1], show: true,
    webPreferences: { preload: path.join(ROOT, 'electron', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
      nodeIntegrationInSubFrames: true, backgroundThrottling: false },
  });
  await win.loadFile(path.join(ROOT, 'renderer', 'review', 'index.html'));
  win.focus();
  win.webContents.focus();
  await new Promise((r) => setTimeout(r, 900));
  const ok = await win.webContents.executeJavaScript(INSTALL);
  if (ok !== 'ok' && ok !== 'already') throw new Error('probe install failed: ' + ok);
  return win;
}

// Field-for-field, the same comparison benchmarks/editor-load-candidate.js makes,
// but over the documents the PAGE ended up with rather than two library calls.
function diffDocs(a, b) {
  const out = [];
  for (const k of ['name', 'bpm', 'bpmEstimated', 'duration']) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out.push(k + ': ' + JSON.stringify(a[k]) + ' vs ' + JSON.stringify(b[k]));
  }
  if (JSON.stringify(a.programs) !== JSON.stringify(b.programs)) out.push('programs differ');
  if (a.notes.length !== b.notes.length) { out.push('note count ' + a.notes.length + ' vs ' + b.notes.length); return out; }
  let bad = 0, worst = 0;
  for (let i = 0; i < a.notes.length; i++) {
    const x = a.notes[i], y = b.notes[i];
    const ds = Math.abs(x.start - y.start), de = Math.abs(x.end - y.end);
    if (ds > worst) worst = ds;
    if (de > worst) worst = de;
    if (x.id !== y.id || x.pitch !== y.pitch || x.velocity !== y.velocity ||
        x.channel !== y.channel || !!x.unterminated !== !!y.unterminated ||
        ds > 1e-6 || de > 1e-6) bad++;
  }
  if (bad) out.push(bad + ' notes differ (worst |dt| ' + worst.toExponential(2) + ' s)');
  return out;
}

(async () => {
  await app.whenReady();
  for (const [ch, fn] of Object.entries(HANDLERS)) {
    ipcMain.removeHandler(ch);
    ipcMain.handle(ch, async (_e, a) => {
      try { return await fn(a); } catch (e) { return { ok: false, error: String(e.message || e) }; }
    });
  }
  for (const ch of ['win:minimize', 'win:maximize', 'win:unmaximize', 'win:toggleMaximize', 'win:close']) {
    ipcMain.removeAllListeners(ch); ipcMain.on(ch, () => {});
  }

  const out = { at: new Date().toISOString(), reps: REPS, cases: {} };
  let win = null;
  try {
    win = await boot();
    for (const c of CASES) {
      const file = path.join(FIXTURES, c.file);
      if (!fs.existsSync(file)) { console.log('skip ' + c.name + ' (no fixture)'); continue; }
      const arms = { python: { open: [], paint: [] }, fast: { open: [], paint: [] } };
      let parity = null, notes = 0, fastAvailable = true;

      // Alternate the arms so drift in machine load hits both equally.
      for (let i = 0; i < REPS; i++) {
        for (const arm of ['python', 'fast']) {
          const r = await win.webContents.executeJavaScript(
            `window.__E.open(${JSON.stringify(file)}, ${arm === 'python'})`);
          arms[arm].open.push(r.openMs);
          arms[arm].paint.push(r.paintMs);
          await new Promise((r2) => setTimeout(r2, 250));
        }
      }
      // Parity: load once each way and compare what the page is holding.
      const snap = async (forcePython) => {
        await win.webContents.executeJavaScript(`window.__E.open(${JSON.stringify(file)}, ${forcePython})`);
        return win.webContents.executeJavaScript('JSON.stringify(window.__E.doc())');
      };
      try {
        const py = JSON.parse(await snap(true));
        const js = JSON.parse(await snap(false));
        if (!py || !js) { parity = ['snapshot unavailable (window.__review.snapshot missing)']; }
        else { parity = diffDocs(py, js); notes = py.notes.length; fastAvailable = js.via !== 'python'; }
      } catch (e) { parity = ['parity check failed: ' + (e.message || e)]; }

      out.cases[c.name] = {
        file: c.file, notes, fastAvailable, parity,
        python: { open: stats(arms.python.open), paint: stats(arms.python.paint) },
        fast: { open: stats(arms.fast.open), paint: stats(arms.fast.paint) },
      };
      const P = out.cases[c.name].python.paint, F = out.cases[c.name].fast.paint;
      console.log('\n' + c.name + '  (' + notes.toLocaleString() + ' notes)  ' + c.file);
      console.log('  open -> first roll paint     mean      p50      p95      p99      max');
      console.log('    python round trip     ' + f1(P.mean) + f1(P.p50) + f1(P.p95) + f1(P.p99) + f1(P.max) + ' ms');
      console.log('    fast (fetch + JS)     ' + f1(F.mean) + f1(F.p50) + f1(F.p95) + f1(F.p99) + f1(F.max) + ' ms');
      if (P.mean && F.mean) console.log('    speedup               ' + (P.mean / F.mean).toFixed(1) + 'x mean, ' +
        (P.max / F.max).toFixed(1) + 'x max');
      console.log('    parity: ' + (parity && parity.length ? parity.join('; ') : 'IDENTICAL') +
        (fastAvailable ? '' : '   [!] fast path fell back to python'));
    }
  } catch (e) {
    process.stderr.write('FATAL ' + ((e && e.stack) || e) + '\n');
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
  }
  if (JSON_AT) { fs.writeFileSync(JSON_AT, JSON.stringify(out, null, 2)); console.log('\nwrote ' + JSON_AT); }
  app.exit(0);
})();

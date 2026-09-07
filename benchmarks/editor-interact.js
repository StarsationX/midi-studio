// editor-interact.js: what the Editor costs to open and to touch, per document
// size, in a real Electron renderer.
//
//   npx electron benchmarks/editor-interact.js
//   npx electron benchmarks/editor-interact.js --json benchmarks/editor-interact.json
//   npx electron benchmarks/editor-interact.js --only 50k --size 1920x1080
//
// It loads renderer/review/index.html in a real window with the real preload,
// answers `review:load` with a document built by
// benchmarks/editor-load-candidate-lib.js (a real fixture, parsed to
// midi_document.py's exact contract, so the note distribution is a real
// transcription's and not a synthetic ramp), then drives the page and reports
// mean/p95/p99/max for:
//
//   open         click -> relayout done -> first roll paint, plus long tasks
//   scroll       one scrollLeft step per frame
//   zoom         one ctrl+wheel per frame
//   boxselect    a marquee sweeping thousands of notes, per pointermove
//   drag         a move-drag of the whole selection, per pointermove
//   velocity     one #n-vel-num commit over the selection
//   undo/redo    one click each
//   repaintrate  how many times the roll actually repaints per second DURING a
//                continuous gesture -- the number that says whether the picture
//                keeps up with the hand, which a per-frame cost cannot tell you
//   memory       renderer RSS and JS heap after open, and across five opens
//
// Timing method. Every measurement is split into the SYNCHRONOUS handler cost
// (the event listener, which is what blocks the next input) and the FRAME cost
// (the requestAnimationFrame callback that draws, which is what makes the
// picture late). Both are captured by wrapping window.requestAnimationFrame and
// marking the roll canvas's own clearRect, so nothing in renderer/ is modified
// to be measured. Memory is read two ways -- the renderer's JS heap from inside
// the page and the process working set from app.getAppMetrics() -- because the
// JS heap alone misses canvas backing stores and DOM.
//
// The drag probe needs a real note under the pointer, so the press point is
// COMPUTED from the document this harness itself supplied plus the geometry the
// page published in #roll-extent, rather than hunted for: KEY_W 60, TOP_H 26,
// ROW_H 14 (review.js's constants at default density) and
// zoom = (extentWidth - 220) / duration from contentW()'s own formula.
//
// One instance only: this opens its own window, never `npm start`, and destroys
// it in a finally.
'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures');
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const JSON_AT = flag('--json', '');
const ONLY = flag('--only', '');
const SIZE = flag('--size', '1600x1000').split('x').map(Number);
const SETTLE = Number(flag('--settle', '1000'));
// CPU profiling is opt-in. Attaching and detaching the DevTools debugger around
// every phase is what produced the per-function attribution below, and it is also
// what intermittently took the renderer down mid-run -- so the default pass is
// the robust one and `--profile` is the diagnostic one.
const WANT_PROFILE = argv.includes('--profile');

// --expose-gc makes the memory numbers mean something: a heap read without a
// collection first measures garbage, not retention.
app.commandLine.appendSwitch('js-flags', '--expose-gc');

const loadCandidate = require('./editor-load-candidate-lib.js');

const CASES = [
  { name: '2k', file: 'normal.mid' },
  { name: '10k', file: 'big-10k.mid' },
  { name: '50k', file: 'huge-50k.mid' },
  { name: '120k', file: 'massive-120k.mid' },
].filter((c) => !ONLY || c.file === ONLY || c.name === ONLY);

const OUT_DIR = path.join(os.homedir(), 'Documents', 'MIDI Studio');
let current = null;      // the document the review:load stub answers with

function payloadFor(doc) {
  return {
    projectPath: path.join(OUT_DIR, doc.name + '.midstudio.json'),
    project: {
      format: 'midi-studio-project', version: 1, name: doc.name,
      sourceAudio: '', previewAudio: '', pipeline: 'piano',
      selectedCandidate: 'clean', candidates: { clean: doc.path },
    },
    documents: { clean: doc },
  };
}

// review.js's calcBounds(), so the harness can compute a note's y itself.
function geometryFor(doc) {
  let lo = 127, hi = 0;
  for (const n of doc.notes) { if (n.pitch < lo) lo = n.pitch; if (n.pitch > hi) hi = n.pitch; }
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const pitchLow = clamp(lo - 3, 0, 72);
  const pitchHigh = clamp(hi + 3, pitchLow + 35, 127);
  let maxEnd = 0;
  for (const n of doc.notes) if (n.end > maxEnd) maxEnd = n.end;
  // The widest note in the first 5% of the song: a wide note is a press target
  // that cannot land on the resize edge by accident.
  const head = doc.notes.slice(0, Math.max(1, Math.ceil(doc.notes.length * 0.05)));
  let pick = head[0];
  for (const n of head) if ((n.end - n.start) > (pick.end - pick.start)) pick = n;
  return { pitchLow, pitchHigh, duration: Math.max(Number(doc.duration) || 0, maxEnd),
    note: { pitch: pick.pitch, start: pick.start, end: pick.end } };
}

const HANDLERS = {
  'app:getUi': () => ({ ok: true, ui: {} }),
  'app:settings': () => ({ ok: true, settings: {} }),
  'settings:get': () => ({ ok: true, value: null }),
  'settings:set': () => ({ ok: true }),
  'review:pick': () => (current ? current.path : ''),
  'review:load': () => ({ ok: true, data: payloadFor(current) }),
  'review:saveProject': () => ({ ok: true, projectPath: '', project: payloadFor(current).project }),
  'review:exportMidi': () => ({ ok: false, canceled: true }),
  'library:list': () => ({ dirs: [], extra: [], files: [], truncated: false }),
  'shell:openPath': () => ({ ok: true }),
};

// Every case destroys its window before the next one opens, and Electron's
// default is to quit the app the moment the last window goes. Without this the
// run silently ends after the first document.
app.on('window-all-closed', () => { /* the runner decides when to exit */ });

// Anything that kills this run has to say so. app.exit() does not flush stdout
// and a dead child process prints nothing on its own, so every fatal path is
// written straight to disk as well.
const FATAL_LOG = path.join(__dirname, 'editor-interact-fatal.log');
const chr10 = String.fromCharCode(10);
function fatal(what, detail) {
  const line = new Date().toISOString() + '  ' + what + '  ' + detail + chr10;
  try { fs.appendFileSync(FATAL_LOG, line); } catch (_) { /* nothing left to do */ }
  process.stderr.write('FATAL ' + line);
}
process.on('uncaughtException', (e) => fatal('uncaughtException', (e && e.stack) || String(e)));
process.on('unhandledRejection', (e) => fatal('unhandledRejection', (e && e.stack) || String(e)));
app.on('child-process-gone', (_e, d) => fatal('child-process-gone', JSON.stringify(d)));
app.on('render-process-gone', (_e, _wc, d) => fatal('render-process-gone', JSON.stringify(d)));

function registerStubs() {
  for (const [ch, fn] of Object.entries(HANDLERS)) {
    ipcMain.removeHandler(ch);
    ipcMain.handle(ch, async (_e, a) => {
      try { return await fn(a); } catch (e) { return { ok: false, error: String(e.message || e) }; }
    });
  }
  for (const ch of ['win:minimize', 'win:maximize', 'win:unmaximize', 'win:toggleMaximize', 'win:close']) {
    ipcMain.removeAllListeners(ch);
    ipcMain.on(ch, () => {});
  }
}

// ---------------------------------------------------------------------------
//  the in-page probe: installed AFTER the page has booted, removes nothing
// ---------------------------------------------------------------------------
const INSTALL = `(() => {
  if (window.__P) return 'already';
  const P = { frames: [], rollFrames: [], long: [], rollDraws: 0, _roll: false, lastRollAt: 0, rollAts: [] };
  window.__P = P;

  // Every draw in this app runs inside a requestAnimationFrame callback (the
  // Draw scheduler's run(), and review.js's own coalesce()). Wrapping rAF is a
  // complete census of frame JS cost with nothing in renderer/ touched.
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => raf((ts) => {
    P._roll = false;
    const t0 = performance.now();
    try { cb(ts); } finally {
      const ms = performance.now() - t0;
      P.frames.push(ms);
      if (P._roll) { P.rollFrames.push(ms); P.rollDraws++; P.lastRollAt = performance.now(); P.rollAts.push(P.lastRollAt); }
    }
  });

  // The roll canvas's own first operation each frame, so a frame can be
  // attributed to "the piano roll actually repainted".
  const rc = document.getElementById('roll').getContext('2d');
  const cr = rc.clearRect;
  rc.clearRect = function (a, b, c, d) { P._roll = true; return cr.call(this, a, b, c, d); };

  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) P.long.push(Math.round(e.duration * 10) / 10); })
      .observe({ entryTypes: ['longtask'] });
  } catch (_) {}

  P.reset = () => { P.frames.length = 0; P.rollFrames.length = 0; P.long.length = 0; P.rollDraws = 0; P.rollAts.length = 0; };
  // The two things that decide whether a repaint-rate number means anything.
  P.env = () => ({ focus: document.hasFocus(),
    budgetMs: (window.Draw && window.Draw.budgetMs) ? window.Draw.budgetMs() : -1 });
  P.rect = () => document.getElementById('roll').getBoundingClientRect();
  P.nextFrame = () => new Promise((r) => raf(() => raf(r)));
  P.heap = () => (performance.memory ? performance.memory.usedJSHeapSize : 0);
  P.gc = async () => { if (window.gc) { window.gc(); await new Promise((r) => setTimeout(r, 80)); window.gc(); } return P.heap(); };
  P.pe = (type, x, y, extra) => {
    document.getElementById('roll').dispatchEvent(new PointerEvent(type, Object.assign({
      bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: 'mouse',
      button: type === 'pointermove' ? -1 : 0, buttons: 1, clientX: x, clientY: y, isPrimary: true,
    }, extra || {})));
  };
  P.sel = () => Number(document.getElementById('sel-count').textContent.replace(/[^0-9]/g, '')) || 0;
  // review.js's own geometry, recovered from what the page published.
  P.geom = (g) => {
    const KEY_W = 60, TOP_H = 26;
    const ROW_H = document.documentElement.dataset.density === 'compact' ? 12 : 14;
    const w = parseFloat(document.getElementById('roll-extent').style.width) || 0;
    const zoom = g.duration > 0 ? (w - (KEY_W + 160)) / g.duration : 85;
    const host = document.getElementById('roll-scroll');
    const r = P.rect();
    // Inside the note, not past its end: hitNote() converts x back to a time and
    // requires the note to still be sounding there, and a transcription's notes
    // are only a few pixels wide at the default zoom.
    const wpx = Math.max(1, (g.note.end - g.note.start) * zoom);
    return {
      zoom, ROW_H, wpx,
      x: r.left + KEY_W + g.note.start * zoom - host.scrollLeft + Math.min(3, wpx * 0.5),
      y: r.top + TOP_H + (g.pitchHigh - g.note.pitch) * ROW_H - host.scrollTop + ROW_H * 0.5,
    };
  };
  P.undoAll = () => { const u = document.getElementById('undo'); let n = 0; while (!u.disabled && n < 500) { u.click(); n++; } return n; };
  P.dirty = () => !document.getElementById('a-save').disabled &&
    (document.getElementById('status-chip') || { textContent: '' }).textContent.indexOf('nsaved') >= 0;
  // A press point that actually lands on a note. The computed point from
  // P.geom() is tried first; the small sweep after it is a fallback, not the
  // plan, and the result says which one was used. "Landed on a note" is proved
  // by the app's own behaviour: a move-drag pushes an undo entry, a marquee
  // does not.
  P.findGrip = (g) => {
    const gm = P.geom(g);
    const u = document.getElementById('undo');
    // Offsets are fractions of the note's own width, because at the default zoom
    // a transcribed 1/32 note is under three pixels wide.
    const tries = [0, gm.wpx * 0.25, gm.wpx * 0.5, -0.5, 1, 2];
    for (let i = 0; i < tries.length; i++) {
      const x = gm.x + tries[i] - Math.min(3, gm.wpx * 0.5), y = gm.y;
      P.pe('pointerdown', x, y);
      P.pe('pointermove', x + 8, y);
      P.pe('pointerup', x + 8, y);
      // The undo button's disabled state is only refreshed by syncUi(), which a
      // pointermove never calls -- so it can only be read after the release.
      const ok = !u.disabled;
      P.undoAll();
      if (ok) return { x, y, ROW_H: gm.ROW_H, zoom: gm.zoom, wpx: gm.wpx, tries: i + 1 };
    }
    return null;
  };
  // A gesture paced by the wall clock, not by rAF: a real mouse reports at
  // 60-1000 Hz regardless of what the renderer manages to draw, and pacing the
  // probe off rAF would hide exactly the repaint starvation being measured.
  P.sweep = async (ms, step) => {
    const h = [];
    const t0 = performance.now();
    let i = 0;
    while (performance.now() - t0 < ms) {
      i++;
      const t = performance.now();
      step(i);
      h.push(performance.now() - t);
      await new Promise((r) => setTimeout(r, 8));
    }
    return { handler: h, spanMs: performance.now() - t0, steps: i };
  };
  // The harness drives repeated opens; the app's own guard would put up a modal
  // the harness cannot answer. Nothing else about the page is changed.
  window.confirm = () => true;
  return 'ok';
})()`;

// Each measurement returns { handler: [...], frame: [...] } so the two halves
// are never averaged together.
const PROBES = {
  // The IPC hop on its own: main answers review:load from memory here, so what
  // this measures is the structured clone of the document across the process
  // boundary and its deserialisation in the renderer -- the part of "opening"
  // that no amount of renderer work can remove, and which has to be subtracted
  // before the rest of the open path can be blamed for anything.
  ipcOnly: (p) => `(async () => {
    const P = window.__P;
    const runs = [];
    let notes = 0;
    for (let i = 0; i < 5; i++) {
      const t = performance.now();
      const r = await window.review.load(${JSON.stringify('')} || 'x');
      runs.push(performance.now() - t);
      notes = r && r.data && r.data.documents.clean.notes.length || 0;
      await P.nextFrame();
    }
    return { runs, notes };
  })()`,

  open: () => `(async () => {
    const P = window.__P; P.reset();
    const ext = document.getElementById('roll-extent');
    let layoutAt = 0;
    const mo = new MutationObserver(() => { if (!layoutAt) layoutAt = performance.now(); });
    mo.observe(ext, { attributes: true, attributeFilter: ['style'] });
    const t0 = performance.now();
    document.getElementById('empty-open').click();
    // relayout() is the last synchronous step of openPath and the only thing
    // that writes #roll-extent's style, so its mutation means "the document is
    // indexed, the geometry is known, every panel has been rebuilt".
    const deadline = t0 + 40000;
    while (!layoutAt && performance.now() < deadline) await new Promise((r) => setTimeout(r, 2));
    mo.disconnect();
    while (!P.rollDraws && performance.now() < deadline) await P.nextFrame();
    return {
      layoutMs: layoutAt - t0, firstPaintMs: P.lastRollAt - t0,
      rollFrames: P.rollFrames.slice(), long: P.long.slice(),
      laneNote: document.getElementById('lane-note').textContent,
      tracks: document.getElementById('tracks-count').textContent,
      extent: ext.style.width, drawStats: window.Draw.stats(),
    };
  })()`,

  scroll: () => `(async () => {
    const P = window.__P;
    const host = document.getElementById('roll-scroll');
    host.scrollLeft = 0;
    await P.nextFrame(); P.reset();
    const s = await P.sweep(1500, () => { host.scrollLeft = host.scrollLeft + 40; });
    return { handler: s.handler, frame: P.rollFrames.slice(), all: P.frames.slice(),
      long: P.long.slice(), spanMs: s.spanMs, steps: s.steps, rollDraws: P.rollDraws, env: P.env() };
  })()`,

  zoom: () => `(async () => {
    const P = window.__P; P.reset();
    const host = document.getElementById('roll-scroll');
    const r = host.getBoundingClientRect();
    const s = await P.sweep(1500, (i) => {
      host.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true,
        deltaY: (i % 20 < 10 ? -1 : 1) * 120, clientX: r.left + r.width * 0.5, clientY: r.top + r.height * 0.5 }));
    });
    return { handler: s.handler, frame: P.rollFrames.slice(), all: P.frames.slice(),
      long: P.long.slice(), spanMs: s.spanMs, steps: s.steps, rollDraws: P.rollDraws, env: P.env() };
  })()`,

  // A marquee dragged across the whole visible roll: the selection grows by
  // hundreds of notes per move, and every move re-runs the selection stats, the
  // note fields and the button gating.
  boxselect: () => `(async () => {
    const P = window.__P;
    document.getElementById('roll-scroll').scrollLeft = 0;
    document.getElementById('s-none').click();
    await P.nextFrame(); P.reset();
    const r = P.rect();
    const x0 = r.left + 70, y0 = r.top + 30;
    P.pe('pointerdown', x0, y0);
    const s = await P.sweep(1500, (i) => {
      const f = Math.min(1, i / 120);
      P.pe('pointermove', x0 + (r.width - 80) * f, y0 + (r.height - 40) * f);
    });
    const count = P.sel();
    const tu = performance.now();
    P.pe('pointerup', r.right - 10, r.bottom - 10);
    const up = performance.now() - tu;
    await P.nextFrame();
    return { handler: s.handler, frame: P.rollFrames.slice(), all: P.frames.slice(),
      long: P.long.slice(), selected: count, upMs: up, spanMs: s.spanMs, steps: s.steps,
      rollDraws: P.rollDraws, env: P.env() };
  })()`,

  // The same marquee, but with the take fitted on screen first (#z-fit, Ctrl+0),
  // so the sweep really does cross thousands of notes instead of the ~20 that are
  // visible at the default zoom on a long transcription. This is the box-select
  // the brief is about.
  boxselectfit: () => `(async () => {
    const P = window.__P;
    document.getElementById('s-none').click();
    document.getElementById('z-fit').click();
    await P.nextFrame(); await P.nextFrame();
    P.reset();
    const r = P.rect();
    const x0 = r.left + 70, y0 = r.top + 30;
    P.pe('pointerdown', x0, y0);
    const s = await P.sweep(1500, (i) => {
      const f = Math.min(1, i / 120);
      P.pe('pointermove', x0 + (r.width - 80) * f, y0 + (r.height - 40) * f);
    });
    const count = P.sel();
    const tu = performance.now();
    P.pe('pointerup', r.right - 10, r.bottom - 10);
    const up = performance.now() - tu;
    await P.nextFrame();
    return { handler: s.handler, frame: P.rollFrames.slice(), all: P.frames.slice(),
      long: P.long.slice(), selected: count, upMs: up, spanMs: s.spanMs, steps: s.steps,
      rollDraws: P.rollDraws, env: P.env(), zoom: Number(document.getElementById('zoom').value) };
  })()`,

  // Everything selected, then dragged. A stall here is what makes an editor feel
  // broken. The press point is computed from the document this harness supplied
  // and then confirmed against the app's own behaviour before it is measured.
  drag: (g) => `(async () => {
    const P = window.__P;
    document.getElementById('roll-scroll').scrollLeft = 0;
    document.getElementById('roll-scroll').scrollTop = 0;
    document.getElementById('s-all').click();
    await P.nextFrame();
    const selected = P.sel();
    const grip = P.findGrip(${JSON.stringify(g)});
    if (!grip) return { skipped: 'no note found under the computed press point or its sweep', selected };
    document.getElementById('s-all').click();
    await P.nextFrame(); P.reset();
    P.pe('pointerdown', grip.x, grip.y);
    const s = await P.sweep(1500, (i) => {
      P.pe('pointermove', grip.x + (i % 40) * 6, grip.y + ((i % 9) - 4) * grip.ROW_H);
    });
    const tu = performance.now();
    P.pe('pointerup', grip.x + 60, grip.y);
    const up = performance.now() - tu;
    await P.nextFrame();
    const undone = P.undoAll();
    return { handler: s.handler, frame: P.rollFrames.slice(), all: P.frames.slice(),
      long: P.long.slice(), selected, dragStarted: undone > 0, upMs: up, spanMs: s.spanMs,
      steps: s.steps, rollDraws: P.rollDraws, env: P.env(), grip };
  })()`,

  velocity: () => `(async () => {
    const P = window.__P;
    document.getElementById('s-all').click();
    await P.nextFrame();
    const selected = P.sel();
    P.reset();
    const el = document.getElementById('n-vel-num');
    const h = [];
    for (let i = 0; i < 12; i++) {
      el.value = String(60 + i);
      const t = performance.now();
      el.dispatchEvent(new Event('change', { bubbles: true }));
      h.push(performance.now() - t);
      await P.nextFrame();
    }
    return { handler: h, frame: P.rollFrames.slice(), all: P.frames.slice(), long: P.long.slice(), selected };
  })()`,

  undoredo: () => `(async () => {
    const P = window.__P; P.reset();
    const u = document.getElementById('undo'), r = document.getElementById('redo');
    const un = [], re = [];
    for (let i = 0; i < 10 && !u.disabled; i++) {
      const t = performance.now(); u.click(); un.push(performance.now() - t);
      await P.nextFrame();
    }
    const uf = P.rollFrames.slice(); const ul = P.long.slice(); P.reset();
    for (let i = 0; i < 10 && !r.disabled; i++) {
      const t = performance.now(); r.click(); re.push(performance.now() - t);
      await P.nextFrame();
    }
    return { undo: un, redo: re, undoFrames: uf, redoFrames: P.rollFrames.slice(),
      long: ul.concat(P.long) };
  })()`,

  // How often the roll ACTUALLY repaints while a gesture is in progress. A
  // per-frame cost of 3ms is meaningless if the frame only happens 4 times a
  // second: the picture is then a quarter-second behind the hand.
  // The one case that lifts the idle clamp today, kept as the control: if the
  // roll repaints at ~30 fps here and at 4 fps during a drag, the gesture rate is
  // the scheduler's idle clamp and not the cost of the draw.
  playbackrate: () => `(async () => {
    const P = window.__P;
    document.getElementById('s-none').click();
    await P.nextFrame(); P.reset();
    const Tr = window.Transport;
    if (!(Tr && Tr.isOwner && Tr.isOwner('editor'))) {
      return { skipped: 'transport not owned by the editor in an isolated frame' };
    }
    Tr.toggle();
    const t0 = performance.now();
    await new Promise((r) => setTimeout(r, 2000));
    const out = { seconds: (performance.now() - t0) / 1000, rollDraws: P.rollDraws, env: P.env(),
      playbackActive: window.Draw.isPlaybackActive(), drawStats: window.Draw.stats() };
    Tr.toggle();
    await P.nextFrame();
    return out;
  })()`,

  // One open, driven from the harness. The heap is then read from OUTSIDE the
  // page over the DevTools protocol, because performance.memory in a renderer is
  // deliberately coarse (it quantises to ~10 MB) and window.gc may not exist --
  // both of which make an in-page heap read useless for a retention question.
  openAgain: () => `(async () => {
    const P = window.__P;
    document.getElementById('empty-open').click();
    await new Promise((r) => setTimeout(r, 1200));
    await P.nextFrame();
    return { notes: document.getElementById('lane-note').textContent };
  })()`,
};

// ---------------------------------------------------------------------------
function stats(samples) {
  const s = (samples || []).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!s.length) return null;
  const at = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, mean: s.reduce((a, b) => a + b, 0) / s.length,
    p50: at(0.5), p95: at(0.95), p99: at(0.99), max: s[s.length - 1] };
}
const f2 = (v) => (v === null || v === undefined ? '       -' : v.toFixed(v < 10 ? 2 : 1).padStart(8));
function line(label, s) {
  if (!s) return console.log('    ' + label.padEnd(24) + '  (no samples)');
  console.log('    ' + label.padEnd(24) + ' mean' + f2(s.mean) + '  p95' + f2(s.p95) +
    '  p99' + f2(s.p99) + '  max' + f2(s.max) + '  ms  (n=' + s.n + ')');
}
// A real CPU profile of one phase, via the DevTools protocol, aggregated by
// self time. This is how "the open path costs 120 ms" becomes "and here are the
// six functions it is in", without adding a single timer to renderer/.
async function profiled(win, fn, topN) {
  const dbg = win.webContents.debugger;
  const INTERVAL_US = 100;
  await dbg.sendCommand('Profiler.enable');
  await dbg.sendCommand('Profiler.setSamplingInterval', { interval: INTERVAL_US });
  await dbg.sendCommand('Profiler.start');
  const result = await fn();
  const { profile } = await dbg.sendCommand('Profiler.stop');
  await dbg.sendCommand('Profiler.disable');

  const rows = [];
  let total = 0;
  for (const n of profile.nodes) {
    const ms = (n.hitCount || 0) * INTERVAL_US / 1000;
    total += ms;
    if (!ms) continue;
    const cf = n.callFrame || {};
    const file = String(cf.url || '').split(/[\\/]/).pop() || '(vm)';
    rows.push({ fn: (cf.functionName || '(anonymous)') + '  ' + file + ':' + ((cf.lineNumber || 0) + 1), ms });
  }
  const byName = new Map();
  for (const r of rows) byName.set(r.fn, (byName.get(r.fn) || 0) + r.ms);
  const top = [...byName.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN || 12)
    .map(([fn, ms]) => ({ fn, ms: Math.round(ms * 10) / 10, pct: Math.round(ms / Math.max(total, 0.001) * 1000) / 10 }));
  return { result, totalSampledMs: Math.round(total * 10) / 10, top };
}

// Precise heap, from outside the page: performance.memory is quantised and
// window.gc is not guaranteed, so the retention question is answered over the
// DevTools protocol instead.
async function heapUsed(win, collect) {
  const dbg = win.webContents.debugger;
  let mine = false;
  try { dbg.attach('1.3'); mine = true; } catch (_) { /* already attached by the caller */ }
  try {
    if (collect) {
      await dbg.sendCommand('HeapProfiler.enable');
      await dbg.sendCommand('HeapProfiler.collectGarbage');
      await dbg.sendCommand('HeapProfiler.collectGarbage');
      await dbg.sendCommand('HeapProfiler.disable');
    }
    const r = await dbg.sendCommand('Runtime.getHeapUsage');
    return Math.round(r.usedSize);
  } catch (_) {
    return 0;
  } finally {
    if (mine) { try { dbg.detach(); } catch (_) { /* fine */ } }
  }
}

function rendererRss(win) {
  try {
    const pid = win.webContents.getOSProcessId();
    const m = app.getAppMetrics().find((x) => x.pid === pid);
    return m && m.memory ? m.memory.workingSetSize * 1024 : 0;
  } catch (_) { return 0; }
}

async function runCase(c, report) {
  const full = path.join(FIXTURES, c.file);
  current = loadCandidate(fs.readFileSync(full), full);
  const geom = geometryFor(current);
  const docBytes = JSON.stringify(current).length;
  console.log('\n' + '='.repeat(78));
  console.log('  ' + c.name + '  ' + c.file + '  ' + current.notes.length.toLocaleString() +
    ' notes  ' + (docBytes / 1e6).toFixed(2) + ' MB as json');
  console.log('='.repeat(78));

  let win = null;
  const row = { case: c.name, file: c.file, notes: current.notes.length, docJsonBytes: docBytes };
  try {
    win = new BrowserWindow({
      width: SIZE[0], height: SIZE[1], show: true, frame: false, backgroundColor: '#141519',
      webPreferences: {
        preload: path.join(ROOT, 'electron', 'preload.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: false,
        nodeIntegrationInSubFrames: true, backgroundThrottling: false,
      },
    });
    // FOCUS, explicitly. draw.js's input 2 clamps an unfocused window's frame
    // budget to 250ms, so a harness window that another app stole focus from
    // reports 4.0 fps for every gesture regardless of what the code under test
    // does -- which is exactly the number this file exists to measure. Two runs
    // of the identical build differed 4.0 fps vs 29.3 fps on nothing but focus,
    // so every gesture row now carries the focus state and the live budget with
    // it and an unfocused run announces itself.
    win.focus();
    win.webContents.focus();
    const errs = [];
    win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) errs.push(msg); });
    win.webContents.on('render-process-gone', (_e, d) => {
      errs.push('render-process-gone: ' + (d && d.reason) + ' exit ' + (d && d.exitCode));
      console.log('  !! RENDERER GONE: ' + (d && d.reason));
    });
    // One attach for the whole case: repeatedly attaching and detaching the
    // DevTools debugger mid-run was enough to take the process down at 120k.
    if (WANT_PROFILE) { try { win.webContents.debugger.attach('1.3'); } catch (_) { /* already attached */ } }
    await win.loadFile(path.join(ROOT, 'renderer', 'review', 'index.html'));
    await new Promise((r) => setTimeout(r, SETTLE));
    const ex = (js) => win.webContents.executeJavaScript(js, true);
    await ex(INSTALL);

    row.heapEmpty = await heapUsed(win, true);
    row.rssEmpty = rendererRss(win);

    const ipc = await ex(PROBES.ipcOnly());
    row.ipcOnly = stats(ipc.runs);
    console.log('  IPC HOP  review.load() round trip, main answers from memory');
    line('structured clone', row.ipcOnly);

    const prof = WANT_PROFILE ? await profiled(win, () => ex(PROBES.open()), 14)
      : { result: await ex(PROBES.open()), totalSampledMs: 0, top: null };
    const open = prof.result;
    if (prof.top) row.openProfile = { totalSampledMs: prof.totalSampledMs, top: prof.top };
    row.open = { layoutMs: open.layoutMs, firstPaintMs: open.firstPaintMs,
      rollFrames: stats(open.rollFrames), longTasks: open.long,
      laneNote: open.laneNote, tracks: open.tracks, extent: open.extent, drawStats: open.drawStats };
    console.log('  OPEN  (review:load is answered from memory, so this is renderer cost only)');
    console.log('    click -> relayout done    ' + open.layoutMs.toFixed(1) + ' ms');
    console.log('    click -> first roll paint ' + open.firstPaintMs.toFixed(1) + ' ms');
    console.log('    long tasks during open    [' + open.long.join(', ') + ']');
    line('open-path roll frame', stats(open.rollFrames));
    if (prof.top) {
      console.log('    CPU profile of the open path (' + prof.totalSampledMs + ' ms sampled, self time):');
      for (const t of prof.top) console.log('      ' + String(t.ms).padStart(7) + ' ms  ' + String(t.pct).padStart(5) + '%  ' + t.fn);
    }
    row.heapAfterOpen = await heapUsed(win, true);
    row.rssAfterOpen = rendererRss(win);
    console.log('    js heap    ' + ((row.heapAfterOpen - row.heapEmpty) / 1e6).toFixed(1) +
      ' MB over empty (' + (row.heapAfterOpen / 1e6).toFixed(1) + ' MB total)');
    console.log('    renderer rss ' + ((row.rssAfterOpen - row.rssEmpty) / 1e6).toFixed(1) +
      ' MB over empty (' + (row.rssAfterOpen / 1e6).toFixed(1) + ' MB total)');

    // Retention first, while the DevTools debugger has been let go: driving five
    // opens with a profiler attached and a heap collection between each was
    // enough to take the renderer down, and a harness that crashes measures
    // nothing.
    if (WANT_PROFILE) { try { win.webContents.debugger.detach(); } catch (_) { /* fine */ } }
    const heaps = [row.heapAfterOpen];
    let memErr = '';
    for (let i = 0; i < 4; i++) {
      try { await ex(PROBES.openAgain()); } catch (e) { memErr = String(e && e.message || e); break; }
      heaps.push(await heapUsed(win, true));
    }
    row.repeatedOpenHeap = heaps;
    row.rssAfterRepeats = rendererRss(win);
    const drift = (heaps[heaps.length - 1] - heaps[0]) / 1e6;
    row.repeatDriftMB = drift;
    console.log('  MEMORY across ' + heaps.length + ' repeated opens of the same document (gc between)');
    console.log('    js heap after each (MB): ' + heaps.map((o) => (o / 1e6).toFixed(1)).join('  '));
    console.log('    drift open 1 -> open ' + heaps.length + ': ' + (drift >= 0 ? '+' : '') + drift.toFixed(1) + ' MB');
    console.log('    renderer rss after:      ' + (row.rssAfterRepeats / 1e6).toFixed(1) + ' MB');
    if (memErr) console.log('    (repeat opens stopped early: ' + memErr + ')');

    if (WANT_PROFILE) { try { win.webContents.debugger.attach('1.3'); } catch (_) { /* fine */ } }

    for (const key of ['scroll', 'zoom', 'boxselect', 'boxselectfit', 'drag', 'velocity', 'undoredo']) {
      let r, gprof = null;
      try {
        // The three gestures whose cost scales with the document get a CPU
        // profile as well, so "8.8 ms per velocity commit" comes with the list
        // of functions it is in.
        if (WANT_PROFILE && (key === 'drag' || key === 'velocity' || key === 'undoredo' || key === 'boxselectfit')) {
          const pr2 = await profiled(win, () => ex(PROBES[key](geom)), 10);
          r = pr2.result; gprof = { totalSampledMs: pr2.totalSampledMs, top: pr2.top };
        } else {
          r = await ex(PROBES[key](geom));
        }
      }
      catch (e) { row[key] = { failed: String(e && e.message || e) }; console.log('  ' + key.toUpperCase() + '  FAILED: ' + row[key].failed); continue; }
      if (r.skipped) { row[key] = r; console.log('  ' + key.toUpperCase() + '  SKIPPED: ' + r.skipped); continue; }
      if (key === 'undoredo') {
        row[key] = { undo: stats(r.undo), redo: stats(r.redo),
          undoFrames: stats(r.undoFrames), redoFrames: stats(r.redoFrames), long: r.long };
        console.log('  UNDO / REDO');
        line('undo click (sync)', row[key].undo);
        line('undo frame', row[key].undoFrames);
        line('redo click (sync)', row[key].redo);
        line('redo frame', row[key].redoFrames);
        if (r.long.length) console.log('    long tasks [' + r.long.join(', ') + ']');
        if (gprof) {
          row[key].profile = gprof;
          console.log('    CPU profile (' + gprof.totalSampledMs + ' ms sampled, self time):');
          for (const t of gprof.top) console.log('      ' + String(t.ms).padStart(7) + ' ms  ' + String(t.pct).padStart(5) + '%  ' + t.fn);
        }
        continue;
      }
      row[key] = { handler: stats(r.handler), frame: stats(r.frame), allFrames: stats(r.all),
        selected: r.selected, grabbed: r.grabbed, dragStarted: r.dragStarted,
        upMs: r.upMs, spanMs: r.spanMs, rollDraws: r.rollDraws, long: r.long, geom: r.geom };
      const tag = r.selected !== undefined ? '  (' + r.selected.toLocaleString() + ' notes selected)' : '';
      console.log('  ' + key.toUpperCase() + tag +
        (key === 'drag' ? '  dragStarted=' + r.dragStarted : ''));
      line('handler (blocks input)', row[key].handler);
      line('roll repaint frame', row[key].frame);
      if (r.rollDraws !== undefined && r.spanMs) {
        console.log('    roll repaints            ' + r.rollDraws + ' in ' + (r.spanMs / 1000).toFixed(2) +
          ' s  = ' + (r.rollDraws / (r.spanMs / 1000)).toFixed(1) + ' fps' +
          (r.env ? '   [focus=' + r.env.focus + ' budget=' + r.env.budgetMs + 'ms]' : ''));
      }
      if (r.upMs !== undefined) console.log('    release (pointerup)      ' + r.upMs.toFixed(1) + ' ms');
      if (r.long && r.long.length) console.log('    long tasks [' + r.long.join(', ') + ']');
      if (gprof) {
        row[key].profile = gprof;
        console.log('    CPU profile (' + gprof.totalSampledMs + ' ms sampled, self time):');
        for (const t of gprof.top) console.log('      ' + String(t.ms).padStart(7) + ' ms  ' + String(t.pct).padStart(5) + '%  ' + t.fn);
      }
    }

    let pr;
    try { pr = await ex(PROBES.playbackrate()); }
    catch (e) { pr = { skipped: 'probe threw: ' + String(e && e.message || e) }; }
    row.playbackRate = pr;
    if (pr.skipped) {
      console.log('  PLAYBACK REPAINT RATE  skipped: ' + pr.skipped);
    } else {
      console.log('  PLAYBACK REPAINT RATE (the control: setLive(true) is only called here)');
      console.log('    ' + pr.rollDraws + ' roll repaints in ' + pr.seconds.toFixed(2) + ' s  = ' +
        (pr.rollDraws / pr.seconds).toFixed(1) + ' fps   Draw.budgetMs=' + pr.drawStats.budgetMs);
    }

    if (errs.length) { row.console = errs; console.log('  CONSOLE: ' + errs.slice(0, 6).join(' | ')); }
  } catch (err) {
    row.failed = String(err && err.message || err);
    console.log('  CASE FAILED: ' + row.failed);
  } finally {
    try { if (win && !win.isDestroyed()) win.webContents.debugger.detach(); } catch (_) { /* fine */ }
    try { if (win && !win.isDestroyed()) win.destroy(); } catch (_) { /* fine */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  report.push(row);
}

app.whenReady().then(async () => {
  registerStubs();
  const report = [];
  for (const c of CASES) await runCase(c, report);

  if (JSON_AT) {
    fs.writeFileSync(path.resolve(JSON_AT), JSON.stringify({ at: new Date().toISOString(),
      electron: process.versions.electron, chrome: process.versions.chrome,
      size: SIZE.join('x'), cases: report }, null, 2));
    console.log('\nwrote ' + path.resolve(JSON_AT));
  }
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });

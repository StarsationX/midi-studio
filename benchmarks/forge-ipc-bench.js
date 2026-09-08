// forge-ipc-bench.js -- repeatable numbers for Forge orchestration, IPC fan-out
// volume, main-process responsiveness while a job streams, and memory over a
// long session.
//
//   npx electron benchmarks/forge-ipc-bench.js
//   npx electron benchmarks/forge-ipc-bench.js --json benchmarks/forge-ipc.json
//   npx electron benchmarks/forge-ipc-bench.js --only fanout,pump,lag,run,memory
//   npx electron benchmarks/forge-ipc-bench.js --only run --run-seconds 240
//   npx electron benchmarks/forge-ipc-bench.js --cycles 6      (memory group)
//
// WHY IT IS SHAPED LIKE THIS
//
//  * It runs the REAL renderer. One BrowserWindow loads renderer/index.html with
//    the real preload, so the shell and all six tab iframes are the real
//    documents with their real listeners. main.js is NOT booted (it would spawn
//    the sidecar, scan the disk and open the app window); every channel main.js
//    answers is stubbed here, enumerated straight out of main.js's source so a
//    new channel can never be silently missing.
//  * It runs the REAL ForgeRunner (electron/forge-runner.js), including its \r/\n
//    pump, its stage table, its keyword fallback and its emit path. The only
//    substitution is the interpreter: paths.forgeEnvPython() is pointed at this
//    Electron binary in ELECTRON_RUN_AS_NODE mode and paths.pythonEngineDir() at
//    a scratch dir holding a fake pipeline script, so a job can be replayed
//    without a GPU, without a model and without touching transcription.
//  * It runs the REAL PlayerSidecar (electron/sidecar.js) against a REAL Python
//    heartbeat that emits NDJSON progress packets at 20 Hz with wall-clock
//    timestamps, which is the shape ipc_main.py emits during playback. The
//    arrival error of those packets in the main process IS the "is the main
//    thread still responsive while Forge streams" number, and it is measured
//    with Forge idle and with Forge streaming at several line rates.
//  * broadcast() is duplicated here from main.js rather than imported, because
//    main.js cannot be required without booting the app. assertFanoutStillMatches()
//    fails the run if main.js stops walking mainFrame.framesInSubtree, so the
//    copy cannot silently drift from the thing it stands in for.
'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : ''; };
const ONLY = flag('--only') ? flag('--only').split(',').map((s) => s.trim()).filter(Boolean) : null;
const JSON_AT = flag('--json');
const CYCLES = Number(flag('--cycles')) || 4;
const want = (g) => !ONLY || ONLY.includes(g);

const SCRATCH = path.join(os.tmpdir(), 'midi-studio-forge-bench');
fs.rmSync(SCRATCH, { recursive: true, force: true });
fs.mkdirSync(SCRATCH, { recursive: true });

// ===========================================================================
//  stats
// ===========================================================================
function stats(samples) {
  if (!samples.length) return { n: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  const s = [...samples].sort((a, b) => a - b);
  const at = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return {
    n: s.length,
    mean: s.reduce((a, b) => a + b, 0) / s.length,
    p50: at(0.5), p95: at(0.95), p99: at(0.99), max: s[s.length - 1],
  };
}
const now = () => Number(process.hrtime.bigint()) / 1e6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RESULTS = {};
const record = (group, row) => { (RESULTS[group] || (RESULTS[group] = [])).push(row); return row; };

// ===========================================================================
//  event-loop lag sampler -- the main process's own responsiveness
// ===========================================================================
// A 5 ms timer that records how late it actually fired. This is the cheapest
// honest proxy for "could the main thread have serviced the sidecar right now".
function lagSampler(intervalMs = 5) {
  const samples = [];
  let last = now();
  const t = setInterval(() => {
    const n = now();
    samples.push(Math.max(0, n - last - intervalMs));
    last = n;
  }, intervalMs);
  return { samples, stop: () => clearInterval(t) };
}

// ===========================================================================
//  IPC stubs -- every channel main.js answers, enumerated from its source
// ===========================================================================
const OUT_DIR = path.join(os.homedir(), 'Documents', 'MIDI Studio');
const SONGS = ['Clair de Lune', 'River Flows In You', 'Nocturne Op. 9 No. 2'];

function makeDocument(name, filePath, count) {
  const notes = [];
  let t = 0;
  for (let i = 0; i < count; i++) {
    const dur = 0.11 + ((i * 37) % 9) * 0.045;
    notes.push({
      id: 'n' + (i + 1), pitch: 36 + ((i * 7 + (i % 13) * 3) % 52),
      start: Number(t.toFixed(6)), end: Number((t + dur).toFixed(6)),
      velocity: 52 + ((i * 11) % 60), channel: i % 4 === 0 ? 1 : 0,
    });
    if (i % 3 === 2) t += 0.128;
  }
  return { path: filePath, name, bpm: 138.462, bpmEstimated: true,
    duration: Number((t + 2).toFixed(6)), programs: { 0: 0, 1: 0 }, notes };
}

// Big on purpose: the memory group opens and closes this repeatedly, and a
// retained 30k-note document is exactly the leak being hunted.
const BIG_NOTES = Number(flag('--doc-notes')) || 30000;
let docSeq = 0;
function reviewPayload() {
  docSeq += 1;                                     // a NEW object graph each open
  const nm = SONGS[docSeq % SONGS.length] + ' #' + docSeq;
  const p = path.join(OUT_DIR, nm + '.mid');
  const clean = makeDocument(nm, p, BIG_NOTES);
  const quant = makeDocument(nm, path.join(OUT_DIR, nm + '_q.mid'), BIG_NOTES);
  return {
    projectPath: path.join(OUT_DIR, nm + '.midstudio.json'),
    project: { format: 'midi-studio-project', version: 1, name: nm,
      sourceAudio: '', previewAudio: '', pipeline: 'piano',
      createdAt: new Date().toISOString(), selectedCandidate: 'clean',
      candidates: { clean: p, quantised: quant.path } },
    documents: { clean, quantised: quant },
  };
}

const LIB_FILES = Array.from({ length: 400 }, (_, i) => ({
  path: path.join(OUT_DIR, SONGS[i % SONGS.length] + ' ' + i + '.mid'),
  name: SONGS[i % SONGS.length] + ' ' + i + '.mid',
  dir: OUT_DIR, size: 8000 + i * 37, mtime: Date.now() - i * 60000,
}));

const UI = { lastTab: 'forge', splits: {}, notesShownFor: '' };
const PERF = { percent: 100, whenGaming: 'ease', lowPriority: false, advanced: { threads: null, batch: null } };
const FORGE_SETTINGS = { pipeline: 'piano', skipSeparation: false, advanced: {}, outputDir: OUT_DIR, timing: {} };

const OVERRIDES = {
  'app:version': () => require(path.join(ROOT, 'package.json')).version,
  'app:release': () => ({ name: 'Graphite', version: require(path.join(ROOT, 'package.json')).version }),
  'app:getUi': () => JSON.parse(JSON.stringify(UI)),
  'app:setUi': (p) => Object.assign(UI, p || {}),
  'app:bootState': () => ({ done: true, milestones: [] }),
  'app:changelog': () => { try { return { ok: true, text: fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf-8') }; } catch { return { ok: false, error: 'missing' }; } },
  'app:whatsNew': () => ({ show: false, version: '' }),
  'app:notesShown': () => ({ ok: true }),
  'app:performance': () => JSON.parse(JSON.stringify(PERF)),
  'app:setPerformance': (p) => Object.assign(PERF, p || {}),
  'app:forgeInfo': () => ({ ready: true, forgeEnvDir: path.join(SCRATCH, 'forge-env'), freeGb: 220, gpu: 'bench (no GPU used)' }),
  'app:getLibraryDir': () => OUT_DIR,
  'app:getOutputDir': () => OUT_DIR,
  'app:listMidis': () => LIB_FILES.map((f) => f.path),
  'update:check': () => ({ state: 'none', current: require(path.join(ROOT, 'package.json')).version }),
  'win:state': () => ({ maximized: false, fullScreen: false }),
  'overlay:state': () => ({ open: false, bounds: null, config: { open: false } }),
  'overlay:toggle': () => ({ open: false, config: { open: false } }),
  'engine:send': () => true,
  'forge:check': () => ({ forgeReady: true, forgePython: process.execPath, gpu: 'bench (no GPU used)', torch: true, missing: [] }),
  'forge:getSettings': () => JSON.parse(JSON.stringify(FORGE_SETTINGS)),
  'forge:setSettings': (p) => Object.assign(FORGE_SETTINGS, p || {}),
  'forge:run': () => ({ ok: true, jobId: 'job-bench' }),
  'forge:cancel': () => true,
  'forge:pause': () => true,
  'library:list': () => ({ dirs: [OUT_DIR], extra: [], files: LIB_FILES, truncated: false }),
  'library:scan': () => ({ scanId: 1, dirs: [OUT_DIR], extra: [], files: LIB_FILES, truncated: false,
    storage: { totalBytes: 12e6, files: LIB_FILES.length }, tags: {}, usage: {}, indexing: false }),
  'library:meta': () => ({ meta: {} }),
  'library:index': () => ({ ok: true, total: 0 }),
  'review:pick': () => path.join(OUT_DIR, SONGS[0] + '.midstudio.json'),
  'review:load': () => { if (LOAD_COUNTER.review) LOAD_COUNTER.review(); return { ok: true, data: reviewPayload() }; },
  'review:saveProject': () => ({ ok: true }),
  'review:exportMidi': () => ({ ok: true, path: '' }),
};

const LOAD_COUNTER = {};
let ipcCalls = 0;
function registerStubs() {
  const src = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf-8');
  const handles = [...src.matchAll(/ipcMain\.handle\('([^']+)'/g)].map((m) => m[1]);
  const ons = [...src.matchAll(/ipcMain\.on\('([^']+)'/g)].map((m) => m[1]);
  for (const ch of new Set(handles)) {
    ipcMain.removeHandler(ch);
    const fn = OVERRIDES[ch] || (() => ({ ok: true }));
    ipcMain.handle(ch, async (_e, arg) => { ipcCalls += 1; try { return await fn(arg); } catch (e) { return { ok: false, error: String(e && e.message || e) }; } });
  }
  for (const ch of new Set(ons)) ipcMain.on(ch, () => { ipcCalls += 1; });
  return { handles: new Set(handles).size, ons: new Set(ons).size };
}

// ===========================================================================
//  the fan-out under test -- a verbatim copy of main.js broadcast(), guarded
// ===========================================================================
function assertFanoutStillMatches() {
  const src = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf-8');
  const ok = /function broadcast\(channel, payload\)/.test(src)
    && /wc\.mainFrame/.test(src)
    && /\.framesInSubtree/.test(src)
    && /wc\.send\(channel, payload\)/.test(src);
  if (!ok) {
    throw new Error('electron/main.js broadcast() no longer matches the copy in this harness. '
      + 'Update benchmarks/forge-ipc-bench.js before trusting its numbers.');
  }
}

const fanout = { broadcasts: 0, sends: 0, bytes: 0, perBroadcast: [], byChannel: new Map() };
function resetFanout() {
  fanout.broadcasts = 0; fanout.sends = 0; fanout.bytes = 0;
  fanout.perBroadcast = []; fanout.byChannel = new Map();
}
// broadcast() from electron/main.js, minus the library.invalidate() hook (no
// library module is loaded here) and minus the Perch window (not opened here; it
// is one extra send() per broadcast when the overlay is up).
function broadcast(win, channel, payload) {
  const t0 = now();
  let sends = 0;
  try {
    if (!win || win.isDestroyed()) return 0;
    const wc = win.webContents;
    if (wc.isDestroyed()) return 0;
    wc.send(channel, payload); sends += 1;
    const main = wc.mainFrame;
    if (main) for (const f of main.framesInSubtree) {
      if (f !== main) { try { f.send(channel, payload); sends += 1; } catch (_) {} }
    }
  } catch (_) {}
  const dt = now() - t0;
  fanout.broadcasts += 1;
  fanout.sends += sends;
  fanout.bytes += Buffer.byteLength(JSON.stringify(payload || {})) * sends;
  fanout.perBroadcast.push(dt);
  const k = fanout.byChannel.get(channel) || { n: 0, sends: 0 };
  k.n += 1; k.sends += sends; fanout.byChannel.set(channel, k);
  return sends;
}
function frameCount(win) {
  try {
    const main = win.webContents.mainFrame;
    return main ? main.framesInSubtree.length : 0;
  } catch { return 0; }
}

// ===========================================================================
//  window
// ===========================================================================
async function openWindow() {
  const win = new BrowserWindow({
    width: 1600, height: 950, show: true, frame: false, backgroundColor: '#141519',
    webPreferences: {
      preload: path.join(ROOT, 'electron', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
      nodeIntegrationInSubFrames: true, backgroundThrottling: false,
    },
  });
  await win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  await sleep(2200);                        // boot IPC, splash hand-over, fonts
  return win;
}
// Tabs are lazy (data-src). main.js's own 'shell-shortcut' channel is the only
// supported way in from outside, so use exactly that.
async function loadAllTabs(win) {
  for (const tab of ['review', 'player', 'audition', 'library', 'logs', 'forge']) {
    win.webContents.send('shell-shortcut', { tab });
    await sleep(900);
  }
  await sleep(1200);
}
const evalIn = (wc, js) => wc.executeJavaScript(js, true).catch(() => null);

// One tab iframe by URL fragment, so a panel can be driven through its own
// documented entry point instead of through the shell's private closure.
function findFrame(win, fragment) {
  try {
    const main = win.webContents.mainFrame;
    for (const f of main.framesInSubtree) {
      if (f !== main && String(f.url).includes(fragment)) return f;
    }
  } catch (_) {}
  return null;
}

// performance.memory is bucketed and capped by Chromium (every frame reports the
// same rounded figure), so it cannot see a leak. These two can:
//   * CDP Runtime.getHeapUsage -- the renderer's real V8 heap, after a real
//     HeapProfiler.collectGarbage. Same-origin iframes share the isolate, so this
//     is one honest number for the whole window's JS.
//   * app.getAppMetrics() -- OS working set per process, which also catches the
//     non-JS side (DOM, canvas backing stores, decoded images).
async function attachDebugger(wc) {
  try { if (!wc.debugger.isAttached()) wc.debugger.attach('1.3'); return true; }
  catch (_) { return false; }
}
async function rendererHeap(wc, { gc = true } = {}) {
  try {
    if (gc) await wc.debugger.sendCommand('HeapProfiler.collectGarbage').catch(() => {});
    const r = await wc.debugger.sendCommand('Runtime.getHeapUsage');
    return { used: r.usedSize, total: r.totalSize };
  } catch (_) { return { used: -1, total: -1 }; }
}
function processMemory() {
  const out = { main: 0, gpu: 0, renderers: 0, rendererCount: 0, utility: 0 };
  try {
    for (const m of app.getAppMetrics()) {
      const kb = (m.memory && (m.memory.workingSetSize || 0)) * 1024;
      if (m.type === 'Browser') out.main += kb;
      else if (m.type === 'GPU') out.gpu += kb;
      else if (m.type === 'Tab' || m.type === 'Renderer') { out.renderers += kb; out.rendererCount += 1; }
      else out.utility += kb;
    }
  } catch (_) {}
  return out;
}

// ===========================================================================
//  fake pipeline script -- replays a realistic Forge output stream
// ===========================================================================
// Written as JavaScript with a .py name on purpose: forge-runner picks the
// script name, and this file is executed by THIS Electron binary in
// ELECTRON_RUN_AS_NODE mode. Nothing about transcription is simulated; only the
// SHAPE and RATE of the bytes a real run puts on the pipe.
const FAKE_PIPELINE = String.raw`
const rate = Number(process.env.BENCH_RATE || 10);        // progress lines / second
const seconds = Number(process.env.BENCH_SECONDS || 6);
const out = (s) => process.stdout.write(s);
const err = (s) => process.stderr.write(s);
out('Device: cuda (bench)\n');
out('Input: ' + (process.argv[2] || 'bench.wav') + '\n');
out('\n[1/3] Separating with BS-Rofo-SW-Fixed (SOTA 6-stem, batch 4)\n');
const total = Math.max(1, Math.round(rate * seconds));
let i = 0;
const bar = (n) => {
  const pct = Math.round((n / total) * 100);
  const filled = Math.max(0, Math.min(40, Math.round(pct / 2.5)));
  // exactly tqdm's shape: one line rewritten with \r, never \n
  return '\rProcessing audio chunks:  ' + String(pct).padStart(3) + '%|'
    + '#'.repeat(filled) + ' '.repeat(40 - filled) + '| '
    + (n * 4096) + '/' + (total * 4096) + ' [00:' + String(n % 60).padStart(2, '0')
    + '<00:12,  ' + rate.toFixed(2) + 'it/s]';
};
const gapMs = 1000 / rate;
function finish() {
  err('\n');
  out('  separation done in ' + seconds.toFixed(1) + 's\n');
  out('  using piano stem -> bench_piano.wav\n');
  out('    Normalizing stem to -20.0 dB RMS (peak ceiling -1.0 dB)\n');
  out('\n[2/3] Transcribing with Transkun V2 (SOTA piano MIDI), cuda\n');
  out('Backend: cuda, 32 segments, batch 4, TF32\n');
  for (let k = 1; k <= 32; k++) out('TSEG|' + k + '|32\n');
  out('Transcribed 4120 events in 21.4s\n');
  out('\n[3/3] Cleaning MIDI (drop notes < 0.03s or velocity < 20); velocity gamma 0.85\n');
  out('  4120 -> 3980 notes (dropped 140)\n');
  out('RESULT|' + JSON.stringify({ notes: 3980, pipeline: 'piano' }) + '\n');
  out('\nDONE.\n  MIDI: ' + (process.argv[3] || 'bench.mid') + '\n');
  setTimeout(() => process.exit(0), 60);
}
function tick() {
  if (i >= total) return finish();
  err(bar(++i));
  setTimeout(tick, gapMs);
}
tick();
`;

// ONE scratch engine dir serves both fakes, because paths.pythonEngineDir() is
// the single source both the ForgeRunner and the PlayerSidecar read. Two groups
// each patching it to their own directory is what made a mixed run spawn the
// wrong interpreter against the wrong script.
//   *.py (JavaScript)  -> run by this Electron binary via forgeChildEnv's
//                         ELECTRON_RUN_AS_NODE, which the sidecar never sees
//   ipc_main.py (real Python) -> run by the real bundled player python
// Re-applied on every call: it must not go stale if another group patched paths.
function installFakeForge() {
  const dir = path.join(SCRATCH, 'engine');
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ['song_to_midi.py', 'stem_to_midi.py', 'transcribe.py', 'melody_to_midi.py', 'drums_to_midi.py']) {
    fs.writeFileSync(path.join(dir, name), FAKE_PIPELINE, 'utf-8');
  }
  fs.writeFileSync(path.join(dir, 'ipc_main.py'), HEARTBEAT_PY, 'utf-8');
  const paths = require(path.join(ROOT, 'electron', 'paths.js'));
  paths.pythonEngineDir = () => dir;
  paths.forgeEnvPython = () => process.execPath;
  paths.forgeEnvReady = () => true;
  paths.forgeJobsFile = () => path.join(SCRATCH, 'forge-jobs.json');
  paths.forgeChildEnv = () => Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' });
  return { dir, paths };
}

// Run one real ForgeRunner job to completion (or the timeout) and hand back
// everything that was emitted.
function runFakeJob(win, { rate, seconds, onEmit }) {
  const { ForgeRunner } = require(path.join(ROOT, 'electron', 'forge-runner.js'));
  installFakeForge();
  process.env.BENCH_RATE = String(rate);
  process.env.BENCH_SECONDS = String(seconds);
  const input = path.join(SCRATCH, 'bench-input.wav');
  fs.writeFileSync(input, 'RIFF');
  return new Promise((resolve) => {
    let settled = false;
    const done = (runner) => { if (settled) return; settled = true; try { runner.cancelAll(); } catch (_) {} resolve(); };
    const runner = new ForgeRunner({
      emit: (p) => {
        onEmit(p);
        if (p && p.event === 'forge.done') done(runner);
      },
      getSettings: () => ({ performance: {} }),
    });
    runner.run({ inputPath: input, pipeline: 'piano', skipSeparation: false, advanced: {}, timing: {} });
    setTimeout(() => done(runner), (seconds + 25) * 1000);
  });
}

// ===========================================================================
//  real Python heartbeat -- the sidecar packet stream, timestamped
// ===========================================================================
const HEARTBEAT_PY = [
  'import json, sys, time',
  'hz = float(sys.argv[1]) if len(sys.argv) > 1 else 20.0',
  'gap = 1.0 / hz',
  'sys.stdout.write(json.dumps({"event": "ready", "windows": []}) + "\\n"); sys.stdout.flush()',
  'n = 0',
  'nxt = time.perf_counter()',
  'while True:',
  '    nxt += gap',
  '    d = nxt - time.perf_counter()',
  '    if d > 0: time.sleep(d)',
  '    n += 1',
  '    sys.stdout.write(json.dumps({"event": "progress", "t": round(n * gap, 4),',
  '                                 "sent": n, "total": 100000,',
  '                                 "sent_at": time.time()}) + "\\n")',
  '    sys.stdout.flush()',
].join('\n');

// ===========================================================================
//  GROUP 1: fan-out volume and cost
// ===========================================================================
async function groupFanout(win) {
  const frames = frameCount(win);
  record('fanout', { name: 'frames in subtree (all 6 tabs loaded)', value: frames, unit: 'frames' });

  // One forge.log line, the commonest event in a run: a tqdm bar repaint.
  const line = { event: 'forge.log', jobId: 'job-1',
    line: 'Processing audio chunks:  47%|##################                      | 192512/409600 [00:19<00:21, 10.02it/s]',
    level: 'info' };

  for (const n of [200, 2000]) {
    resetFanout();
    const t0 = now();
    for (let i = 0; i < n; i++) broadcast(win, 'forge:status', line);
    const wall = now() - t0;
    record('fanout', {
      name: `broadcast forge.log x${n} back-to-back`, unit: 'ms/broadcast',
      ...stats(fanout.perBroadcast),
      sendsPerBroadcast: fanout.sends / fanout.broadcasts,
      totalSends: fanout.sends,
      totalWallMs: wall,
      bytesSerialised: fanout.bytes,
    });
    await sleep(400);
  }

  // The same at realistic rates, with the loop otherwise free, so the
  // per-second main-thread cost of a stream can be read off directly.
  for (const rate of [10, 100, 1000]) {
    resetFanout();
    const lag = lagSampler(5);
    const dur = 3000;
    const t0 = now();
    let sent = 0;
    await new Promise((res) => {
      const gap = Math.max(1, 1000 / rate);
      const perTick = Math.max(1, Math.round(rate / 1000));  // >1kHz needs batching per tick
      const t = setInterval(() => {
        for (let i = 0; i < perTick; i++) { broadcast(win, 'forge:status', line); sent += 1; }
        if (now() - t0 >= dur) { clearInterval(t); res(); }
      }, gap);
    });
    lag.stop();
    const secs = (now() - t0) / 1000;
    const cpuMs = fanout.perBroadcast.reduce((a, b) => a + b, 0);
    const l = stats(lag.samples);
    record('fanout', {
      name: `sustained ~${rate} lines/s for 3s`, unit: 'ms/broadcast',
      ...stats(fanout.perBroadcast),
      linesSent: sent,
      actualLinesPerSecond: sent / secs,
      sendsPerSecond: fanout.sends / secs,
      mainCpuPercent: (cpuMs / (secs * 1000)) * 100,
      loopLagP99: l.p99, loopLagMax: l.max,
    });
    await sleep(500);
  }

  // How many of those 7 frames can possibly USE the message. Read out of the
  // renderer sources, so the ratio stays honest as panels are added or removed.
  const SUBSCRIBER_OF = {
    'forge:status': 'onStatus',
    'engine-event': 'onEngineEvent',
    'engine-error': 'onEngineError',
    'library-changed': 'onLibraryChanged',
    'game-active': 'onGameActive',
    'overlay-state': 'onOverlayState',
  };
  const PANEL_FILES = {
    shell: ['shell/shell.js'],
    forge: ['forge/forge.js'],
    review: ['review/review.js'],
    player: ['player/app.js', 'player/midi-library.js'],
    audition: ['audition/audition.js'],
    library: ['library/library.js'],
    logs: ['logs/logs.js'],
  };
  const srcOf = (rel) => { try { return fs.readFileSync(path.join(ROOT, 'renderer', rel), 'utf-8'); } catch { return ''; } };
  for (const [channel, api] of Object.entries(SUBSCRIBER_OF)) {
    const listeners = Object.entries(PANEL_FILES)
      .filter(([, files]) => files.some((f) => srcOf(f).includes('.' + api + '(')))
      .map(([panel]) => panel);
    record('fanout', {
      name: `frames that subscribe to '${channel}'`, unit: 'frames',
      subscribers: listeners.join(',') || '(none)',
      subscriberCount: listeners.length,
      sendsPerBroadcast: frames,
      wastedSendsPerBroadcast: frames - listeners.length,
      wastedFraction: (frames - listeners.length) / frames,
    });
  }

  // What the fan-out would cost if it went only to the frames that subscribe.
  // Measured, not projected: the same payload, the same API, fewer targets.
  const targets = [];
  try {
    const mainFrame = win.webContents.mainFrame;
    for (const f of mainFrame.framesInSubtree) {
      if (f === mainFrame || String(f.url).includes('/forge/')) targets.push(f);
    }
  } catch (_) {}
  const narrow = [];
  for (let i = 0; i < 2000; i++) {
    const t0 = now();
    try {
      win.webContents.send('forge:status', line);
      for (const f of targets) { if (f !== win.webContents.mainFrame) f.send('forge:status', line); }
    } catch (_) {}
    narrow.push(now() - t0);
  }
  record('fanout', {
    name: 'the same 2000 broadcasts addressed only to the shell + Forge frames', unit: 'ms/broadcast',
    ...stats(narrow), sendsPerBroadcast: 1 + Math.max(0, targets.length - 1),
    note: 'the headroom a per-channel frame filter would recover; not a change to the app',
  });

  return frames;
}

// ===========================================================================
//  GROUP 5: one realistic end-to-end run, counted
// ===========================================================================
// The headline volume number: how many emits, IPC sends and bytes a single job
// puts through the main process, at the tqdm rate that was actually measured.
async function groupRun(win) {
  const secs = Number(flag('--run-seconds')) || 120;
  const counts = new Map();
  const emitCost = [];
  resetFanout();
  const lag = lagSampler(5);
  const t0 = now();
  await runFakeJob(win, {
    rate: 10, seconds: secs,
    onEmit: (p) => {
      const t = now();
      counts.set((p && p.event) || '?', (counts.get((p && p.event) || '?') || 0) + 1);
      broadcast(win, 'forge:status', p);
      emitCost.push(now() - t);
    },
  });
  lag.stop();
  const wall = (now() - t0) / 1000;
  const cpuMs = emitCost.reduce((a, b) => a + b, 0);
  const l = stats(lag.samples);
  record('run', {
    name: `one job, ${secs}s of pipeline output at the measured 10 lines/s`, unit: 'ms/emit',
    ...stats(emitCost),
    wallSeconds: wall,
    emitsByEvent: [...counts.entries()].map(([k, v]) => `${k}=${v}`).join(' '),
    totalEmits: [...counts.values()].reduce((a, b) => a + b, 0),
    totalIpcSends: fanout.sends,
    totalIpcBytes: fanout.bytes,
    mainThreadMsSpentFanningOut: cpuMs,
    mainCpuPercent: (cpuMs / (wall * 1000)) * 100,
    loopLagP99: l.p99, loopLagMax: l.max,
  });
}

// The same broadcast with only the boot-default tab loaded, for the delta.
async function groupFanoutColdFrames() {
  const win = await openWindow();
  try {
    const frames = frameCount(win);
    resetFanout();
    const line = { event: 'forge.log', jobId: 'job-1',
      line: 'Processing audio chunks:  47%|##################                      | 192512/409600 [00:19<00:21, 10.02it/s]',
      level: 'info' };
    for (let i = 0; i < 2000; i++) broadcast(win, 'forge:status', line);
    record('fanout', {
      name: 'broadcast forge.log x2000, only the default tab loaded', unit: 'ms/broadcast',
      ...stats(fanout.perBroadcast),
      sendsPerBroadcast: fanout.sends / fanout.broadcasts,
      framesInSubtree: frames,
    });
  } finally { win.destroy(); await sleep(600); }
}

// ===========================================================================
//  GROUP 2: the real pump, driven by a real child process
// ===========================================================================
async function groupPump(win) {
  for (const rate of [10, 100, 1000]) {
    const counts = new Map();
    const emitCost = [];
    resetFanout();
    const lag = lagSampler(5);
    const t0 = now();
    await runFakeJob(win, {
      rate, seconds: 5,
      onEmit: (p) => {
        const t = now();
        const k = (p && p.event) || '?';
        counts.set(k, (counts.get(k) || 0) + 1);
        broadcast(win, 'forge:status', p);
        emitCost.push(now() - t);
      },
    });
    lag.stop();
    const secs = (now() - t0) / 1000;
    const cpuMs = emitCost.reduce((a, b) => a + b, 0);
    const l = stats(lag.samples);
    record('pump', {
      name: `real ForgeRunner job, pipeline emitting ~${rate} lines/s for 5s`, unit: 'ms/emit',
      ...stats(emitCost),
      wallSeconds: secs,
      emitsByEvent: [...counts.entries()].map(([k, v]) => `${k}=${v}`).join(' '),
      totalEmits: [...counts.values()].reduce((a, b) => a + b, 0),
      emitsPerSecond: [...counts.values()].reduce((a, b) => a + b, 0) / secs,
      ipcSends: fanout.sends,
      ipcBytes: fanout.bytes,
      mainCpuPercent: (cpuMs / (secs * 1000)) * 100,
      loopLagP99: l.p99, loopLagMax: l.max,
    });
    await sleep(700);
  }
}

// ===========================================================================
//  GROUP 3: sidecar packet arrival error while Forge streams
// ===========================================================================
async function groupLag(win) {
  const paths = require(path.join(ROOT, 'electron', 'paths.js'));
  const playerPy = path.join(ROOT, 'python-engine', 'python', 'python.exe');
  if (!fs.existsSync(playerPy)) {
    record('lag', { name: 'SKIPPED: no bundled player python at ' + playerPy, value: 0, unit: '' });
    return;
  }
  const { PlayerSidecar } = require(path.join(ROOT, 'electron', 'sidecar.js'));
  installFakeForge();                       // writes ipc_main.py too, and owns pythonEngineDir
  paths.bundledPlayerPython = () => playerPy;

  // Two numbers per packet:
  //   jitter  |gap since the previous packet - 50 ms|. Free of any clock skew
  //           between the two processes, and it is exactly what a late delivery
  //           looks like to the code that consumes the stream.
  //   skew    arrival wall clock minus the sender's stamp. Carries a constant
  //           offset between the two clocks, so only its SPREAD is meaningful.
  let jitter = [], skew = [], lastAt = 0, collecting = false;
  const sidecar = new PlayerSidecar({
    getSettings: () => ({}),
    onEvent: (p) => {
      if (p && p.event === 'progress' && p.sent_at) {
        const t = now();
        if (collecting && lastAt) jitter.push(Math.abs(t - lastAt - 50));
        if (collecting) skew.push((Date.now() / 1000 - p.sent_at) * 1000);
        lastAt = t;
      }
      broadcast(win, 'engine-event', p);
    },
    onError: () => {},
  });
  await sidecar.start();
  await sleep(3000);

  async function measure(label, rate) {
    let emits = 0;
    let job = null;
    if (rate) {
      // Start the job and let its spawn stall pass before measuring: process
      // creation is a one-off cost, not a property of the stream.
      job = runFakeJob(win, {
        rate, seconds: 11,
        onEmit: (p) => { emits += 1; broadcast(win, 'forge:status', p); },
      });
      await sleep(2500);
    }
    jitter = []; skew = []; collecting = true;
    resetFanout();
    const emitsAtStart = emits;
    const lag = lagSampler(5);
    const t0 = now();
    await sleep(8000);
    lag.stop();
    collecting = false;
    const secs = (now() - t0) / 1000;
    if (job) await job;
    const l = stats(lag.samples);
    const sk = stats(skew);
    record('lag', {
      name: label, unit: 'ms (deviation from the 50 ms sidecar cadence)',
      ...stats(jitter),
      packets: jitter.length,
      seconds: secs,
      skewSpreadP99MinusP50: sk.p99 - sk.p50,
      skewMaxMinusP50: sk.max - sk.p50,
      forgeEmitsDuringWindow: emits - emitsAtStart,
      forgeIpcSends: fanout.sends,
      forgeIpcSendsPerSecond: fanout.sends / secs,
      loopLagP99: l.p99, loopLagMax: l.max,
    });
    await sleep(900);
  }

  await measure('sidecar alone, Forge idle', 0);
  await measure('sidecar + Forge at ~10 lines/s (the measured tqdm rate)', 10);
  await measure('sidecar + Forge at ~100 lines/s', 100);
  await measure('sidecar + Forge at ~1000 lines/s', 1000);

  sidecar.kill();
  await sleep(1200);
}

// ===========================================================================
//  GROUP 4: memory over a long session
// ===========================================================================
async function groupMemory(win) {
  const wc = win.webContents;
  await attachDebugger(wc);
  const rows = [];
  let reviewLoads = 0;
  LOAD_COUNTER.review = () => { reviewLoads += 1; };

  const settleGc = async () => {
    try { if (global.gc) global.gc(); } catch (_) {}
    await rendererHeap(wc, { gc: true });      // HeapProfiler.collectGarbage
    await sleep(900);
  };

  const sample = async (cycle, phase) => {
    await settleGc();
    const heap = await rendererHeap(wc, { gc: true });
    const proc = processMemory();
    const row = { cycle, phase, mainHeap: process.memoryUsage().heapUsed,
      rendererJsHeap: heap.used, rendererJsHeapTotal: heap.total,
      mainWorkingSet: proc.main, rendererWorkingSet: proc.renderers,
      gpuWorkingSet: proc.gpu, rendererProcesses: proc.rendererCount };
    rows.push(row);
    return row;
  };

  await sample(0, 'baseline');

  for (let c = 1; c <= CYCLES; c++) {
    console.log(`  memory cycle ${c}/${CYCLES}...`);
    // 1. open a large document in the Editor -- the app's heaviest object graph.
    //    review:load hands back a NEW 30k-note document every time, so anything
    //    still holding the previous one shows up as monotonic growth.
    win.webContents.send('shell-shortcut', { tab: 'review' });
    await sleep(500);
    const rf = findFrame(win, '/review/');
    if (rf) await rf.executeJavaScript(
      `(window.openReviewProject ? (window.openReviewProject('bench-${c}.mid'), 1) : 0)`, true).catch(() => 0);
    await sleep(2200);
    // 2. a full tab-switch cycle
    for (const tab of ['player', 'library', 'logs', 'audition', 'forge', 'review']) {
      win.webContents.send('shell-shortcut', { tab });
      await sleep(220);
    }
    // 3. a queue's worth of forge traffic through the real fan-out
    for (let i = 0; i < 1500; i++) {
      broadcast(win, 'forge:status', { event: 'forge.log', jobId: 'job-' + c,
        line: 'Processing audio chunks: ' + i + '/1500  [cycle ' + c + ']', level: 'info' });
    }
    broadcast(win, 'forge:status', { event: 'forge.done', jobId: 'job-' + c, ok: true, result: { midiPath: 'x.mid' } });
    await sleep(800);

    await sample(c, 'after open+tabs+1500 forge lines');
  }

  const base = rows[0];
  const first = rows[1] || rows[0];
  const last = rows[rows.length - 1];
  const grow = (k) => (CYCLES > 1 ? (last[k] - first[k]) / (CYCLES - 1) : 0);
  record('memory', {
    name: `documents actually opened during the run`, unit: 'loads', value: reviewLoads,
    note: reviewLoads >= CYCLES ? 'each cycle really did load a fresh 30k-note document'
      : 'FEWER LOADS THAN CYCLES -- the numbers below do not mean what they look like',
  });
  record('memory', {
    name: `renderer V8 heap over ${CYCLES} open/close cycles (after forced GC)`, unit: 'bytes',
    baseline: base.rendererJsHeap, afterFirstCycle: first.rendererJsHeap,
    afterLastCycle: last.rendererJsHeap, growthPerCycleAfterFirst: grow('rendererJsHeap'),
  });
  record('memory', {
    name: `renderer process working set over ${CYCLES} cycles`, unit: 'bytes',
    baseline: base.rendererWorkingSet, afterFirstCycle: first.rendererWorkingSet,
    afterLastCycle: last.rendererWorkingSet, growthPerCycleAfterFirst: grow('rendererWorkingSet'),
  });
  record('memory', {
    name: `main-process V8 heap over ${CYCLES} cycles`, unit: 'bytes',
    baseline: base.mainHeap, afterFirstCycle: first.mainHeap,
    afterLastCycle: last.mainHeap, growthPerCycleAfterFirst: grow('mainHeap'),
  });
  record('memory', {
    name: `main process working set over ${CYCLES} cycles`, unit: 'bytes',
    baseline: base.mainWorkingSet, afterFirstCycle: first.mainWorkingSet,
    afterLastCycle: last.mainWorkingSet, growthPerCycleAfterFirst: grow('mainWorkingSet'),
  });
  record('memory', { name: 'per-cycle samples', unit: 'bytes', series: rows });

  const census = await evalIn(wc, `(() => {
    const out = {};
    const q = (root, sel) => { try { return root.querySelectorAll(sel).length; } catch (e) { return -1; } };
    out.iframes = q(document, 'iframe');
    for (const id of ['forge', 'review', 'player', 'library', 'logs', 'audition']) {
      const f = document.getElementById('frame-' + id);
      let d = null; try { d = f && f.contentDocument; } catch (e) {}
      out[id + 'Nodes'] = d ? q(d, '*') : -1;
      if (d && id === 'forge') out.forgeLogCount = (d.getElementById('log-count') || {}).textContent || '';
      if (d && id === 'logs') out.logsRows = q(d, '.vlist > *');
    }
    return out;
  })()`);
  record('memory', { name: 'DOM census after the run', unit: 'nodes', census: census || {} });
  try { if (wc.debugger.isAttached()) wc.debugger.detach(); } catch (_) {}
}

// ===========================================================================
//  print + write
// ===========================================================================
// Written after EVERY group, and merged with whatever a previous invocation left
// behind, so one group dying never costs the numbers the others already produced
// and the groups can be run in separate processes.
function outPath() {
  const rel = JSON_AT || 'benchmarks/forge-ipc.json';
  return path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
}
function persist() {
  const out = outPath();
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(out, 'utf-8')); } catch (_) {}
  const merged = Object.assign({}, prev.results || {}, RESULTS);
  try {
    fs.writeFileSync(out, JSON.stringify({
      at: new Date().toISOString(), electron: process.versions.electron,
      node: process.versions.node, cycles: CYCLES, docNotes: BIG_NOTES,
      results: merged,
    }, null, 2));
  } catch (e) { console.error('could not write', out, e.message); }
}

function report() {
  for (const [group, rows] of Object.entries(RESULTS)) {
    process.stdout.write(`\n${group.toUpperCase()}\n`);
    for (const r of rows) {
      const bits = [];
      for (const [k, v] of Object.entries(r)) {
        if (k === 'name' || k === 'unit' || k === 'series' || k === 'census' || k === 'frames') continue;
        bits.push(`${k}=${typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(4)) : v}`);
      }
      console.log(`  ${r.name}${r.unit ? '  [' + r.unit + ']' : ''}\n      ${bits.join('  ')}`);
      if (r.series) for (const s of r.series) {
        console.log(`      cycle ${s.cycle}: rendererJS=${(s.rendererJsHeap / 1e6).toFixed(1)}MB  rendererWS=${(s.rendererWorkingSet / 1e6).toFixed(1)}MB  mainJS=${(s.mainHeap / 1e6).toFixed(1)}MB  mainWS=${(s.mainWorkingSet / 1e6).toFixed(1)}MB  gpuWS=${(s.gpuWorkingSet / 1e6).toFixed(1)}MB  (${s.phase})`);
      }
      if (r.census) console.log(`      ${JSON.stringify(r.census)}`);
    }
  }
  persist();
  console.log('wrote ' + outPath());
}

// ===========================================================================
//  main
// ===========================================================================
// Its own profile: sharing the default Electron userData with another instance
// (the app itself, or a second harness) fails the disk cache and pollutes the
// real app's state.
app.setPath('userData', path.join(SCRATCH, 'userData'));
// GPU/shader caches live under sessionData, not userData. Leaving them shared is
// what produced "Unable to move the cache: Access is denied" and an occasional
// hard exit when a second Electron harness was running at the same time.
app.setPath('sessionData', path.join(SCRATCH, 'sessionData'));
app.commandLine.appendSwitch('disk-cache-dir', path.join(SCRATCH, 'diskCache'));
app.commandLine.appendSwitch('js-flags', '--expose-gc');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
// The cold-frames group closes its own window part-way through; Electron's
// default would quit the app right there and the run would end silently.
app.on('window-all-closed', () => {});
// A silent exit mid-run makes every number in the report a guess about what was
// actually measured, so say why.
process.on('uncaughtException', (e) => { console.error('UNCAUGHT', e && e.stack || e); });
process.on('unhandledRejection', (e) => { console.error('UNHANDLED', e && e.stack || e); });
process.on('exit', (code) => { if (code !== 0) console.error('process exiting with code', code); });
app.on('child-process-gone', (_e, d) => console.error('child-process-gone', JSON.stringify(d)));
app.on('render-process-gone', (_e, _wc, d) => console.error('render-process-gone', JSON.stringify(d)));

app.whenReady().then(async () => {
  let win = null;
  try {
    assertFanoutStillMatches();
    const chans = registerStubs();
    console.log(`stubbed ${chans.handles} invoke channels + ${chans.ons} send channels from main.js`);

    if (want('fanout')) { await groupFanoutColdFrames(); persist(); }

    win = await openWindow();
    await loadAllTabs(win);
    console.log('frames in subtree: ' + frameCount(win));

    for (const [name, fn] of [['fanout', groupFanout], ['pump', groupPump],
      ['lag', groupLag], ['run', groupRun], ['memory', groupMemory]]) {
      if (!want(name)) continue;
      console.log('-- ' + name);
      try { await fn(win); } catch (e) { console.error('group ' + name + ' failed:', e && e.stack || e); }
      persist();
    }

    record('meta', { name: 'stub IPC calls answered during the run', value: ipcCalls, unit: 'calls' });
  } catch (err) {
    console.error('\nBENCH FAILED:', err && err.stack || err);
  } finally {
    report();
    try { if (win && !win.isDestroyed()) win.destroy(); } catch (_) {}
    setTimeout(() => app.exit(0), 1200);
  }
});

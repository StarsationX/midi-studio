// ipc-stubs.js: the fake main process every UI harness shares.
//
// electron/main.js is not booted by a harness (it would spawn the python
// sidecar, scan the disk and open the real window), so every channel the pages
// invoke on load is answered here by a stub that returns the same SHAPE main.js
// returns, filled with realistic data: a few hundred library files with
// names/sizes/mtimes, a provisioned Forge env with a GPU, a loaded MIDI
// document with a few thousand notes. An unpopulated page hides exactly the
// defects a harness is hunting -- and, for the performance harnesses, an empty
// page does far less work than a real one, so the numbers would flatter.
//
// This file was extracted verbatim from tools/layout-audit.js so the layout
// audit and the performance harnesses measure the same app against the same
// data. It has no side effects on require: call registerStubs() yourself.
//
//   const stubs = require('./ipc-stubs');
//   stubs.registerStubs();                 // after app.whenReady()
'use strict';

const { ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');

// ===========================================================================
//  FIXTURES -- realistic data, in main.js's exact return shapes
// ===========================================================================

const HOME = os.homedir();
const OUT_DIR = path.join(HOME, 'Documents', 'MIDI Studio');
const EXTRA_DIR = path.join(HOME, 'Music', 'Piano transcriptions');
const FORGE_DIR = path.join(HOME, 'AppData', 'Local', 'MIDI Studio', 'forge-env');

// Long, real-world names on purpose: a fixed-width chip that holds
// "Clair de Lune" and clips "Rachmaninoff — Piano Concerto No. 2..." is
// precisely the defect this harness exists to surface.
const SONGS = [
  'Debussy - Clair de Lune (Suite bergamasque No. 3)',
  'Rachmaninoff - Piano Concerto No. 2 in C minor, Op. 18 - II. Adagio sostenuto',
  'Chopin - Nocturne in E-flat major, Op. 9 No. 2',
  'Liszt - Hungarian Rhapsody No. 2 in C-sharp minor, S.244',
  'Beethoven - Sonata No. 14 Moonlight - III. Presto agitato',
  'Yiruma - River Flows in You (piano solo arrangement)',
  'Joe Hisaishi - One Summer’s Day (Spirited Away)',
  'Interstellar - Day One (Hans Zimmer, extended organ version)',
  'Undertale - Megalovania (advanced piano arrangement by Kyle Landry)',
  'Ludovico Einaudi - Nuvole Bianche',
  'Bach - Prelude and Fugue in C major, BWV 846',
  'Satie - Gymnopedie No. 1',
  'Nujabes - Aruarian Dance',
  'Persona 5 - Beneath the Mask (rain version)',
  'Attack on Titan - Vogel im Kafig',
  'Your Lie in April - Watashi no Uso (Hikaru Nara ending)',
  'Deltarune - Field of Hopes and Dreams',
  'Minecraft - Sweden (C418) slow piano cover',
  'Studio Ghibli - Merry-Go-Round of Life (Howl’s Moving Castle)',
  'Fur Elise WoO 59 (complete, with both trios)',
  'Vitamin - Somebody That I Used to Know',
  'Mariage d’Amour - Paul de Senneville (Richard Clayderman)',
  'Tetris Theme A (Type A) - Korobeiniki, hard version',
  'La Campanella - Liszt, Grandes etudes de Paganini No. 3',
];
const TAGSETS = [['practice'], ['favourite', 'recital'], [], ['forge'], ['wip', 'needs quantise'], []];

function makeLibraryFiles(n) {
  const files = [];
  const now = Date.now();
  for (let i = 0; i < n; i++) {
    const stem = SONGS[i % SONGS.length] + (i >= SONGS.length ? ` (take ${1 + Math.floor(i / SONGS.length)})` : '');
    const dir = i % 5 === 0 ? EXTRA_DIR : OUT_DIR;
    files.push({
      path: path.join(dir, stem + '.mid'),
      name: stem,
      dir,
      size: 4200 + ((i * 5471) % 180000),
      modified: now - (i * 3600_000 + (i % 7) * 86_400_000),
    });
  }
  return files;
}
const LIB_FILES = makeLibraryFiles(320);

const LIB_TAGS = {};
const LIB_USAGE = {};
LIB_FILES.forEach((f, i) => {
  const t = TAGSETS[i % TAGSETS.length];
  if (t.length) LIB_TAGS[f.path] = t.slice();
  if (i % 3 === 0) LIB_USAGE[f.path] = { played: 1 + (i % 9), lastAt: Date.now() - i * 7_200_000 };
});

// A few thousand notes, in python-engine/midi_document.py's shape.
function makeDocument(name, filePath, count) {
  const notes = [];
  let t = 0;
  for (let i = 0; i < count; i++) {
    const start = t;
    const dur = 0.11 + ((i * 37) % 9) * 0.045;
    notes.push({
      id: 'n' + (i + 1), pitch: 36 + ((i * 7 + (i % 13) * 3) % 52),
      start: Number(start.toFixed(6)), end: Number((start + dur).toFixed(6)),
      velocity: 52 + ((i * 11) % 60), channel: i % 4 === 0 ? 1 : 0,
    });
    if (i % 3 === 2) t += 0.128;
  }
  return {
    path: filePath, name, bpm: 138.462, bpmEstimated: true,
    duration: Number((t + 2).toFixed(6)), programs: { 0: 0, 1: 0 }, notes,
  };
}
const DOC_NOTES = 3200;
const REVIEW_PATH = path.join(OUT_DIR, SONGS[1] + '.mid');
const REVIEW_PROJECT = path.join(OUT_DIR, SONGS[1] + '.midstudio.json');

function reviewPayload() {
  const clean = makeDocument(SONGS[1], REVIEW_PATH, DOC_NOTES);
  const quantised = makeDocument(SONGS[1], path.join(OUT_DIR, SONGS[1] + '_quantised.mid'), DOC_NOTES);
  return {
    projectPath: REVIEW_PROJECT,
    project: {
      format: 'midi-studio-project', version: 1, name: SONGS[1],
      sourceAudio: path.join(OUT_DIR, SONGS[1] + '.wav'),
      previewAudio: path.join(OUT_DIR, SONGS[1] + '.preview.mp3'),
      pipeline: 'piano', createdAt: new Date(Date.now() - 86_400_000).toISOString(),
      selectedCandidate: 'clean',
      candidates: { clean: REVIEW_PATH, quantised: quantised.path },
    },
    documents: { clean, quantised },
  };
}

// The player's engine events. events[i] = [t, key, dur, note, ch].
function playerEvents(count) {
  const KEYS = '1!2@34$5%6^78*9(0qQwWeErtTyYuiIoOpPasSdDfgGhHjJklLzZxcCvVbBnm';
  const out = [];
  let t = 0.4;
  for (let i = 0; i < count; i++) {
    out.push([Number(t.toFixed(4)), KEYS[i % KEYS.length], 0.16 + ((i * 5) % 7) * 0.04, 36 + ((i * 7) % 52), i % 3 === 0 ? 1 : 0]);
    if (i % 2 === 1) t += 0.145;
  }
  return out;
}
function noteToKey() {
  const KEYS = '1!2@34$5%6^78*9(0qQwWeErtTyYuiIoOpPasSdDfgGhHjJklLzZxcCvVbBnm';
  const map = {};
  for (let i = 0; i < 61; i++) map[36 + i] = KEYS[i % KEYS.length];
  return map;
}
const MIDI_LOADED = {
  event: 'midi_loaded',
  path: path.join(OUT_DIR, SONGS[0] + '.mid'),
  name: SONGS[0],
  events: playerEvents(2600),
  note_to_key: noteToKey(),
  duration: 263.482, bpm: 72.5, bpm_estimate: 0, transpose: 0,
  collapsed_sharps: 4, unmapped: [21, 22, 23, 105, 106],
  mapping_description: 'Roblox 61-key (sharps collapsed, 5 notes out of range)',
  report: { mapped: 2595, unmapped: 5, collapsed: 4 },
};
const WINDOWS_EVENT = {
  event: 'windows',
  windows: [
    { hwnd: 197634, title: 'Roblox - Grand Piano [Virtual Piano Sheet Music]', process: 'RobloxPlayerBeta.exe', pid: 8124 },
    { hwnd: 197888, title: 'Virtual Piano - Play Piano Online With Your Keyboard', process: 'chrome.exe', pid: 4412 },
    { hwnd: 198012, title: 'Untitled - Notepad', process: 'notepad.exe', pid: 9004 },
  ],
};

const FORGE_SETTINGS = {
  pipeline: 'piano', skipSeparation: false,
  advanced: { USE_TTA: '1', BIGSHIFTS: '2', VELOCITY_GAMMA: '0.9' },
  outputDir: OUT_DIR,
  timing: { enabled: true, start: '00:12', end: '03:48' },
};
const PERFORMANCE = {
  percent: 100, cores: 16, threads: 16, batch: 2, drawMs: 17,
  lowPriority: false, whenGaming: 'limit', custom: { threads: null, batch: null },
};
const UI = {
  lastTab: 'forge', autoCheckUpdates: true, alwaysOnTop: true,
  theme: '', density: 'normal', handoffPlay: 'load', spaceTransport: true,
  transportMs: false, autoQueueForged: false, logOpen: false,
};
const OVERLAY_CFG = {
  open: false, mode: 'full', opacity: 0.92, clickThrough: false, locked: false,
  autoShow: true, autoHide: true, lookahead: 3, showKeys: true, showTransport: true,
  bounds: { x: 1180, y: 720, width: 620, height: 260 },
};
const STORAGE = { root: path.parse(OUT_DIR).root, totalBytes: 1_000_204_886_016, freeBytes: 271_803_355_136, usedBytes: 728_401_530_880 };

// ===========================================================================
//  IPC STUBS -- same shapes electron/main.js returns
// ===========================================================================

const okPath = () => '';
const HANDLERS = {
  // ---- app / shell -------------------------------------------------------
  'app:version': () => require(path.join(ROOT, 'package.json')).version,
  'app:release': () => require(path.join(ROOT, 'package.json')).releaseName || '',
  // What's New reads the real CHANGELOG.md, so the harness hands over the real
  // file: this state's whole job is to catch that file's own longest heading and
  // longest bullet overflowing the reading column.
  'app:changelog': () => {
    const file = path.join(ROOT, 'CHANGELOG.md');
    try { return { ok: true, file, text: fs.readFileSync(file, 'utf-8') }; }
    catch (e) { return { ok: false, error: String((e && e.message) || e), file, text: '' }; }
  },
  'app:whatsNew': () => ({
    version: require(path.join(ROOT, 'package.json')).version,
    name: require(path.join(ROOT, 'package.json')).releaseName || '',
    // autoShow stays false: the harness drives the sheet from its own state so
    // the earlier states are not covered by it.
    postUpdate: false, shownFor: '', autoShow: false,
    releasesUrl: 'https://github.com/StarsationX/midi-studio/releases',
  }),
  'app:notesShown': (v) => String(v || ''),
  'app:getUi': () => Object.assign({}, UI),
  'app:setUi': (patch) => Object.assign(UI, patch || {}),
  'app:performance': () => Object.assign({}, PERFORMANCE),
  'app:setPerformance': (patch) => Object.assign(PERFORMANCE, patch || {}),
  'app:bootState': () => ({
    steps: [
      { step: 'app', label: 'Electron started' },
      { step: 'settings', label: 'Settings loaded' },
      { step: 'engine', label: 'Found your Forge engine' },
      { step: 'window', label: 'Window created' },
    ],
    ready: true,
  }),
  'app:openBootLog': () => ({ ok: true, path: path.join(HOME, 'AppData', 'Roaming', 'MIDI Studio', 'boot.log') }),
  'app:openSetupLog': () => ({ ok: true, path: path.join(FORGE_DIR, 'setup.log') }),
  'app:forgeInfo': () => ({
    version: require(path.join(ROOT, 'package.json')).version,
    forgeReady: true,
    forgePython: path.join(FORGE_DIR, 'python', 'python.exe'),
    forgeEnvDir: FORGE_DIR,
    forgeFreeGb: 253,
    forgeDefaultDir: FORGE_DIR,
    forgeCustom: false,
    forgeNeedGb: 15,
  }),
  'app:changeForgeFolder': () => ({ ok: false, canceled: true }),
  'app:resetForgeFolder': () => ({ ok: false, canceled: true }),
  'app:openForgeFolder': okPath,
  'app:cleanReinstall': () => ({ ok: false, canceled: true }),
  'app:openExternal': () => null,
  'app:getOutputDir': () => OUT_DIR,
  'app:getLibraryDir': () => OUT_DIR,
  'app:setLibraryDir': (dir) => String(dir || ''),
  'app:listMidis': () => LIB_FILES.map((f) => f.path),
  'app:pickFolder': () => null,
  'app:openMappingsDir': okPath,

  // ---- window ------------------------------------------------------------
  'win:state': () => ({ maximized: false, minimized: false, fullScreen: false, focused: true }),

  // ---- updates -----------------------------------------------------------
  'update:check': () => ({ state: 'none', current: require(path.join(ROOT, 'package.json')).version }),
  'update:apply': () => ({ ok: false, error: 'nothing staged' }),

  // ---- overlay / Perch ---------------------------------------------------
  'overlay:state': () => ({ open: !!OVERLAY_CFG.open, bounds: OVERLAY_CFG.bounds, config: Object.assign({}, OVERLAY_CFG) }),
  'overlay:toggle': () => { OVERLAY_CFG.open = !OVERLAY_CFG.open; return { open: OVERLAY_CFG.open, config: Object.assign({}, OVERLAY_CFG) }; },
  'overlay:apply': (patch) => Object.assign(OVERLAY_CFG, patch || {}),
  'overlay:snap': () => Object.assign({}, OVERLAY_CFG),

  // ---- engine (the player sidecar) --------------------------------------
  'engine:send': () => true,
  'dialog:openMidi': () => [],
  'dialog:openMapping': () => null,

  // ---- Forge -------------------------------------------------------------
  'forge:check': () => ({
    forgeReady: true,
    forgePython: path.join(FORGE_DIR, 'python', 'python.exe'),
    gpu: 'NVIDIA GeForce RTX 4070 Laptop GPU',
    torch: true, missing: [],
  }),
  'forge:provision': () => ({ started: true }),
  'forge:provision:cancel': () => true,
  'forge:run': () => ({ ok: true, jobId: 'job-audit-1' }),
  'forge:yt': () => ({ ok: true, jobId: 'job-audit-yt' }),
  'forge:cancel': () => true,
  'forge:pause': () => true,
  'forge:pickInput': () => null,
  'forge:pickOutDir': () => null,
  'forge:getSettings': () => JSON.parse(JSON.stringify(FORGE_SETTINGS)),
  'forge:setSettings': (patch) => Object.assign(FORGE_SETTINGS, patch || {}),

  // ---- review ------------------------------------------------------------
  'review:pick': () => REVIEW_PROJECT,
  'review:load': () => ({ ok: true, data: reviewPayload() }),
  'review:saveProject': () => ({ ok: true, projectPath: REVIEW_PROJECT, project: reviewPayload().project }),
  'review:exportMidi': () => ({ ok: true, path: path.join(OUT_DIR, SONGS[1] + '_edited.mid') }),

  // ---- library -----------------------------------------------------------
  'library:list': () => ({ dirs: [OUT_DIR, EXTRA_DIR], extra: [EXTRA_DIR], files: LIB_FILES, truncated: false }),
  'library:scan': () => ({
    scanId: 1, dirs: [OUT_DIR, EXTRA_DIR], extra: [EXTRA_DIR], files: LIB_FILES, truncated: false,
    storage: STORAGE, tags: LIB_TAGS, usage: LIB_USAGE, indexing: false,
  }),
  'library:meta': (payload) => {
    const meta = {};
    const list = (payload && Array.isArray(payload.paths) ? payload.paths : []).slice(0, 40);
    for (const req of list) {
      const p = typeof req === 'string' ? req : (req && req.path);
      if (!p) continue;
      const h = Math.abs(String(p).length * 977) % 4000;
      meta[p] = { notes: 480 + h, duration: 60 + (h % 300) + 0.482, bpm: 72 + (h % 96) };
    }
    const out = { meta };
    if (payload && payload.roll) {
      const doc = makeDocument('roll', String(payload.roll), 900);
      out.roll = {
        path: String(payload.roll), notes: doc.notes, duration: doc.duration, bpm: doc.bpm,
        roll: doc.notes.map((n) => [n.start, n.pitch, n.end - n.start, n.velocity]),
        sampled: false,
        projectPath: REVIEW_PROJECT,
        previewAudio: path.join(OUT_DIR, SONGS[1] + '.preview.mp3'),
        sourceAudio: path.join(OUT_DIR, SONGS[1] + '.wav'),
        pipeline: 'piano', createdAt: new Date(Date.now() - 86_400_000).toISOString(),
      };
    }
    return out;
  },
  'library:setTags': (p) => ({ ok: true, tags: (p && p.tags) || [] }),
  'library:usage': (p) => ({ ok: true, usage: { played: 3, lastAt: Date.now(), kind: (p && p.kind) || 'play' } }),
  'library:index': () => ({ ok: true, total: 0 }),
  'library:delete': (p) => ({ ok: true, trashed: (p && p.paths) || [], failed: [] }),
  'library:addFolder': () => ({ ok: false, canceled: true }),
  'library:removeFolder': () => ({ ok: true }),
  'library:reveal': okPath,

  // ---- shell helpers -----------------------------------------------------
  'shell:openPath': okPath,
  'shell:showItem': okPath,
};

// Channels the preload reaches with ipcRenderer.send (no reply expected).
const SEND_CHANNELS = [
  'win:minimize', 'win:maximize', 'win:unmaximize', 'win:toggleMaximize', 'win:close',
  'overlay:ready', 'overlay:close', 'overlay:resize', 'overlay:command', 'overlay:replay',
];

const invoked = new Set();
// Per-channel call counts. The layout audit only cares whether a channel was
// touched; the performance harnesses care HOW OFTEN, because an idle app that
// invokes IPC 20 times a second is a defect you can only see by counting.
const calls = new Map();
// A timestamped log as well as a count. WHEN a channel is invoked matters as
// much as how often: an expensive probe fired during boot and the same probe
// fired ten seconds later are the same count and a completely different app.
const callLog = [];
function countCall(channel) {
  invoked.add(channel);
  calls.set(channel, (calls.get(channel) || 0) + 1);
  if (callLog.length < 4000) callLog.push({ t: Date.now(), channel: channel });
}
function resetCalls() { calls.clear(); callLog.length = 0; }
function callTotal() { let n = 0; for (const v of calls.values()) n += v; return n; }
function registerStubs() {
  for (const [channel, fn] of Object.entries(HANDLERS)) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (_e, arg) => {
      countCall(channel);
      try { return await fn(arg); }
      catch (err) { return { ok: false, error: String(err && err.message || err) }; }
    });
  }
  for (const channel of SEND_CHANNELS) ipcMain.on(channel, () => countCall(channel));
  // Additive channels the real preload exposes that the audit never needed but
  // a boot measurement does. app:bootMark is send(), not invoke().
  ipcMain.removeAllListeners('app:bootMark');
  ipcMain.on('app:bootMark', () => countCall('app:bootMark'));
}
module.exports = {
  ROOT, HOME, OUT_DIR, EXTRA_DIR, FORGE_DIR, SONGS,
  HANDLERS, SEND_CHANNELS, invoked, calls, callLog, resetCalls, callTotal, registerStubs,
  MIDI_LOADED, WINDOWS_EVENT,
  makeLibraryFiles, makeDocument, reviewPayload,
  LIB_FILES, STORAGE, LIB_TAGS, LIB_USAGE, FORGE_SETTINGS, OVERLAY_CFG, REVIEW_PROJECT,
};

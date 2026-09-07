// layout-audit.js: find clipping, overlap and overflow across every page.
//
//   npx electron tools/layout-audit.js               1920x1080 and 1040x700
//   npx electron tools/layout-audit.js --sizes 2560x1440
//   npx electron tools/layout-audit.js --shot        also write PNGs
//   npx electron tools/layout-audit.js --only shell,forge
//   npx electron tools/layout-audit.js --states default,palette
//
// Loads each renderer page in a real Electron window with the real preload and
// reports, per page, per size and per STATE:
//   OVERFLOW  in-flow content wider/taller than its own non-scrolling box, so
//             text or a control is genuinely being cut off
//   POPOVER   the same measurement, but the overflow comes from an out-of-flow
//             box (an absolutely positioned child, or an abs ::before/::after
//             such as a data-tip bubble). A popup is MEANT to leave its anchor,
//             so this is a separate, quieter bucket -- but it is still reported,
//             because a popup that leaves the WINDOW shows up as an OVERFLOW on
//             <body> and this is how you find which popup did it.
//   ESCAPE    an element whose painted box extends past its clipping ancestor
//   OVERLAP   two static siblings that visually intersect
//   OFFSCREEN an element that sits outside the viewport entirely
//   truncated an element that clips a single line with an ellipsis (which is a
//             legitimate answer to text that does not fit) but offers no title,
//             aria-label or data-tip, so the full string cannot be read at all
//   CONSOLE   any console error or warning the page emitted
//
// Three things make the numbers trustworthy:
//
//  1. IPC IS ANSWERED. electron/main.js is not booted (it would spawn the
//     sidecar, scan the disk and open the real window), so every channel the
//     pages invoke on load is answered here by a stub that returns the same
//     SHAPE main.js returns, filled with realistic data: a few hundred library
//     files with names/sizes/mtimes, a provisioned Forge env with a GPU, a
//     loaded MIDI document with a few thousand notes. An unpopulated page hides
//     exactly the defects we are hunting -- a chip reading "Idle" is narrower
//     than one reading a real song title.
//  2. EVERY PAGE IS ISOLATED. Load, settle, setup, probe and capture all run
//     inside a try/catch, the window is always destroyed in a finally, and a
//     failure becomes a result row instead of aborting the run.
//  3. STATES. A panel that only clips once its content is real is the common
//     case, so a page may declare extra states: open the settings sheet, open
//     the palette, expand the log drawer, switch a pane, select a row. Each one
//     is probed in its own right.
//
// It stays deliberately noisy about real geometry and quiet about intent: a
// container that can actually scroll is excluded, as is anything marked hidden.
//
// The summary is printed AND written to benchmarks/layout-audit.json.
'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : '';
};
const WANT_SHOTS = argv.includes('--shot');
const SIZES = flag('--sizes')
  ? flag('--sizes').split(',').map((s) => s.split('x').map(Number))
  : [[1920, 1080], [1040, 700]];
const ONLY = flag('--only') ? flag('--only').split(',').map((s) => s.trim()).filter(Boolean) : null;
const ONLY_STATES = flag('--states') ? flag('--states').split(',').map((s) => s.trim()).filter(Boolean) : null;
const SETTLE = Number(flag('--settle')) || 1400;

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
function registerStubs() {
  for (const [channel, fn] of Object.entries(HANDLERS)) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (_e, arg) => {
      invoked.add(channel);
      try { return await fn(arg); }
      catch (err) { return { ok: false, error: String(err && err.message || err) }; }
    });
  }
  for (const channel of SEND_CHANNELS) ipcMain.on(channel, () => invoked.add(channel));
}

// ===========================================================================
//  THE PROBE -- runs inside the page, returns plain data only
// ===========================================================================
const PROBE = `(() => {
  const out = { overflow: [], popover: [], escape: [], overlap: [], offscreen: [], truncated: [] };
  const vw = innerWidth, vh = innerHeight;

  const label = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    const c = (el.getAttribute('class') || '').trim().split(/\\s+/).filter(Boolean).slice(0, 3);
    if (c.length) s += '.' + c.join('.');
    const t = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40);
    return t ? s + '  "' + t + '"' : s;
  };

  const visible = (el, cs) =>
    cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.01 &&
    el.offsetWidth > 0 && el.offsetHeight > 0;

  const scrolls = (cs) => /auto|scroll/.test(cs.overflowX + ' ' + cs.overflowY);
  const clips  = (cs) => /hidden|clip|auto|scroll/.test(cs.overflowX + ' ' + cs.overflowY);
  const outOfFlow = (cs) => cs.position === 'absolute' || cs.position === 'fixed';

  // A single-line run that clips with an ellipsis is TRUNCATING ON PURPOSE, and
  // the design system says that is one of the legitimate answers to text that
  // does not fit (.u-truncate, .aitem-name, .pathchip-dir, .lrow-name...).
  // Reporting those as clipping made the real cut-off text impossible to find.
  // The one thing that IS still wrong is truncating with no way to read the
  // whole string, so those land in their own quiet bucket instead.
  const ellipsis = (cs) =>
    cs.textOverflow === 'ellipsis' && /hidden|clip/.test(cs.overflowX) && /nowrap|pre$/.test(cs.whiteSpace);
  const hasFullText = (el) =>
    !!(el.title || el.getAttribute('aria-label') || el.dataset.tip ||
       (el.parentElement && (el.parentElement.title || el.parentElement.dataset.tip)) ||
       el.closest('[title]'));

  // Is this element's scroll overflow caused by something OUT OF FLOW -- an
  // absolutely positioned child, or an abs ::before/::after such as a data-tip
  // bubble? A popup is meant to be bigger than its anchor, so that is a
  // different finding from text being cut off. <html>/<body> are exempt: the
  // page itself must never overflow, whatever caused it.
  // How much do the IN-FLOW children alone stick out of the padding box? This is
  // what decides OVERFLOW vs POPOVER, and it has to be measured rather than
  // guessed: "does this element contain anything absolutely positioned" put the
  // whole titlebar in the popover bucket because of one 1px .nav-ind, and hid a
  // genuine 133px overflow whose cause was the in-flow window-control group.
  // Direct children only: a grandchild that overflows a non-clipping child is
  // reported on that child in its own right, so the chain is never lost.
  const inflowOverflow = (el, cs, r) => {
    const kids = el.children;
    if (!kids.length) return { dw: el.scrollWidth - el.clientWidth, dh: el.scrollHeight - el.clientHeight };
    const bl = parseFloat(cs.borderLeftWidth) || 0;
    const bt = parseFloat(cs.borderTopWidth) || 0;
    const right = r.left + bl + el.clientWidth;
    const bottom = r.top + bt + el.clientHeight;
    let dw = 0, dh = 0;
    for (const k of kids) {
      if (k.hasAttribute('hidden')) continue;
      const kcs = getComputedStyle(k);
      if (outOfFlow(kcs) || kcs.display === 'none' || kcs.visibility === 'hidden') continue;
      const kr = k.getBoundingClientRect();
      if (kr.width < 1 && kr.height < 1) continue;
      if (kr.right - right > dw) dw = kr.right - right;
      if (kr.bottom - bottom > dh) dh = kr.bottom - bottom;
    }
    return { dw, dh };
  };

  const all = Array.from(document.querySelectorAll('*'));
  for (const el of all) {
    if (el.closest('[hidden]') || el.hasAttribute('hidden')) continue;
    const cs = getComputedStyle(el);
    if (!visible(el, cs)) continue;
    const r = el.getBoundingClientRect();
    // 1x1 is the screen-reader-only pattern (.u-hidden-visually): its content is
    // MEANT to be far bigger than its box.
    if (r.width <= 1 || r.height <= 1) continue;

    // 1. Content bigger than its own box, in a box that cannot scroll to reveal
    //    it. That is text or a control being cut off.
    //    A form field is exempt: an <input>'s content is the user's own value and
    //    the field scrolls it natively as you type, so "value wider than the box"
    //    is normal operation, not clipping. (A 300px-long project name in a 132px
    //    field is a wide value, not a layout defect.)
    if (!scrolls(cs) && !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) {
      const dw = el.scrollWidth - el.clientWidth;
      const dh = el.scrollHeight - el.clientHeight;
      // 1px is rounding; a canvas manages its own bitmap.
      const cut = ellipsis(cs);
      // <html>/<body> keep the RAW figure: whatever caused it, the page itself
      // must never be wider or taller than the window, and this is the one
      // headline that says a popup has escaped the viewport.
      const page = el === document.body || el === document.documentElement;
      if (el.tagName !== 'CANVAS' && page && (dw > 1 || dh > 1)) {
        out.overflow.push({ el: label(el), dw, dh, w: Math.round(r.width), h: Math.round(r.height) });
      } else if (el.tagName !== 'CANVAS' && ((cut ? 0 : dw) > 1 || dh > 1)) {
        const flow = inflowOverflow(el, cs, r);
        // The in-flow figure can never exceed the real one; clamp so a rounding
        // difference in a rect cannot invent an overflow.
        const fdw = Math.min(dw, Math.max(0, Math.round(flow.dw)));
        const fdh = Math.min(dh, Math.max(0, Math.round(flow.dh)));
        if ((cut ? 0 : fdw) > 1 || fdh > 1) {
          out.overflow.push({ el: label(el), dw: fdw, dh: fdh, w: Math.round(r.width), h: Math.round(r.height) });
        } else {
          out.popover.push({ el: label(el), dw, dh, w: Math.round(r.width), h: Math.round(r.height) });
        }
      }
      if (cut && dw > 1 && !hasFullText(el)) {
        out.truncated.push({ el: label(el), dw, w: Math.round(r.width) });
      }
    }

    // 2. Painted box escaping the nearest clipping ancestor.
    let anc = el.parentElement;
    while (anc && anc !== document.body) {
      const acs = getComputedStyle(anc);
      if (clips(acs)) {
        const ar = anc.getBoundingClientRect();
        const outL = ar.left - r.left, outR = r.right - ar.right;
        const outT = ar.top - r.top,  outB = r.bottom - ar.bottom;
        // Ignore the scroll axis: content is meant to extend along it.
        const bad = Math.max(
          /auto|scroll/.test(acs.overflowX) ? 0 : Math.max(outL, outR),
          /auto|scroll/.test(acs.overflowY) ? 0 : Math.max(outT, outB)
        );
        if (bad > 1 && !outOfFlow(cs)) out.escape.push({ el: label(el), by: Math.round(bad), inside: label(anc) });
        break;
      }
      anc = anc.parentElement;
    }

    // 3. Wholly outside the viewport -- and NOT because a scroll container it
    //    lives in happens to be scrolled somewhere else. Content below the fold
    //    of a scrolling rail is not a defect; a fixed or absolutely placed box
    //    parked off the window is. This check used to report every element of
    //    every panel's scrolled-out inspector section, ~130 rows of pure noise
    //    that buried the four window buttons genuinely pushed off the titlebar.
    if (r.right < -1 || r.bottom < -1 || r.left > vw + 1 || r.top > vh + 1) {
      let scrollable = false;
      for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
        if (/auto|scroll/.test(getComputedStyle(a).overflowX + ' ' + getComputedStyle(a).overflowY)) { scrollable = true; break; }
      }
      if (!scrollable && !el.closest('.vlist, .dlg-scrim, .menu, .toast-host, .toasts, .splash, .pal-scrim')) {
        out.offscreen.push({ el: label(el), x: Math.round(r.left), y: Math.round(r.top) });
      }
    }
  }

  // 4. Sibling overlap among in-flow leaf-ish elements. Positioned things are
  //    meant to overlap, so only static siblings count.
  const seen = new Set();
  for (const el of all) {
    const kids = Array.from(el.children).filter((k) => {
      if (k.hasAttribute('hidden')) return false;
      const cs = getComputedStyle(k);
      return visible(k, cs) && cs.position === 'static' && cs.float === 'none';
    });
    for (let i = 0; i < kids.length; i++) {
      for (let j = i + 1; j < kids.length; j++) {
        const a = kids[i].getBoundingClientRect(), b = kids[j].getBoundingClientRect();
        const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (ox > 1 && oy > 1) {
          const key = label(kids[i]) + '|' + label(kids[j]);
          if (seen.has(key)) continue;
          seen.add(key);
          out.overlap.push({ a: label(kids[i]), b: label(kids[j]), ox: Math.round(ox), oy: Math.round(oy) });
        }
      }
    }
  }
  return out;
})()`;

// ===========================================================================
//  PAGES AND THEIR STATES
//  A state is { name, js?, main? }. `js` is evaluated in the page (a setup
//  script: open a sheet, switch a pane, select a row); `main` is an async fn
//  given the BrowserWindow, for pushing the events main.js would push. States
//  run in order in ONE window, each building on the last, and each is probed.
// ===========================================================================

const push = (win, channel, payload) => { try { win.webContents.send(channel, payload); } catch (_) {} };

// Wait for the page to be QUIET, not for a guessed number of milliseconds.
// Every render in the app is coalesced through a rAF (renderStrip, renderLog,
// VList.invalidate), so a fixed timeout caught a half-applied frame now and
// then -- a VList whose sizer had grown but whose rows had not moved yet showed
// up as a 306px overflow that was gone on the next run. Two frames plus a beat
// is enough for a rAF that schedules another rAF.
const SETTLE_JS = `new Promise((r) => requestAnimationFrame(() =>
  requestAnimationFrame(() => setTimeout(r, 120))))`;
async function settle(win) {
  try { await win.webContents.executeJavaScript(SETTLE_JS, true); }
  catch (_) { await new Promise((r) => setTimeout(r, 250)); }
}

// Fill the shell's activity strip, log and transport the way a working session
// would: a Forge job in flight, log traffic including errors, an update on
// offer, a game detected, and a real song playing with a long title.
const shellBusy = async (win) => {
  push(win, 'forge:status', { event: 'forge.job', jobId: 'j1', name: SONGS[1], kind: 'file' });
  push(win, 'forge:status', { event: 'forge.log', jobId: 'j1', line: `input: ${path.join(EXTRA_DIR, SONGS[1] + '.wav')}` });
  for (let i = 0; i < 40; i++) {
    push(win, 'forge:status', {
      event: 'forge.log', jobId: 'j1',
      line: i % 9 === 8
        ? `WARNING: onset model fell back to CPU for segment ${i} (cuda out of memory, 148 MiB short)`
        : `[demucs] separating stem ${i + 1}/40  ${path.join(EXTRA_DIR, SONGS[i % SONGS.length] + '.wav')}`,
      level: i % 17 === 16 ? 'error' : 'info',
    });
  }
  push(win, 'forge:status', { event: 'forge.progress', jobId: 'j1', stage: 'Separating stems (demucs htdemucs_ft)', percent: 41 });
  push(win, 'engine-error', 'Sidecar reported: could not launch the keypress engine (pywin32 missing)');
  push(win, 'update-status', { state: 'available', version: '2.28.0', current: '2.27.1', percent: 0, staged: false, canSelfUpdate: true });
  push(win, 'game-active', { name: 'RobloxPlayerBeta' });
  await new Promise((r) => setTimeout(r, 250));
};

const SHELL_TRANSPORT = `(() => {
  if (!window.Bus) return 'no bus';
  const caps = { seek: true, rate: true, loop: true, queue: true, volume: true, transpose: true,
                 target: 'Roblox - Grand Piano', notes: 4821 };
  window.Bus.send('transport:claim', { owner: 'player', caps: caps }, { local: true });
  window.Bus.send('transport:state', { owner: 'player', status: 'playing', position: 74.312,
    duration: 263.482, rate: 1.25, loop: { a: 40, b: 180 },
    label: ${JSON.stringify(SONGS[1])}, dirty: false, caps: caps }, { local: true });
  return 'ok';
})()`;

const settingsPane = (pane) => `(() => {
  const scrim = document.getElementById('set-scrim');
  if (scrim && scrim.hidden) document.getElementById('settings-btn').click();
  const b = document.querySelector('#set-nav button[data-pane="' + ${JSON.stringify(pane)} + '"]');
  if (b) b.click();
  return ${JSON.stringify(pane)};
})()`;

const PAGES = [
  {
    name: 'shell', file: 'renderer/index.html',
    states: [
      { name: 'boot' },
      { name: 'busy', main: shellBusy, js: SHELL_TRANSPORT },
      { name: 'log-open', js: `document.getElementById('as-log-toggle').click(), 'ok'` },
      { name: 'palette', js: `(() => {
          document.getElementById('search-trigger').click();
          const i = document.getElementById('pal-input');
          i.value = 'no';
          i.dispatchEvent(new Event('input', { bubbles: true }));
          return 'ok';
        })()` },
      { name: 'palette-empty', js: `(() => {
          const i = document.getElementById('pal-input');
          i.value = 'zzzzqqqq';
          i.dispatchEvent(new Event('input', { bubbles: true }));
          return 'ok';
        })()` },
      { name: 'settings-appearance', js: `(() => {
          document.getElementById('pal-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          const s = document.getElementById('pal-scrim'); if (s) s.hidden = true;
          document.getElementById('settings-btn').click();
          return 'ok';
        })()` },
      { name: 'settings-playback', js: settingsPane('playback') },
      { name: 'settings-performance', js: `(() => {
          const b = document.querySelector('#set-nav button[data-pane="performance"]');
          if (b) b.click();
          const t = document.getElementById('s-perf-toggle');
          if (t && t.getAttribute('aria-expanded') !== 'true') t.click();
          return 'ok';
        })()` },
      { name: 'settings-forge', js: settingsPane('forge') },
      { name: 'settings-storage', js: settingsPane('storage') },
      { name: 'settings-updates', js: settingsPane('updates') },
      { name: 'settings-overlay', js: settingsPane('overlay') },
      { name: 'settings-about', js: settingsPane('about') },
    ],
  },
  {
    name: 'forge', file: 'renderer/forge/index.html',
    states: [
      { name: 'default' },
      {
        name: 'running',
        main: async (win) => {
          push(win, 'forge:status', { event: 'forge.job', jobId: 'j1', name: SONGS[1], kind: 'file' });
          push(win, 'forge:status', { event: 'forge.progress', jobId: 'j1', stage: 'Transcribing piano (transkun)', percent: 63 });
          for (let i = 0; i < 24; i++) {
            push(win, 'forge:status', { event: 'forge.log', jobId: 'j1', line: `[transkun] frame ${i * 512} / 12288  ${SONGS[i % SONGS.length]}` });
          }
          await new Promise((r) => setTimeout(r, 200));
        },
      },
    ],
  },
  {
    name: 'editor', file: 'renderer/review/index.html',
    states: [
      { name: 'default' },
      // The Editor boots empty and only ever loads a document from a user
      // action, so its whole working layout -- piano roll, track list,
      // inspector, candidate switcher -- is invisible to an audit that just
      // loads the page. This clicks its own Open button; review:pick and
      // review:load answer with the 3200-note fixture project.
      { name: 'loaded', js: `(() => {
          const b = document.getElementById('empty-open');
          if (!b) return 'no #empty-open';
          b.click();
          return new Promise((r) => setTimeout(() => r('opened'), 1200));
        })()` },
    ],
  },
  {
    name: 'player', file: 'renderer/player/index.html',
    states: [
      { name: 'default' },
      {
        name: 'loaded',
        main: async (win) => {
          push(win, 'engine-event', { event: 'ready' });
          push(win, 'engine-event', WINDOWS_EVENT);
          push(win, 'engine-event', MIDI_LOADED);
          await new Promise((r) => setTimeout(r, 300));
        },
      },
      {
        name: 'playing',
        main: async (win) => {
          push(win, 'engine-event', { event: 'playback_started', duration: MIDI_LOADED.duration });
          push(win, 'engine-event', { event: 'progress', t: 74.312, sent: 812, total: 2600 });
          await new Promise((r) => setTimeout(r, 200));
        },
      },
    ],
  },
  {
    name: 'selfmidi', file: 'renderer/audition/index.html',
    states: [
      { name: 'default' },
      {
        name: 'measure',
        js: ,
      },
      {
        name: 'loaded',
        js: `(async () => {
          const row = document.querySelector('#nav-files [role="option"], #nav-files .lrow');
          if (!row) return 'no rows';
          row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          await new Promise(r => setTimeout(r, 900));
          return document.getElementById('sm-song').hidden
            ? 'STILL HIDDEN state=' + document.getElementById('sm-state-title').textContent
            : 'song=' + document.getElementById('song-title').textContent;
        })()`,
      },
      {
        name: 'loaded-info',
        js: `(async () => {
          document.getElementById('info-head').click();
          document.getElementById('loop-on').click();
          document.getElementById('loop-set-a').click();
          document.getElementById('mark-name').value = 'the bit right before the key change';
          document.getElementById('mark-add').click();
          document.getElementById('mark-name').value = 'B';
          document.getElementById('mark-add').click();
          await new Promise(r => setTimeout(r, 300));
          return 'ok';
        })()`,
      },
      {
        name: 'queue-history',
        js: `(async () => {
          const rows = Array.from(document.querySelectorAll('#nav-files [role="option"], #nav-files .lrow')).slice(0, 14);
          for (const n of rows) {
            n.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 300 }));
            const add = Array.from(document.querySelectorAll('.menu.is-open .menu-item'))
              .find(b => /Add to Queue/.test(b.textContent));
            if (add) add.click(); else document.body.click();
            await new Promise(r => setTimeout(r, 25));
          }
          await new Promise(r => setTimeout(r, 350));
          return 'queue=' + document.getElementById('queue-count').textContent;
        })()`,
      },
      {
        name: 'rowmenu',
        js: `(async () => {
          const row = document.querySelector('#nav-files [role="option"], #nav-files .lrow');
          row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 150, clientY: 430 }));
          await new Promise(r => setTimeout(r, 250));
          return 'menus=' + document.querySelectorAll('.menu.is-open').length;
        })()`,
      },
      {
        name: 'playlists',
        js: `(async () => {
          document.body.click();
          await new Promise(r => setTimeout(r, 80));
          document.getElementById('nav-tab-playlists').click();
          await new Promise(r => setTimeout(r, 250));
          return 'ok';
        })()`,
      },
      {
        name: 'favorites',
        js: `(async () => {
          document.getElementById('nav-tab-favorites').click();
          await new Promise(r => setTimeout(r, 250));
          return 'ok';
        })()`,
      },
      {
        name: 'search-empty',
        js: `(async () => {
          document.getElementById('nav-tab-library').click();
          const s = document.getElementById('nav-search');
          s.value = 'zzzzzz no such song anywhere in this library at all';
          s.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise(r => setTimeout(r, 450));
          return 'ok';
        })()`,
      },
      {
        name: 'name-sheet',
        js: `(async () => {
          const s = document.getElementById('nav-search');
          s.value = ''; s.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise(r => setTimeout(r, 250));
          document.getElementById('rail-save').click();
          await new Promise(r => setTimeout(r, 300));
          const i = document.getElementById('name-input');
          if (i) i.value = 'Practice list for the November recital, take two';
          const sc = document.getElementById('name-scrim');
          if (sc.hidden) { document.getElementById('name-title').textContent = 'Save the queue as a playlist'; sc.hidden = false; sc.classList.add('is-open'); document.getElementById('name-input').value = 'Practice list for the November recital, take two'; }
          await new Promise(r => setTimeout(r, 120));
          return 'saveDisabled=' + document.getElementById('rail-save').disabled;
        })()`,
      },
      {
        name: 'error',
        js: `(async () => {
          const c = document.getElementById('name-cancel'); if (c) c.click();
          await new Promise(r => setTimeout(r, 250));
          document.getElementById('sm-song').hidden = true;
          const st = document.getElementById('sm-state');
          st.hidden = false; st.classList.add('is-error');
          document.getElementById('sm-state-title').textContent = 'Could not open this MIDI';
          document.getElementById('sm-state-msg').textContent =
            'EBUSY: resource busy or locked, open C:/Users/stars/Documents/MIDI Studio/Rachmaninoff - Piano Concerto No. 2 in C minor, Op. 18 - II. Adagio sostenuto.mid -- the file could not be read. It may have moved, be open in another program, or be a different format entirely.';
          return 'ok';
        })()`,
      },
      {
        name: 'dropveil',
        js: `(() => { document.documentElement.setAttribute('data-drop', 'on'); return 'ok'; })()`,
      },
    ],
  },
  {
    name: 'library', file: 'renderer/library/index.html',
    states: [
      { name: 'default' },
      {
        name: 'row-selected',
        js: `(() => {
          const row = document.querySelector('.vlist .lrow, .vlist [role="option"]');
          if (!row) return 'no rows';
          row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          return 'clicked';
        })()`,
      },
    ],
  },
];

// ===========================================================================
//  RUNNER
// ===========================================================================

app.commandLine.appendSwitch('disable-renderer-backgrounding');
// The first run of this harness died with a crashpad "not connected" abort part
// way through, which took every page after it down with it. Nothing here needs
// the crash reporter, and no page is audited after the process is gone.
app.commandLine.appendSwitch('disable-crash-reporter');
app.commandLine.appendSwitch('no-sandbox');
app.disableHardwareAcceleration();
// THE BUG THAT KILLED THE FIRST RUN. Every page is audited in its own window and
// the window is destroyed before the next one opens, so between two pages there
// are zero windows -- and Electron's default 'window-all-closed' behaviour quits
// the app on Windows. The run ended, quietly and with exit code 0, after
// whichever page happened to be first (crashpad then complained it was "not
// connected" on the way down). Owning this event is what makes the loop finish.
app.on('window-all-closed', () => { /* the runner decides when we are done */ });

function countOf(res) {
  return res.overflow.length + res.escape.length + res.overlap.length + res.offscreen.length;
}

function printState(pageName, stateName, res, console_, popovers) {
  const n = countOf(res) + console_.length;
  const tail = [
    n ? `${n}` : 'clean',
    popovers ? `${popovers} popover` : '',
    res.truncated.length ? `${res.truncated.length} untitled-truncation` : '',
  ].filter(Boolean).join(', ');
  console.log(`\n-- ${pageName} / ${stateName}  (${tail})`);
  for (const c of console_.slice(0, 12)) console.log(`   ${c}`);
  for (const o of res.overflow.slice(0, 14)) {
    const w = o.dw > 1 ? `${o.dw}px wide` : '';
    const h = o.dh > 1 ? `${o.dh}px tall` : '';
    console.log(`   OVERFLOW  ${o.el}  content exceeds box by ${[w, h].filter(Boolean).join(', ')}  (box ${o.w}x${o.h})`);
  }
  for (const o of res.escape.slice(0, 12)) console.log(`   ESCAPE    ${o.el}  ${o.by}px outside  ${o.inside}`);
  for (const o of res.overlap.slice(0, 12)) console.log(`   OVERLAP   ${o.a}\n             over  ${o.b}   (${o.ox}x${o.oy}px)`);
  for (const o of res.offscreen.slice(0, 8)) console.log(`   OFFSCREEN ${o.el}  at ${o.x},${o.y}`);
  for (const o of res.truncated.slice(0, 6)) {
    console.log(`   truncated ${o.el}  clipped by ${o.dw}px with an ellipsis but no title/aria-label  (box ${o.w})`);
  }
  for (const o of res.popover.slice(0, 6)) {
    const w = o.dw > 1 ? `${o.dw}px wide` : '';
    const h = o.dh > 1 ? `${o.dh}px tall` : '';
    console.log(`   popover   ${o.el}  out-of-flow child exceeds anchor by ${[w, h].filter(Boolean).join(', ')}`);
  }
  const more = [
    res.overflow.length > 14 && `${res.overflow.length - 14} more overflow`,
    res.escape.length > 12 && `${res.escape.length - 12} more escape`,
    res.overlap.length > 12 && `${res.overlap.length - 12} more overlap`,
    res.popover.length > 6 && `${res.popover.length - 6} more popover`,
  ].filter(Boolean);
  if (more.length) console.log(`   ... ${more.join(', ')}`);
}

async function auditPage(page, w, h, report) {
  const file = path.join(ROOT, page.file);
  if (!fs.existsSync(file)) {
    console.log(`\n-- ${page.name}: MISSING ${page.file}`);
    report.push({ page: page.name, size: `${w}x${h}`, state: '-', failed: `missing ${page.file}`, counts: {} });
    return 1;
  }

  let win = null;
  let problems = 0;
  const console_ = [];

  try {
    win = new BrowserWindow({
      width: w, height: h, show: true, frame: false, backgroundColor: '#141519',
      webPreferences: {
        preload: path.join(ROOT, 'electron', 'preload.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: false,
        nodeIntegrationInSubFrames: true, backgroundThrottling: false,
      },
    });

    win.webContents.on('console-message', (_e, level, message, line, src) => {
      if (level >= 2) console_.push(`${level === 3 ? 'ERROR' : 'WARN '} ${message}  (${path.basename(src || '')}:${line})`);
    });
    win.webContents.on('did-fail-load', (_e, code, desc, url) => {
      console_.push(`ERROR did-fail-load ${code} ${desc} ${url}`);
    });
    win.webContents.on('render-process-gone', (_e, details) => {
      console_.push(`ERROR render-process-gone ${details && details.reason}`);
    });

    await win.loadFile(file);
    // Let fonts settle, canvases size themselves and the boot IPC answer.
    await new Promise((r) => setTimeout(r, SETTLE));
    await settle(win);

    const states = (page.states || [{ name: 'default' }])
      .filter((s) => !ONLY_STATES || ONLY_STATES.includes(s.name));

    for (const state of states) {
      const taken = console_.splice(0, console_.length);   // console since the last state
      try {
        if (state.main) await state.main(win);
        if (state.js) {
          const r = await win.webContents.executeJavaScript(state.js, true);
          // A setup script may return a note ("no rows", a diagnostic dump);
          // printing it is how you tell "the state was set up" from "the
          // selector missed and the state never happened".
          if (r != null && r !== 'ok' && r !== state.name) console.log(`   setup(${state.name}) -> ${String(r).slice(0, 30000)}`);
        }
        if (state.main || state.js) await settle(win);

        const res = await win.webContents.executeJavaScript(PROBE, true);
        const mine = taken.concat(console_.splice(0, console_.length));
        const n = countOf(res) + mine.length;
        problems += n;
        printState(page.name, state.name, res, mine, res.popover.length);
        report.push({
          page: page.name, size: `${w}x${h}`, state: state.name,
          counts: {
            overflow: res.overflow.length, popover: res.popover.length, escape: res.escape.length,
            overlap: res.overlap.length, offscreen: res.offscreen.length, console: mine.length,
            truncated: res.truncated.length,
          },
          problems: n,
          console: mine, overflow: res.overflow, popover: res.popover,
          escape: res.escape, overlap: res.overlap, offscreen: res.offscreen,
          truncated: res.truncated,
        });

        if (WANT_SHOTS) {
          const img = await win.webContents.capturePage();
          fs.writeFileSync(path.join(ROOT, 'benchmarks', 'shots', `${page.name}-${state.name}-${w}x${h}.png`), img.toPNG());
        }
      } catch (err) {
        console.log(`\n-- ${page.name} / ${state.name}: STATE FAILED  ${err && err.message}`);
        problems++;
        report.push({ page: page.name, size: `${w}x${h}`, state: state.name, failed: String(err && err.message || err), counts: {} });
      }
    }
  } catch (err) {
    console.log(`\n-- ${page.name}: PAGE FAILED  ${err && err.message}`);
    problems++;
    report.push({ page: page.name, size: `${w}x${h}`, state: '-', failed: String(err && err.message || err), counts: {} });
  } finally {
    // Always, whatever happened above: one page must never take the run down.
    try { if (win && !win.isDestroyed()) win.destroy(); } catch (_) {}
    await new Promise((r) => setTimeout(r, 120));
  }
  return problems;
}

app.whenReady().then(async () => {
  registerStubs();
  if (WANT_SHOTS) fs.mkdirSync(path.join(ROOT, 'benchmarks', 'shots'), { recursive: true });

  const report = [];
  let problems = 0;
  const pages = PAGES.filter((p) => !ONLY || ONLY.includes(p.name));

  for (const [w, h] of SIZES) {
    console.log(`\n${'='.repeat(70)}\n  ${w} x ${h}\n${'='.repeat(70)}`);
    for (const page of pages) problems += await auditPage(page, w, h, report);
  }

  // ---- per-page roll-up ---------------------------------------------------
  const byPage = new Map();
  for (const row of report) {
    const k = row.page;
    const acc = byPage.get(k) || { page: k, overflow: 0, popover: 0, escape: 0, overlap: 0, offscreen: 0, console: 0, truncated: 0, failed: 0 };
    if (row.failed) acc.failed++;
    for (const key of ['overflow', 'popover', 'escape', 'overlap', 'offscreen', 'console', 'truncated']) acc[key] += (row.counts && row.counts[key]) || 0;
    byPage.set(k, acc);
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log('  per page (all sizes, all states)');
  console.log(`${'='.repeat(70)}`);
  for (const a of byPage.values()) {
    const bits = ['overflow', 'escape', 'overlap', 'offscreen', 'console', 'popover', 'truncated']
      .filter((k) => a[k]).map((k) => `${k} ${a[k]}`);
    console.log(`  ${a.page.padEnd(10)} ${a.failed ? `FAILED x${a.failed}  ` : ''}${bits.length ? bits.join(', ') : 'clean'}`);
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    sizes: SIZES.map(([w, h]) => `${w}x${h}`),
    problems,
    stubChannelsInvoked: Array.from(invoked).sort(),
    stubChannelsUnused: Object.keys(HANDLERS).filter((c) => !invoked.has(c)).sort(),
    perPage: Array.from(byPage.values()),
    results: report,
  };
  const outFile = path.join(ROOT, 'benchmarks', 'layout-audit.json');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(summary, null, 2), 'utf-8');

  console.log(`\n${problems ? problems + ' problems' : 'clean'}   ->  benchmarks/layout-audit.json\n`);
  app.exit(problems ? 1 : 0);
});

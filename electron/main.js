// main.js — Electron main process for MIDI Studio.
// One window with Forge, Review, and Player tab iframes. Owns the player
// sidecar, the forge runner/provisioner, the updater, and all IPC.
'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');

const os = require('os');
const paths = require('./paths');
const { Settings } = require('./settings');
const { PlayerSidecar } = require('./sidecar');
const { ForgeRunner, reapOrphanJobs } = require('./forge-runner');
const { ForgeProvisioner } = require('./forge-provisioner');
const forgeStorage = require('./forge-storage');
const library = require('./library');
const { GameWatch } = require('./gamewatch');
const updater = require('./updater');

// Boot diagnostics — a packaged GUI app has no console; this captures startup
// milestones/errors to a file so a silent early exit can be diagnosed.
const BOOT_LOG = path.join(os.tmpdir(), 'midi-studio-boot.log');
function blog(m) { try { fs.appendFileSync(BOOT_LOG, `${Date.now()} ${m}\n`); } catch (_) {} }
blog(`--- boot --- packaged=${app.isPackaged} resources=${process.resourcesPath} argv=${process.argv.slice(1).join(' ')}`);

// Self Midi / Midi Editor keep playing while you are in the game window.
// backgroundThrottling:false alone is not enough: Chromium also backgrounds
// renderers whose window is occluded, which stalls timers and audio scheduling.
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

const OPEN_DEVTOOLS = process.argv.includes('--dev');
const POST_UPDATE = process.argv.includes('--post-update');
const CONFIGURE_FORGE_INDEX = process.argv.indexOf('--configure-forge-storage');
const CONFIGURE_FORGE_STORAGE = CONFIGURE_FORGE_INDEX >= 0
  ? String(process.argv[CONFIGURE_FORGE_INDEX + 1] || '').trim()
  : '';

let win = null;
let settings = null;
let sidecar = null;
let forge = null;
let provisioner = null;
let gameWatch = null;
let lastReady = null; // cached engine 'ready' so a late-loading tab iframe still syncs

const gotLock = CONFIGURE_FORGE_INDEX >= 0 || app.requestSingleInstanceLock();
blog(`gotLock=${gotLock}`);

// ---- frame-aware messaging --------------------------------------------------
// Push to the MAIN (shell) frame only — used for update-status so the shell owns
// the single updater UI (the player iframe must not also pop a banner).
function sendToRenderer(channel, payload) {
  try {
    if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  } catch (_) { /* frame disposing during shutdown */ }
}
// Push to the shell frame AND all tab iframes. webContents.send only reaches
// the main frame, so engine/forge events must be fanned out to subframes or the
// player + forge tabs never receive anything.
function broadcast(channel, payload) {
  try {
    if (!win || win.isDestroyed()) return;
    const wc = win.webContents;
    if (wc.isDestroyed()) return;
    wc.send(channel, payload);
    const main = wc.mainFrame;
    if (main) for (const f of main.framesInSubtree) {
      if (f !== main) { try { f.send(channel, payload); } catch (_) {} }
    }
  } catch (_) {}
}

// List every .mid/.midi in a folder (one level of subfolders), for the player's
// "Songs folder" picker. Capped so a huge tree can't hang the UI.
function listMidis(dir) {
  if (!dir || !paths.exists(dir)) return [];
  const out = [];
  const walk = (d, depth) => {
    let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= 1000) return;
      const full = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < 1) walk(full, depth + 1); }
      else if (e.isFile() && /\.midi?$/i.test(e.name)) out.push(full);
    }
  };
  walk(dir, 0);
  out.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  return out;
}

// The program's output folder — where Forge writes transcriptions and the
// Midi-Player lists from by default. The Forge "Output folder" setting overrides
// it; otherwise it's Documents\MIDI Studio.
function programOutputDir() {
  const set = settings.get('forge.outputDir');
  if (set && String(set).trim()) return String(set);
  return path.join(os.homedir(), 'Documents', 'MIDI Studio');
}

const { uniquePath, candidateTarget } = forgeStorage;

function runMidiDocument(action, midiPath, document) {
  return new Promise((resolve, reject) => {
    const py = paths.bundledPlayerPython() || paths.forgeEnvPython(settings.forgePaths()) || 'python';
    const script = path.join(paths.pythonEngineDir(), 'midi_document.py');
    let stdout = '', stderr = '';
    let child;
    try {
      child = spawn(py, [script, action, midiPath], {
        cwd: paths.pythonEngineDir(), windowsHide: process.platform === 'win32',
        env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' }),
      });
    } catch (error) { reject(error); return; }
    child.stdout.setEncoding('utf-8'); child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.setEncoding('utf-8'); child.stderr.on('data', (data) => { stderr += data; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) { reject(new Error(stderr.trim() || `MIDI helper exited with code ${code}`)); return; }
      try { resolve(JSON.parse(stdout.trim())); } catch { reject(new Error('MIDI helper returned invalid data.')); }
    });
    if (action === 'save') child.stdin.end(JSON.stringify(document || {}));
  });
}

async function loadReviewFile(filePath) {
  filePath = String(filePath || '');
  if (!filePath || !paths.exists(filePath)) throw new Error('Project or MIDI file was not found.');
  if (/\.midi?$/i.test(filePath)) {
    const document = await runMidiDocument('load', filePath);
    return {
      projectPath: '',
      project: { format: 'midi-studio-project', version: 1, name: path.basename(filePath, path.extname(filePath)),
        sourceAudio: '', selectedCandidate: 'clean', candidates: { clean: filePath } },
      documents: { clean: document },
    };
  }
  const project = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  if (project.format !== 'midi-studio-project' || !isObj(project.candidates)) throw new Error('This is not a MIDI Studio project.');
  const documents = {};
  for (const [name, midiPath] of Object.entries(project.candidates)) {
    if (paths.exists(midiPath)) documents[name] = await runMidiDocument('load', midiPath);
  }
  if (!Object.keys(documents).length) throw new Error('The project MIDI files could not be found.');
  return { projectPath: filePath, project, documents };
}

function createWindow() {
  const wb = settings.get('window') || {};
  win = new BrowserWindow({
    width: wb.width || 1240, height: wb.height || 880, minWidth: 1040, minHeight: 700,
    x: typeof wb.x === 'number' ? wb.x : undefined,
    y: typeof wb.y === 'number' ? wb.y : undefined,
    backgroundColor: '#0e1014', title: 'MIDI Studio', show: false, autoHideMenuBar: true,
    icon: paths.appIcon() || undefined,
    webPreferences: {
      preload: paths.preloadScript(),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
      nodeIntegrationInSubFrames: true,
      // Review/Audition preview runs on requestAnimationFrame; Chromium throttles
      // that in a background window, which freezes playback the moment you alt-tab.
      backgroundThrottling: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(paths.rendererIndexHtml());
  win.once('ready-to-show', () => {
    if (wb.maximized) win.maximize();
    win.show();
    if (OPEN_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' });
  });

  // A tab iframe loads after the engine may have already emitted 'ready'. Replay
  // the cached ready to it once it has finished loading (and thus subscribed).
  win.webContents.on('did-frame-finish-load', (_e, isMainFrame) => {
    if (isMainFrame || !lastReady) return;
    setTimeout(() => broadcast('engine-event', lastReady), 60);
  });

  // An iframe calling preventDefault in beforeunload (the Editor does, when it
  // has unsaved notes) silently cancels the close unless we answer for it — the
  // window just refused to close, with no dialog and no way out but Task Manager.
  win.webContents.on('will-prevent-unload', (e) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question', title: 'Unsaved changes',
      message: 'The Midi Editor has unsaved note edits.',
      detail: 'Close anyway and lose them?',
      buttons: ['Keep editing', 'Discard and close'], defaultId: 0, cancelId: 0,
    });
    if (choice === 1) e.preventDefault(); // proceed with the close
  });

  // Closing mid-transcription throws away 20+ minutes of GPU time, or a
  // multi-GB setup download, without asking.
  win.on('close', (e) => {
    const job = forge && forge.isRunning();
    const setup = provisioner && provisioner.isRunning();
    if (!job && !setup) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question', title: 'Still working',
      message: job ? 'A transcription is still running.' : 'Midi Forge setup is still downloading.',
      detail: 'Quit anyway? The work in progress is lost.',
      buttons: ['Keep running', 'Quit anyway'], defaultId: 0, cancelId: 0,
    });
    if (choice !== 1) e.preventDefault();
  });

  // Tab shortcuts have to be caught in the main process: the stage iframe covers
  // almost the whole window, so a keydown listener in the shell frame never sees
  // them once the user has clicked into a tab.
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown' || !input.control || input.alt || input.meta) return;
    const tab = { 1: 'forge', 2: 'player', 3: 'review', 4: 'audition' }[input.key];
    if (!tab) return;
    sendToRenderer('shell-shortcut', { tab });
    e.preventDefault();
  });

  // Blank-screen recovery: a missing/corrupt renderer should not fail silently.
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    if (code === -3) return; // aborted (normal during reloads)
    dialog.showErrorBox('MIDI Studio failed to load',
      `The interface couldn't load (${desc} ${code}).\n${url}\nTry reinstalling.`);
  });

  const persist = debounce(() => {
    if (!win) return;
    const maximized = win.isMaximized();
    const patch = { window: { maximized } };
    if (!maximized) { const b = win.getBounds(); Object.assign(patch.window, { width: b.width, height: b.height, x: b.x, y: b.y }); }
    settings.merge(patch);
  }, 400);
  win.on('resize', persist);
  win.on('move', persist);
  win.on('closed', () => { win = null; });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
}

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

// ---- services ---------------------------------------------------------------
function createServices() {
  // Make user mappings persistent (AppData) and tell the player engine where
  // to find them — set BEFORE the sidecar spawns so it inherits the env var.
  try {
    const md = paths.ensureUserMappings();
    process.env.MIDI_STUDIO_MAPPINGS_DIR = md;
    blog(`user mappings dir=${md}`);
  } catch (e) { blog(`ensureUserMappings failed: ${e && e.message}`); }

  sidecar = new PlayerSidecar({
    getSettings: () => settings.getAll(),
    onEvent: (payload) => {
      const ev = payload && payload.event;
      if (ev === 'ready') lastReady = payload;
      if (ev === 'ready' || ev === 'error') console.log('[player]', JSON.stringify(payload).slice(0, 200));
      broadcast('engine-event', payload);
    },
    onError: (msg) => broadcast('engine-error', msg),
  });
  // Starting python while the window is still painting makes first launch feel
  // broken on a slow machine (and it is the moment Defender is scanning the
  // freshly installed files). The Player tab needs it, not the splash.
  setTimeout(() => {
    Promise.resolve(sidecar.start()).catch((e) => broadcast('engine-error', `Player engine failed to start: ${e && e.message || e}`));
  }, 1200);

  const forgeEmit = (payload) => {
    // Move each finished transcription into the program's output folder so they
    // collect in one place, then tell the player to re-scan.
    if (payload && payload.event === 'forge.done' && payload.ok && payload.result && payload.result.midiPath) {
      let mp = String(payload.result.midiPath);
      try {
        const outDir = programOutputDir();
        fs.mkdirSync(outDir, { recursive: true });
        const moved = new Map();
        const moveOutput = (source) => {
          source = String(source || '');
          if (!source || !paths.exists(source)) return source;
          const key = path.resolve(source).toLowerCase();
          if (moved.has(key)) return moved.get(key);
          let dest = source;
          if (path.resolve(path.dirname(source)).toLowerCase() !== path.resolve(outDir).toLowerCase()) {
            dest = uniquePath(path.join(outDir, path.basename(source)));
            try { fs.renameSync(source, dest); }
            catch { fs.copyFileSync(source, dest); try { fs.unlinkSync(source); } catch {} }
          }
          moved.set(key, dest);
          return dest;
        };
        mp = moveOutput(mp);
        if (payload.result.candidates && isObj(payload.result.candidates)) {
          const candidates = {};
          for (const [name, file] of Object.entries(payload.result.candidates)) {
            candidates[name] = moveOutput(file);
          }
          payload.result.candidates = candidates;
          // Named off the FINAL midi basename so the pair never drifts apart.
          const projectPath = path.join(outDir, path.basename(mp, path.extname(mp)) + '.midstudio.json');
          const project = {
            format: 'midi-studio-project', version: 1,
            name: path.basename(mp, path.extname(mp)),
            sourceAudio: payload.result.sourceAudio || '',
            previewAudio: payload.result.previewAudio || payload.result.sourceAudio || '',
            selectedCandidate: 'clean', candidates,
            candidateCounts: payload.result.candidateCounts || {},
            pipeline: payload.result.pipeline || 'melody',
            timing: payload.result.timing || {},
            createdAt: new Date().toISOString(),
          };
          fs.writeFileSync(projectPath, JSON.stringify(project, null, 2), 'utf-8');
          payload.result.projectPath = projectPath;
        }
      } catch (_) {}
      payload.result.midiPath = mp;
      broadcast('library-changed', path.dirname(mp));
    }
    broadcast('forge:status', payload);
  };
  forge = new ForgeRunner({ emit: forgeEmit,
    getSettings: () => Object.assign({}, settings.forgePaths(), { perfMode: !!(settings.get('ui') || {}).perfMode }) });
  // While a game is up, this app is the guest: idle priority, smaller batches,
  // and the renderer drops to its limited draw rate.
  gameWatch = new GameWatch((game) => {
    if (forge) forge.setBackground(!!game);
    broadcast('game-active', { game: game || '' });
  });
  // Nothing needs to know about a running game in the first seconds.
  setTimeout(() => gameWatch.start(), 8000);
  try { adoptInstallerForgePath(); } catch (e) { blog(`adopt forge path failed: ${e.message}`); }
  // A previous run that was force-killed can leave a Forge job pinning the GPU.
  try {
    const reaped = reapOrphanJobs();
    if (reaped) { blog(`reaped ${reaped} orphaned forge job(s)`); setTimeout(() =>
      broadcast('forge:status', { event: 'forge.log', line: `Stopped ${reaped} leftover Forge job${reaped === 1 ? '' : 's'} from a previous session.`, level: 'info' }), 1500); }
  } catch (e) { blog(`reap failed: ${e.message}`); }
  provisioner = new ForgeProvisioner({ emit: forgeEmit, getSettings: () => settings.forgePaths(), settings });
}

// ---- IPC --------------------------------------------------------------------
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const FORGE_SETTINGS_KEYS = ['pipeline', 'skipSeparation', 'advanced', 'outputDir', 'timing'];

// Free space on the drive that holds the Forge env. Setup writes ~15 GB there
// (pip cache and temp included), so the number belongs next to the path.
function freeGb(dir) {
  try {
    const probe = fs.existsSync(dir) ? dir : path.parse(path.resolve(dir)).root;
    const st = fs.statfsSync(probe);
    return Math.round((st.bavail * st.bsize) / (1024 ** 3) * 10) / 10;
  } catch (_) { return null; }
}

function forgeInfo() {
  const s = settings.forgePaths();
  const dir = paths.forgeEnvDir(s);
  return { version: app.getVersion(), forgeReady: paths.forgeEnvReady(s),
    forgePython: paths.forgeEnvPython(s), forgeEnvDir: dir, forgeFreeGb: freeGb(dir),
    forgeDefaultDir: paths.forgeEnvDir({}), forgeCustom: !!s.forgeEnvDir };
}

// The installer records the folder the user picked; the app applies it on its
// first run. (It used to be applied by the installer launching the app, which
// caused install-time failures.)
function adoptInstallerForgePath() {
  if (process.platform !== 'win32') return;
  if (settings.forgePaths().forgeEnvDir) return;         // an explicit choice already exists
  let chosen = '';
  try {
    const out = spawnSync('reg.exe', ['query', 'HKCU\Software\StarsationX\MIDI Studio', '/v', 'ForgeStorageDir'],
      { windowsHide: true, encoding: 'utf-8', timeout: 5000 });
    const match = /ForgeStorageDir\s+REG_SZ\s+(.+)/i.exec(out.stdout || '');
    chosen = match ? match[1].trim() : '';
  } catch (_) { return; }
  if (!chosen) return;
  const current = paths.forgeEnvDir(settings.forgePaths());
  if (forgeStorage.samePath(chosen, current)) return;
  try {
    forgeStorage.assertWritable(path.dirname(chosen));
    forgeStorage.markManaged(chosen);
    settings.merge({ paths: { forgeEnvDir: forgeStorage.samePath(chosen, paths.forgeEnvDir({})) ? '' : chosen,
      forgePythonPath: '', modelsDir: '' } });
    blog(`adopted installer Forge storage: ${chosen}`);
  } catch (e) {
    blog(`installer Forge storage ${chosen} unusable (${e.message}); keeping ${current}`);
  }
}

function syncInstallerForgePath(dir) {
  if (process.platform !== 'win32' || !dir) return;
  try {
    spawnSync('reg.exe', ['add', 'HKCU\\Software\\StarsationX\\MIDI Studio', '/v', 'ForgeStorageDir',
      '/t', 'REG_SZ', '/d', dir, '/f'], { windowsHide: true, stdio: 'ignore' });
  } catch (_) { /* Settings remain the source of truth if registry sync fails. */ }
}

async function changeForgeStorage(fixedTarget = '') {
  if ((forge && forge.isRunning()) || (provisioner && provisioner.isRunning())) {
    return { ok: false, error: 'Wait for the current Forge job or setup to finish.' };
  }
  const current = paths.forgeEnvDir(settings.forgePaths());
  const defaultDir = paths.forgeEnvDir({});
  let target = fixedTarget;
  if (!target) {
    const picked = await dialog.showOpenDialog(win, {
      title: 'Choose where to store the Forge engine',
      defaultPath: path.dirname(current),
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Use this folder',
    });
    if (picked.canceled || !picked.filePaths[0]) return { ok: false, canceled: true };
    target = forgeStorage.targetForSelection(picked.filePaths[0]);
  }
  target = path.resolve(target);
  if (forgeStorage.samePath(current, target)) {
    syncInstallerForgePath(target);
    return { ok: true, unchanged: true, ...forgeInfo() };
  }

  try { forgeStorage.assertWritable(path.dirname(target)); }
  catch (error) { return { ok: false, error: `That location is not writable. Choose another folder. (${error.message})` }; }

  const sourceExists = paths.exists(current);
  const targetExists = paths.exists(target) && !forgeStorage.isEmpty(target);
  let moved = false;
  if (targetExists) {
    if (!forgeStorage.isManaged(target, defaultDir)) {
      return { ok: false, error: 'The destination is not empty. Choose another folder.' };
    }
    const use = await dialog.showMessageBox(win, {
      type: 'question', title: 'Use existing Forge storage?',
      message: 'MIDI Studio files already exist in that location.',
      detail: 'Use them instead of moving the current Forge files?',
      buttons: ['Use existing', 'Cancel'], defaultId: 0, cancelId: 1,
    });
    if (use.response !== 0) return { ok: false, canceled: true };
  } else if (sourceExists) {
    const choice = await dialog.showMessageBox(win, {
      type: 'question', title: 'Move Forge storage?',
      message: 'Move the existing Forge engine to the new location?',
      detail: 'Moving keeps the current setup ready. Starting fresh requires downloading the Forge engine again.',
      buttons: ['Move existing files', 'Start fresh', 'Cancel'], defaultId: 0, cancelId: 2,
    });
    if (choice.response === 2) return { ok: false, canceled: true };
    if (choice.response === 0) { await forgeStorage.moveManaged(current, target, defaultDir); moved = true; }
    else forgeStorage.markManaged(target);
  } else {
    forgeStorage.markManaged(target);
  }

  settings.merge({ paths: { forgeEnvDir: forgeStorage.samePath(target, defaultDir) ? '' : target,
    forgePythonPath: '', modelsDir: '' } });
  syncInstallerForgePath(target);
  return { ok: true, moved, ...forgeInfo() };
}

function wireIpc() {
  ipcMain.handle('engine:send', (_e, msg) => (isObj(msg) ? sidecar.send(msg) : false));

  ipcMain.handle('dialog:openMidi', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Select MIDI file(s)', properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'MIDI', extensions: ['mid', 'midi'] }, { name: 'All files', extensions: ['*'] }] });
    return r.canceled ? [] : r.filePaths;
  });
  ipcMain.handle('dialog:openMapping', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Select mapping JSON',
      defaultPath: paths.userMappingsDir(), properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }, { name: 'All files', extensions: ['*'] }] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('review:pick', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Open MIDI Studio project or MIDI', properties: ['openFile'],
      filters: [{ name: 'MIDI Studio', extensions: ['json', 'mid', 'midi'] }, { name: 'All files', extensions: ['*'] }] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('review:load', async (_e, filePath) => {
    try { return { ok: true, data: await loadReviewFile(filePath) }; }
    catch (error) { return { ok: false, error: String(error.message || error) }; }
  });
  ipcMain.handle('review:saveProject', async (_e, payload) => {
    try {
      payload = isObj(payload) ? payload : {};
      const project = isObj(payload.project) ? payload.project : {};
      const documents = isObj(payload.documents) ? payload.documents : {};
      let projectPath = String(payload.projectPath || '');
      // Opening a plain .mid points candidates.clean at that file. Reusing it as
      // the save target would overwrite the user's original; only a real project
      // file (or a candidate already living beside it) may be written in place.
      const fromProject = !!projectPath;
      if (!projectPath) {
        const r = await dialog.showSaveDialog(win, { title: 'Save MIDI Studio project',
          defaultPath: path.join(programOutputDir(), `${project.name || 'melody'}.midstudio.json`),
          filters: [{ name: 'MIDI Studio project', extensions: ['json'] }] });
        if (r.canceled || !r.filePath) return { ok: false, canceled: true };
        projectPath = r.filePath;
      }
      const projectDir = path.dirname(projectPath);
      const candidates = {};
      for (const [name, document] of Object.entries(documents)) {
        const midiPath = candidateTarget({
          existing: project.candidates && project.candidates[name],
          projectDir, fromProject, fallbackName: `${project.name || 'melody'}_${name}.mid`,
        });
        await runMidiDocument('save', midiPath, document);
        candidates[name] = midiPath;
      }
      const saved = Object.assign({}, project, { format: 'midi-studio-project', version: 1, candidates,
        selectedCandidate: payload.selectedCandidate || project.selectedCandidate || 'clean', updatedAt: new Date().toISOString() });
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(projectPath, JSON.stringify(saved, null, 2), 'utf-8');
      return { ok: true, projectPath, project: saved };
    } catch (error) { return { ok: false, error: String(error.message || error) }; }
  });
  ipcMain.handle('review:exportMidi', async (_e, payload) => {
    try {
      payload = isObj(payload) ? payload : {};
      const r = await dialog.showSaveDialog(win, { title: 'Export edited MIDI',
        defaultPath: path.join(programOutputDir(), `${payload.name || 'melody'}_edited.mid`),
        filters: [{ name: 'MIDI', extensions: ['mid'] }] });
      if (r.canceled || !r.filePath) return { ok: false, canceled: true };
      await runMidiDocument('save', r.filePath, payload.document || {});
      broadcast('library-changed', path.dirname(r.filePath));
      return { ok: true, path: r.filePath };
    } catch (error) { return { ok: false, error: String(error.message || error) }; }
  });
  // ---- Self Midi library ----------------------------------------------------
  const libraryDirs = () => {
    const extra = (settings.get('library.dirs') || []).filter((d) => typeof d === 'string' && d);
    return [programOutputDir(), path.join(os.homedir(), 'Documents', 'MIDI Studio'), ...extra];
  };
  ipcMain.handle('library:list', () => {
    const dirs = libraryDirs();
    return Object.assign({ dirs, extra: settings.get('library.dirs') || [] }, library.list(dirs));
  });
  ipcMain.handle('library:addFolder', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Add a folder of MIDI files',
      properties: ['openDirectory'], buttonLabel: 'Add folder' });
    if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
    const extra = (settings.get('library.dirs') || []).filter(Boolean);
    const picked = path.resolve(r.filePaths[0]);
    if (!extra.some((d) => path.resolve(d).toLowerCase() === picked.toLowerCase())) extra.push(picked);
    settings.merge({ library: { dirs: extra } });
    return { ok: true, dir: picked };
  });
  ipcMain.handle('library:removeFolder', (_e, dir) => {
    const target = path.resolve(String(dir || '')).toLowerCase();
    const extra = (settings.get('library.dirs') || []).filter((d) => path.resolve(d).toLowerCase() !== target);
    settings.merge({ library: { dirs: extra } });
    return { ok: true };
  });
  ipcMain.handle('library:reveal', (_e, p) => shell.showItemInFolder(String(p || '')));

  ipcMain.handle('forge:pause', (_e, paused) => forge.setPaused(!!paused));
  ipcMain.handle('app:openMappingsDir', () => {
    const d = paths.ensureUserMappings();
    return shell.openPath(d);
  });
  ipcMain.handle('forge:pickInput', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Select song / audio file(s)', properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'flac', 'm4a', 'ogg', 'opus', 'aac', 'wma'] }, { name: 'All files', extensions: ['*'] }] });
    return r.canceled ? [] : r.filePaths;
  });
  ipcMain.handle('forge:pickOutDir', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Output folder', properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('app:openExternal', (_e, url) => (/^https?:\/\//i.test(String(url)) ? shell.openExternal(url) : null));
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('app:getUi', () => settings.get('ui') || {});
  ipcMain.handle('app:getOutputDir', () => programOutputDir());
  ipcMain.handle('app:getLibraryDir', () => {
    const manual = settings.get('libraryDir');
    if (manual) return manual;
    const d = programOutputDir();
    try { fs.mkdirSync(d, { recursive: true }); } catch {}
    return d;
  });
  ipcMain.handle('app:setLibraryDir', (_e, dir) => settings.merge({ libraryDir: String(dir || '') }).libraryDir);
  ipcMain.handle('app:listMidis', (_e, dir) => listMidis(String(dir || '')));
  ipcMain.handle('app:pickFolder', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Choose a folder of MIDI files', properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('app:setUi', (_e, patch) => settings.merge({ ui: isObj(patch) ? patch : {} }).ui);
  ipcMain.handle('app:forgeInfo', forgeInfo);
  ipcMain.handle('app:changeForgeFolder', () => changeForgeStorage());
  ipcMain.handle('app:resetForgeFolder', () => changeForgeStorage(paths.forgeEnvDir({})));
  ipcMain.handle('app:openSetupLog', () => {
    const p = paths.forgeSetupLog();
    if (!paths.exists(p)) return { ok: false, error: 'no setup log yet' };
    return shell.openPath(p).then((err) => (err ? shell.showItemInFolder(p) : null)).then(() => ({ ok: true, path: p }));
  });
  ipcMain.handle('app:openForgeFolder', () => {
    const dir = paths.forgeEnvDir(settings.forgePaths());
    const target = paths.exists(dir) ? dir : (paths.exists(path.dirname(dir)) ? path.dirname(dir) : paths.localAppData());
    return shell.openPath(target);
  });
  ipcMain.handle('app:cleanReinstall', () => {
    if ((forge && forge.isRunning()) || (provisioner && provisioner.isRunning())) {
      return { ok: false, error: 'Wait for the current Forge job or setup to finish.' };
    }
    // Only ever delete OUR managed env — never a user's adopted legacy midi-forge.
    const dir = paths.forgeEnvDir(settings.forgePaths());
    if (!forgeStorage.isManaged(dir, paths.forgeEnvDir({}))) return { ok: false, error: 'refused (unsafe path)' };
    try { if (paths.exists(dir)) fs.rmSync(dir, { recursive: true, force: true }); return { ok: true, dir }; }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  ipcMain.handle('shell:openPath', (_e, p) => {
    p = String(p || ''); if (!p || !fs.existsSync(p)) return { ok: false, error: 'not found' };
    return shell.openPath(p).then((err) => (err ? { ok: false, error: err } : { ok: true }));
  });
  ipcMain.handle('shell:showItem', (_e, p) => {
    p = String(p || ''); if (!p || !fs.existsSync(p)) return { ok: false, error: 'not found' };
    shell.showItemInFolder(p); return { ok: true };
  });

  const sendUpdate = (payload) => sendToRenderer('update-status', payload); // shell only
  ipcMain.handle('update:check', (_e, opts) => updater.checkForUpdates(sendUpdate, isObj(opts) ? opts : { manual: true }));
  ipcMain.handle('update:apply', () => updater.applyUpdate(sendUpdate));

  ipcMain.handle('forge:check', () => forge.check());
  ipcMain.handle('forge:provision', () => (provisioner.isRunning() ? { running: true } : (provisioner.start(), { started: true })));
  ipcMain.handle('forge:provision:cancel', () => { provisioner.cancel(); return true; });
  ipcMain.handle('forge:run', (_e, opts) => {
    opts = isObj(opts) ? opts : {};
    return forge.run({
      inputPath: String(opts.inputPath || ''),
      pipeline: String(opts.pipeline || 'melody'),
      skipSeparation: !!opts.skipSeparation,
      outputName: String(opts.outputName || ''),
      advanced: isObj(opts.advanced) ? opts.advanced : {},
      timing: isObj(opts.timing) ? opts.timing : {},
    });
  });
  ipcMain.handle('forge:yt', (_e, opts) => {
    opts = isObj(opts) ? opts : {};
    return forge.ytDownload({ url: String(opts.url || ''), outDir: String(opts.outDir || programOutputDir()) });
  });
  ipcMain.handle('forge:cancel', (_e, jobId) => forge.cancel(String(jobId || '')));
  ipcMain.handle('forge:getSettings', () => settings.get('forge'));
  ipcMain.handle('forge:setSettings', (_e, patch) => {
    const clean = {};
    if (isObj(patch)) for (const k of FORGE_SETTINGS_KEYS) if (k in patch) clean[k] = patch[k];
    return settings.merge({ forge: clean }).forge;
  });
}

// ---- lifecycle --------------------------------------------------------------
if (CONFIGURE_FORGE_INDEX >= 0) {
  app.whenReady().then(async () => {
    try {
      if (!CONFIGURE_FORGE_STORAGE) throw new Error('Forge storage path is missing.');
      settings = new Settings();
      const current = paths.forgeEnvDir(settings.forgePaths());
      const defaultDir = paths.forgeEnvDir({});
      await forgeStorage.configure(settings, CONFIGURE_FORGE_STORAGE, current, defaultDir);
      syncInstallerForgePath(path.resolve(CONFIGURE_FORGE_STORAGE));
      blog(`installer configured Forge storage: ${CONFIGURE_FORGE_STORAGE}`);
      app.exit(0);
    } catch (error) {
      blog(`installer Forge storage error: ${error && error.stack || error}`);
      app.exit(2);
    }
  });
} else if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

  app.whenReady().then(() => {
    blog('whenReady fired');
    try {
      settings = new Settings();
      wireIpc();
      createServices();
      createWindow();
      blog(`window created; index=${paths.rendererIndexHtml()}`);
    } catch (e) { blog(`BOOT ERROR: ${e && e.stack || e}`); throw e; }
    if (POST_UPDATE) {
      setTimeout(() => sendToRenderer('update-status', { state: 'updated', version: app.getVersion() }), 1500);
    } else if (app.isPackaged && settings.get('ui.autoCheckUpdates') !== false) {
      setTimeout(() => updater.checkForUpdates((p) => sendToRenderer('update-status', p), { manual: false }), 4000);
    }
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });

  app.on('window-all-closed', () => { blog('window-all-closed'); cleanup(); if (process.platform !== 'darwin') app.quit(); });

  process.on('unhandledRejection', (e) => { blog(`unhandledRejection: ${e && e.stack || e}`); try { broadcast('engine-event', { event: 'log', level: 'error', message: `Internal error: ${e && e.message || e}` }); } catch (_) {} });
  process.on('uncaughtException', (e) => { blog(`uncaughtException: ${e && e.stack || e}`); try { console.error('[uncaught]', e); broadcast('engine-event', { event: 'log', level: 'error', message: `Internal error: ${e && e.message || e}` }); } catch (_) {} });
}

let cleaned = false;
function cleanup() {
  if (cleaned) return; cleaned = true;
  try { if (sidecar) sidecar.kill(); } catch {}
  try { if (forge) forge.cancelAll(); } catch {}
  try { if (provisioner) provisioner.cancel(); } catch {}
}
app.on('before-quit', cleanup);
app.on('quit', cleanup);
process.on('exit', cleanup);

module.exports = { Notification };

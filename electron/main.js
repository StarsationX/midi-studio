// main.js — Electron main process for MIDI Studio.
// One window, two tab iframes (Midi-Forge + Midi-Player). Owns the player
// sidecar, the forge runner/provisioner, the updater, and all IPC.
'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Notification } = require('electron');
const path = require('path');
const fs = require('fs');

const os = require('os');
const paths = require('./paths');
const { Settings } = require('./settings');
const { PlayerSidecar } = require('./sidecar');
const { ForgeRunner } = require('./forge-runner');
const { ForgeProvisioner } = require('./forge-provisioner');
const updater = require('./updater');

// Boot diagnostics — a packaged GUI app has no console; this captures startup
// milestones/errors to a file so a silent early exit can be diagnosed.
const BOOT_LOG = path.join(os.tmpdir(), 'midi-studio-boot.log');
function blog(m) { try { fs.appendFileSync(BOOT_LOG, `${Date.now()} ${m}\n`); } catch (_) {} }
blog(`--- boot --- packaged=${app.isPackaged} resources=${process.resourcesPath} argv=${process.argv.slice(1).join(' ')}`);

const OPEN_DEVTOOLS = process.argv.includes('--dev');
const POST_UPDATE = process.argv.includes('--post-update');

let win = null;
let settings = null;
let sidecar = null;
let forge = null;
let provisioner = null;
let lastReady = null; // cached engine 'ready' so a late-loading tab iframe still syncs

const gotLock = app.requestSingleInstanceLock();
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
// Push to the shell frame AND both tab iframes. webContents.send only reaches
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
  Promise.resolve(sidecar.start()).catch((e) => broadcast('engine-error', `Player engine failed to start: ${e && e.message || e}`));

  const forgeEmit = (payload) => {
    // Move each finished transcription into the program's output folder so they
    // collect in one place, then tell the player to re-scan.
    if (payload && payload.event === 'forge.done' && payload.ok && payload.result && payload.result.midiPath) {
      let mp = String(payload.result.midiPath);
      try {
        const outDir = programOutputDir();
        fs.mkdirSync(outDir, { recursive: true });
        if (paths.exists(mp) && path.resolve(path.dirname(mp)).toLowerCase() !== path.resolve(outDir).toLowerCase()) {
          const dest = path.join(outDir, path.basename(mp));
          try { fs.renameSync(mp, dest); } catch { fs.copyFileSync(mp, dest); try { fs.unlinkSync(mp); } catch {} }
          mp = dest;
        }
      } catch (_) {}
      payload.result.midiPath = mp;
      broadcast('library-changed', path.dirname(mp));
    }
    broadcast('forge:status', payload);
  };
  forge = new ForgeRunner({ emit: forgeEmit, getSettings: () => settings.forgePaths() });
  provisioner = new ForgeProvisioner({ emit: forgeEmit, getSettings: () => settings.forgePaths() });
}

// ---- IPC --------------------------------------------------------------------
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const FORGE_SETTINGS_KEYS = ['pipeline', 'skipSeparation', 'advanced', 'outputDir'];

function wireIpc() {
  ipcMain.handle('engine:send', (_e, msg) => (isObj(msg) ? sidecar.send(msg) : false));

  ipcMain.handle('dialog:openMidi', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Select MIDI file', properties: ['openFile'],
      filters: [{ name: 'MIDI', extensions: ['mid', 'midi'] }, { name: 'All files', extensions: ['*'] }] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('dialog:openMapping', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Select mapping JSON',
      defaultPath: paths.userMappingsDir(), properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }, { name: 'All files', extensions: ['*'] }] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('app:openMappingsDir', () => {
    const d = paths.ensureUserMappings();
    return shell.openPath(d);
  });
  ipcMain.handle('forge:pickInput', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Select a song / audio file', properties: ['openFile'],
      filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'flac', 'm4a', 'ogg', 'opus', 'aac', 'wma'] }, { name: 'All files', extensions: ['*'] }] });
    return r.canceled ? null : r.filePaths[0];
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
  ipcMain.handle('app:forgeInfo', () => {
    const s = settings.forgePaths();
    return { version: app.getVersion(), forgeReady: paths.forgeEnvReady(s),
      forgePython: paths.forgeEnvPython(s), forgeEnvDir: paths.forgeEnvDir(s) };
  });
  ipcMain.handle('app:openForgeFolder', () => {
    const dir = paths.forgeEnvDir(settings.forgePaths());
    const target = paths.exists(dir) ? dir : (paths.exists(path.dirname(dir)) ? path.dirname(dir) : paths.localAppData());
    return shell.openPath(target);
  });
  ipcMain.handle('app:cleanReinstall', () => {
    // Only ever delete OUR managed env — never a user's adopted legacy midi-forge.
    const dir = paths.forgeEnvDir(settings.forgePaths());
    const lad = paths.localAppData().toLowerCase();
    if (!dir.toLowerCase().startsWith(lad) || !/midi-studio/i.test(dir)) return { ok: false, error: 'refused (unsafe path)' };
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
      pipeline: String(opts.pipeline || 'piano'),
      skipSeparation: !!opts.skipSeparation,
      advanced: isObj(opts.advanced) ? opts.advanced : {},
    });
  });
  ipcMain.handle('forge:yt', (_e, opts) => {
    opts = isObj(opts) ? opts : {};
    return forge.ytDownload({ url: String(opts.url || ''), outDir: String(opts.outDir || '') });
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
if (!gotLock) {
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

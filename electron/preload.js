// preload.js: runs in every frame (top shell + tab iframes).
//   window.api    : the ORIGINAL midi-player bridge (unchanged surface), the
//                   verbatim player renderer uses this.
//   window.forge  : Midi-Forge tab (provisioning + pipeline jobs).
//   window.studio : shell-level helpers (version, updates).
'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');
const { pathToFileURL } = require('url');

const onChannel = (channel) => (handler) => {
  const fn = (_e, payload) => handler(payload);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.off(channel, fn);
};

// ---- Player (original midi-player API, preserved exactly) ------------------
contextBridge.exposeInMainWorld('api', {
  send: (msg) => ipcRenderer.invoke('engine:send', msg),
  onEngineEvent: onChannel('engine-event'),
  onEngineError: onChannel('engine-error'),
  pickMidi: () => ipcRenderer.invoke('dialog:openMidi'),
  pickMapping: () => ipcRenderer.invoke('dialog:openMapping'),
  getDroppedFilePath: (file) => webUtils.getPathForFile(file),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  getVersion: () => ipcRenderer.invoke('app:version'),
  checkForUpdates: (opts) => ipcRenderer.invoke('update:check', opts),
  applyUpdate: () => ipcRenderer.invoke('update:apply'),
  onUpdateStatus: onChannel('update-status'),
  // The overlay can be opened mid-song, after midi_loaded has long gone past.
  // It asks, and the Player tab (the only frame that kept the payload) answers.
  onOverlayWantsState: onChannel('overlay-wants-state'),
  replayToOverlay: (payload) => ipcRenderer.send('overlay:replay', payload),
  overlayState: () => ipcRenderer.invoke('overlay:state'),
  toggleOverlay: () => ipcRenderer.invoke('overlay:toggle'),
  onOverlayState: onChannel('overlay-state'),
});

// ---- Forge tab -------------------------------------------------------------
contextBridge.exposeInMainWorld('forge', {
  check: () => ipcRenderer.invoke('forge:check'),
  provision: () => ipcRenderer.invoke('forge:provision'),
  cancelProvision: () => ipcRenderer.invoke('forge:provision:cancel'),
  run: (opts) => ipcRenderer.invoke('forge:run', opts),
  yt: (opts) => ipcRenderer.invoke('forge:yt', opts),
  cancel: (jobId) => ipcRenderer.invoke('forge:cancel', jobId),
  pickInput: () => ipcRenderer.invoke('forge:pickInput'),
  pickOutDir: () => ipcRenderer.invoke('forge:pickOutDir'),
  getDroppedFilePath: (file) => webUtils.getPathForFile(file),
  getSettings: () => ipcRenderer.invoke('forge:getSettings'),
  setSettings: (patch) => ipcRenderer.invoke('forge:setSettings', patch),
  getOutputDir: () => ipcRenderer.invoke('app:getOutputDir'),
  fileUrl: (p) => pathToFileURL(String(p || '')).href,
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  showItem: (p) => ipcRenderer.invoke('shell:showItem', p),
  onStatus: onChannel('forge:status'),
  pause: (paused) => ipcRenderer.invoke('forge:pause', paused),
});

// ---- Review workspace ------------------------------------------------------
contextBridge.exposeInMainWorld('review', {
  pick: () => ipcRenderer.invoke('review:pick'),
  load: (p) => ipcRenderer.invoke('review:load', p),
  saveProject: (payload) => ipcRenderer.invoke('review:saveProject', payload),
  exportMidi: (payload) => ipcRenderer.invoke('review:exportMidi', payload),
  fileUrl: (p) => pathToFileURL(String(p || '')).href,
  showItem: (p) => ipcRenderer.invoke('shell:showItem', p),
  getDroppedFilePath: (file) => webUtils.getPathForFile(file),
});

// ---- MIDI library (Self Midi) ----------------------------------------------
contextBridge.exposeInMainWorld('library', {
  list: () => ipcRenderer.invoke('library:list'),
  addFolder: () => ipcRenderer.invoke('library:addFolder'),
  removeFolder: (dir) => ipcRenderer.invoke('library:removeFolder', dir),
  reveal: (p) => ipcRenderer.invoke('library:reveal', p),
  onChanged: onChannel('library-changed'),
});

// ---- Perch (the always-on-top overlay window) ------------------------------
// Its own small surface rather than reusing `studio`: the overlay is a separate
// window with a separate job, and giving it the whole app API would let a
// frameless always-on-top window do things it has no business doing.
contextBridge.exposeInMainWorld('perch', {
  ready: () => ipcRenderer.send('overlay:ready'),
  close: () => ipcRenderer.send('overlay:close'),
  apply: (patch) => ipcRenderer.invoke('overlay:apply', patch),
  snap: (where) => ipcRenderer.invoke('overlay:snap', where),
  resize: (width, height) => ipcRenderer.send('overlay:resize', { width, height }),
  command: (name) => ipcRenderer.send('overlay:command', name),
  onEngineEvent: onChannel('engine-event'),
  onConfig: onChannel('overlay-config'),
});

// ---- Shell -----------------------------------------------------------------
contextBridge.exposeInMainWorld('studio', {
  getVersion: () => ipcRenderer.invoke('app:version'),
  checkForUpdates: (opts) => ipcRenderer.invoke('update:check', opts),
  applyUpdate: () => ipcRenderer.invoke('update:apply'),
  onUpdateStatus: onChannel('update-status'),
  onEngineError: onChannel('engine-error'),
  getUi: () => ipcRenderer.invoke('app:getUi'),
  setUi: (patch) => ipcRenderer.invoke('app:setUi', patch),
  forgeInfo: () => ipcRenderer.invoke('app:forgeInfo'),
  onShortcut: onChannel('shell-shortcut'),
  getPerformance: () => ipcRenderer.invoke('app:performance'),
  setPerformance: (patch) => ipcRenderer.invoke('app:setPerformance', patch),
  onGameActive: onChannel('game-active'),
  openForgeFolder: () => ipcRenderer.invoke('app:openForgeFolder'),
  changeForgeFolder: () => ipcRenderer.invoke('app:changeForgeFolder'),
  resetForgeFolder: () => ipcRenderer.invoke('app:resetForgeFolder'),
  openSetupLog: () => ipcRenderer.invoke('app:openSetupLog'),
  cleanReinstall: () => ipcRenderer.invoke('app:cleanReinstall'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  getLibraryDir: () => ipcRenderer.invoke('app:getLibraryDir'),
  setLibraryDir: (dir) => ipcRenderer.invoke('app:setLibraryDir', dir),
  listMidis: (dir) => ipcRenderer.invoke('app:listMidis', dir),
  pickFolder: () => ipcRenderer.invoke('app:pickFolder'),
  openMappingsDir: () => ipcRenderer.invoke('app:openMappingsDir'),
  onLibraryChanged: onChannel('library-changed'),
  overlayState: () => ipcRenderer.invoke('overlay:state'),
  toggleOverlay: () => ipcRenderer.invoke('overlay:toggle'),
  setOverlay: (patch) => ipcRenderer.invoke('overlay:apply', patch),
  onOverlayState: onChannel('overlay-state'),
});

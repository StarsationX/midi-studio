// preload.js — runs in every frame (top shell + both tab iframes).
//   window.api    : the ORIGINAL midi-player bridge (unchanged surface) — the
//                   verbatim player renderer uses this.
//   window.forge  : Midi-Forge tab (provisioning + pipeline jobs).
//   window.studio : shell-level helpers (version, updates).
'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

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
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  showItem: (p) => ipcRenderer.invoke('shell:showItem', p),
  onStatus: onChannel('forge:status'),
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
  openForgeFolder: () => ipcRenderer.invoke('app:openForgeFolder'),
  cleanReinstall: () => ipcRenderer.invoke('app:cleanReinstall'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  getLibraryDir: () => ipcRenderer.invoke('app:getLibraryDir'),
  setLibraryDir: (dir) => ipcRenderer.invoke('app:setLibraryDir', dir),
  listMidis: (dir) => ipcRenderer.invoke('app:listMidis', dir),
  pickFolder: () => ipcRenderer.invoke('app:pickFolder'),
  openMappingsDir: () => ipcRenderer.invoke('app:openMappingsDir'),
  onLibraryChanged: onChannel('library-changed'),
});

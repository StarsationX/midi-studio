// preload.js: runs in every frame (top shell + tab iframes).
//   window.api    : the ORIGINAL midi-player bridge (unchanged surface), the
//                   verbatim player renderer uses this.
//   window.forge  : Midi-Forge tab (provisioning + pipeline jobs).
//   window.studio : shell-level helpers (version, updates).
'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');
const { pathToFileURL } = require('url');

// The single place any push listener is registered in any frame, which is why
// it is also where the frame tells main WHICH pushes it wants. main.js's
// broadcast() sends to all 7 frames; 71-86% of those sends were landing in a
// document with no listener (engine-event alone is 20 a second while a song
// plays). See electron/fanout.js for the rule that keeps invariant 4 intact.
//
// Ordering matters: the listener is attached BEFORE the subscription is sent,
// so main can never be told about a subscription that is not live yet. And
// unsubscribing is deliberately not reported -- a stale subscription costs one
// send, a missed one costs a dropped event.
const subscribedChannels = new Set();
const onChannel = (channel) => (handler) => {
  const fn = (_e, payload) => handler(payload);
  ipcRenderer.on(channel, fn);
  if (!subscribedChannels.has(channel)) {
    subscribedChannels.add(channel);
    try { ipcRenderer.send('app:subscribe', channel); } catch (_) {}
  }
  return () => ipcRenderer.off(channel, fn);
};

// A frame that subscribes to nothing has to say so, or main cannot tell it
// apart from a frame whose scripts have not run yet and must keep sending to
// it. Sent on load, i.e. after every listener the document registers while it
// starts up has already been reported above. A listener registered LATER still
// reports itself through onChannel, so the set only ever grows.
const announceSubsReady = () => { try { ipcRenderer.send('app:subscribe', null); } catch (_) {} };
if (typeof document !== 'undefined') {
  if (document.readyState === 'complete') announceSubsReady();
  else window.addEventListener('load', announceSubsReady, { once: true });
}

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
  // check({ fresh: true }) forces a new capability probe; without it a verdict
  // less than ten seconds old is reused, so the Forge tab and the shell asking
  // independently at launch cost one `import torch` instead of two.
  check: (opts) => ipcRenderer.invoke('forge:check', opts),
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

// ---- MIDI library (the Library tab, Self Midi, the shell's song index) ------
// list/addFolder/removeFolder/reveal/onChanged are the original surface and are
// unchanged. Everything below them is additive, for the Library tab: a streaming
// scan, the lazily-parsed Length/Notes index, tags, usage and trash.
contextBridge.exposeInMainWorld('library', {
  list: () => ipcRenderer.invoke('library:list'),
  addFolder: () => ipcRenderer.invoke('library:addFolder'),
  removeFolder: (dir) => ipcRenderer.invoke('library:removeFolder', dir),
  reveal: (p) => ipcRenderer.invoke('library:reveal', p),
  onChanged: onChannel('library-changed'),
  scan: () => ipcRenderer.invoke('library:scan'),
  meta: (payload) => ipcRenderer.invoke('library:meta', payload),
  setTags: (payload) => ipcRenderer.invoke('library:setTags', payload),
  usage: (payload) => ipcRenderer.invoke('library:usage', payload),
  index: (payload) => ipcRenderer.invoke('library:index', payload),
  remove: (payload) => ipcRenderer.invoke('library:delete', payload),
  // Partial scan batches and full-index progress, pushed to THIS frame only.
  onProgress: onChannel('library-progress'),
  fileUrl: (p) => pathToFileURL(String(p || '')).href,
  showItem: (p) => ipcRenderer.invoke('shell:showItem', p),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
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
  getRelease: () => ipcRenderer.invoke('app:release'),
  checkForUpdates: (opts) => ipcRenderer.invoke('update:check', opts),
  applyUpdate: () => ipcRenderer.invoke('update:apply'),
  onUpdateStatus: onChannel('update-status'),
  onEngineError: onChannel('engine-error'),
  getUi: () => ipcRenderer.invoke('app:getUi'),
  setUi: (patch) => ipcRenderer.invoke('app:setUi', patch),
  forgeInfo: () => ipcRenderer.invoke('app:forgeInfo'),
  onShortcut: onChannel('shell-shortcut'),
  onOpenMidi: onChannel('open-midi'),
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
  snapOverlay: (where) => ipcRenderer.invoke('overlay:snap', where),
  onOverlayState: onChannel('overlay-state'),
  // ---- added for the custom titlebar (the window is frameless now) --------
  window: {
    minimize: () => ipcRenderer.send('win:minimize'),
    maximize: () => ipcRenderer.send('win:maximize'),
    unmaximize: () => ipcRenderer.send('win:unmaximize'),
    toggleMaximize: () => ipcRenderer.send('win:toggleMaximize'),
    close: () => ipcRenderer.send('win:close'),
    state: () => ipcRenderer.invoke('win:state'),
  },
  onWindowState: onChannel('window-state'),
  onPanelFailed: onChannel('panel-failed'),
  // ---- added for the boot splash: real milestones, never a fake percentage -
  bootState: () => ipcRenderer.invoke('app:bootState'),
  // Renderer-side startup milestones, appended to main's boot log. send(), not
  // invoke(): instrumenting the boot path must not slow the boot path.
  bootMark: (step, ms) => ipcRenderer.send('app:bootMark', { step, ms }),
  onBootMilestone: onChannel('boot-milestone'),
  // ---- added for the What's New screen ------------------------------------
  // changelog() hands over the raw CHANGELOG.md; the renderer parses it with
  // renderer/shell/changelog.js, which is the same parser the tests exercise.
  changelog: () => ipcRenderer.invoke('app:changelog'),
  whatsNew: () => ipcRenderer.invoke('app:whatsNew'),
  markNotesShown: (v) => ipcRenderer.invoke('app:notesShown', v),
  // ---- added for Settings > Storage and the palette's file actions --------
  openBootLog: () => ipcRenderer.invoke('app:openBootLog'),
  getOutputDir: () => ipcRenderer.invoke('app:getOutputDir'),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  showItem: (p) => ipcRenderer.invoke('shell:showItem', p),
});

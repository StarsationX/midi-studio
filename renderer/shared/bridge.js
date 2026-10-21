// bridge.js: electron/preload.js for the Tauri host, loaded by the SHELL only.
//
// Tauri's IPC lives in the main frame alone, so this builds the six preload
// namespaces (api, forge, review, library, perch, studio) here, on invoke and
// listen, and every panel iframe borrows a copy bound to itself through
// window.__studioBridge (see bridge-frame.js). Under Electron the preload has
// already put window.api in place and this file does nothing.
//
// What the Electron main process did around the bridge happens here instead:
//   * fanout.js / app:subscribe: each push channel is listened to ONCE and
//     dispatched in JS to the frames that registered for it. A frame's
//     handlers go when its document does (pagehide).
//   * sendToRenderer vs broadcast: SHELL_ONLY channels reach shell handlers
//     only, as they reached the main frame only.
//   * the cached engine `ready` is replayed to every late subscriber, which is
//     what did-frame-finish-load's replay was for.
//   * before-input-event: Ctrl+1..6, Ctrl+K, Ctrl+, and Ctrl+Alt+L are caught
//     in every frame and handed to the shell as shell-shortcut.
//   * webUtils.getPathForFile: Tauri takes OS file drops itself, so the host
//     sends the paths and this replays them as DOM drag events in whichever
//     panel is under the cursor, with File objects that resolve to those paths.
//   * will-prevent-unload: the Editor's unsaved-edits guard runs before close.
(() => {
  'use strict';
  const T = window.__TAURI__;
  if (!T || window.api) return;
  const invoke = T.core.invoke;
  const listen = T.event.listen;
  const convertFileSrc = T.core.convertFileSrc;

  const PUSH = [
    'engine-event', 'engine-error', 'update-status', 'overlay-wants-state', 'overlay-state',
    'overlay-config', 'forge:status', 'library-changed', 'library-progress', 'shell-shortcut',
    'open-midi', 'game-active', 'window-state', 'panel-failed', 'boot-milestone',
    'close-requested', 'studio-drag',
  ];
  const SHELL_ONLY = new Set(['update-status', 'shell-shortcut', 'open-midi', 'window-state', 'panel-failed', 'boot-milestone', 'close-requested']);

  const errText = (e) => String((e && e.message) || e);

  // A frame's own objects, not the shell's: what contextBridge's copy did, so
  // a panel's instanceof / Array checks see values from its own realm.
  function copyInto(win, v) {
    if (win === window || v === undefined) return v;
    return win.JSON.parse(JSON.stringify(v));
  }

  // ---- push channels ------------------------------------------------------
  const handlers = new Map();               // channel -> Set<{ win, fn }>
  let lastReady = null;

  function deliver(h, channel, payload) {
    if (SHELL_ONLY.has(channel) && h.win !== window) return;
    try { h.fn(copyInto(h.win, payload)); }
    catch (e) {
      // An exception in a listener surfaced in that frame's console under
      // Electron; keep it that way instead of losing it here.
      try { h.win.setTimeout(() => { throw e; }); } catch (_) {}
    }
  }

  function dispatch(channel, payload) {
    if (channel === 'engine-event' && payload && payload.event === 'ready') lastReady = payload;
    const set = handlers.get(channel);
    if (!set) return;
    for (const h of [...set]) if (set.has(h)) deliver(h, channel, payload);
  }

  function subscribe(win, channel, fn) {
    if (typeof fn !== 'function') return () => {};
    let set = handlers.get(channel);
    if (!set) { set = new Set(); handlers.set(channel, set); }
    const h = { win, fn };
    set.add(h);
    // A panel loads after the engine said ready; tell it again.
    if (channel === 'engine-event' && lastReady) {
      const ready = lastReady;
      setTimeout(() => { if (set.has(h)) deliver(h, channel, ready); }, 60);
    }
    return () => set.delete(h);
  }

  function dropFrame(win) {
    for (const set of handlers.values()) for (const h of [...set]) if (h.win === win) set.delete(h);
  }

  // ---- calls --------------------------------------------------------------
  function call(win, channel, args) {
    const p = invoke('ipc', { channel, args });
    if (win === window) return p.catch((e) => { throw new Error(errText(e)); });
    return new win.Promise((resolve, reject) => {
      p.then((v) => resolve(copyInto(win, v)), (e) => reject(new win.Error(errText(e))));
    });
  }
  // ipcRenderer.send: nobody waits and nobody hears about a failure.
  function fire(channel, args) {
    invoke('ipc', { channel, args }).catch(() => {});
  }

  // ---- files --------------------------------------------------------------
  // Paths the host handed over are already in the asset scope. Anything else
  // (a recent file from localStorage) is let in on first sight; that call is
  // synchronous on the host side, so it lands before the read that follows.
  const granted = new Set();
  function fileUrl(p) {
    p = String(p || '');
    if (p && !granted.has(p)) {
      granted.add(p);
      invoke('asset_allow', { path: p }).catch(() => {});
    }
    return convertFileSrc(p);
  }
  const droppedPaths = new WeakMap();       // File -> path, for this drag's files
  let droppedByName = new Map();            // name -> path, if a File was re-wrapped
  function getDroppedFilePath(file) {
    if (!file) return '';
    return droppedPaths.get(file) || droppedByName.get(file.name) || '';
  }

  // ---- the six namespaces, bound to one frame -------------------------------
  function namespacesFor(win) {
    const c = (channel) => (...args) => call(win, channel, args);
    const on = (channel) => (fn) => subscribe(win, channel, fn);
    const f = (channel) => (...args) => fire(channel, args);
    return {
      api: {
        send: c('engine:send'),
        onEngineEvent: on('engine-event'),
        onEngineError: on('engine-error'),
        pickMidi: c('dialog:openMidi'),
        pickMapping: c('dialog:openMapping'),
        getDroppedFilePath,
        openExternal: c('app:openExternal'),
        getVersion: c('app:version'),
        checkForUpdates: c('update:check'),
        applyUpdate: c('update:apply'),
        onUpdateStatus: on('update-status'),
        onOverlayWantsState: on('overlay-wants-state'),
        replayToOverlay: f('overlay:replay'),
        overlayState: c('overlay:state'),
        toggleOverlay: c('overlay:toggle'),
        onOverlayState: on('overlay-state'),
      },
      forge: {
        check: c('forge:check'),
        provision: c('forge:provision'),
        cancelProvision: c('forge:provision:cancel'),
        run: c('forge:run'),
        yt: c('forge:yt'),
        cancel: c('forge:cancel'),
        pickInput: c('forge:pickInput'),
        pickOutDir: c('forge:pickOutDir'),
        getDroppedFilePath,
        getSettings: c('forge:getSettings'),
        setSettings: c('forge:setSettings'),
        getOutputDir: c('app:getOutputDir'),
        fileUrl,
        openPath: c('shell:openPath'),
        showItem: c('shell:showItem'),
        onStatus: on('forge:status'),
        pause: c('forge:pause'),
      },
      review: {
        pick: c('review:pick'),
        load: c('review:load'),
        saveProject: c('review:saveProject'),
        exportMidi: c('review:exportMidi'),
        fileUrl,
        showItem: c('shell:showItem'),
        getDroppedFilePath,
      },
      library: {
        list: c('library:list'),
        addFolder: c('library:addFolder'),
        removeFolder: c('library:removeFolder'),
        reveal: c('library:reveal'),
        onChanged: on('library-changed'),
        scan: c('library:scan'),
        meta: c('library:meta'),
        setTags: c('library:setTags'),
        usage: c('library:usage'),
        index: c('library:index'),
        remove: c('library:delete'),
        onProgress: on('library-progress'),
        fileUrl,
        showItem: c('shell:showItem'),
        openPath: c('shell:openPath'),
      },
      perch: {
        ready: f('overlay:ready'),
        close: f('overlay:close'),
        apply: c('overlay:apply'),
        snap: c('overlay:snap'),
        resize: (width, height) => fire('overlay:resize', [{ width, height }]),
        command: f('overlay:command'),
        onEngineEvent: on('engine-event'),
        onConfig: on('overlay-config'),
      },
      studio: {
        getVersion: c('app:version'),
        getRelease: c('app:release'),
        checkForUpdates: c('update:check'),
        applyUpdate: c('update:apply'),
        onUpdateStatus: on('update-status'),
        onEngineError: on('engine-error'),
        getUi: c('app:getUi'),
        setUi: c('app:setUi'),
        forgeInfo: c('app:forgeInfo'),
        onShortcut: on('shell-shortcut'),
        onOpenMidi: on('open-midi'),
        getPerformance: c('app:performance'),
        setPerformance: c('app:setPerformance'),
        onGameActive: on('game-active'),
        openForgeFolder: c('app:openForgeFolder'),
        changeForgeFolder: c('app:changeForgeFolder'),
        resetForgeFolder: c('app:resetForgeFolder'),
        openSetupLog: c('app:openSetupLog'),
        cleanReinstall: c('app:cleanReinstall'),
        openExternal: c('app:openExternal'),
        getLibraryDir: c('app:getLibraryDir'),
        setLibraryDir: c('app:setLibraryDir'),
        listMidis: c('app:listMidis'),
        pickFolder: c('app:pickFolder'),
        openMappingsDir: c('app:openMappingsDir'),
        onLibraryChanged: on('library-changed'),
        overlayState: c('overlay:state'),
        toggleOverlay: c('overlay:toggle'),
        setOverlay: c('overlay:apply'),
        snapOverlay: c('overlay:snap'),
        onOverlayState: on('overlay-state'),
        window: {
          minimize: f('win:minimize'),
          maximize: f('win:maximize'),
          unmaximize: f('win:unmaximize'),
          toggleMaximize: f('win:toggleMaximize'),
          close: () => { requestClose(); },
          state: c('win:state'),
        },
        onWindowState: on('window-state'),
        onPanelFailed: on('panel-failed'),
        bootState: c('app:bootState'),
        bootMark: (step, ms) => fire('app:bootMark', [{ step, ms }]),
        onBootMilestone: on('boot-milestone'),
        changelog: c('app:changelog'),
        whatsNew: c('app:whatsNew'),
        markNotesShown: c('app:notesShown'),
        openBootLog: c('app:openBootLog'),
        getOutputDir: c('app:getOutputDir'),
        openPath: c('shell:openPath'),
        showItem: c('shell:showItem'),
      },
    };
  }

  // ---- key router (main.js before-input-event) -----------------------------
  // The stage iframe covers almost the whole window, so the shell's own
  // keydown never sees these once a panel has focus. This map and the shell's
  // Ctrl+1..6 must list the same six tabs in the same order.
  const TAB_KEYS = { 1: 'forge', 2: 'player', 3: 'review', 4: 'audition', 5: 'library', 6: 'logs' };
  function routeKeys(win) {
    win.addEventListener('keydown', (e) => {
      if (!e.ctrlKey || e.metaKey) return;
      let msg = null;
      if (e.altKey) {
        if (e.key === 'l' || e.key === 'L') msg = { id: 'log' };
      } else if (TAB_KEYS[e.key]) {
        msg = { tab: TAB_KEYS[e.key] };
      } else if (e.key === 'k' || e.key === 'K') {
        msg = { id: 'palette' };
      } else if (e.key === ',') {
        msg = { id: 'settings' };
      }
      if (!msg) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      dispatch('shell-shortcut', msg);
    }, true);
  }

  // ---- drag and drop ---------------------------------------------------------
  // The deepest element under the point, descending into same-origin iframes.
  function hitTest(cx, cy) {
    let el = document.elementFromPoint(cx, cy);
    let x = cx, y = cy;
    while (el && el.tagName === 'IFRAME') {
      let doc = null;
      try { doc = el.contentDocument; } catch (_) {}
      if (!doc || !doc.documentElement) break;
      const r = el.getBoundingClientRect();
      x -= r.left + el.clientLeft;
      y -= r.top + el.clientTop;
      el = doc.elementFromPoint(x, y) || doc.documentElement;
    }
    return { el: el || document.documentElement, x, y };
  }

  const MIME = { mid: 'audio/midi', midi: 'audio/midi', mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac',
    m4a: 'audio/mp4', ogg: 'audio/ogg', opus: 'audio/ogg', aac: 'audio/aac', json: 'application/json' };
  let drag = null;                          // { paths, files: Map<win, File[]>, at: {el,x,y} | null }

  function filesFor(win) {
    let list = drag.files.get(win);
    if (!list) {
      list = drag.paths.map((p) => {
        const name = String(p).split(/[\\/]/).pop();
        const ext = (name.split('.').pop() || '').toLowerCase();
        const file = new win.File([], name, { type: MIME[ext] || '' });
        droppedPaths.set(file, p);
        return file;
      });
      drag.files.set(win, list);
    }
    return list;
  }

  function fireDrag(type, at) {
    const win = at.el.ownerDocument.defaultView;
    if (!win) return;
    const dt = new win.DataTransfer();
    for (const file of filesFor(win)) dt.items.add(file);
    at.el.dispatchEvent(new win.DragEvent(type, {
      bubbles: true, cancelable: true, composed: true, clientX: at.x, clientY: at.y, dataTransfer: dt,
    }));
  }

  function dragTo(at) {
    const prev = drag.at;
    if (prev && prev.el === at.el) { drag.at = at; return; }
    fireDrag('dragenter', at);              // the browser's order: enter the new, then leave the old
    if (prev) fireDrag('dragleave', prev);
    drag.at = at;
  }

  function onDrag(p) {
    if (!p) return;
    const scale = window.devicePixelRatio || 1;
    const at = () => hitTest((Number(p.x) || 0) / scale, (Number(p.y) || 0) / scale);
    if (p.type === 'enter' || (p.type === 'drop' && !drag)) {
      drag = { paths: (p.paths || []).map(String), files: new Map(), at: null };
      droppedByName = new Map(drag.paths.map((x) => [String(x).split(/[\\/]/).pop(), x]));
    }
    if (!drag) return;
    if (p.type === 'leave') {
      if (drag.at) fireDrag('dragleave', drag.at);
      drag = null;
      return;
    }
    dragTo(at());
    fireDrag('dragover', drag.at);
    if (p.type === 'drop') {
      fireDrag('drop', drag.at);
      drag = null;
    }
  }

  // ---- close ------------------------------------------------------------------
  // The Editor is the one panel that can refuse to close (main.js answered its
  // will-prevent-unload with the same question). Its beforeunload is asked
  // directly: the others tear themselves down in theirs, which must not happen
  // unless the window really is going.
  let closing = false;
  function editorHasUnsavedEdits() {
    const frame = document.querySelector('iframe[data-frame="review"]');
    let w = null;
    try { w = frame && frame.getAttribute('src') && frame.contentWindow; } catch (_) {}
    if (!w || !w.document || w.document.readyState === 'loading') return false;
    const ev = new w.Event('beforeunload', { cancelable: true });
    w.dispatchEvent(ev);
    return ev.defaultPrevented;
  }
  // What closing the window used to run in every document: the shell flushes
  // its UI prefs, the Player and Listen save theirs.
  function unloadEverything() {
    const wins = [window];
    for (const frame of document.querySelectorAll('iframe')) {
      try { if (frame.getAttribute('src') && frame.contentWindow) wins.push(frame.contentWindow); } catch (_) {}
    }
    for (const w of wins) {
      for (const type of ['beforeunload', 'pagehide']) {
        try { w.dispatchEvent(new w.Event(type)); } catch (_) {}
      }
    }
  }
  async function requestClose() {
    if (closing) return;
    closing = true;
    try {
      if (editorHasUnsavedEdits() && !(await invoke('ipc', { channel: 'dialog:confirmClose', args: [] }))) return;
      unloadEverything();
      await new Promise((r) => setTimeout(r, 150));   // let the flushes' IPC land first
      await invoke('ipc', { channel: 'win:close', args: [] });
    } catch (_) {
      fire('win:close', []);
    } finally {
      closing = false;
    }
  }

  // Tauri's drag script maximises on a double click in a drag region, as
  // Windows did for Electron's app-region, which never let the page see the
  // click. The shell's own titlebar dblclick must not toggle it straight back.
  const CLICKABLE = 'button, a, input, select, textarea, label, summary, [contenteditable]:not([contenteditable="false"]), [role="button"], [role="tab"], [tabindex]:not([tabindex="-1"])';
  document.addEventListener('dblclick', (e) => {
    const el = e.target;
    if (el && el.closest && el.closest('[data-tauri-drag-region]') && !el.closest(CLICKABLE)) e.stopImmediatePropagation();
  }, true);

  // ---- wiring ---------------------------------------------------------------------
  function bridgeFor(win) {
    routeKeys(win);
    if (win !== window) win.addEventListener('pagehide', () => dropFrame(win), { once: true });
    return namespacesFor(win);
  }
  window.__studioBridge = bridgeFor;
  const own = bridgeFor(window);
  for (const k of Object.keys(own)) {
    Object.defineProperty(window, k, { value: own[k], configurable: true, enumerable: true });
  }

  Promise.all(PUSH.map((channel) => listen(channel, (e) => dispatch(channel, e.payload))))
    .then(() => {
      subscribe(window, 'studio-drag', onDrag);
      subscribe(window, 'close-requested', () => { fire('win:closeAck', []); requestClose(); });
      return invoke('ipc', { channel: 'bridge:attach', args: [] });
    })
    .then((r) => {
      if (r && r.ready && !lastReady) dispatch('engine-event', r.ready);
      // A .mid from the command line. The Player needs a beat after the shell.
      if (r && r.openMidi) {
        const send = () => setTimeout(() => dispatch('open-midi', { midiPath: r.openMidi }), 600);
        if (document.readyState === 'complete') send(); else window.addEventListener('load', send, { once: true });
      }
    })
    .catch((e) => console.error('[bridge] could not attach to the host:', errText(e)));
})();

// ===========================================================================
// shell.js — the application shell.
//
// It owns: the custom titlebar, the activity strip, the
// tab stage, the persistent bottom transport, the command palette, the settings
// sheet, the boot splash, the window-level drop veil, toasts, the key router,
// and the cross-tab hand-off router.
//
// It deliberately owns NO playback clock, NO canvas loop and NO panel state.
// Everything it renders comes from one of four places: the transport-owner
// state (shared/bus.js), main-process IPC, its own persisted settings, or the
// activity model below. See docs/rewrite/CONTRACT.md § Shell.
// ===========================================================================
(() => {
  'use strict';

  const studio = window.studio || {};
  const forgeApi = window.forge || {};
  const libApi = window.library || {};
  const playerApi = window.api || {};

  const $ = (id) => document.getElementById(id);
  const root = document.documentElement;
  const T = (window.Bus && window.Bus.TYPES) || {};
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const raf = (fn) => window.requestAnimationFrame(fn);

  // ---- startup instrumentation ---------------------------------------------
  // Renderer milestones go into main's boot log (the one startup story lives in
  // one file; see benchmarks/startup.js). Timestamps are ms since this
  // document's navigation start, so they compose with main's absolute marks.
  const uiMark = (step) => {
    try { if (studio.bootMark) studio.bootMark(step, performance.now()); } catch (_) {}
  };
  uiMark('script');
  try {
    new PerformanceObserver((list, obs) => {
      for (const e of list.getEntries()) {
        if (e.name === 'first-contentful-paint') { uiMark('fcp'); obs.disconnect(); }
      }
    }).observe({ type: 'paint', buffered: true });
  } catch (_) {}

  // A trailing-edge coalescer. Used for every continuous input in the shell:
  // the accent picker, the perf slider, the scrub bar, the ui:* IPC writes.
  // flush() INVOKES the pending call with the last arguments; cancel() drops it.
  // A flush that merely cleared the timer silently swallowed the final value of
  // every gesture whose only send path was the debounce (the volume knob) and
  // let the palette run a row from the previous result list.
  function debounce(fn, ms) {
    let t = 0, last = null;
    const wrapped = (...a) => {
      last = a;
      clearTimeout(t);
      t = setTimeout(() => { t = 0; const p = last; last = null; fn(...p); }, ms);
    };
    wrapped.flush = () => {
      if (!t) return;
      clearTimeout(t); t = 0;
      const p = last; last = null;
      if (p) fn(...p);
    };
    wrapped.cancel = () => { clearTimeout(t); t = 0; last = null; };
    wrapped.pending = () => !!t;
    return wrapped;
  }
  // One rAF per burst, last value wins.
  function coalesce(fn) {
    let armed = false, args = null;
    return (...a) => {
      args = a;
      if (armed) return;
      armed = true;
      raf(() => { armed = false; fn(...args); });
    };
  }
  const isFormFocus = (el) => {
    el = el || document.activeElement;
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON'
      || el.isContentEditable || el.getAttribute('role') === 'slider';
  };

  // ==========================================================================
  // 1. FRAMES
  // ==========================================================================
  // Internal frame keys never change: 'review' is the Editor, 'audition' is
  // Listen. The nav order is Forge, Editor, Player, Listen, Library,
  // Logs, and Ctrl+1..6 follow that order (main.js maps the same six, in the
  // same order -- see the KEY ROUTER section).
  const FRAMES = [
    { key: 'forge',    nav: 'nav-forge',    el: 'frame-forge',    label: 'Forge',     title: 'MIDI Studio · Forge' },
    { key: 'player',   nav: 'nav-player',   el: 'frame-player',   label: 'Player',    title: 'MIDI Studio · Player' },
    { key: 'review',   nav: 'nav-review',   el: 'frame-review',   label: 'Editor',    title: 'MIDI Studio · Editor' },
    { key: 'audition', nav: 'nav-audition', el: 'frame-audition', label: 'Listen',    title: 'MIDI Studio · Listen' },
    { key: 'library',  nav: 'nav-library',  el: 'frame-library',  label: 'Library',   title: 'MIDI Studio · Library' },
    { key: 'logs',     nav: 'nav-logs',     el: 'frame-logs',     label: 'Logs',      title: 'MIDI Studio · Logs' }
  ];
  const ORDER = FRAMES.map((f) => f.key);
  const byKey = Object.create(null);
  for (const f of FRAMES) {
    f.frame = $(f.el);
    f.navEl = $(f.nav);
    f.loaded = false;      // the iframe has fired 'load' at least once
    f.busReady = false;    // the panel announced frame:ready over the bus
    f.readyForLoad = false;// ...and it was THIS document that announced it
    f.queue = [];          // hand-offs waiting for it
    f.onscreen = false;
    byKey[f.key] = f;
    if (window.Bus) window.Bus.trustFrame(f.frame);
    f.frame.addEventListener('load', () => onFrameLoad(f));
  }
  // Settings used to store 'lastTab' with the old ids; the ids did not change,
  // but a stored value from a build that used display names must not strand a
  // returning user on a blank stage.
  const LEGACY_TAB = { editor: 'review', selfmidi: 'audition', 'self midi': 'audition' };
  const normaliseTab = (t) => {
    t = String(t || '').toLowerCase();
    t = LEGACY_TAB[t] || t;
    return byKey[t] ? t : 'forge';
  };

  let activeKey = 'forge';
  let covered = false;    // an overlay (palette/settings/drop) is up

  function ensureFrame(key) {
    const f = byKey[key];
    if (!f) return null;
    if (!f.frame.getAttribute('src') && f.frame.dataset.src) {
      // First open of this tab: the two marks around it are what
      // benchmarks/startup.js reports as "time to a usable tab".
      f.openedAt = performance.now();
      uiMark(`tab.${key}.src`);
      f.frame.setAttribute('src', f.frame.dataset.src);
    }
    return f;
  }

  // A panel whose document is missing or unreadable. main tells us (its
  // did-fail-load sees the subframe), and the shell covers the tab with its own
  // empty state rather than leaving Chromium's white error page on screen.
  const failedFrames = new Set();
  function renderStage() {
    const fb = $('tab-fallback');
    const bad = failedFrames.has(activeKey);
    fb.hidden = !bad;
    if (!bad) return;
    const f = byKey[activeKey];
    $('tf-title').textContent = `${f.label} could not load`;
    $('tf-msg').textContent = f.failReason || 'Its interface file is missing from this build.';
  }
  function markFrameFailed(url, desc) {
    const f = FRAMES.find((x) => x.frame.dataset.src && url.indexOf(x.frame.dataset.src.replace('./', '')) >= 0);
    if (!f) return;
    failedFrames.add(f.key);
    f.failReason = desc ? `${desc}. Its interface file is missing from this build.` : '';
    f.loaded = false;
    f.busReady = false;
    f.readyForLoad = false;
    f.queue.length = 0;
    logPush(`${f.label} panel failed to load: ${desc || 'unknown error'}`, 'error', 'app');
    renderStage();
  }
  function retryFrame(key) {
    const f = byKey[key];
    if (!f) return;
    failedFrames.delete(key);
    renderStage();
    const src = f.frame.dataset.src;
    f.frame.removeAttribute('src');
    if (src) setTimeout(() => f.frame.setAttribute('src', src), 30);
  }

  // Chromium fires 'load' for a src-less iframe's initial about:blank document,
  // and every frame here starts src-less (data-src, set lazily by ensureFrame).
  // Treating that as "the panel is up" marked all five loaded at boot, which let
  // the splash hand over to an empty stage and pointed the legacy-global probe
  // at about:blank.
  function frameNavigated(f) {
    if (!f.frame.getAttribute('src')) return false;
    try {
      const w = f.frame.contentWindow;
      if (w && w.location && w.location.href === 'about:blank') return false;
    } catch (_) { /* mid-navigation: treat as navigated */ }
    return true;
  }

  function onFrameLoad(f) {
    if (!frameNavigated(f)) return;
    failedFrames.delete(f.key);
    // A reload retracts anything the old document announced about itself.
    if (activity.panels[f.key]) { delete activity.panels[f.key]; renderStrip(); }
    renderStage();
    f.loaded = true;
    // A reload retracts the announcement -- but a panel sends frame:ready from
    // its own script, which runs BEFORE this load event fires, so clearing it
    // unconditionally threw away the handshake of the document that had just
    // arrived. The shell then believed the panel was not listening and every
    // later push to it was dropped (this is what stopped log:append reaching
    // the Logs tab). Retract only when THIS document never announced itself,
    // which is exactly the legacy-panel case the retraction is for.
    if (!f.readyForLoad) f.busReady = false;
    f.readyForLoad = false;
    skinFrame(f);
    stampFrame(f);
    markVisibility();
    // A panel that speaks the bus will answer with frame:ready in a moment. One
    // that does not (a not-yet-rewritten tab) gets the legacy delivery path.
    setTimeout(() => flushQueue(f), 140);
  }

  // ---- the frame-level attribute push-down (invariants: data-onscreen and
  // ---- data-drawms). Written with an equality guard so a 20Hz perf stream or
  // ---- a fast tab switch does not touch attributes that already say this.
  function frameRoot(f) {
    try { return f.frame.contentDocument && f.frame.contentDocument.documentElement; }
    catch (_) { return null; }
  }

  function markVisibility() {
    for (const f of FRAMES) {
      const on = (f.key === activeKey && !covered);
      f.onscreen = on;
      const el = frameRoot(f);
      const v = on ? '1' : '0';
      if (!el || el.dataset.onscreen === v) continue;
      el.dataset.onscreen = v;
      if (on) {
        // The panel cannot detect that it was uncovered: document.hidden only
        // tracks the window. Say it, and let its draw scheduler repaint once.
        try { f.frame.contentWindow.dispatchEvent(new Event('midi-studio:onscreen')); } catch (_) {}
      }
      if (window.Bus) window.Bus.send(T.FRAME_ONSCREEN, { frame: f.key, on }, { to: f.frame });
    }
  }

  function stampFrame(f) {
    const el = frameRoot(f);
    if (!el) return;
    const ms = String(perf.drawMs || 33);
    if (el.dataset.drawms !== ms) el.dataset.drawms = ms;
    const g = gameRaises() ? '1' : '';
    if ((el.dataset.game || '') !== g) el.dataset.game = g;
    const d = density === 'compact' ? 'compact' : '';
    if ((el.dataset.density || '') !== d) el.dataset.density = d;
  }

  // ==========================================================================
  // 2. PERFORMANCE PUSH-DOWN
  // The user's budget, "a game is up" and the unfocused penalty are three
  // separate inputs and must never be folded together. The shell stamps the
  // user's BASE ms in data-drawms and says "a game is up" in data-game; the
  // shared draw scheduler applies the x3 raise, the unfocused clamp and the
  // playback floor. Multiplying here as well is exactly the compounding bug
  // that once landed the piano roll at 5fps.
  // ==========================================================================
  let perf = { percent: 100, drawMs: 16, whenGaming: 'limit', cores: 0, threads: 0, batch: 0, lowPriority: false, custom: {} };
  let gameName = '';
  const gameRaises = () => !!gameName && perf.whenGaming !== 'nothing';

  function applyPerf() {
    const ms = String(perf.drawMs || 33);
    if (root.dataset.drawms !== ms) root.dataset.drawms = ms;
    const g = gameRaises() ? '1' : '';
    if ((root.dataset.game || '') !== g) root.dataset.game = g;
    for (const f of FRAMES) stampFrame(f);
    if (window.Bus) {
      window.Bus.send(T.UI_PERF, {
        drawMs: perf.drawMs, percent: perf.percent,
        gameActive: !!gameName, whenGaming: perf.whenGaming
      }, { to: 'frames' });
    }
  }

  // ==========================================================================
  // 3. THEME, ACCENT, DENSITY
  // One owner. Panels never apply their own theme; they are told.
  // ==========================================================================
  const ACCENT_KEYS = ['--accent', '--accent-2', '--accent-deep', '--accent-ink', '--accent-soft', '--accent-line', '--ok'];
  let themePreset = '';
  let accentVars = null;
  let density = 'normal';

  function deriveAccent(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) return null;
    const n = parseInt(m[1], 16), r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    const h2 = (v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
    const blend = (tr, tg, tb, p) => '#' + h2(r + (tr - r) * p) + h2(g + (tg - g) * p) + h2(b + (tb - b) * p);
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    return {
      '--accent': '#' + m[1].toLowerCase(),
      '--accent-2': blend(255, 255, 255, 0.18),
      '--accent-deep': blend(0, 0, 0, 0.28),
      '--accent-ink': lum > 0.6 ? '#0c0d10' : '#f4f6ff',
      '--accent-soft': blend(20, 21, 25, 0.86),
      '--accent-line': blend(20, 21, 25, 0.62),
      '--ok': '#' + m[1].toLowerCase()
    };
  }

  function skinEl(el) {
    if (!el) return;
    if ((el.dataset.theme || '') !== themePreset) el.dataset.theme = themePreset;
    if (accentVars) for (const k of ACCENT_KEYS) el.style.setProperty(k, accentVars[k]);
    else for (const k of ACCENT_KEYS) el.style.removeProperty(k);
  }
  function skinFrame(f) {
    const el = frameRoot(f);
    if (!el) return;
    skinEl(el);
    try {
      f.frame.contentWindow.dispatchEvent(new Event('midi-studio:theme'));
    } catch (_) {}
  }
  const applySkin = coalesce(() => {
    skinEl(root);
    if (window.Tokens) window.Tokens.refresh();
    window.dispatchEvent(new Event('midi-studio:accent'));
    for (const f of FRAMES) if (f.loaded) skinFrame(f);
    if (window.Bus) window.Bus.send(T.UI_THEME, { theme: themePreset, accent: accentVars ? accentVars['--accent'] : '' }, { to: 'frames' });
    renderPalSwatch();
  });

  function setTheme(preset) { themePreset = preset || ''; accentVars = null; applySkin(); }
  function setAccent(hex) { accentVars = hex ? deriveAccent(hex) : null; applySkin(); }

  function applyDensity() {
    const d = density === 'compact' ? 'compact' : '';
    if ((root.dataset.density || '') !== d) root.dataset.density = d;
    for (const f of FRAMES) {
      const el = frameRoot(f);
      if (!el) continue;
      if ((el.dataset.density || '') !== d) el.dataset.density = d;
      try { f.frame.contentWindow.dispatchEvent(new Event('midi-studio:density')); } catch (_) {}
    }
    if (window.Tokens) window.Tokens.refresh();
    window.dispatchEvent(new Event('midi-studio:density'));
    if (window.Bus) window.Bus.send(T.UI_DENSITY, { density: density === 'compact' ? 'compact' : 'normal' }, { to: 'frames' });
    moveIndicator();
  }
  function setDensity(d) {
    density = d === 'compact' ? 'compact' : 'normal';
    applyDensity();
    saveUi({ density });
  }

  // ==========================================================================
  // 4. SETTINGS PERSISTENCE (renderer side)
  // Continuous inputs are coalesced into one trailing IPC write; the flush is
  // guaranteed on sheet close and on unload so nothing is lost.
  // ==========================================================================
  let uiPatch = null;
  const flushUi = () => {
    if (!uiPatch) return;
    const patch = uiPatch; uiPatch = null;
    if (studio.setUi) studio.setUi(patch).catch(() => {});
  };
  const flushUiSoon = debounce(flushUi, 300);
  function saveUi(patch) {
    uiPatch = Object.assign(uiPatch || {}, patch);
    flushUiSoon();
  }
  window.addEventListener('beforeunload', () => { flushUiSoon.cancel(); flushUi(); });

  // ==========================================================================
  // 5. TOASTS
  // ==========================================================================
  const toastHost = $('toasts');
  const toastByKey = new Map();
  function toast(opts) {
    const o = typeof opts === 'string' ? { title: opts } : (opts || {});
    const sev = ['ok', 'warn', 'err', 'info'].includes(o.severity) ? o.severity : 'info';
    const key = o.key || (sev + '|' + o.title);
    const existing = toastByKey.get(key);
    if (existing) {
      existing.count += 1;
      existing.el.querySelector('.toast-count').textContent = String(existing.count);
      existing.el.querySelector('.toast-count').hidden = false;
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => dropToast(key), o.timeout || 4200);
      return;
    }
    const el = document.createElement('div');
    el.className = 'toast is-in' + (sev === 'info' ? '' : ' is-' + sev);
    el.setAttribute('role', sev === 'err' ? 'alert' : 'status');
    el.innerHTML = '<span class="toast-body"><span class="toast-title"></span>'
      + '<span class="toast-msg"></span></span>'
      + '<span class="toast-count mono" hidden>1</span>'
      + '<button class="toast-x" aria-label="Dismiss">×</button>';
    el.querySelector('.toast-title').textContent = o.title || '';
    const msg = el.querySelector('.toast-msg');
    if (o.message) msg.textContent = o.message; else msg.hidden = true;
    el.querySelector('.toast-x').addEventListener('click', () => dropToast(key));
    toastHost.appendChild(el);
    raf(() => el.classList.remove('is-in'));
    const rec = { el, count: 1, timer: setTimeout(() => dropToast(key), o.timeout || 4200) };
    toastByKey.set(key, rec);
    // Four is as many as anyone reads. The oldest goes.
    while (toastHost.children.length > 4) {
      const first = toastHost.firstElementChild;
      for (const [k, v] of toastByKey) if (v.el === first) { dropToast(k); break; }
      if (toastHost.firstElementChild === first) first.remove();
    }
  }
  function dropToast(key) {
    const rec = toastByKey.get(key);
    if (!rec) return;
    toastByKey.delete(key);
    clearTimeout(rec.timer);
    rec.el.classList.add('is-out');
    setTimeout(() => rec.el.remove(), 200);
  }

  // ==========================================================================
  // 6. ACTIVITY MODEL
  // One object. The strip is a pure render of it; every writer goes through
  // one of the mutators below and calls renderStrip().
  // ==========================================================================
  const activity = {
    forge: null,      // {jobId, name, stage, percent|null, startedAt, paused, kind}
    forged: null,     // {name, midiPath, projectPath, at} — a finished transcription on offer
    playback: null,   // mirrored transport snapshot, or null when idle
    editor: null,     // {name, notes, dirty}
    panels: {},       // frameKey -> {frame, label, percent} — a panel's own long job
    pending: null,    // {frame, name, at} — a hand-off in flight
    engine: { known: false, ready: false, gpu: null, missing: [], dir: '', custom: false, freeGb: null, needGb: null },
    update: { state: 'idle', percent: 0, version: '', current: '', staged: false, canSelfUpdate: true, message: '', dismissed: false },
    reaped: ''
  };

  // ---- the log ring buffer (one sink: Forge, provisioning, player, shell) ---
  // The SHELL owns it. It receives forge:status, engine:error, the provisioning
  // stream and ui:status from every frame, and it must keep collecting whether
  // or not the Logs tab has ever been opened -- tab frames load lazily, so the
  // viewer cannot be the owner. The Logs frame is a pure view of this buffer:
  // one full log:sync when it announces frame:ready, batched log:append after.
  const LOG_CAP = 600;
  const logLines = [];
  let logSeq = 0, logErrors = 0;

  const LEVEL_RANK = { info: 0, ok: 0, warn: 1, error: 2 };

  // Batched publish. A transcription emits hundreds of lines per stage, and one
  // bus message per line across a frame boundary is exactly the hot path this
  // rewrite has been removing. One rAF, one message, however many lines.
  let logOut = [];
  const flushLogOut = coalesce(() => {
    if (!logOut.length) return;
    const f = byKey.logs;
    if (!window.Bus || !f || !f.busReady) return;      // nobody is watching yet
    const batch = logOut; logOut = [];
    window.Bus.send(T.LOG_APPEND, { lines: batch }, { to: f.frame });
  });

  function logPush(text, level, src) {
    text = String(text == null ? '' : text).replace(/\s+$/, '');
    if (!text) return;
    level = LEVEL_RANK[level] === undefined ? 'info' : level;
    src = src || 'app';
    const last = logLines[logLines.length - 1];
    if (last && last.text === text && last.level === level && last.src === src) return;   // pure repeat
    const d = new Date();
    const line = {
      id: ++logSeq, text: text, level: level, src: src,
      clock: String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0')
    };
    logLines.push(line);
    while (logLines.length > LOG_CAP) logLines.shift();
    if (level === 'error') { logErrors += 1; renderLogCount(); }
    logOut.push(line);
    // The viewer keeps the same cap, so a backlog longer than the buffer is
    // pointless to carry: the sync it will get is authoritative anyway.
    if (logOut.length > LOG_CAP) logOut.splice(0, logOut.length - LOG_CAP);
    flushLogOut();
  }

  // The one thing left on the strip. An error must stay discoverable from any
  // tab, so the count survives; clicking it goes to the Logs tab.
  function renderLogCount() {
    const host = $('as-errors'), el = $('as-log-count');
    if (!host || !el) return;
    host.hidden = logErrors === 0;
    if (!logErrors) return;
    el.textContent = logErrors > 99 ? '99+' : String(logErrors);
    host.setAttribute('aria-label',
      logErrors + (logErrors === 1 ? ' error' : ' errors') + ' in the log. Show the Logs tab.');
  }
  function logSync(to) {
    if (!window.Bus) return;
    window.Bus.send(T.LOG_SYNC, { lines: logLines.slice(), cap: LOG_CAP, seq: logSeq }, { to: to });
  }
  function logClear() {
    logLines.length = 0; logOut.length = 0; logErrors = 0; logSeq = 0;
    renderLogCount();
    const f = byKey.logs;
    if (f && f.busReady) logSync(f.frame);
  }
  function logText() {
    return logLines.map((l) => l.clock + ' [' + l.src + '] '
      + (l.level === 'info' ? '' : l.level.toUpperCase() + ' ') + l.text).join('\n');
  }
  async function copyLog() {
    if (!logLines.length) { toast({ severity: 'warn', title: 'Nothing to copy' }); return; }
    try {
      await navigator.clipboard.writeText(logText());
      toast({ severity: 'ok', title: 'Log copied', message: logLines.length + ' lines' });
    } catch (_) { toast({ severity: 'err', title: 'Could not copy the log' }); }
  }
  $('as-errors').addEventListener('click', () => activate('logs'));

  // ==========================================================================
  // 7. THE ACTIVITY STRIP RENDER
  // ONE context line, never a competition. Everything that is live is described
  // as a context object; the most important one owns the row -- state word,
  // name, one metadata line, its progress and its own actions -- and every
  // other live context collapses to a chip that brings it forward on click.
  // The nodes are built once and patched in place: the strip is on screen for
  // the whole session and a 20Hz progress stream must not churn the DOM.
  // ==========================================================================
  const stripEl = $('astrip');
  const ctxHost = $('as-ctx'), altHost = $('as-alts'), actHost = $('as-acts');

  ctxHost.innerHTML = '<button type="button" class="as-ctx-main">'
    + '<span class="as-ctx-badge" aria-hidden="true"><span class="dot"></span></span>'
    + '<span class="as-ctx-lines">'
    +   '<span class="as-ctx-head"><span class="as-ctx-state"></span><span class="as-ctx-name"></span></span>'
    +   '<span class="as-ctx-meta"></span>'
    + '</span></button>'
    + '<div class="bar is-sm as-ctx-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" hidden>'
    +   '<div class="bar-fill" style="--p:0"></div></div>';

  const ctxUI = (() => {
    const main = ctxHost.firstElementChild;
    const lines = main.children[1];
    const bar = ctxHost.children[1];
    return {
      main: main,
      dot: main.children[0].firstElementChild,
      state: lines.children[0].children[0],
      name: lines.children[0].children[1],
      meta: lines.children[1],
      bar: bar,
      fill: bar.firstElementChild
    };
  })();

  // The one the user brought forward by clicking its chip. Dropped as soon as
  // that context stops being live, so a pin can never strand the strip.
  let ctxPin = null;
  const ctxLast = { id: '', pct: -3, actKey: '', meta: '', name: '' };

  function setActions(defs) {
    const key = defs.map((d) => d.id).join(',');
    if (ctxLast.actKey === key) return;
    ctxLast.actKey = key;
    actHost.textContent = '';
    for (const d of defs) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn-sm ' + (d.primary ? 'btn-primary' : d.danger ? 'btn-danger' : '');
      b.textContent = d.label;
      b.dataset.act = d.id;
      b.addEventListener('click', (e) => { e.stopPropagation(); d.run(); });
      actHost.appendChild(b);
    }
  }

  function etaText(startedAt, percent) {
    if (!startedAt || !(percent > 4)) return '';
    const elapsed = (Date.now() - startedAt) / 1000;
    if (elapsed < 8) return '';
    const total = elapsed * 100 / percent;
    const left = Math.max(0, total - elapsed);
    return window.Fmt ? window.Fmt.duration(left) + ' left' : Math.round(left) + 's left';
  }

  // The refs group thousands ("2,841 notes"); Fmt.count only pluralises a word.
  const countOf = (n) => {
    const v = Number(n) || 0;
    try { return v.toLocaleString(); } catch (_) { return String(v); }
  };

  // ---- the model, as an ordered list of contexts ---------------------------
  // Order IS the priority: a Forge job outranks live playback, playback
  // outranks an unsaved document, and so on down to the idle placeholder.
  function stripContexts() {
    const out = [];

    // -- a Forge job -------------------------------------------------------
    if (activity.forge) {
      const j = activity.forge;
      const indet = j.percent == null || j.percent < 0;
      const ip = indet ? -1 : Math.round(j.percent);
      const eta = indet ? '' : etaText(j.startedAt, ip);
      out.push({
        id: 'forge',
        live: !j.paused,
        dot: j.paused ? 'is-paused' : 'is-live',
        state: j.paused ? 'Paused' : (j.kind === 'yt' ? 'Fetching' : 'Forging'),
        name: j.name || 'transcription',
        title: j.name || '',
        meta: indet ? (j.stage || 'Working') : [j.stage, ip + '%', eta].filter(Boolean).join(' · '),
        pct: ip,
        chip: j.paused ? 'Paused' : 'Forging',
        aria: 'Forge: ' + (j.name || 'job') + ' ' + (j.stage || '') + '. Open the Forge tab.',
        open: () => activate('forge'),
        actions: [
          { id: 'details', label: 'View details', run: () => activate('forge') },
          { id: 'cancel', label: 'Cancel', danger: true, run: cancelForgeJob }
        ]
      });
    }

    // -- live playback -----------------------------------------------------
    const pb = activity.playback;
    if (pb && pb.owner && pb.status !== 'idle') {
      const live = pb.status === 'playing' || pb.status === 'counting';
      const caps = pb.caps || {};
      const home = pb.owner === 'selfmidi' ? 'audition' : pb.owner === 'editor' ? 'review' : 'player';
      const bits = [];
      if (caps.target) bits.push('Playing on ' + String(caps.target).split(' - ')[0]);
      bits.push(fmtClock(pb.position) + ' / ' + fmtClock(pb.duration));
      if (caps.notes) bits.push(countOf(caps.notes) + ' notes');
      out.push({
        id: 'play',
        live: live,
        dot: live ? 'is-live' : pb.status === 'blocked' ? 'is-blocked' : 'is-paused',
        state: pb.status === 'blocked' ? 'Blocked' : pb.status === 'paused' ? 'Paused'
          : pb.status === 'counting' ? 'Counting in' : 'Now playing',
        name: pb.label || 'untitled',
        title: pb.label || '',
        meta: bits.join(' · '),
        pct: pb.duration > 0 ? clamp(Math.round(pb.position / pb.duration * 100), 0, 100) : -3,
        chip: live ? 'Playing' : 'Paused',
        aria: 'Now playing ' + (pb.label || '') + '. Open the ' + byKey[home].label + ' tab.',
        open: () => activate(home),
        actions: (caps.target ? [{ id: 'target', label: String(caps.target), run: () => activate(home) }] : [])
          .concat([{ id: 'focus', label: 'Focus', run: () => activate(home) }])
      });
    }

    // -- an unsaved Editor document ---------------------------------------
    if (activity.editor && activity.editor.dirty) {
      const e = activity.editor;
      out.push({
        id: 'edit',
        live: false,
        dot: 'warn',
        state: 'Editing',
        name: e.name || 'untitled',
        title: e.name || '',
        meta: (e.notes ? countOf(e.notes) + ' notes · ' : '') + 'Unsaved changes',
        pct: -3,
        chip: 'Editing',
        aria: 'Editor has unsaved changes to ' + (e.name || 'the document') + '. Open the Editor tab.',
        open: () => activate('review'),
        actions: [
          { id: 'save', label: 'Save', primary: true, run: () => runCommand('editor.save', 'review') },
          { id: 'saveplay', label: 'Save & Play', run: () => runCommand('editor.savePlay', 'review') }
        ]
      });
    }

    // -- a finished transcription on offer ----------------------------------
    // With auto-queue off the finished MIDI is an OFFER, and an offer has to
    // outlive a 7s toast: the settings hint promises the strip, and a user who
    // steps away must still find it. Cleared by Dismiss or by the next job.
    // The actions never close over the record -- a second offer would otherwise
    // reuse the first offer's buttons -- so they read the model at click time.
    if (activity.forged) {
      const g = activity.forged;
      out.push({
        id: 'forged',
        live: false,
        dot: 'ok',
        state: 'Forged',
        name: g.name || 'transcription',
        title: g.midiPath || '',
        meta: 'Ready',
        pct: -3,
        chip: 'Forged',
        aria: (g.name || 'A transcription') + ' is ready. Show it in the Library.',
        open: () => {
          const f = activity.forged;
          if (f) handoff('library', { selectPath: f.midiPath }, { from: 'forge' });
        },
        actions: [
          { id: 'queue', label: 'Add to queue', primary: true, run: () => {
            const f = activity.forged;
            if (!f) return;
            handoff('player', { midiPath: f.midiPath, play: false, queue: true }, { from: 'forge', focus: false });
            toast({ severity: 'ok', title: 'Added ' + f.name + ' to the Player queue' });
            clearForged();
          } },
          { id: 'edit', label: 'Edit', run: () => {
            const f = activity.forged;
            if (!f) return;
            handoff('review', { projectPath: f.projectPath, midiPath: f.midiPath }, { from: 'forge' });
            clearForged();
          } },
          { id: 'dismiss', label: 'Dismiss', run: clearForged }
        ]
      });
    }

    // -- a panel's own long determinate operation ---------------------------
    // The strip exists for work that outlives a toast, and a folder rescan over
    // a few thousand files is exactly that. A `frame:busy` carrying a numeric
    // `percent` gets a context here; one without a percent is still only
    // logged, because a row that can never finish is worse than a log line.
    for (const pkey of Object.keys(activity.panels)) {
      const q = activity.panels[pkey];
      const pf = byKey[pkey];
      if (!pf) continue;
      const ip = Math.round(q.percent);
      out.push({
        id: 'panel:' + pkey,
        live: true,
        dot: 'is-live',
        state: pf.label,
        name: q.label || 'working',
        title: q.label || '',
        meta: ip + '%',
        pct: ip,
        chip: pf.label,
        aria: pf.label + ': ' + (q.label || 'working') + ' ' + ip + '%. Open the ' + pf.label + ' tab.',
        open: () => activate(pkey),
        actions: []
      });
    }

    // -- a hand-off in flight ---------------------------------------------
    if (activity.pending) {
      const p = activity.pending;
      const where = byKey[p.frame] ? byKey[p.frame].label : p.frame;
      out.push({
        id: 'pending',
        live: false,
        quiet: true,
        dot: '',
        state: 'Opening',
        name: p.name || '',
        title: p.name || '',
        meta: 'in ' + where,
        pct: -3,
        chip: 'Opening',
        aria: 'Opening ' + p.name + ' in ' + where,
        open: null,
        actions: []
      });
    }

    return out;
  }

  const renderStrip = coalesce(() => {
    const list = stripContexts();

    // A pin only survives while the context it points at is still live, so it
    // can never strand the strip on something that has finished.
    if (ctxPin && !list.some((c) => c.id === ctxPin)) ctxPin = null;
    let primary = (ctxPin ? list.find((c) => c.id === ctxPin) : null) || list[0] || null;

    const idle = !primary;
    stripEl.dataset.state = idle ? 'idle' : 'live';
    if (idle) {
      primary = {
        id: 'idle', live: false, quiet: true, dot: '',
        state: 'Idle', name: activity.reaped || 'Nothing running',
        title: '', meta: '', pct: -3, open: null, actions: [], aria: ''
      };
    }

    const fresh = ctxLast.id !== primary.id;
    ctxLast.id = primary.id;

    ctxHost.classList.toggle('is-live', !!primary.live);
    ctxHost.classList.toggle('is-quiet', !!primary.quiet);
    ctxUI.dot.className = 'dot' + (primary.dot ? ' ' + primary.dot : '');
    ctxUI.state.textContent = primary.state;
    if (fresh || ctxLast.name !== primary.name) {
      ctxLast.name = primary.name;
      ctxUI.name.textContent = primary.name;
      ctxUI.name.title = primary.title || primary.name || '';
    }
    // The meta line is rebuilt on every render but written only when it really
    // changed: a 20Hz progress stream must not touch the DOM 20 times a second.
    if (fresh || ctxLast.meta !== primary.meta) {
      ctxLast.meta = primary.meta;
      ctxUI.meta.textContent = primary.meta;
      ctxUI.meta.title = primary.meta;
    }

    // progress: -3 = no bar, -1 = indeterminate, 0..100 = determinate
    const pct = primary.pct;
    ctxUI.bar.hidden = pct === -3;
    if (pct === -1) {
      if (!ctxUI.fill.classList.contains('indet')) { ctxUI.fill.classList.add('indet'); ctxUI.fill.style.setProperty('--p', 1); }
      ctxUI.bar.removeAttribute('aria-valuenow');
      ctxLast.pct = -1;
    } else if (pct >= 0) {
      ctxUI.fill.classList.remove('indet');
      if (fresh || ctxLast.pct !== pct) {
        ctxLast.pct = pct;
        ctxUI.fill.style.setProperty('--p', (pct / 100).toFixed(3));
        ctxUI.bar.setAttribute('aria-valuenow', String(pct));
      }
    }

    if (primary.aria) ctxUI.main.setAttribute('aria-label', primary.aria);
    else ctxUI.main.removeAttribute('aria-label');
    ctxUI.main.disabled = !primary.open;
    ctxUI.main.onclick = primary.open || null;
    if (fresh) ctxLast.actKey = null;           // force a rebuild across a switch
    setActions(primary.actions || []);

    // -- everything else that is live, as one small chip each ---------------
    const alts = list.filter((c) => c.id !== primary.id);
    const altKey = alts.map((c) => c.id + ':' + c.chip + ':' + c.dot).join(',');
    if (altHost.dataset.key !== altKey) {
      altHost.dataset.key = altKey;
      altHost.textContent = '';
      for (const c of alts) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'as-alt' + (c.live ? ' is-live' : '');
        b.dataset.tip = c.chip + ': ' + (c.title || c.name) + '. Show it on the strip.';
        b.setAttribute('aria-label', 'Also running — ' + c.chip + ': ' + (c.name || '') + '. Show it on the strip.');
        b.innerHTML = '<span class="dot' + (c.dot ? ' ' + c.dot : '') + '"></span><span class="as-alt-t"></span>';
        b.lastElementChild.textContent = c.chip;
        const id = c.id;
        b.addEventListener('click', () => { ctxPin = id; renderStrip(); });
        altHost.appendChild(b);
      }
    }
  });

  function clearForged() {
    if (!activity.forged) return;
    activity.forged = null;
    renderStrip();
  }

  // ---- engine chip ---------------------------------------------------------
  const ENGINE_CACHE_KEY = 'midi-studio:forgeEnv';
  function readEngineCache() {
    try {
      const raw = localStorage.getItem(ENGINE_CACHE_KEY);
      if (!raw) return null;
      const v = JSON.parse(raw);
      return (v && typeof v === 'object') ? v : null;
    } catch (_) { return null; }
  }
  function writeEngineCache() {
    const e = activity.engine;
    try { localStorage.setItem(ENGINE_CACHE_KEY, JSON.stringify({ ready: e.ready, gpu: e.gpu, missing: e.missing })); } catch (_) {}
  }
  function renderEngine() {
    const e = activity.engine, chip = $('as-engine');
    const dot = chip.firstElementChild, txt = chip.lastElementChild;
    let cls = 'as-chip', dcls = 'dot', label, tip;
    if (!e.known) { label = 'Engine…'; tip = 'Checking the Forge engine'; }
    else if (!e.ready) {
      cls += ' is-warn'; dcls += ' warn';
      label = 'Not set up';
      tip = e.missing && e.missing.length ? 'Missing: ' + e.missing.join(', ') : 'Forge has not been set up yet';
    } else if (e.gpu) {
      cls += ' is-ok'; dcls += ' ok';
      label = 'Ready · GPU';
      tip = 'Forge is ready on ' + e.gpu;
    } else {
      cls += ' is-ok'; dcls += ' ok';
      label = 'CPU mode';
      tip = 'Forge is ready, but no CUDA GPU was found. Transcriptions will be slower.';
    }
    chip.className = cls;
    dot.className = dcls;
    txt.textContent = label;
    chip.dataset.tip = tip;
    chip.setAttribute('aria-label', 'Forge engine: ' + label);
    // Settings mirror
    const st = $('s-forge-status');
    if (st) {
      st.innerHTML = '';
      const pill = document.createElement('span');
      pill.className = 'pill' + (!e.known ? '' : e.ready ? ' is-ok' : ' is-warn');
      pill.innerHTML = '<span class="' + dcls + '"></span>';
      pill.appendChild(document.createTextNode(label));
      st.appendChild(pill);
    }
    const miss = $('s-forge-missing');
    if (miss) miss.textContent = (e.missing && e.missing.length) ? e.missing.join(', ') : '—';
  }
  $('as-engine').addEventListener('click', () => {
    if (!activity.engine.ready) {
      activate('forge');
      runCommand('forge.setup', 'forge', () => openSettings('forge'));
      return;
    }
    openSettings('forge');
  });

  // ---- game chip (edge-triggered: repeated broadcasts must not spam) -------
  function renderGame() {
    const chip = $('as-game');
    chip.hidden = !gameName;
    if (!gameName) return;
    const clean = gameName.replace(/\.exe$/i, '');
    chip.lastElementChild.textContent = clean;
    const rule = perf.whenGaming;
    chip.dataset.tip = rule === 'nothing' ? `${clean} is running. MIDI Studio is carrying on as normal.`
      : rule === 'pause' ? `${clean} is running. Forge jobs are paused.`
        : `${clean} is running. Forge is on idle priority and the visuals are lighter.`;
    chip.setAttribute('aria-label', 'Game detected: ' + clean);
  }
  $('as-game').addEventListener('click', () => openSettings('performance'));

  // ---- update row: all eight states, main frame only ----------------------
  function renderUpdate() {
    const u = activity.update;
    const row = $('as-update');
    const title = $('as-upd-title'), sub = $('as-upd-sub');
    const bar = $('as-upd-bar'), fill = $('as-upd-fill');
    const apply = $('as-upd-apply');
    const show = (t, s) => { title.textContent = t; sub.textContent = s || ''; row.hidden = false; };
    apply.hidden = false; apply.disabled = false; bar.hidden = true;

    switch (u.state) {
      case 'checking':
        u.staged = false;
        show('Checking for updates…', '');
        apply.hidden = true;
        break;
      case 'available': {
        u.staged = true;
        const note = String(u.notes || '').split(/\r?\n/).find((l) => l.trim()) || '';
        show(`Update available: v${u.version}`,
          `from v${u.current}${u.size ? ' · ' + fmtBytes(u.size) : ''}${note ? ' · ' + note.replace(/^#+\s*/, '') : ''}`);
        apply.textContent = u.canSelfUpdate ? 'Update & restart' : 'Open download page';
        break;
      }
      case 'downloading': {
        const ip = clamp(Math.round(u.percent || 0), 0, 100);
        show(`Downloading update… ${ip}%`, `v${u.version || ''}`);
        bar.hidden = false;
        if (fill.dataset.p !== String(ip)) { fill.dataset.p = String(ip); fill.style.setProperty('--p', (ip / 100).toFixed(3)); bar.setAttribute('aria-valuenow', String(ip)); }
        apply.disabled = true; apply.textContent = 'Update & restart';
        break;
      }
      case 'verifying':
        show('Verifying the download…', 'Checking the signature');
        apply.disabled = true;
        break;
      case 'ready':
        show('Restarting to apply the update…', '');
        apply.hidden = true;
        break;
      case 'manual':
        show('Finish the update in your browser', 'The download page has opened.');
        apply.hidden = true;
        break;
      case 'updated':
        row.hidden = true;
        break;
      case 'none':
        row.hidden = true;
        break;
      case 'error':
        u.staged = false;
        show('Update failed', u.message || 'Try again later.');
        apply.textContent = 'Retry';
        break;
      default:
        row.hidden = true;
    }
    if (u.dismissed) row.hidden = true;
    const chip = $('version-chip');
    chip.classList.toggle('is-new', u.state === 'available');
    const state = $('s-updstate');
    if (state) {
      state.textContent = u.state === 'available' ? `v${u.version} is available`
        : u.state === 'none' ? 'up to date'
          : u.state === 'error' ? (u.message || 'the last check failed')
            : u.state === 'checking' ? 'checking…'
              : u.state === 'downloading' ? `downloading ${Math.round(u.percent || 0)}%`
                : u.state === 'updated' ? `updated to v${u.version}` : 'not checked yet';
    }
  }
  $('as-upd-x').addEventListener('click', () => { activity.update.dismissed = true; renderUpdate(); });
  $('as-upd-apply').addEventListener('click', () => {
    const u = activity.update;
    if (!u.staged) { if (studio.checkForUpdates) studio.checkForUpdates({ manual: true }); return; }
    const b = $('as-upd-apply');
    b.disabled = true; b.textContent = 'Working…';
    if (studio.applyUpdate) studio.applyUpdate();
  });

  const fmtClock = (s) => (window.Fmt ? window.Fmt.clock(s, { ms: xportMs }) : (s == null ? '--:--' : Math.round(s) + 's'));
  const fmtBytes = (b) => (window.Fmt ? window.Fmt.bytes(b) : Math.round(b / 1048576) + ' MB');

  // ---- version chrome. The chip stays bare (v3.0.0); the About pane is the
  // ---- one place the release name is spelt out.
  let appVersion = '', releaseName = '';
  function applyVersion(v) {
    if (v) appVersion = String(v);
    if (!appVersion) return;
    const chip = $('version-chip');
    chip.textContent = 'v' + appVersion;
    chip.setAttribute('aria-label', 'Version ' + appVersion + ', what’s new');
    $('s-version').textContent = 'v' + appVersion;
    $('s-about-version').textContent = appVersion + (releaseName ? ' \u201c' + releaseName + '\u201d' : '');
  }

  // ==========================================================================
  // 8. TAB ROUTING
  // ==========================================================================
  const navHost = $('nav'), navInd = $('nav-ind');
  const leaveTimers = new Map();

  const moveIndicator = coalesce(() => {
    const f = byKey[activeKey];
    if (!f || !f.navEl) return;
    const host = navHost.getBoundingClientRect();
    const item = f.navEl.getBoundingClientRect();
    navInd.style.transform = `translateX(${(item.left - host.left).toFixed(1)}px) scaleX(${item.width.toFixed(1)})`;
  });
  window.addEventListener('resize', moveIndicator);

  function activate(key, opts) {
    key = normaliseTab(key);
    const o = opts || {};
    const previous = activeKey;
    ensureFrame(key);

    for (const f of FRAMES) {
      const on = f.key === key;
      f.navEl.setAttribute('aria-selected', on ? 'true' : 'false');
      f.navEl.tabIndex = on ? 0 : -1;
    }

    if (previous !== key) {
      const out = byKey[previous];
      if (out && !out.frame.hidden) {
        out.frame.classList.remove('is-active');
        out.frame.classList.add('is-leaving');
        clearTimeout(leaveTimers.get(previous));
        leaveTimers.set(previous, setTimeout(() => {
          // Only retire it if it is still the one leaving.
          if (activeKey !== previous) { out.frame.hidden = true; out.frame.classList.remove('is-leaving'); }
        }, 170));
      }
    }
    const inc = byKey[key];
    clearTimeout(leaveTimers.get(key));
    inc.frame.classList.remove('is-leaving');
    if (inc.frame.hidden) {
      inc.frame.hidden = false;
      void inc.frame.offsetWidth;          // commit the pre-transition state
    }
    activeKey = key;
    inc.frame.classList.add('is-active');

    renderStage();
    markVisibility();
    moveIndicator();
    document.title = inc.title;
    if (o.focus !== false) { try { inc.frame.contentWindow.focus(); } catch (_) {} }
    if (o.persist !== false) saveUi({ lastTab: key });
    if (window.Bus) {
      window.Bus.send(T.NAV_ACTIVATED, { tab: key, previous }, { to: 'frames' });
    }
    // The palette filters by scope explicitly; the shell's OWN default scope
    // stays 'global' so a shell command never inherits a tab's scope.
    renderPalCount();
  }

  navHost.addEventListener('click', (e) => {
    const b = e.target.closest('.nav-item');
    if (b) activate(b.dataset.frame);
  });
  navHost.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') return;
    const cur = ORDER.indexOf(activeKey);
    let next;
    if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = ORDER.length - 1;
    else next = (cur + (e.key === 'ArrowRight' ? 1 : ORDER.length - 1)) % ORDER.length;
    activate(ORDER[next], { focus: false });
    byKey[ORDER[next]].navEl.focus();
    e.preventDefault();
  });

  function setCovered(on) {
    on = !!on;
    if (covered === on) return;
    covered = on;
    document.body.classList.toggle('is-covered', on);
    markVisibility();
  }
  const anyOverlayOpen = () => !$('pal-scrim').hidden || !$('set-scrim').hidden || !$('wn-scrim').hidden || dropDepth > 0;
  const syncCovered = () => setCovered(anyOverlayOpen());

  // ==========================================================================
  // 9. CROSS-TAB HAND-OFF ROUTER
  // A file can go from any tab to any other. Frames load lazily, so a hand-off
  // to a frame that does not exist yet is queued, the frame is created, and the
  // payload is delivered when it reports in. The strip shows the filename
  // immediately, before the target has finished loading.
  // ==========================================================================
  const HANDOFF = {
    forge:    { type: () => T.NAV_OPEN_FORGE,    legacy: (w, p) => (typeof w.setForgeInput === 'function' ? (w.setForgeInput(p.inputPath || p.url || ''), true) : false) },
    review:   { type: () => T.NAV_OPEN_EDITOR,   legacy: (w, p) => (typeof w.openReviewProject === 'function' ? (w.openReviewProject(p.projectPath || p.midiPath || ''), true) : false) },
    player:   { type: () => T.NAV_OPEN_PLAYER,   legacy: (w, p) => {
      if (typeof w.setMidiFile === 'function') { w.setMidiFile(p.midiPath || '', !!p.play); return true; }
      if (w.api && typeof w.api.send === 'function' && p.midiPath) {
        w.api.send({ cmd: 'load_midi', path: p.midiPath, mapping: 'roblox', tempo: 1.0 });
        return true;
      }
      return false;
    } },
    audition: { type: () => T.NAV_OPEN_SELFMIDI, legacy: (w, p) => (typeof w.loadAudition === 'function' ? (w.loadAudition(p.midiPath || '', p.projectPath || '', { play: p.play }), true) : false) },
    library:  { type: () => T.NAV_OPEN_LIBRARY,  legacy: () => false },
    logs:     { type: () => T.NAV_OPEN_LOGS,     legacy: () => false }
  };

  let pendingClear = 0;
  function nameOf(payload) {
    const p = payload || {};
    const path = p.midiPath || p.projectPath || p.inputPath || p.selectPath || p.path || p.url || '';
    return window.Fmt ? window.Fmt.basename(path) : String(path).split(/[\\/]/).pop();
  }

  function handoff(target, payload, opts) {
    const f = byKey[normaliseTab(target)];
    if (!f) return;
    const o = opts || {};
    const p = Object.assign({}, payload || {});
    if (p.play === undefined && (f.key === 'player' || f.key === 'audition')) {
      // The invariant is that loading is not playing. Sending a file across IS
      // an explicit ask, so this is the one place the preference applies.
      p.play = handoffPlay === 'play';
    }

    // The continuity cue: the target's name is already in the strip, and the
    // nav item it is going to lights up for a moment.
    const label = nameOf(p);
    if (label) {
      activity.pending = { frame: f.key, name: label, at: Date.now() };
      renderStrip();
      clearTimeout(pendingClear);
      pendingClear = setTimeout(() => { activity.pending = null; renderStrip(); }, 2600);
    }
    f.navEl.classList.add('is-cue');
    navInd.classList.add('is-cue');
    setTimeout(() => { f.navEl.classList.remove('is-cue'); navInd.classList.remove('is-cue'); }, 340);

    // Let the source panel flash the row the file came from.
    if (window.Bus && o.from && (p.midiPath || p.projectPath || p.inputPath)) {
      window.Bus.send(T.FILE_OPEN, {
        path: p.midiPath || p.projectPath || p.inputPath,
        kind: p.projectPath ? 'project' : p.inputPath ? 'audio' : 'mid',
        from: o.from
      }, { to: 'frames' });
    }

    ensureFrame(f.key);
    activate(f.key, { focus: o.focus !== false });
    f.queue.push(p);
    flushQueue(f);
  }

  function flushQueue(f) {
    if (!f.queue.length) return;
    const spec = HANDOFF[f.key];
    if (!spec) { f.queue.length = 0; return; }
    if (f.busReady && window.Bus) {
      const q = f.queue.slice(); f.queue.length = 0;
      for (const p of q) window.Bus.send(spec.type(), p, { to: f.frame });
      return;
    }
    if (!f.loaded) return;                       // wait for 'load'
    let w = null;
    try { w = f.frame.contentWindow; } catch (_) { return; }
    if (!w) return;
    const q = f.queue.slice();
    let delivered = false;
    for (const p of q) delivered = spec.legacy(w, p) || delivered;
    if (delivered) f.queue.length = 0;
    // A panel that answers neither the bus nor a legacy global keeps its queue;
    // frame:ready or the next load will drain it.
  }

  if (window.Bus) {
    window.Bus.on(T.FRAME_READY, (p, meta) => {
      const f = FRAMES.find((x) => x.key === (p && p.frame)) || FRAMES.find((x) => {
        try { return x.frame.contentWindow === meta.source; } catch (_) { return false; }
      });
      if (!f) return;
      if (!f.busReady) uiMark(`tab.${f.key}.ready`);
      f.busReady = true;
      f.readyForLoad = true;
      f.loaded = true;
      skinFrame(f); stampFrame(f); markVisibility();
      flushQueue(f);
      // A freshly opened Logs tab missed everything logged before it existed;
      // one full sync on the handshake is how it catches up.
      if (f.key === 'logs') logSync(f.frame);
      if (window.Bus) window.Bus.send(T.UI_DENSITY, { density: density === 'compact' ? 'compact' : 'normal' }, { to: f.frame });
    });
    // frame:busy is how a panel says "I am holding work". The Editor uses it for
    // an unsaved document (label: "<name> · <n> notes"), which is what the strip
    // renders as the Editing row; every other frame's busy state is just logged.
    window.Bus.on(T.FRAME_BUSY, (p, m) => {
      const key = (p && p.frame) || frameKeyOf(m);
      if (!key) return;
      if (key === 'review') {
        if (!p.busy) activity.editor = null;
        else {
          const parts = String(p.label || '').split(' · ');
          const notes = /(\d+)\s*notes?/i.exec(p.label || '');
          activity.editor = { name: parts[0] || 'untitled', notes: notes ? Number(notes[1]) : 0, dirty: true };
        }
        renderStrip();
        return;
      }
      // Any other frame: a busy state with a numeric `percent` is a long
      // determinate operation and earns a strip row (see §11.3). Without one it
      // is logged, exactly as before.
      const pct = Number(p.percent);
      const hasPct = Number.isFinite(pct) && pct >= 0;
      const had = Object.prototype.hasOwnProperty.call(activity.panels, key);
      if (p.busy && hasPct) {
        activity.panels[key] = { frame: key, label: String(p.label || ''), percent: clamp(pct, 0, 100) };
        if (!had && p.label) logPush(p.label, 'info', key);
        renderStrip();
        return;
      }
      if (had) { delete activity.panels[key]; renderStrip(); }
      if (p.label) logPush(p.busy ? p.label : p.label + ' — done', 'info', key);
    });
    window.Bus.on(T.NAV_ACTIVATE, (p) => { if (p && p.tab) activate(p.tab, { focus: p.focus !== false }); });
    window.Bus.on(T.NAV_OPEN_FORGE, (p, m) => handoff('forge', p, { from: frameKeyOf(m) }));
    window.Bus.on(T.NAV_OPEN_EDITOR, (p, m) => handoff('review', p, { from: frameKeyOf(m) }));
    window.Bus.on(T.NAV_OPEN_PLAYER, (p, m) => handoff('player', p, { from: frameKeyOf(m) }));
    window.Bus.on(T.NAV_OPEN_SELFMIDI, (p, m) => handoff('audition', p, { from: frameKeyOf(m) }));
    window.Bus.on(T.NAV_OPEN_LIBRARY, (p, m) => handoff('library', p, { from: frameKeyOf(m) }));
    window.Bus.on(T.NAV_OPEN_LOGS, (p, m) => handoff('logs', p, { from: frameKeyOf(m) }));
    // The viewer never owns the buffer, so Clear is a request, not a local act.
    window.Bus.on(T.LOG_CLEAR, () => logClear());
    window.Bus.on(T.FILE_DROPPED, (p, m) => routePaths((p && p.paths) || [], frameKeyOf(m)));
    window.Bus.on(T.FILE_REVEAL, (p) => { if (p && p.path && studio.showItem) studio.showItem(p.path); });
    window.Bus.on(T.UI_TOAST, (p) => toast(p));
    window.Bus.on(T.UI_STATUS, (p) => { if (p && p.text) logPush(p.text, p.severity === 'err' ? 'error' : p.severity === 'warn' ? 'warn' : 'info', p.frame || 'app'); });
    window.Bus.on(T.UI_PALETTE, (p) => { if (p && p.open) openPalette(p.query || ''); else closePalette(); });
    window.Bus.on(T.UI_SETTINGS, (p) => { if (p && p.open) openSettings(p.pane); else closeSettings(); });
    window.Bus.on(T.LIBRARY_CHANGED, () => refreshLibraryIndex());
    // The Forge tab's env verdict is the only place the GPU is actually known:
    // probing imports torch and takes tens of seconds, so whoever paid for it
    // shares the answer and the shell caches it for the next cold start.
    // A frame's own forge:status packets land here (mirror() addresses frames
    // only, so nothing the shell rebroadcasts comes back round). forge.env is
    // the shell's cache; everything else -- notably the {event:'forge.job'} a
    // tab sends to name the job it just started (11.3) -- goes to the same
    // handler the IPC stream uses, or the strip gets a nameless row for any job
    // whose pipeline never echoes an `Input:` line (a yt-dlp download).
    window.Bus.on(T.FORGE_STATUS, (p) => {
      if (!p || typeof p !== 'object') return;
      if (p.event === 'forge.env') adoptEnvProbe(p);
      else handleForgeStatus(p);
    });
  }
  function frameKeyOf(meta) {
    if (!meta || !meta.source) return '';
    for (const f of FRAMES) { try { if (f.frame.contentWindow === meta.source) return f.key; } catch (_) {} }
    return '';
  }

  // ---- routing dropped / associated files ---------------------------------
  const AUDIO_RE = /\.(mp3|wav|flac|m4a|aac|ogg|opus|wma|webm|mp4|aiff?|alac)$/i;
  function routePaths(paths, from) {
    const list = (paths || []).map(String).filter(Boolean);
    if (!list.length) return;
    const project = list.find((p) => /\.midstudio\.json$/i.test(p));
    if (project) { handoff('review', { projectPath: project }, { from }); return; }
    const midi = list.filter((p) => /\.midi?$/i.test(p));
    if (midi.length) {
      // If the tab you are looking at can take a MIDI, it gets it.
      const target = (activeKey === 'audition' || activeKey === 'review' || activeKey === 'library') ? activeKey : 'player';
      handoff(target, target === 'library' ? { selectPath: midi[0] } : { midiPath: midi[0] }, { from });
      if (midi.length > 1) toast({ severity: 'info', title: `Opened ${window.Fmt ? window.Fmt.basename(midi[0]) : midi[0]}`, message: `${midi.length - 1} more were ignored: one file at a time.` });
      return;
    }
    const mapping = list.find((p) => /\.json$/i.test(p));
    if (mapping) { handoff('player', { mappingPath: mapping }, { from }); return; }
    // No extension at all is treated as audio: yt-dlp and a few converters
    // write files that way, and Forge is the only thing that can use them.
    const audio = list.filter((p) => AUDIO_RE.test(p) || !/\.[a-z0-9]{1,5}$/i.test(p));
    if (audio.length) { handoff('forge', { inputPath: audio[0], inputPaths: audio }, { from }); return; }
    toast({ severity: 'warn', title: 'Nothing MIDI Studio can open', message: 'Audio for Forge, .mid for the Player, .midstudio.json for the Editor.' });
  }

  // ==========================================================================
  // 10. BOTTOM TRANSPORT
  // Renders from the transport-owner state and nothing else. No clock lives
  // here: every position on screen arrived in a transport:state packet.
  // ==========================================================================
  const OWNER_HOME = { player: 'player', selfmidi: 'audition', editor: 'review' };
  const OWNER_LABEL = { player: 'Player', selfmidi: 'Listen', editor: 'Editor' };
  const xport = $('xport');
  let xportMs = false;                    // show milliseconds in the readout
  let scrubbing = false, scrubValue = 0;
  let lastState = null;
  // Writing a knob is a round trip through the owning frame, so the shell shows
  // what it just sent until the owner confirms it (or 1.5s passes). Without this
  // the next state packet, which cannot know yet, snaps the knob back.
  const knobEcho = { transpose: null, volume: null, rate: null };
  const knobEchoAt = { transpose: 0, volume: 0, rate: 0 };
  function setEcho(which, v) { knobEcho[which] = v; knobEchoAt[which] = Date.now(); }
  function reconcileEcho(which, reported) {
    if (knobEcho[which] == null) return;
    const near = reported != null && Math.abs(Number(reported) - knobEcho[which]) < 1e-6;
    if (near || Date.now() - knobEchoAt[which] > 1500) knobEcho[which] = null;
  }

  const renderTransport = coalesce(() => renderTransportNow());
  function renderTransportNow() {
    const s = lastState || { owner: null, status: 'idle', position: 0, duration: 0, rate: 1, label: '', caps: {}, dirty: false };
    const caps = s.caps || {};
    const owner = s.owner || '';
    const live = s.status === 'playing' || s.status === 'counting';
    xport.dataset.owner = owner;
    xport.classList.toggle('is-live', live);

    $('xp-name').textContent = s.label || (owner ? 'Nothing loaded' : 'Nothing loaded');
    $('xp-name').title = s.label || '';
    const sub = caps.sub || (owner ? OWNER_LABEL[owner] : 'No transport owner');
    $('xp-sub').textContent = sub;
    $('xp-sub').title = sub;

    // status pill: a word and a dot, never colour alone
    const pill = $('xp-status'), stxt = $('xp-status-txt');
    const map = {
      idle: ['', 'Idle', 'dot'],
      playing: [' is-ok', 'Playing', 'dot is-live'],
      counting: [' is-ok', 'Count in', 'dot is-live'],
      paused: [' is-warn', 'Paused', 'dot is-paused'],
      blocked: [' is-blocked', caps.blockedWhy || 'Blocked', 'dot is-blocked']
    };
    const m = map[s.status] || map.idle;
    pill.className = 'pill xp-status' + m[0];
    pill.firstElementChild.className = m[2];
    stxt.textContent = m[1];

    // play / pause: one button, the glyph cross-fades. The DOM never changes.
    const play = $('xp-play');
    play.dataset.mode = live ? 'pause' : 'play';
    play.setAttribute('aria-label', live ? 'Pause' : 'Play');
    play.disabled = !owner || s.status === 'blocked';
    $('xp-stop').disabled = !owner || s.status === 'idle';
    $('xp-prev').disabled = !owner || !caps.queue;
    $('xp-next').disabled = !owner || !caps.queue;

    const shuffle = $('xp-shuffle');
    const hasShuffle = owner && 'shuffle' in caps;
    shuffle.disabled = !hasShuffle;
    shuffle.setAttribute('aria-pressed', hasShuffle && caps.shuffle ? 'true' : 'false');

    const repeat = $('xp-repeat');
    const rep = owner && 'repeat' in caps ? String(caps.repeat || 'off') : null;
    repeat.disabled = rep === null;
    repeat.dataset.repeat = rep || 'off';
    repeat.setAttribute('aria-pressed', rep && rep !== 'off' ? 'true' : 'false');
    repeat.setAttribute('aria-label', rep === 'one' ? 'Repeat one' : rep === 'all' ? 'Repeat all' : 'Repeat off');

    // time + scrub
    const dur = s.duration > 0 ? s.duration : null;
    $('xp-total').textContent = fmtClock(dur);
    const pos = scrubbing ? scrubValue : s.position;
    $('xp-elapsed').textContent = fmtClock(owner ? pos : null);
    const scrub = $('xp-scrub');
    scrub.disabled = !owner || !caps.seek || !dur;
    if (!scrubbing) {
      const v = dur ? clamp(Math.round(pos / dur * 1000), 0, 1000) : 0;
      if (scrub.value !== String(v)) scrub.value = String(v);
      setRange(scrub, v / 1000);
    }
    scrub.setAttribute('aria-valuetext', fmtClock(owner ? pos : null) + ' of ' + fmtClock(dur));

    // tempo / transpose / volume: the owner advertises them in caps, and a
    // write goes out as a command to the owning frame.
    reconcileEcho('rate', s.rate);
    reconcileEcho('transpose', 'transpose' in caps ? caps.transpose : null);
    reconcileEcho('volume', 'volume' in caps ? caps.volume : null);
    knob('tempo', owner && caps.rate ? (knobEcho.rate != null ? knobEcho.rate : s.rate || 1) : null);
    knob('transpose', owner && 'transpose' in caps ? (knobEcho.transpose != null ? knobEcho.transpose : Number(caps.transpose) || 0) : null);
    knob('volume', owner && 'volume' in caps ? (knobEcho.volume != null ? knobEcho.volume : Number(caps.volume)) : null);

    activity.playback = owner ? s : null;
    // Only the Editor's own transport report may change the Editor's dirty
    // marker; the Player owning the transport says nothing about unsaved notes.
    if (owner === 'editor') {
      activity.editor = s.dirty ? { name: s.label, notes: caps.notes || 0, dirty: true } : null;
    }
    renderStrip();
  }

  function setRange(el, p) {
    const v = clamp(p, 0, 1).toFixed(4);
    if (el.dataset.p !== v) { el.dataset.p = v; el.style.setProperty('--p', v); }
  }
  // Tempo and Transpose are steppers now, so the value IS the control's own
  // text and there is no separate readout to write. `:focus` rather than
  // `:active`: a number input is being typed into while it holds focus, and an
  // echoed state must not overwrite half-typed digits.
  function knob(which, value) {
    const wrap = $('xp-knob-' + which);
    const input = $('xp-' + which);
    const off = value == null || Number.isNaN(value);
    wrap.classList.toggle('is-off', off);
    input.disabled = off;
    for (const b of wrap.querySelectorAll('.stepper-btn')) b.disabled = off;
    if (off) return;
    if (which === 'tempo') {
      const pct = clamp(Math.round(value * 100), 25, 300);
      if (!input.matches(':focus')) input.value = (pct / 100).toFixed(2);
    } else if (which === 'transpose') {
      const n = clamp(Math.round(value), -24, 24);
      if (!input.matches(':focus')) input.value = String(n);
    } else {
      const n = clamp(Math.round(value * 100), 0, 100);
      if (!input.matches(':active')) input.value = String(n);
      setRange(input, n / 100);
      $('xp-volume-val').textContent = String(n);
      input.setAttribute('aria-valuetext', n + ' percent');
    }
  }

  // The -/+ buttons of the two transport steppers. One delegated handler: the
  // input's own step arithmetic does the clamping, and the synthetic events are
  // the same ones typing fires, so there is exactly one code path per value.
  $('xp-knobs').addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('.stepper-btn');
    if (!b || b.disabled) return;
    const input = $(b.dataset.for);
    if (!input || input.disabled) return;
    const step = Number(b.dataset.step) || 0;
    const min = Number(input.min), max = Number(input.max);
    const dec = input.step && Number(input.step) < 1 ? 2 : 0;
    const next = clamp(Number(input.value) + step, min, max);
    input.value = next.toFixed(dec);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });

  // Ask the owning frame to change something the transport protocol does not
  // carry. Commands.run dispatches to whichever frame published the id.
  function ownerCommand(suffix, arg) {
    const owner = lastState && lastState.owner;
    if (!owner || !window.Commands) return false;
    const id = owner + '.' + suffix;
    if (!window.Commands.get(id)) { toast({ severity: 'warn', title: 'Not available here', message: `${OWNER_LABEL[owner]} does not offer ${suffix}.`, key: 'nocmd:' + id }); return false; }
    window.Commands.run(id, arg);
    return true;
  }
  function runCommand(id, tab, fallback) {
    if (window.Commands && window.Commands.get(id)) { window.Commands.run(id); return true; }
    if (tab) activate(tab);
    if (typeof fallback === 'function') fallback();
    return false;
  }

  $('xp-play').addEventListener('click', () => window.Transport && window.Transport.toggle());
  $('xp-stop').addEventListener('click', () => window.Transport && window.Transport.stop());
  $('xp-next').addEventListener('click', () => window.Transport && window.Transport.next());
  $('xp-prev').addEventListener('click', () => window.Transport && window.Transport.prev());
  $('xp-shuffle').addEventListener('click', (e) => {
    const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
    e.currentTarget.setAttribute('aria-pressed', on ? 'true' : 'false');
    ownerCommand('shuffle', on);
  });
  $('xp-repeat').addEventListener('click', (e) => {
    const cur = e.currentTarget.dataset.repeat || 'off';
    const next = cur === 'off' ? 'all' : cur === 'all' ? 'one' : 'off';
    e.currentTarget.dataset.repeat = next;
    e.currentTarget.setAttribute('aria-pressed', next === 'off' ? 'false' : 'true');
    ownerCommand('repeat', next);
  });

  {
    const scrub = $('xp-scrub');
    const seek = coalesce((secs) => window.Transport && window.Transport.seek(secs));
    // A gesture that never moved must not seek. Grabbing the thumb and letting
    // go fires pointerdown then pointerup with no 'input' in between, and the
    // old code seeked to the module-level scrubValue anyway: 0 on the first
    // gesture (a full rewind of live playback) and the previous drag's value
    // afterwards. So: seed from the current position, and only commit on a real
    // move.
    let scrubMoved = false;
    const start = () => {
      scrubbing = true;
      scrubMoved = false;
      scrubValue = (lastState && lastState.position) || 0;
    };
    const move = () => {
      const dur = (lastState && lastState.duration) || 0;
      if (!dur) return;
      scrubMoved = true;
      scrubValue = Number(scrub.value) / 1000 * dur;
      setRange(scrub, Number(scrub.value) / 1000);
      $('xp-elapsed').textContent = fmtClock(scrubValue);
      seek(scrubValue);
    };
    const end = () => {
      if (scrubbing) {
        scrubbing = false;
        if (scrubMoved && window.Transport) window.Transport.seek(scrubValue);
        scrubMoved = false;
      }
      renderTransport();
    };
    scrub.addEventListener('pointerdown', start);
    scrub.addEventListener('keydown', start);
    scrub.addEventListener('input', move);
    scrub.addEventListener('change', end);
    scrub.addEventListener('pointerup', end);
    scrub.addEventListener('blur', end);
  }
  {
    const tempo = $('xp-tempo');
    const push = debounce((v) => { setEcho('rate', v); if (window.Transport) window.Transport.rate(v); }, 120);
    tempo.addEventListener('input', () => {
      const pct = clamp(Math.round(Number(tempo.value) * 100), 25, 300);
      push(pct / 100);
    });
    // flush() invokes, so the pending value goes out here. An arrow-key press
    // fires input then change with nothing in between, so this is also the only
    // path for a keyboard adjustment.
    tempo.addEventListener('change', () => {
      if (push.pending()) { push.flush(); return; }
      const v = clamp(Math.round(Number(tempo.value) * 100), 25, 300) / 100;
      setEcho('rate', v);
      if (window.Transport) window.Transport.rate(v);
    });
  }
  {
    // Nothing on 'input': a stepper writes its own text, and a half-typed
    // value must not be sent. 'change' clamps what was typed and sends it once.
    const tr = $('xp-transpose');
    tr.addEventListener('change', () => {
      const n = clamp(Math.round(Number(tr.value)), -24, 24);
      if (String(n) !== tr.value) tr.value = String(n);
      setEcho('transpose', n);
      ownerCommand('transpose', n);
    });
  }
  {
    const vol = $('xp-volume');
    const push = debounce((v) => { setEcho('volume', v); ownerCommand('volume', v); }, 140);
    vol.addEventListener('input', () => {
      const n = clamp(Math.round(Number(vol.value)), 0, 100);
      setRange(vol, n / 100);
      $('xp-volume-val').textContent = String(n);
      push(n / 100);
    });
    // The debounce is the only send path for the volume knob, so 'change' must
    // FLUSH it (invoke), never cancel it: 'change' lands a few ms after the last
    // 'input' in the same gesture, well inside the 140ms window.
    vol.addEventListener('change', () => {
      if (push.pending()) { push.flush(); return; }
      const n = clamp(Math.round(Number(vol.value)), 0, 100) / 100;
      setEcho('volume', n);
      ownerCommand('volume', n);
    });
  }

  // Perch, driven by the real overlay state, never by an optimistic toggle.
  let overlayCfg = { open: false };
  function renderPerch() {
    const b = $('xp-perch');
    b.setAttribute('aria-pressed', overlayCfg.open ? 'true' : 'false');
    b.classList.toggle('is-active', !!overlayCfg.open);
    b.dataset.tip = overlayCfg.open
      ? 'Perch is open. Ctrl+Alt+O closes it, Ctrl+Alt+P toggles click-through.'
      : 'Perch: the always-on-top playback overlay (Ctrl+Alt+O)';
    renderOverlayPane();
  }
  $('xp-perch').addEventListener('click', () => { if (studio.toggleOverlay) studio.toggleOverlay().catch(() => {}); });

  // ==========================================================================
  // 11. COMMAND PALETTE
  // ==========================================================================
  const palScrim = $('pal-scrim'), palInput = $('pal-input'), palList = $('pal-list');
  let palRows = [], palCursor = 0, palOpen = false, palReturn = null;

  // The song index behind "search songs" and the recent list.
  let libIndex = { files: [], truncated: false, dirs: [] };
  let libIndexAt = 0;
  function refreshLibraryIndex() {
    if (!libApi.list) return Promise.resolve(libIndex);
    return libApi.list().then((r) => {
      libIndex = { files: (r && r.files) || [], truncated: !!(r && r.truncated), dirs: (r && r.dirs) || [] };
      libIndexAt = Date.now();
      renderLibraryPane();
      if (palOpen) renderPalette();
      return libIndex;
    }).catch(() => libIndex);
  }

  function openPalette(prefill) {
    if (palOpen) { palInput.focus(); palInput.select(); return; }
    palOpen = true;
    palReturn = document.activeElement;
    palScrim.hidden = false;
    syncCovered();
    raf(() => palScrim.classList.add('is-open'));
    palInput.value = prefill || '';
    palCursor = 0;
    renderPalette();
    palInput.focus();
    if (!libIndexAt || Date.now() - libIndexAt > 30000) refreshLibraryIndex();
  }
  function closePalette() {
    if (!palOpen) return;
    palOpen = false;
    palScrim.classList.remove('is-open');
    setTimeout(() => { if (!palOpen) { palScrim.hidden = true; syncCovered(); } }, 140);
    syncCovered();
    if (palReturn && palReturn.focus) { try { palReturn.focus(); } catch (_) {} }
    palReturn = null;
  }

  function paletteItems(q) {
    const out = [];
    const query = String(q || '').trim();
    const cmds = window.Commands ? window.Commands.search(query, { scope: activeKey, limit: 40 }) : [];
    let group = null;
    for (const c of cmds) {
      const g = c.group || 'Commands';
      if (g !== group) { group = g; out.push({ kind: 'label', text: g }); }
      out.push({ kind: 'cmd', cmd: c, label: c.label, sub: '', keys: c.keys, enabled: window.Commands.isEnabled(c), danger: c.danger });
    }
    // Songs. With no query these are the ten most recent, which is what
    // "open recent MIDI" means when the only record we keep is the file system.
    const files = libIndex.files;
    let hits;
    if (!query) hits = files.slice(0, 10);
    else {
      const terms = query.toLowerCase().split(/\s+/);
      hits = [];
      for (let i = 0; i < files.length && hits.length < 40; i++) {
        const hay = (files[i].name + ' ' + files[i].dir).toLowerCase();
        let ok = true;
        for (const t of terms) if (hay.indexOf(t) < 0) { ok = false; break; }
        if (ok) hits.push(files[i]);
      }
    }
    if (hits.length) {
      out.push({ kind: 'label', text: query ? 'Songs' : 'Recent songs' });
      for (const f of hits) {
        out.push({
          kind: 'file', file: f, enabled: true,
          label: f.name,
          sub: (window.Fmt ? window.Fmt.when(f.modified) : '') + ' · ' + (window.Fmt ? window.Fmt.shortPath(f.dir, 34) : f.dir)
        });
      }
    }
    return out;
  }

  function renderPalette() {
    const items = paletteItems(palInput.value);
    palRows = items.filter((i) => i.kind !== 'label');
    palList.textContent = '';
    if (!items.length) {
      $('pal-empty').hidden = false;
      palList.hidden = true;
      renderPalCount();
      return;
    }
    $('pal-empty').hidden = true;
    palList.hidden = false;
    let idx = -1;
    const frag = document.createDocumentFragment();
    for (const it of items) {
      if (it.kind === 'label') {
        const l = document.createElement('div');
        l.className = 'menu-label';
        l.textContent = it.text;
        frag.appendChild(l);
        continue;
      }
      idx += 1;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'menu-item' + (it.danger ? ' is-danger' : '');
      b.setAttribute('role', 'option');
      b.id = 'pal-row-' + idx;
      b.dataset.row = String(idx);
      b.disabled = !it.enabled;
      const t = document.createElement('span');
      t.className = 'menu-text';
      t.textContent = it.label;
      b.appendChild(t);
      // A SIBLING of the label, never a child of it: .menu-text truncates with
      // an ellipsis, so a sub nested inside it was simply clipped away on any
      // row with a long song name. The title carries both parts, because a row
      // that truncates has to leave some way of reading the whole thing.
      if (it.sub) {
        const s = document.createElement('span');
        s.className = 'pal-row-sub';
        s.textContent = it.sub;
        b.appendChild(s);
      }
      b.title = it.sub ? it.label + '\n' + it.sub : it.label;
      if (it.keys) {
        const k = document.createElement('span');
        k.className = 'menu-key';
        k.textContent = it.keys;
        b.appendChild(k);
      }
      frag.appendChild(b);
    }
    palList.appendChild(frag);
    palCursor = clamp(palCursor, 0, Math.max(0, palRows.length - 1));
    if (!palRows.length) palInput.removeAttribute('aria-activedescendant');
    paintCursor();
    renderPalCount();
  }
  function paintCursor() {
    const rows = palList.querySelectorAll('.menu-item');
    for (let i = 0; i < rows.length; i++) {
      const on = i === palCursor;
      rows[i].classList.toggle('is-cursor', on);
      rows[i].setAttribute('aria-selected', on ? 'true' : 'false');
      if (on) {
        palInput.setAttribute('aria-activedescendant', rows[i].id);
        const r = rows[i], host = palList;
        if (r.offsetTop < host.scrollTop) host.scrollTop = r.offsetTop;
        else if (r.offsetTop + r.offsetHeight > host.scrollTop + host.clientHeight) host.scrollTop = r.offsetTop + r.offsetHeight - host.clientHeight;
      }
    }
  }
  function renderPalCount() {
    const el = $('pal-count');
    if (!el) return;
    el.textContent = palRows.length ? `${palRows.length} in ${byKey[activeKey].label}` : '';
  }
  function runPaletteRow(i) {
    const it = palRows[i];
    if (!it || !it.enabled) return;
    closePalette();
    if (it.kind === 'cmd') window.Commands.run(it.cmd.id);
    else if (it.kind === 'file') handoff('player', { midiPath: it.file.path, play: handoffPlay === 'play' }, { from: 'palette' });
  }
  const palSearch = debounce(() => { palCursor = 0; renderPalette(); }, 90);
  palInput.addEventListener('input', palSearch);
  palInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { palCursor = Math.min(palCursor + 1, palRows.length - 1); paintCursor(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { palCursor = Math.max(palCursor - 1, 0); paintCursor(); e.preventDefault(); }
    else if (e.key === 'PageDown') { palCursor = Math.min(palCursor + 8, palRows.length - 1); paintCursor(); e.preventDefault(); }
    else if (e.key === 'PageUp') { palCursor = Math.max(palCursor - 8, 0); paintCursor(); e.preventDefault(); }
    else if (e.key === 'Home') { palCursor = 0; paintCursor(); e.preventDefault(); }
    else if (e.key === 'End') { palCursor = palRows.length - 1; paintCursor(); e.preventDefault(); }
    else if (e.key === 'Enter') { palSearch.flush(); runPaletteRow(palCursor); e.preventDefault(); }
  });
  palList.addEventListener('click', (e) => {
    const b = e.target.closest('.menu-item');
    if (b) runPaletteRow(Number(b.dataset.row));
  });
  palList.addEventListener('pointermove', (e) => {
    const b = e.target.closest('.menu-item');
    if (b && Number(b.dataset.row) !== palCursor) { palCursor = Number(b.dataset.row); paintCursor(); }
  });
  palScrim.addEventListener('mousedown', (e) => { if (e.target === palScrim) closePalette(); });

  $('search-trigger').addEventListener('click', () => openPalette(''));
  $('search-trigger').addEventListener('keydown', (e) => {
    if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) { openPalette(e.key); e.preventDefault(); }
  });

  // ==========================================================================
  // 12. SETTINGS SHEET
  // ==========================================================================
  const setScrim = $('set-scrim');
  let setOpen = false, setReturn = null;

  function openSettings(pane) {
    if (pane) showPane(pane);
    if (setOpen) return;
    setOpen = true;
    setReturn = document.activeElement;
    setScrim.hidden = false;
    syncCovered();
    raf(() => setScrim.classList.add('is-open'));
    refreshSettings();
    const first = $('set-nav').querySelector('button[aria-selected="true"]') || $('set-nav').firstElementChild;
    if (first) first.focus();
  }
  function closeSettings() {
    if (!setOpen) return;
    setOpen = false;
    setScrim.classList.remove('is-open');
    setTimeout(() => { if (!setOpen) { setScrim.hidden = true; syncCovered(); } }, 140);
    syncCovered();
    flushUiSoon.cancel(); flushUi();
    if (setReturn && setReturn.focus) { try { setReturn.focus(); } catch (_) {} }
    setReturn = null;
  }
  function showPane(name) {
    const nav = $('set-nav');
    let found = false;
    for (const b of nav.querySelectorAll('button')) {
      const on = b.dataset.pane === name;
      if (on) found = true;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    }
    if (!found) return;
    for (const p of $('set-panes').querySelectorAll('.set-pane')) p.hidden = p.dataset.pane !== name;
    $('set-panes').scrollTop = 0;
  }
  $('set-nav').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-pane]');
    if (b) showPane(b.dataset.pane);
  });
  $('set-nav').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const btns = [...$('set-nav').querySelectorAll('button')];
    const cur = btns.findIndex((b) => b.getAttribute('aria-selected') === 'true');
    const next = (cur + (e.key === 'ArrowDown' ? 1 : btns.length - 1) + btns.length) % btns.length;
    showPane(btns[next].dataset.pane);
    btns[next].focus();
    e.preventDefault();
  });
  $('settings-btn').addEventListener('click', () => openSettings());
  $('set-close').addEventListener('click', closeSettings);
  setScrim.addEventListener('mousedown', (e) => { if (e.target === setScrim) closeSettings(); });
  $('s-goto-forge').addEventListener('click', () => showPane('forge'));

  // ---- a small helper for the switch rows ---------------------------------
  function wireSwitch(id, onChange) {
    const el = $(id);
    if (!el) return;
    el.addEventListener('click', () => {
      const on = el.getAttribute('aria-checked') !== 'true';
      el.setAttribute('aria-checked', on ? 'true' : 'false');
      onChange(on);
    });
  }
  const setSwitch = (id, on) => { const el = $(id); if (el) el.setAttribute('aria-checked', on ? 'true' : 'false'); };
  function wireRadios(id, onPick) {
    const host = $(id);
    if (!host) return;
    host.addEventListener('click', (e) => {
      const b = e.target.closest('button[role=radio]');
      if (!b) return;
      markRadios(id, b);
      onPick(b);
    });
    host.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const btns = [...host.querySelectorAll('button[role=radio]')];
      const cur = btns.findIndex((b) => b.getAttribute('aria-checked') === 'true');
      const next = btns[(cur + (e.key === 'ArrowRight' ? 1 : btns.length - 1) + btns.length) % btns.length];
      markRadios(id, next); next.focus(); onPick(next); e.preventDefault();
    });
  }
  function markRadios(id, pick) {
    for (const b of $(id).querySelectorAll('button[role=radio]')) {
      const on = b === pick;
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    }
  }

  // ---- Appearance ---------------------------------------------------------
  wireRadios('s-theme', (b) => {
    setTheme(b.dataset.theme || '');
    saveUi({ theme: b.dataset.theme || '', accent: '' });
    renderPalSwatch();
  });
  const paintAccent = coalesce((hex) => { setAccent(hex); $('s-accent-hex').textContent = hex; });
  $('s-accent').addEventListener('input', (e) => paintAccent(e.target.value));
  $('s-accent').addEventListener('change', (e) => { paintAccent(e.target.value); saveUi({ accent: e.target.value }); });
  $('s-accent-clear').addEventListener('click', () => {
    setAccent('');
    saveUi({ accent: '' });
    renderPalSwatch();
  });
  function renderPalSwatch() {
    const hex = accentVars ? accentVars['--accent']
      : (window.Tokens ? window.Tokens.get('accent', '#b8e62e') : '#b8e62e');
    const input = $('s-accent');
    if (input && /^#[0-9a-f]{6}$/i.test(hex)) input.value = hex.toLowerCase();
    const label = $('s-accent-hex');
    if (label) label.textContent = hex;
    for (const b of $('s-theme').querySelectorAll('button[role=radio]')) {
      const on = (b.dataset.theme || '') === themePreset && !accentVars;
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    }
  }
  wireRadios('s-density', (b) => setDensity(b.dataset.density));
  wireSwitch('s-ontop', (on) => saveUi({ alwaysOnTop: on }));

  // ---- Playback -----------------------------------------------------------
  let handoffPlay = 'load';
  $('s-handoff').addEventListener('change', (e) => { handoffPlay = e.target.value === 'play' ? 'play' : 'load'; saveUi({ handoffPlay }); });
  let spaceTransport = true;
  wireSwitch('s-space', (on) => { spaceTransport = on; saveUi({ spaceTransport: on }); });
  wireSwitch('s-xpms', (on) => { xportMs = on; saveUi({ transportMs: on }); renderTransport(); });
  let autoQueueForged = false;
  wireSwitch('s-autoqueue', (on) => { autoQueueForged = on; saveUi({ autoQueueForged: on }); });

  // ---- Performance --------------------------------------------------------
  function showPerf(p) {
    if (!p) return;
    perf = p;
    const pc = $('s-perf-percent');
    pc.value = String(p.percent);
    setRange(pc, (p.percent - 10) / 90);
    $('s-perf-value').textContent = p.percent + '%';
    $('s-perf-threads').value = String(p.threads);
    $('s-perf-batch').value = String(p.batch);
    $('s-perf-gaming').value = p.whenGaming || 'limit';
    const fps = Math.max(1, Math.round(1000 / p.drawMs));
    const custom = p.custom && (p.custom.threads || p.custom.batch) ? ' · set by hand' : '';
    $('s-perf-explain').textContent =
      `${p.threads} of ${p.cores} CPU cores · GPU batch ${p.batch} · ${fps} fps visuals`
      + (p.lowPriority ? ' · low priority' : '') + custom;
    applyPerf();
    renderGame();
  }
  const savePerf = (patch) => (studio.setPerformance ? studio.setPerformance(patch).then(showPerf).catch(() => {}) : Promise.resolve());
  {
    const pc = $('s-perf-percent');
    const paint = coalesce(() => { $('s-perf-value').textContent = pc.value + '%'; setRange(pc, (Number(pc.value) - 10) / 90); });
    pc.addEventListener('input', paint);
    pc.addEventListener('change', () => savePerf({ percent: Number(pc.value) }));
  }
  $('s-perf-gaming').addEventListener('change', (e) => savePerf({ whenGaming: e.target.value }));
  $('s-perf-toggle').addEventListener('click', () => {
    const row = $('s-perf-advanced');
    row.hidden = !row.hidden;
    $('s-perf-toggle').setAttribute('aria-expanded', row.hidden ? 'false' : 'true');
    $('s-perf-toggle').textContent = row.hidden ? 'Set exact numbers…' : 'Hide exact numbers';
  });
  // "Back to automatic" re-sends the percent, which is what makes main write
  // explicit nulls over the hand-set values.
  $('s-perf-auto').addEventListener('click', () => savePerf({ percent: perf.percent }));
  const pushAdvanced = () => savePerf({ advanced: { threads: Number($('s-perf-threads').value), batch: Number($('s-perf-batch').value) } });
  for (const id of ['s-perf-threads', 's-perf-batch']) $(id).addEventListener('change', pushAdvanced);
  $('s-perf-advanced').addEventListener('click', (e) => {
    const b = e.target.closest('.stepper-btn');
    if (!b) return;
    const input = b.parentElement.querySelector('input');
    const step = Number(b.dataset.step);
    input.value = String(clamp(Number(input.value || 0) + step, Number(input.min), Number(input.max)));
    pushAdvanced();
  });

  // ---- Forge engine -------------------------------------------------------
  function setPathChip(id, full, missingWhenEmpty) {
    const chip = $(id);
    if (!chip) return;
    const dir = chip.querySelector('.pathchip-dir'), name = chip.querySelector('.pathchip-name');
    if (!full) {
      dir.textContent = '';
      name.textContent = missingWhenEmpty || 'not set';
      chip.classList.add('is-missing');
      chip.removeAttribute('title');
      return;
    }
    chip.classList.remove('is-missing');
    const base = window.Fmt ? window.Fmt.basename(full) : String(full).split(/[\\/]/).pop();
    dir.textContent = String(full).slice(0, String(full).length - base.length);
    name.textContent = base;
    chip.title = full;
  }
  function showForgeInfo(info) {
    if (!info) return;
    activity.engine.dir = info.forgeEnvDir || '';
    activity.engine.custom = !!info.forgeCustom;
    activity.engine.freeGb = info.forgeFreeGb;
    activity.engine.needGb = info.forgeNeedGb;
    activity.engine.known = true;
    // forgeInfo only knows whether the marker and torch folder exist; a probe
    // is what knows about the GPU, so never let this clear a known GPU verdict.
    activity.engine.ready = !!info.forgeReady;
    if (!info.forgeReady) activity.engine.gpu = null;
    applyVersion(info.version);
    setPathChip('s-forgedir', info.forgeEnvDir, 'not set');
    $('s-forgedir-mirror').textContent = info.forgeEnvDir || '—';
    $('s-forgedir-mirror').title = info.forgeEnvDir || '';
    $('s-forgefree').textContent = info.forgeFreeGb != null
      ? `${info.forgeFreeGb} GB free · setup needs about ${info.forgeNeedGb} GB`
      : '';
    $('s-resetforge').hidden = !info.forgeCustom;
    renderEngine();
    writeEngineCache();
  }
  function adoptEnvProbe(p) {
    activity.engine.known = true;
    activity.engine.ready = !!(p.forgeReady !== undefined ? p.forgeReady : p.ready);
    activity.engine.gpu = p.gpu || null;
    activity.engine.missing = Array.isArray(p.missing) ? p.missing : [];
    renderEngine();
    writeEngineCache();
  }
  const refreshForgeInfo = () => (studio.forgeInfo ? studio.forgeInfo().then(showForgeInfo).catch(() => {}) : Promise.resolve());

  $('s-forge-recheck').addEventListener('click', async () => {
    const b = $('s-forge-recheck');
    b.classList.add('is-busy'); b.disabled = true;
    try {
      await refreshForgeInfo();
      if (forgeApi.check) adoptEnvProbe(await forgeApi.check());
    } catch (_) { /* the chip stays on the last known verdict */ }
    finally { b.classList.remove('is-busy'); b.disabled = false; }
  });
  $('s-forge-setup').addEventListener('click', () => {
    closeSettings();
    activate('forge');
    runCommand('forge.setup', 'forge', () => toast({ severity: 'info', title: 'Setup lives in the Forge tab', message: 'Use the banner at the top of Forge to start it.' }));
  });
  $('s-openforge').addEventListener('click', () => studio.openForgeFolder && studio.openForgeFolder());
  async function relocateForge(method, button) {
    if (!studio[method]) return;
    const both = [$('s-changeforge'), $('s-resetforge')];
    both.forEach((b) => { b.disabled = true; });
    const was = button.textContent;
    button.textContent = 'Moving…';
    try {
      const r = await studio[method]();
      if (r && r.ok) {
        showForgeInfo(r);
        toast({ severity: 'ok', title: r.moved ? 'Forge storage moved' : 'Forge storage location updated' });
        // The Forge panel's own env banner has to be told, or it keeps showing
        // the old verdict for the old folder.
        const f = byKey.forge;
        try { if (f.loaded && typeof f.frame.contentWindow.refreshForgeEnvironment === 'function') f.frame.contentWindow.refreshForgeEnvironment(); } catch (_) {}
        runCommand('forge.recheck');
      } else if (r && !r.canceled) toast({ severity: 'err', title: 'Could not change Forge storage', message: r.error || '' });
    } catch (e) {
      toast({ severity: 'err', title: 'Could not change Forge storage', message: e.message || String(e) });
    } finally {
      button.textContent = was;
      both.forEach((b) => { b.disabled = false; });
      $('s-resetforge').hidden = !activity.engine.custom;
    }
  }
  $('s-changeforge').addEventListener('click', () => relocateForge('changeForgeFolder', $('s-changeforge')));
  $('s-resetforge').addEventListener('click', () => relocateForge('resetForgeFolder', $('s-resetforge')));
  $('s-setuplog').addEventListener('click', async () => {
    const r = studio.openSetupLog ? await studio.openSetupLog() : null;
    if (r && !r.ok) toast({ severity: 'warn', title: 'No setup log yet', message: 'One is written the first time setup runs.' });
  });
  $('s-bootlog').addEventListener('click', async () => {
    const r = studio.openBootLog ? await studio.openBootLog() : null;
    if (r && !r.ok) toast({ severity: 'warn', title: 'No boot log', message: (r && r.error) || 'Nothing has been written yet.' });
  });
  $('s-clean').addEventListener('click', async () => {
    if (!window.confirm('Clean reinstall? This deletes MIDI Studio\'s managed Forge environment so it re-downloads next time. (It never touches a separate Midi-Forge install.)')) return;
    const r = studio.cleanReinstall ? await studio.cleanReinstall() : null;
    if (r && r.ok) {
      toast({ severity: 'ok', title: 'Forge storage cleared', message: 'Setup will download it again next time.' });
      logPush('Forge environment deleted: ' + r.dir, 'warn', 'forge');
      const f = byKey.forge;
      try { if (f.loaded && typeof f.frame.contentWindow.refreshForgeEnvironment === 'function') f.frame.contentWindow.refreshForgeEnvironment(); } catch (_) {}
    } else {
      toast({ severity: 'err', title: 'Nothing was cleaned', message: (r && r.error) || '' });
    }
    activity.engine.gpu = null;
    refreshForgeInfo();
  });

  // ---- Storage ------------------------------------------------------------
  let outputDir = '';
  function renderLibraryPane() {
    const host = $('s-libdirs');
    if (!host) return;
    // main returns [outputDir, Documents/MIDI Studio, ...the ones the user
    // added]. The first two are built in: library:removeFolder only filters the
    // user list, so offering a remove button for them would do nothing at all.
    const dirs = libIndex.dirs || [];
    const BUILTIN = 2;
    host.textContent = '';
    if (!dirs.length) {
      const empty = document.createElement('div');
      empty.className = 'set-note';
      empty.textContent = 'Only the output folder is scanned.';
      host.appendChild(empty);
    }
    dirs.forEach((dir, i) => {
      const row = document.createElement('div');
      row.className = 'set-list-row';
      const chip = document.createElement('span');
      chip.className = 'pathchip';
      chip.title = dir;
      const base = window.Fmt ? window.Fmt.basename(dir) : dir.split(/[\\/]/).pop();
      chip.innerHTML = '<span class="pathchip-dir"></span><span class="pathchip-name"></span>';
      chip.children[0].textContent = dir.slice(0, dir.length - base.length);
      chip.children[1].textContent = base;
      row.appendChild(chip);
      const open = document.createElement('button');
      open.className = 'btn btn-icon is-sm is-bare';
      open.setAttribute('aria-label', 'Open ' + base);
      open.innerHTML = '<i data-icon="folder" data-icon-size="13"></i>';
      open.addEventListener('click', () => studio.openPath && studio.openPath(dir));
      row.appendChild(open);
      if (i < BUILTIN) {
        const tag = document.createElement('span');
        tag.className = 'tag is-bare';
        tag.textContent = 'built in';
        row.appendChild(tag);
      } else {
        const rm = document.createElement('button');
        rm.className = 'btn btn-icon is-sm is-bare';
        rm.setAttribute('aria-label', 'Stop scanning ' + base);
        rm.innerHTML = '<i data-icon="close" data-icon-size="12"></i>';
        rm.addEventListener('click', async () => {
          if (!libApi.removeFolder) return;
          await libApi.removeFolder(dir);
          refreshLibraryIndex();
        });
        row.appendChild(rm);
      }
      host.appendChild(row);
    });
    if (window.Icon) window.Icon.apply(host);
    const count = $('s-libcount');
    if (count) {
      count.textContent = libIndex.files.length
        ? `${window.Fmt ? window.Fmt.count(libIndex.files.length, 'MIDI file') : libIndex.files.length + ' files'} found${libIndex.truncated ? ' (list truncated)' : ''}.`
        : 'No MIDI files found yet.';
    }
  }
  $('s-libadd').addEventListener('click', async () => {
    if (!libApi.addFolder) return;
    const r = await libApi.addFolder();
    if (r && r.ok) { await refreshLibraryIndex(); toast({ severity: 'ok', title: 'Folder added', message: r.dir }); }
  });
  $('s-librescan').addEventListener('click', () => refreshLibraryIndex().then(() => toast({ severity: 'ok', title: 'Library rescanned', message: `${libIndex.files.length} files` })));
  $('s-outdir-open').addEventListener('click', () => outputDir && studio.openPath && studio.openPath(outputDir));
  $('s-outdir-change').addEventListener('click', async () => {
    if (!forgeApi.pickOutDir) return;
    const dir = await forgeApi.pickOutDir();
    if (!dir) return;
    if (forgeApi.setSettings) await forgeApi.setSettings({ outputDir: dir });
    outputDir = dir;
    setPathChip('s-outdir', outputDir, '—');
    refreshLibraryIndex();
    toast({ severity: 'ok', title: 'Output folder changed', message: dir });
  });
  $('s-mapdir').addEventListener('click', () => studio.openMappingsDir && studio.openMappingsDir());

  // ---- Updates ------------------------------------------------------------
  wireSwitch('s-autoupdate', (on) => saveUi({ autoCheckUpdates: on }));
  $('s-recheck').addEventListener('click', () => {
    activity.update.dismissed = false;
    if (studio.checkForUpdates) studio.checkForUpdates({ manual: true });
    closeSettings();
  });
  // The chip is the app's version news, so it opens What's New: the notes for
  // the running build, or the notes for an update on offer when the updater has
  // them. Checking for updates has not gone anywhere -- it is the modal's own
  // secondary action, this pane's "Check now", and app.updates in the palette.
  $('version-chip').addEventListener('click', () => {
    activity.update.dismissed = false;
    renderUpdate();
    openWhatsNew();
  });
  $('s-whatsnew').addEventListener('click', () => openWhatsNew());
  $('s-repo').addEventListener('click', () => studio.openExternal && studio.openExternal('https://github.com/StarsationX/midi-studio'));

  // ---- Overlay (Perch) ----------------------------------------------------
  const setOverlay = (patch) => (studio.setOverlay ? studio.setOverlay(patch).then(applyOverlayCfg).catch(() => {}) : Promise.resolve());
  function applyOverlayCfg(cfg) {
    if (!cfg) return;
    overlayCfg = Object.assign({}, overlayCfg, cfg);
    renderPerch();
  }
  function renderOverlayPane() {
    const c = overlayCfg;
    setSwitch('s-ov-open', !!c.open);
    for (const b of $('s-ov-mode').querySelectorAll('button[role=radio]')) {
      const on = b.dataset.mode === (c.mode || 'full');
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    }
    const op = $('s-ov-opacity'), ah = $('s-ov-ahead');
    const opv = clamp(Math.round((c.opacity == null ? 0.92 : c.opacity) * 100), 20, 100);
    if (!op.matches(':active')) op.value = String(opv);
    setRange(op, (opv - 20) / 80);
    $('s-ov-opacity-val').textContent = opv + '%';
    const ahv = clamp(Math.round(c.lookahead == null ? 3 : c.lookahead), 1, 12);
    if (!ah.matches(':active')) ah.value = String(ahv);
    setRange(ah, (ahv - 1) / 11);
    $('s-ov-ahead-val').textContent = ahv + 's';
    setSwitch('s-ov-through', !!c.clickThrough);
    setSwitch('s-ov-locked', !!c.locked);
    setSwitch('s-ov-keys', c.showKeys !== false);
    setSwitch('s-ov-buttons', c.showTransport !== false);
    setSwitch('s-ov-autoshow', c.autoShow !== false);
    setSwitch('s-ov-autohide', c.autoHide !== false);
  }
  wireSwitch('s-ov-open', () => { if (studio.toggleOverlay) studio.toggleOverlay().then(applyOverlayCfg).catch(() => {}); });
  wireRadios('s-ov-mode', (b) => setOverlay({ mode: b.dataset.mode }));
  {
    const op = $('s-ov-opacity');
    const paint = coalesce(() => { const v = Number(op.value); setRange(op, (v - 20) / 80); $('s-ov-opacity-val').textContent = v + '%'; });
    op.addEventListener('input', paint);
    op.addEventListener('change', () => setOverlay({ opacity: Number(op.value) / 100 }));
    const ah = $('s-ov-ahead');
    const paintA = coalesce(() => { const v = Number(ah.value); setRange(ah, (v - 1) / 11); $('s-ov-ahead-val').textContent = v + 's'; });
    ah.addEventListener('input', paintA);
    ah.addEventListener('change', () => setOverlay({ lookahead: Number(ah.value) }));
  }
  wireSwitch('s-ov-through', (on) => setOverlay({ clickThrough: on }));
  wireSwitch('s-ov-locked', (on) => setOverlay({ locked: on }));
  wireSwitch('s-ov-keys', (on) => setOverlay({ showKeys: on }));
  wireSwitch('s-ov-buttons', (on) => setOverlay({ showTransport: on }));
  wireSwitch('s-ov-autoshow', (on) => setOverlay({ autoShow: on }));
  wireSwitch('s-ov-autohide', (on) => setOverlay({ autoHide: on }));
  $('s-ov-park').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-snap]');
    if (!b) return;
    if (!overlayCfg.open) { toast({ severity: 'warn', title: 'Perch is closed', message: 'Open it first, then park it.' }); return; }
    if (studio.snapOverlay) studio.snapOverlay(b.dataset.snap).then(applyOverlayCfg).catch(() => {});
  });

  function refreshSettings() {
    refreshForgeInfo();
    if (studio.getPerformance) studio.getPerformance().then(showPerf).catch(() => {});
    if (studio.overlayState) studio.overlayState().then(applyOverlayCfg).catch(() => {});
    if (forgeApi.getOutputDir) forgeApi.getOutputDir().then((d) => { outputDir = d || ''; setPathChip('s-outdir', outputDir, '—'); }).catch(() => {});
    refreshLibraryIndex();
    renderPalSwatch();
    renderUpdate();
    $('s-about-runtime').textContent = navigator.userAgent.match(/Electron\/([\d.]+)/)
      ? 'Electron ' + navigator.userAgent.match(/Electron\/([\d.]+)/)[1]
      : '—';
  }

  // ==========================================================================
  // 13. WINDOW CONTROLS + DROP VEIL
  // ==========================================================================
  const wnd = studio.window || {};
  $('win-min').addEventListener('click', () => wnd.minimize && wnd.minimize());
  $('win-max').addEventListener('click', () => {
    if (document.body.dataset.maximized === '1') { if (wnd.unmaximize) wnd.unmaximize(); }
    else if (wnd.maximize) wnd.maximize();
  });
  $('win-close').addEventListener('click', () => wnd.close && wnd.close());
  $('titlebar').addEventListener('dblclick', (e) => {
    if (e.target.closest('button, input, .wctl, .tbar-nav')) return;
    if (document.body.dataset.maximized === '1') { if (wnd.unmaximize) wnd.unmaximize(); }
    else if (wnd.maximize) wnd.maximize();
  });
  function applyWindowState(s) {
    if (!s) return;
    const max = s.maximized ? '1' : '0';
    if (document.body.dataset.maximized !== max) document.body.dataset.maximized = max;
    const b = $('win-max');
    b.setAttribute('aria-pressed', s.maximized ? 'true' : 'false');
    b.setAttribute('aria-label', s.maximized ? 'Restore' : 'Maximise');
    moveIndicator();
  }
  if (studio.onPanelFailed) studio.onPanelFailed((p) => { if (p && p.url) markFrameFailed(p.url, p.desc); });
  $('tf-retry').addEventListener('click', () => retryFrame(activeKey));
  $('tf-log').addEventListener('click', () => activate('logs'));
  if (studio.onWindowState) studio.onWindowState(applyWindowState);
  if (wnd.state) wnd.state().then(applyWindowState).catch(() => {});

  let dropDepth = 0;
  const setDrop = (on) => { root.dataset.drop = on ? 'on' : ''; $('drop-veil').setAttribute('aria-hidden', on ? 'false' : 'true'); syncCovered(); };
  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
    dropDepth += 1;
    if (dropDepth === 1) setDrop(true);
    e.preventDefault();
  });
  window.addEventListener('dragover', (e) => { if (dropDepth) e.preventDefault(); });
  window.addEventListener('dragleave', () => { dropDepth = Math.max(0, dropDepth - 1); if (!dropDepth) setDrop(false); });
  window.addEventListener('drop', (e) => {
    dropDepth = 0; setDrop(false);
    if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
    e.preventDefault();
    const resolve = playerApi.getDroppedFilePath || forgeApi.getDroppedFilePath;
    if (!resolve) return;
    const paths = [];
    for (const file of e.dataTransfer.files) { try { const p = resolve(file); if (p) paths.push(p); } catch (_) {} }
    routePaths(paths, 'shell');
  });


  // ==========================================================================
  // 13b. WHAT'S NEW
  //
  // One modal, two sources:
  //   'installed' — CHANGELOG.md, parsed by renderer/shell/changelog.js. Read
  //                 once per session, lazily, and NEVER on the boot path.
  //   'available' — the release notes the updater already fetched with the
  //                 'available' status. No second request is ever made, and
  //                 nothing here waits on the network: with no notes in hand
  //                 the mode simply is not offered.
  //
  // A missing, unreadable or malformed changelog degrades to the .wn-fallback
  // state with a link to the releases page. The parser cannot throw, and this
  // screen cannot end up blank.
  // ==========================================================================
  const wnScrim = $('wn-scrim'), wnDlg = $('wn-dlg'), wnBody = $('wn-body');
  const WN_FOCUS = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
  let wnOpen = false, wnReturn = null;
  let wnDoc = null, wnDocPromise = null;      // the parsed CHANGELOG.md
  let wnMode = 'installed';
  let wnReleasesUrl = 'https://github.com/StarsationX/midi-studio/releases';

  function loadChangelog() {
    if (wnDocPromise) return wnDocPromise;
    const fail = (error) => { wnDoc = { ok: false, error: error, releases: [] }; return wnDoc; };
    wnDocPromise = (studio.changelog ? studio.changelog() : Promise.resolve(null))
      .then((r) => {
        if (!r) return fail('unavailable');
        if (!r.ok) return fail(r.error || 'unavailable');
        if (!window.Changelog) return fail('no parser');
        const parsed = window.Changelog.parse(r.text);
        if (!parsed.ok) logPush('CHANGELOG.md could not be read (' + parsed.error + ').', 'warn', 'app');
        wnDoc = parsed;
        return wnDoc;
      })
      .catch((e) => fail(String((e && e.message) || e)));
    return wnDocPromise;
  }

  // The notes for an update on OFFER, straight out of the status we already have.
  function wnAvailable() {
    const u = activity.update;
    if (u.state !== 'available' || !u.version) return null;
    const parsed = window.Changelog ? window.Changelog.parseNotes(u.notes || '', { version: u.version }) : null;
    const release = parsed && parsed.ok && (window.Changelog.count(parsed.release) + parsed.release.intro.length)
      ? parsed.release : null;
    return { version: u.version, htmlUrl: u.htmlUrl || '', staged: !!u.staged, canSelf: u.canSelfUpdate !== false, release };
  }
  function wnInstalled() {
    if (!wnDoc || !wnDoc.ok || !window.Changelog) return null;
    return window.Changelog.find(wnDoc.releases, appVersion) || wnDoc.releases[0] || null;
  }

  function wnRenderSections(release) {
    const host = $('wn-secs');
    host.textContent = '';
    const frag = document.createDocumentFragment();
    for (const para of (release.intro || [])) {
      const p = document.createElement('p');
      p.className = 'wn-intro';
      p.textContent = para;
      frag.appendChild(p);
    }
    for (const sec of (release.sections || [])) {
      const s = document.createElement('section');
      s.className = 'wn-sec';
      const h = document.createElement('h3');
      h.className = 'wn-sec-h';
      h.textContent = sec.title;
      if (sec.items.length > 1) {
        const n = document.createElement('span');
        n.className = 'wn-sec-n mono';
        n.textContent = String(sec.items.length);
        h.appendChild(n);
      }
      s.appendChild(h);
      if (sec.items.length) {
        const ul = document.createElement('ul');
        ul.className = 'wn-list';
        for (const it of sec.items) {
          const li = document.createElement('li');
          li.className = 'wn-item';
          if (it.lead) {
            const b = document.createElement('b');
            b.className = 'wn-lead';
            b.textContent = it.lead;
            li.appendChild(b);
            li.appendChild(document.createTextNode(' '));
          }
          li.appendChild(document.createTextNode(it.text));
          ul.appendChild(li);
        }
        s.appendChild(ul);
      }
      for (const t of (sec.notes || [])) {
        const p = document.createElement('p');
        p.className = 'wn-note';
        p.textContent = t;
        s.appendChild(p);
      }
      frag.appendChild(s);
    }
    host.appendChild(frag);
  }

  function renderWhatsNew() {
    const av = wnAvailable();
    const inst = wnInstalled();
    // The offered release only wins the toggle when its notes actually exist.
    if (wnMode === 'available' && !(av && av.release)) wnMode = 'installed';

    const modes = $('wn-modes');
    const both = !!(av && av.release) && !!inst;
    modes.hidden = !both;
    if (both) {
      $('wn-mode-available').textContent = 'Coming in ' + av.version;
      $('wn-mode-installed').textContent = 'Installed ' + appVersion;
      for (const b of modes.querySelectorAll('button[role=radio]')) {
        const on = b.dataset.mode === wnMode;
        b.setAttribute('aria-checked', on ? 'true' : 'false');
        b.tabIndex = on ? 0 : -1;
      }
    }

    const offering = wnMode === 'available' && !!(av && av.release);
    const release = offering ? av.release : inst;

    $('wn-eyebrow').textContent = offering ? 'Coming in this update' : 'What’s new';
    $('wn-ver').textContent = (release && release.version) || (offering ? av.version : appVersion) || '—';
    $('wn-name').textContent = release && release.name ? '“' + release.name + '”'
      : (!offering && releaseName ? '“' + releaseName + '”' : '');
    $('wn-date').textContent = (release && release.date) || '';

    // The one line that keeps the two apart: notes for a version you are not
    // running have to say so, or they read as a description of what you have.
    const offer = $('wn-offer');
    if (offering) {
      offer.hidden = false;
      offer.textContent = 'These are the notes for ' + av.version + '. You are running '
        + (appVersion || 'this build') + '.';
    } else offer.hidden = true;

    const empty = !release || !window.Changelog
      || !(window.Changelog.count(release) + (release.intro || []).length);
    $('wn-fallback').hidden = !empty;
    $('wn-secs').hidden = empty;
    if (empty) {
      $('wn-secs').textContent = '';
      const why = offering ? 'This release published no notes.'
        : !wnDoc ? 'Reading the changelog…'
          : wnDoc.ok ? 'There is no entry for this version yet.'
            : wnDoc.error === 'not found' ? 'This build does not carry a changelog file.'
              : 'The changelog could not be read (' + wnDoc.error + ').';
      $('wn-fb-title').textContent = offering ? 'No notes for ' + av.version : 'No release notes here';
      $('wn-fb-msg').textContent = why + ' The full history is on the releases page.';
    } else {
      wnRenderSections(release);
    }

    const apply = $('wn-apply');
    apply.hidden = !(offering && av.staged && av.canSelf);
    // A failed apply left the button reading "Working…" for ever; the state that
    // decides whether it is shown is the state that owns its label.
    if (!apply.hidden && activity.update.state === 'available') {
      apply.disabled = false;
      apply.textContent = 'Update & restart';
    }
    $('wn-check').hidden = offering;
    $('wn-full').textContent = offering ? 'Open the release page' : 'Full changelog';
  }

  function wnFullUrl() {
    const av = wnAvailable();
    if (wnMode === 'available' && av && av.htmlUrl) return av.htmlUrl;
    return wnReleasesUrl;
  }

  function openWhatsNew(opts) {
    opts = opts || {};
    if (setOpen) closeSettings();
    if (palOpen) closePalette();
    const av = wnAvailable();
    wnMode = opts.mode || ((av && av.release) ? 'available' : 'installed');
    if (wnOpen) { renderWhatsNew(); wnBody.focus(); return; }
    wnOpen = true;
    wnReturn = document.activeElement;
    wnScrim.hidden = false;
    syncCovered();
    raf(() => wnScrim.classList.add('is-open'));
    renderWhatsNew();
    // The file read is off the open path: the sheet is already on screen and
    // re-renders itself when the parse lands.
    loadChangelog().then(() => { if (wnOpen) renderWhatsNew(); });
    wnBody.scrollTop = 0;
    wnBody.focus();
  }
  function closeWhatsNew() {
    if (!wnOpen) return;
    wnOpen = false;
    wnScrim.classList.remove('is-open');
    setTimeout(() => { if (!wnOpen) { wnScrim.hidden = true; syncCovered(); } }, 140);
    syncCovered();
    if (wnReturn && wnReturn.focus) { try { wnReturn.focus(); } catch (_) {} }
    wnReturn = null;
  }

  // A real modal: Tab cannot leave it, and Enter closes it unless the focus is
  // on a control that has its own answer to Enter.
  wnDlg.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      if (e.target && e.target.closest && e.target.closest('button, a, input, select, textarea')) return;
      closeWhatsNew();
      e.preventDefault();
      return;
    }
    if (e.key !== 'Tab') return;
    const nodes = [...wnDlg.querySelectorAll(WN_FOCUS)].filter((n) => !n.hidden && n.offsetParent !== null);
    if (!nodes.length) { wnBody.focus(); e.preventDefault(); return; }
    const first = nodes[0], last = nodes[nodes.length - 1];
    const at = nodes.indexOf(document.activeElement);
    if (e.shiftKey && at <= 0) { last.focus(); e.preventDefault(); }
    else if (!e.shiftKey && (at === -1 || at === nodes.length - 1)) { first.focus(); e.preventDefault(); }
  });
  wnScrim.addEventListener('mousedown', (e) => { if (e.target === wnScrim) closeWhatsNew(); });
  $('wn-close').addEventListener('click', closeWhatsNew);
  $('wn-done').addEventListener('click', closeWhatsNew);
  // The same radiogroup helper every other segmented control in the shell uses,
  // so this one gets the arrow-key roving for free instead of reinventing it.
  wireRadios('wn-modes', (b) => {
    if (!b.dataset.mode || b.dataset.mode === wnMode) return;
    wnMode = b.dataset.mode;
    renderWhatsNew();
    wnBody.scrollTop = 0;
  });
  const wnOpenFull = () => { if (studio.openExternal) studio.openExternal(wnFullUrl()); };
  $('wn-full').addEventListener('click', wnOpenFull);
  $('wn-fb-open').addEventListener('click', wnOpenFull);
  $('wn-check').addEventListener('click', () => {
    activity.update.dismissed = false;
    renderUpdate();
    if (studio.checkForUpdates) studio.checkForUpdates({ manual: true });
  });
  $('wn-apply').addEventListener('click', () => {
    const b = $('wn-apply');
    b.disabled = true; b.textContent = 'Working…';
    if (studio.applyUpdate) studio.applyUpdate();
  });

  // ==========================================================================
  // 14. KEY ROUTER
  // Ctrl+1..6 is handled here AND in main via before-input-event, because the
  // stage covers nearly the whole window and swallows keydowns the moment focus
  // is inside a panel. Both maps must list the same six tabs in the same order:
  // forge, review, player, audition, library, logs.
  // ==========================================================================
  window.addEventListener('keydown', (e) => {
    // Escape has one precedence order and affects exactly one thing.
    if (e.key === 'Escape') {
      if (wnOpen) { closeWhatsNew(); e.preventDefault(); return; }
      if (palOpen) { closePalette(); e.preventDefault(); return; }
      if (setOpen) { closeSettings(); e.preventDefault(); return; }
      if (!$('as-update').hidden) { activity.update.dismissed = true; renderUpdate(); e.preventDefault(); }
      return;
    }
    if (e.ctrlKey && !e.altKey && !e.metaKey) {
      const n = '123456'.indexOf(e.key);
      if (n >= 0) { activate(ORDER[n]); e.preventDefault(); return; }
      if (e.key === 'k' || e.key === 'K') { openPalette(''); e.preventDefault(); return; }
      if (e.key === ',') { openSettings(); e.preventDefault(); return; }
    }
    if (e.ctrlKey && e.altKey && (e.key === 'l' || e.key === 'L')) { activate('logs'); e.preventDefault(); return; }
    if (palOpen || setOpen || wnOpen) return;
    // Space belongs to the transport owner, but never while a field has focus.
    if (e.key === ' ' && spaceTransport && !isFormFocus()) {
      if (window.Transport && window.Transport.owner()) { window.Transport.toggle(); e.preventDefault(); }
      return;
    }
    if (e.key === 'Home' && !isFormFocus() && window.Transport && window.Transport.owner()) {
      window.Transport.stop(); e.preventDefault();
    }
  });
  // Ctrl+1..6 arriving from the main process (before-input-event) because the
  // panel iframe swallowed the keydown.
  if (studio.onShortcut) studio.onShortcut((p) => {
    if (!p) return;
    if (p.tab) { activate(p.tab); return; }
    if (p.id === 'palette') { if (palOpen) closePalette(); else openPalette(''); return; }
    if (p.id === 'settings') { if (setOpen) closeSettings(); else openSettings(); return; }
    if (p.id === 'log') { activate('logs'); return; }
    if (window.Bus && p.id) window.Bus.send(T.UI_SHORTCUT, { id: p.id }, { to: 'frames' });
  });

  // ==========================================================================
  // 15. MAIN-PROCESS EVENT WIRING
  //
  // engine-event / engine-error / forge:status / library-changed / game-active /
  // overlay-state already reach every frame through main's broadcast(). The
  // shell mirrors them onto the bus as well, for panels that speak the bus
  // rather than the legacy IPC surface. A panel must pick ONE of the two.
  //
  // update-status is deliberately NOT mirrored: it is main-frame-only so that
  // exactly one update banner exists in the whole app.
  // ==========================================================================
  // Main's broadcast() already reaches every frame over IPC. The shell mirrors
  // the LOW-RATE events onto the bus as well, for panels that speak the bus
  // rather than the legacy IPC surface. The high-rate streams (engine progress
  // packets, forge.log, forge.progress) are deliberately NOT mirrored: doubling
  // a 20Hz stream across five frames is exactly the fan-out cost the perf
  // review flagged as the hottest main-thread path. A panel that wants those
  // uses window.api.onEngineEvent / window.forge.onStatus, which every frame
  // already has. update-status is never mirrored at all, so that exactly one
  // update banner exists in the whole app.
  const MIRROR_FORGE = new Set(['forge.done', 'forge.paused', 'forge.job', 'forge.env',
    'forge.provision.done', 'forge.provision.error']);
  const mirror = (type, payload) => { if (window.Bus) window.Bus.send(type, payload, { to: 'frames' }); };

  if (studio.onUpdateStatus) studio.onUpdateStatus((s) => {
    if (!s || !s.state) return;
    Object.assign(activity.update, s, { dismissed: false });
    if (s.state === 'updated') toast({ severity: 'ok', title: `Updated to v${s.version}` });
    if (s.state === 'none') toast({ severity: 'ok', title: `You are on the latest version (v${s.current})` });
    if (s.state === 'error') logPush('Update failed: ' + (s.message || 'unknown error'), 'error', 'update');
    renderUpdate();
    // The What's New modal offers the fetched notes for an available update, so
    // a status arriving while it is open changes what it has to show.
    if (wnOpen) renderWhatsNew();
  });

  if (studio.onEngineError) studio.onEngineError((msg) => {
    const text = typeof msg === 'string' ? msg : (msg && msg.message) || String(msg);
    logPush(text, 'error', 'player');
    mirror(T.ENGINE_ERROR, { message: text });
    // Ordinary sidecar chatter must not toast; only the failures that stop it.
    if (/missing|couldn't launch|could not launch|not running|crashed|failed/i.test(text)) {
      toast({ severity: 'err', title: 'Player engine', message: text.slice(0, 160), key: 'engine-error' });
    }
  });

  if (playerApi.onEngineEvent) playerApi.onEngineEvent((p) => {
    if (!p || typeof p !== 'object') return;
    if (p.event === 'ready' || p.event === 'error') mirror(T.ENGINE_EVENT, p);
    if (p.event === 'log' && p.message) logPush(p.message, p.level === 'error' ? 'error' : p.level === 'warn' ? 'warn' : 'info', 'player');
    if (p.event === 'error' && p.message) logPush(p.message, 'error', 'player');
    if (p.event === 'ready') { bootMark('engine', 'Starting MIDI engine'); logPush('Player engine ready.', 'ok', 'player'); }
  });

  if (forgeApi.onStatus) forgeApi.onStatus((p) => {
    if (!p || typeof p !== 'object') return;
    if (MIRROR_FORGE.has(p.event)) mirror(T.FORGE_STATUS, p);
    handleForgeStatus(p);
  });

  if (studio.onGameActive) studio.onGameActive((p) => {
    const was = gameName;
    gameName = (p && p.game) || '';
    if (p && p.rule) perf.whenGaming = p.rule;
    applyPerf();
    renderGame();
    mirror(T.GAME_ACTIVE, { name: gameName });
    // Edge-triggered: the watcher re-broadcasts, and a toast per broadcast was
    // a notification every few seconds for as long as the game was open.
    if (gameName && !was) {
      const clean = gameName.replace(/\.exe$/i, '');
      const note = perf.whenGaming === 'pause' ? 'Forge jobs are paused.'
        : perf.whenGaming === 'nothing' ? 'Carrying on as normal.'
          : 'Going easy on the GPU.';
      toast({ severity: 'ok', title: `${clean} detected`, message: note, key: 'game' });
      logPush(`${clean} detected. ${note}`, 'info', 'app');
    } else if (!gameName && was) {
      toast({ severity: 'ok', title: 'Game closed', message: 'Full speed again.', key: 'game' });
    }
  });

  if (studio.onOverlayState) studio.onOverlayState((cfg) => { applyOverlayCfg(cfg); mirror(T.OVERLAY_STATE, { open: !!(cfg && cfg.open) }); });
  if (studio.onLibraryChanged) studio.onLibraryChanged(() => { refreshLibraryIndex(); mirror(T.LIBRARY_CHANGED, { reason: 'fs' }); });
  // A .mid handed over by Windows (double-click, "Open with"). Same router as
  // every in-app hand-off, so it queues correctly if the Player is not loaded.
  if (studio.onOpenMidi) studio.onOpenMidi((p) => { if (p && p.midiPath) handoff('player', { midiPath: p.midiPath }, { from: 'os' }); });

  // ---- Forge job tracking -------------------------------------------------
  const forgeJobs = new Map();
  function handleForgeStatus(p) {
    const ev = p.event || '';
    if (ev === 'forge.log') {
      logPush(p.line, p.level === 'error' ? 'error' : /warn/i.test(p.line || '') ? 'warn' : 'info', 'forge');
      // Launch-time housekeeping notices belong on the strip, not only the log.
      if (/^Stopped \d+ leftover Forge job/i.test(String(p.line || '')) || /^Found your Forge engine at /i.test(String(p.line || ''))) {
        activity.reaped = String(p.line).replace(/\s+$/, '');
        renderStrip();
      }
      // The pipeline echoes the file it was handed; that is the only place a
      // job's name appears before it finishes.
      const m = /^\s*input:\s*(.+?)\s*$/i.exec(String(p.line || ''));
      if (m && p.jobId) {
        const job = forgeJobs.get(p.jobId) || {};
        job.name = window.Fmt ? window.Fmt.basename(m[1]) : m[1].split(/[\\/]/).pop();
        forgeJobs.set(p.jobId, Object.assign(job, { jobId: p.jobId }));
        syncForgeItem();
      }
      return;
    }
    if (ev === 'forge.job') {                     // the Forge tab, saying what it started
      const job = forgeJobs.get(p.jobId) || { jobId: p.jobId, startedAt: Date.now(), percent: null, stage: 'Queued' };
      if (p.name) job.name = p.name;
      if (p.kind) job.kind = p.kind;
      forgeJobs.set(p.jobId, job);
      clearForged();                 // the next job supersedes the last offer
      syncForgeItem();
      return;
    }
    if (ev === 'forge.progress') {
      const job = forgeJobs.get(p.jobId) || { jobId: p.jobId, startedAt: Date.now(), name: '' };
      job.stage = p.stage || job.stage || '';
      const pct = Number(p.percent);
      job.percent = Number.isFinite(pct) && pct >= 0 ? Math.max(job.percent || 0, pct) : null;
      if (!job.startedAt) job.startedAt = Date.now();
      forgeJobs.set(p.jobId, job);
      syncForgeItem();
      return;
    }
    if (ev === 'forge.paused') {
      for (const job of forgeJobs.values()) job.paused = !!p.paused;
      syncForgeItem();
      return;
    }
    if (ev === 'forge.done') {
      const job = forgeJobs.get(p.jobId);
      forgeJobs.delete(p.jobId);
      syncForgeItem();
      const name = (job && job.name) || (p.result && p.result.midiPath ? (window.Fmt ? window.Fmt.basename(p.result.midiPath) : p.result.midiPath) : 'the job');
      if (p.ok && p.result) {
        logPush(`Finished ${name}.`, 'ok', 'forge');
        onForgeResult(name, p.result);
      } else if (p.error === 'cancelled') {
        logPush(`Cancelled ${name}.`, 'warn', 'forge');
      } else {
        logPush(`Failed ${name}: ${p.error || 'unknown error'}`, 'error', 'forge');
        toast({ severity: 'err', title: 'Transcription failed', message: String(p.error || '').slice(0, 160) });
      }
      return;
    }
    if (ev === 'forge.provision.log') { logPush(p.line, 'info', 'setup'); return; }
    if (ev === 'forge.provision.progress') { logPush(`[${p.percent < 0 ? '--' : p.percent + '%'}] ${p.step}: ${p.message}`, 'info', 'setup'); return; }
    if (ev === 'forge.provision.error') {
      logPush('Setup failed: ' + (p.message || ''), 'error', 'setup');
      toast({ severity: 'err', title: 'Forge setup failed', message: String(p.message || '').slice(0, 160) });
      return;
    }
    if (ev === 'forge.provision.done') {
      logPush('Setup finished.', 'ok', 'setup');
      toast({ severity: 'ok', title: 'Forge is set up' });
      activity.engine.gpu = null;
      refreshForgeInfo();
      if (forgeApi.check) forgeApi.check().then(adoptEnvProbe).catch(() => {});
    }
  }
  function syncForgeItem() {
    const first = forgeJobs.values().next();
    activity.forge = first.done ? null : first.value;
    renderStrip();
  }
  function cancelForgeJob() {
    const job = activity.forge;
    if (!job || !forgeApi.cancel) return;
    forgeApi.cancel(job.jobId);
    logPush('Cancelling ' + (job.name || 'the job') + '…', 'warn', 'forge');
  }
  function onForgeResult(name, result) {
    const midiPath = result.midiPath || '';
    if (!midiPath) return;
    if (autoQueueForged) {
      handoff('player', { midiPath, play: false, queue: true }, { from: 'forge', focus: false });
      toast({ severity: 'ok', title: `Added ${name} to the Player queue` });
      return;
    }
    // The old behaviour queued every finished transcription into the Player
    // whether you wanted it there or not. Now it is an offer: a durable activity
    // strip row with "Add to queue" / "Edit" / "Dismiss", two palette commands
    // ("Edit the last transcription", "Show the last transcription"), and the
    // Library lists it either way. The toast is the transient echo of the row,
    // not the offer itself.
    lastForged = { name, midiPath, projectPath: result.projectPath || '' };
    activity.forged = { name, midiPath, projectPath: result.projectPath || '', at: Date.now() };
    renderStrip();
    toast({
      severity: 'ok', title: `Forged ${name}`,
      message: 'The activity strip can queue it or open it in the Editor.', timeout: 7000
    });
    refreshLibraryIndex();
  }
  let lastForged = null;

  // ==========================================================================
  // 16. COMMAND REGISTRY (shell-owned commands)
  // Panel-owned commands arrive over the bus; see CONTRACT.md § Shell for the
  // ids the transport bar and the activity strip look for.
  // ==========================================================================
  function registerCommands() {
    if (!window.Commands) return;
    window.Commands.host();
    window.Commands.setScope('global');
    const nav = FRAMES.map((f, i) => ({
      id: 'nav.' + f.key, label: 'Go to ' + f.label, group: 'Workspace',
      keywords: ['tab', 'open', f.label], keys: 'Ctrl+' + (i + 1),
      run: () => activate(f.key)
    }));
    window.Commands.registerAll(nav.concat([
      { id: 'transport.toggle', label: 'Play / pause', group: 'Transport', keys: 'Space', keywords: ['start', 'stop', 'resume'],
        enabled: () => !!(window.Transport && window.Transport.owner()), run: () => window.Transport.toggle() },
      { id: 'transport.stop', label: 'Stop playback', group: 'Transport', keys: 'Home',
        enabled: () => !!(window.Transport && window.Transport.owner()), run: () => window.Transport.stop() },
      { id: 'transport.next', label: 'Next track', group: 'Transport',
        enabled: () => !!(lastState && lastState.caps && lastState.caps.queue), run: () => window.Transport.next() },
      { id: 'transport.prev', label: 'Previous track', group: 'Transport',
        enabled: () => !!(lastState && lastState.caps && lastState.caps.queue), run: () => window.Transport.prev() },
      { id: 'transport.perch', label: 'Toggle Perch overlay', group: 'Transport', keys: 'Ctrl+Alt+O', keywords: ['overlay', 'on top'],
        run: () => studio.toggleOverlay && studio.toggleOverlay() },
      { id: 'app.openFile', label: 'Open a MIDI file…', group: 'File', keywords: ['browse', 'pick'],
        run: async () => { const p = playerApi.pickMidi ? await playerApi.pickMidi() : null; if (p) handoff('player', { midiPath: p }, { from: 'palette' }); } },
      { id: 'app.outputFolder', label: 'Show the output folder', group: 'File', keywords: ['transcriptions', 'reveal', 'explorer'],
        run: async () => {
          const dir = outputDir || (forgeApi.getOutputDir ? await forgeApi.getOutputDir() : '');
          if (dir && studio.openPath) studio.openPath(dir);
        } },
      { id: 'app.revealLast', label: 'Show the last transcription', group: 'File',
        enabled: () => !!(lastForged && lastForged.midiPath),
        run: () => studio.showItem && studio.showItem(lastForged.midiPath) },
      { id: 'app.editLast', label: 'Edit the last transcription', group: 'File',
        enabled: () => !!(lastForged && (lastForged.projectPath || lastForged.midiPath)),
        run: () => handoff('review', { projectPath: lastForged.projectPath, midiPath: lastForged.midiPath }, { from: 'palette' }) },
      { id: 'app.settings', label: 'Open settings', group: 'Application', keys: 'Ctrl+,', run: () => openSettings() },
      { id: 'app.updates', label: 'Check for updates', group: 'Application', keywords: ['version', 'upgrade'],
        run: () => { activity.update.dismissed = false; if (studio.checkForUpdates) studio.checkForUpdates({ manual: true }); } },
      { id: 'app.whatsNew', label: 'What’s new', group: 'Application',
        keywords: ['changelog', 'release notes', 'version', 'what changed'],
        run: () => openWhatsNew() },
      { id: 'app.log', label: 'Open Logs', group: 'Application', keys: 'Ctrl+Alt+L',
        keywords: ['console', 'output', 'errors', 'activity log'], run: () => activate('logs') },
      { id: 'app.copyLog', label: 'Copy the activity log', group: 'Application', run: () => copyLog() },
      { id: 'app.density', label: 'Toggle compact density', group: 'Appearance', keywords: ['spacing', 'comfortable'],
        run: () => setDensity(density === 'compact' ? 'normal' : 'compact') },
      { id: 'app.forgeStorage', label: 'Change Forge storage folder…', group: 'Forge',
        run: () => { openSettings('forge'); } },
      { id: 'app.setupLog', label: 'Open the Forge setup log', group: 'Forge', run: () => $('s-setuplog').click() },
      { id: 'app.bootLog', label: 'Open the boot log', group: 'Forge', run: () => $('s-bootlog').click() },
      { id: 'app.minimize', label: 'Minimise the window', group: 'Window', run: () => wnd.minimize && wnd.minimize() },
      { id: 'app.maximize', label: 'Maximise or restore the window', group: 'Window',
        run: () => $('win-max').click() }
    ]));
  }

  // ==========================================================================
  // 17. BOOT SPLASH
  // Real milestones only. It never delays startup: the moment everything it is
  // waiting on has happened, it shortens its own animation and hands over.
  // ==========================================================================
  const BOOT_STEPS = ['interface', 'engine', 'session', 'recent', 'ready'];
  const BOOT_LABEL = {
    interface: 'Loading interface',
    engine: 'Starting MIDI engine',
    session: 'Restoring session',
    recent: 'Scanning recent files',
    ready: 'Ready'
  };
  const bootSeen = Object.create(null);
  let bootDone = false;
  const bootStart = Date.now();
  // Anything that wants to put a sheet on screen at startup waits for this: a
  // modal opened behind the splash is a modal nobody ever saw.
  const bootWaiters = [];
  function onBooted(fn) {
    if (bootDone) { setTimeout(fn, 0); return; }
    bootWaiters.push(fn);
  }

  function bootMark(step, label) {
    if (bootDone) return;
    bootSeen[step] = true;
    uiMark(step);
    const el = $('splash-status');
    // Always show the furthest step reached, so a late milestone cannot make
    // the line travel backwards.
    let text = label || BOOT_LABEL[step] || step;
    for (let i = BOOT_STEPS.length - 1; i >= 0; i--) {
      if (bootSeen[BOOT_STEPS[i]]) { text = BOOT_LABEL[BOOT_STEPS[i]]; break; }
    }
    if (el.textContent !== text) el.textContent = text;
    maybeHandover();
  }
  function maybeHandover() {
    if (bootDone) return;
    // Wait only for things that actually gate a usable window.
    if (!bootSeen.session || !bootSeen.panel) return;
    finishBoot();
  }
  function finishBoot() {
    if (bootDone) return;
    bootDone = true;
    uiMark('handover');
    const splash = $('splash');
    const el = $('splash-status');
    el.textContent = BOOT_LABEL.ready;
    // A boot this fast never gets to see the stagger, so settle the bars at
    // once instead of holding the window back for an animation.
    if (Date.now() - bootStart < 700) splash.classList.add('is-settled');
    raf(() => {
      document.body.dataset.boot = 'ready';
      splash.classList.add('is-out');
      setTimeout(() => {
        splash.hidden = true;
        const waiting = bootWaiters.splice(0, bootWaiters.length);
        for (const fn of waiting) { try { fn(); } catch (_) {} }
      }, 280);
    });
  }
  // A stuck sidecar, a slow disk or a panel that never fires 'load' must not
  // leave the splash on screen for ever.
  setTimeout(() => { bootSeen.session = true; bootSeen.panel = true; finishBoot(); }, 6000);

  if (studio.onBootMilestone) studio.onBootMilestone((p) => { if (p && p.step) bootMark(p.step, p.label); });

  // ==========================================================================
  // 18. TRANSPORT HOST + BOOT SEQUENCE
  // ==========================================================================
  if (window.Transport) {
    window.Transport.host();            // installs the registry and the bus relay
    window.Transport.onChange((s) => {
      // A change of owner drops every echo: the new owner's values are its own.
      if (!lastState || lastState.owner !== s.owner) { knobEcho.rate = null; knobEcho.transpose = null; knobEcho.volume = null; }
      lastState = s;
      renderTransport();
    });
  }
  registerCommands();
  if (window.Commands) window.Commands.onChange(() => { if (palOpen) renderPalette(); });

  // paint the cached engine verdict synchronously: probing imports torch and
  // takes tens of seconds, and an empty chip on every cold start is worse than
  // a one-run-stale one.
  {
    const cached = readEngineCache();
    if (cached) {
      activity.engine.known = true;
      activity.engine.ready = !!cached.ready;
      activity.engine.gpu = cached.gpu || null;
      activity.engine.missing = Array.isArray(cached.missing) ? cached.missing : [];
    }
  }
  renderEngine();
  renderUpdate();
  renderStrip();
  renderTransport();
  renderPerch();
  bootMark('interface');

  if (studio.getRelease) studio.getRelease().then((r) => { releaseName = String(r || ''); applyVersion(appVersion); }).catch(() => {});

  // What's New, automatically, exactly once per installed version. Main answers
  // autoShow only when this process was started with --post-update AND the
  // version it is running is not the one whose notes were last shown, and the
  // mark is written the moment the sheet goes up rather than when it is closed,
  // so a window killed with the notes still open does not owe them again.
  if (studio.whatsNew) studio.whatsNew().then((w) => {
    if (!w) return;
    if (w.releasesUrl) wnReleasesUrl = String(w.releasesUrl);
    if (w.name && !releaseName) { releaseName = String(w.name); applyVersion(appVersion); }
    if (!w.autoShow) return;
    const shown = String(w.version || appVersion || '');
    if (studio.markNotesShown) studio.markNotesShown(shown).catch(() => {});
    onBooted(() => openWhatsNew({ mode: 'installed' }));
  }).catch(() => {});
  if (studio.getVersion) studio.getVersion().then((v) => {
    applyVersion(v);
    activity.update.current = v;
  }).catch(() => {});

  if (studio.bootState) studio.bootState().then((s) => {
    for (const st of (s && s.steps) || []) bootMark(st.step, st.label);
  }).catch(() => {});

  // Restore the session, then bring the first panel up.
  const restore = (studio.getUi ? studio.getUi() : Promise.resolve(null)).then((ui) => {
    ui = ui || {};
    themePreset = ui.theme || '';
    if (ui.accent) accentVars = deriveAccent(ui.accent);
    density = ui.density === 'compact' ? 'compact'
      : (ui.density ? 'normal' : (ui.forgeLayout === 'cards' ? 'compact' : 'normal'));   // Cards users get Compact
    handoffPlay = ui.handoffPlay === 'play' ? 'play' : 'load';
    spaceTransport = ui.spaceTransport !== false;
    xportMs = !!ui.transportMs;
    autoQueueForged = !!ui.autoQueueForged;

    skinEl(root);
    if (window.Tokens) window.Tokens.refresh();
    applyDensity();
    renderPalSwatch();
    $('s-handoff').value = handoffPlay;
    setSwitch('s-space', spaceTransport);
    setSwitch('s-xpms', xportMs);
    setSwitch('s-autoqueue', autoQueueForged);
    setSwitch('s-autoupdate', ui.autoCheckUpdates !== false);
    setSwitch('s-ontop', ui.alwaysOnTop !== false);
    for (const b of $('s-density').querySelectorAll('button[role=radio]')) {
      const on = b.dataset.density === density;
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    }
    renderTransport();
    activate(normaliseTab(ui.lastTab), { persist: false, focus: false });
    bootMark('session');
  }).catch(() => { activate('forge', { persist: false, focus: false }); bootMark('session'); });

  // The splash waits for the first panel to actually be up, so the hand-over
  // never reveals an empty stage.
  restore.then(() => {
    const f = byKey[activeKey];
    const done = () => { bootSeen.panel = true; maybeHandover(); };
    // f.loaded is only ever set for a frame that really navigated (see
    // frameNavigated), but the listener still has to skip the about:blank load.
    if (f.loaded && frameNavigated(f)) done();
    else {
      const onLoad = () => {
        if (!frameNavigated(f)) return;
        f.frame.removeEventListener('load', onLoad);
        done();
      };
      f.frame.addEventListener('load', onLoad);
    }
    setTimeout(done, 2500);      // a panel that fails to load must not trap us
  });

  if (studio.getPerformance) studio.getPerformance().then(showPerf).catch(() => {});
  if (studio.overlayState) studio.overlayState().then(applyOverlayCfg).catch(() => {});
  if (forgeApi.getOutputDir) forgeApi.getOutputDir().then((d) => { outputDir = d || ''; setPathChip('s-outdir', outputDir, '—'); }).catch(() => {});
  refreshForgeInfo();
  refreshLibraryIndex().then(() => bootMark('recent'));

  // No cached GPU verdict and nobody has probed: do it ourselves, but late and
  // once, because the probe imports torch.
  setTimeout(() => {
    if (activity.engine.gpu || !activity.engine.ready || !forgeApi.check) return;
    forgeApi.check().then(adoptEnvProbe).catch(() => {});
  }, 12000);

  if (window.Icon) window.Icon.apply(document);
})();

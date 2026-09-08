// idle.js -- what does MIDI Studio cost when it is doing nothing, and what
// does each tab cost the first time you open it?
//
//   npx electron benchmarks/idle.js                       60s per tab
//   npx electron benchmarks/idle.js --seconds 20          quicker sweep
//   npx electron benchmarks/idle.js --tabs player,library
//   npx electron benchmarks/idle.js --json benchmarks/idle.json
//   npx electron benchmarks/idle.js --occluded            also measure hidden
//   npx electron benchmarks/idle.js --noanim              A/B control: same run
//                                                         with CSS animations
//                                                         stopped and nothing
//                                                         else changed
//   npx electron benchmarks/idle.js --boot 6              only the shell's first
//                                                         paint, 6 fresh windows
//   npx electron benchmarks/idle.js --boot 6 --variant noimg   ... without the
//                                                         splash artwork
//   npx electron benchmarks/idle.js --boot 6 --variant nofont  ... without the
//                                                         webfonts
//   npx electron benchmarks/idle.js --trace               step-by-step progress
//
// Its companion is benchmarks/startup.js, which times the REAL app from
// process spawn using the app's own boot log.
//
// WHY A HARNESS AND NOT THE REAL APP
// ----------------------------------
// electron/main.js is deliberately NOT booted: it would spawn the python
// sidecar, poll tasklist, hit the network for updates and open the real window,
// and none of that can be held still across runs. Instead the real renderer --
// the same renderer/index.html, the same preload, the same six panels -- runs
// against tools/ipc-stubs.js, the same realistic fixture data the layout audit
// uses (895 library files, a provisioned Forge env, a 4000-note document). So
// every number here is the RENDERER's own cost, isolated and repeatable.
// The main-process side of idle (gamewatch's tasklist poll, the updater, the
// sidecar) is measured separately by benchmarks/startup.js and named in the
// findings rather than guessed at here.
//
// WHAT IT MEASURES
//
// 1. THE BOOT TIMELINE INSIDE THE RENDERER. After hand-over it reads the page's
//    own PerformanceTimeline: navigation, every resource with its start/duration,
//    and the paint entries. That is what answers "what does the shell do before
//    first paint" with evidence instead of a hunch.
//
// 2. FIRST OPEN OF EACH TAB, in a FRESH window each time so it really is the
//    first open: from the click on the nav item to the panel going quiet, with
//    the main-thread script/layout/style time it burned getting there, taken
//    from the DevTools Performance domain (thread ticks, not wall clock, so
//    another process cannot inflate it).
//
// 3. IDLE, per tab, over --seconds. Everything that should be ZERO when nothing
//    is playing:
//      rAF/s          animation frames the app asked for
//      timers/s       setTimeout/setInterval arms
//      ipc/s          renderer -> main invocations
//      script ms/s    main-thread JS time
//      layouts/s      forced layouts
//      cpu %          per Electron process, from app.getAppMetrics()
//    The app disables Chromium's background throttling on purpose (an
//    invariant), so a loop that wakes with nothing to draw is not throttled
//    away -- it costs full price, forever. That is what these counters are for.
//
// The rAF/timer counters are installed AFTER load, by wrapping the page's own
// requestAnimationFrame/setTimeout/setInterval. A loop that keeps running has
// to re-arm through the wrapper, so a free-running loop is caught on its very
// next tick, which is exactly the defect being hunted. A one-shot callback that
// was already pending when the wrapper went in is missed once; that is stated
// here rather than papered over.
'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const stubs = require(path.join(ROOT, 'tools', 'ipc-stubs.js'));

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const SECONDS = Number(flag('--seconds', 60));
const JSON_OUT = flag('--json', '');
const ALSO_OCCLUDED = argv.includes('--occluded');
const NO_ANIM = argv.includes('--noanim');
const SIZE = String(flag('--size', '1280x800')).split('x').map(Number);
const TABS = String(flag('--tabs', 'forge,review,player,audition,library,logs'))
  .split(',').map((s) => s.trim()).filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TRACE = argv.includes('--trace');
const trace = (m) => { if (TRACE) process.stderr.write('    . ' + m + String.fromCharCode(10)); };
const round = (v, d) => (v == null ? null : Math.round(v * Math.pow(10, d)) / Math.pow(10, d));

// ---------------------------------------------------------------------------
//  In-page instrumentation. Installed once the shell has handed over, so it
//  counts steady-state behaviour and not the boot burst.
// ---------------------------------------------------------------------------
const INSTALL_COUNTERS = `(() => {
  // Every frame gets its own counter object, reachable from the top frame so
  // one executeJavaScript can read the whole window's behaviour.
  const install = (w, name) => {
    try {
      if (w.__perf) return w.__perf;
      const c = { name: name, raf: 0, timeout: 0, interval: 0, longTimers: 0 };
      const raf = w.requestAnimationFrame.bind(w);
      const st = w.setTimeout.bind(w);
      const si = w.setInterval.bind(w);
      w.requestAnimationFrame = (fn) => { c.raf++; return raf(fn); };
      w.setTimeout = (fn, ms, ...rest) => { c.timeout++; return st(fn, ms, ...rest); };
      w.setInterval = (fn, ms, ...rest) => { c.interval++; if (ms != null && ms < 2000) c.longTimers++; return si(fn, ms, ...rest); };
      w.__perf = c;
      return c;
    } catch (_) { return null; }
  };
  const out = [];
  const top = install(window, 'shell');
  if (top) out.push('shell');
  for (const f of Array.from(document.querySelectorAll('iframe'))) {
    let w = null;
    try { w = f.contentWindow; } catch (_) { w = null; }
    if (!w) continue;
    const c = install(w, f.id || 'frame');
    if (c) out.push(f.id || 'frame');
  }
  window.__perfFrames = () => {
    const rows = [];
    const push = (w) => { try { if (w && w.__perf) rows.push(Object.assign({}, w.__perf)); } catch (_) {} };
    push(window);
    for (const f of Array.from(document.querySelectorAll('iframe'))) { try { push(f.contentWindow); } catch (_) {} }
    return rows;
  };
  return out;
})()`;

const READ_COUNTERS = `(typeof window.__perfFrames === 'function' ? window.__perfFrames() : [])`;

// The renderer's own view of its startup: what it loaded, when, and when it
// first put ink on the screen.
const READ_TIMELINE = `(() => {
  const nav = performance.getEntriesByType('navigation')[0] || {};
  const paints = performance.getEntriesByType('paint').map((p) => ({ name: p.name, at: Math.round(p.startTime * 10) / 10 }));
  const res = performance.getEntriesByType('resource').map((r) => ({
    name: String(r.name).split('/').slice(-2).join('/'),
    kind: r.initiatorType,
    start: Math.round(r.startTime * 10) / 10,
    dur: Math.round(r.duration * 10) / 10,
    size: r.decodedBodySize || r.transferSize || 0,
  })).sort((a, b) => (b.start + b.dur) - (a.start + a.dur));
  return {
    domContentLoaded: Math.round((nav.domContentLoadedEventEnd || 0) * 10) / 10,
    domComplete: Math.round((nav.domComplete || 0) * 10) / 10,
    loadEventEnd: Math.round((nav.loadEventEnd || 0) * 10) / 10,
    paints: paints,
    resources: res,
    fontsReadyAt: window.__fontsReadyAt == null ? null : Math.round(window.__fontsReadyAt * 10) / 10,
    booted: document.body.dataset.boot === 'ready',
    // The splash's own artwork: if first-contentful-paint waits on anything,
    // this is the thing it waits on.
    splashImg: (() => {
      const img = document.querySelector('.splash-logo');
      if (!img) return null;
      const e = performance.getEntriesByName(img.src)[0];
      return { src: String(img.src).split('/').pop(), complete: img.complete,
        w: img.naturalWidth, h: img.naturalHeight,
        cssW: img.clientWidth, cssH: img.clientHeight,
        start: e ? Math.round(e.startTime * 10) / 10 : null,
        dur: e ? Math.round(e.duration * 10) / 10 : null,
        bytes: e ? (e.decodedBodySize || e.transferSize || 0) : 0 };
    })(),
    scripts: performance.getEntriesByType('resource')
      .filter((r) => r.initiatorType === 'script' || r.initiatorType === 'link' || r.initiatorType === 'css')
      .map((r) => ({ n: String(r.name).split('/').slice(-2).join('/'),
        s: Math.round(r.startTime * 10) / 10, d: Math.round(r.duration * 10) / 10,
        b: r.decodedBodySize || r.transferSize || 0 })),
  };
})()`;

// Installed at dom-ready, so it is in place before the splash artwork and the
// webfonts arrive. Resource Timing does not record file:// requests, so the
// things that can gate the first contentful paint have to be timed by hand.
const WATCH_FONTS = `(() => {
  try { document.fonts.ready.then(() => { window.__fontsReadyAt = performance.now(); }); } catch (_) {}
  try {
    window.__dclAt = performance.now();
    const img = document.querySelector('.splash-logo');
    if (img) {
      if (img.complete && img.naturalWidth) window.__imgAt = 0;
      else img.addEventListener('load', () => { window.__imgAt = performance.now(); }, { once: true });
      // decode() resolves when the bitmap is ready to paint, which is the real
      // gate -- a fetched-but-undecoded image still paints nothing.
      if (img.decode) img.decode().then(() => { window.__imgDecodedAt = performance.now(); }).catch(() => {});
    }
    // Anything over 50ms on the main thread during boot is a stall the user can
    // see; record them rather than averaging them away.
    window.__longTasks = [];
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) window.__longTasks.push([Math.round(e.startTime), Math.round(e.duration)]);
    }).observe({ type: 'longtask', buffered: true });
  } catch (_) {}
  return true;
})()`;

// Everything the renderer knows about its own first paint.
const READ_PAINT = `(() => {
  const p = {};
  for (const e of performance.getEntriesByType('paint')) p[e.name] = Math.round(e.startTime * 10) / 10;
  const nav = performance.getEntriesByType('navigation')[0] || {};
  return {
    firstPaint: p['first-paint'] == null ? null : p['first-paint'],
    fcp: p['first-contentful-paint'] == null ? null : p['first-contentful-paint'],
    dcl: Math.round((nav.domContentLoadedEventEnd || 0) * 10) / 10,
    domComplete: Math.round((nav.domComplete || 0) * 10) / 10,
    imgLoadedAt: window.__imgAt == null ? null : Math.round(window.__imgAt * 10) / 10,
    imgDecodedAt: window.__imgDecodedAt == null ? null : Math.round(window.__imgDecodedAt * 10) / 10,
    fontsReadyAt: window.__fontsReadyAt == null ? null : Math.round(window.__fontsReadyAt * 10) / 10,
    longTasks: (window.__longTasks || []).slice(0, 12),
    booted: document.body.dataset.boot === 'ready',
  };
})()`;

// ---------------------------------------------------------------------------
//  CDP Performance domain -- thread-time counters, immune to other processes
// ---------------------------------------------------------------------------
async function metrics(wc) {
  const r = await wc.debugger.sendCommand('Performance.getMetrics');
  const m = {};
  for (const e of r.metrics) m[e.name] = e.value;
  return m;
}
function deltaMetrics(a, b) {
  const keys = ['ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration', 'TaskDuration',
    'TaskOtherDuration', 'ThreadTime', 'ProcessTime', 'LayoutCount', 'RecalcStyleCount'];
  const out = {};
  for (const k of keys) if (a[k] != null && b[k] != null) out[k] = b[k] - a[k];
  out.JSHeapUsedSizeMB = round((b.JSHeapUsedSize || 0) / 1048576, 2);
  out.JSHeapGrowthMB = round(((b.JSHeapUsedSize || 0) - (a.JSHeapUsedSize || 0)) / 1048576, 2);
  out.Nodes = b.Nodes;
  out.JSEventListeners = b.JSEventListeners;
  out.Documents = b.Documents;
  out.Frames = b.Frames;
  return out;
}

// app.getAppMetrics() gives per-PROCESS cpu, which is the only place the GPU
// process and the browser process show up at all. percentCPUUsage on Windows is
// cumulative-since-last-call per process, so sampling on a fixed cadence and
// averaging is the honest reading.
function sampleProcesses() {
  const rows = {};
  for (const m of app.getAppMetrics()) {
    const key = m.type === 'Tab' ? 'renderer' : String(m.type).toLowerCase();
    const acc = rows[key] || (rows[key] = { cpu: 0, mem: 0, n: 0 });
    acc.cpu += (m.cpu && m.cpu.percentCPUUsage) || 0;
    acc.mem += (m.memory && m.memory.workingSetSize) || 0;
    acc.n += 1;
  }
  return rows;
}

// ---------------------------------------------------------------------------
async function waitFor(wc, expr, timeout, every) {
  const deadline = Date.now() + (timeout || 15000);
  while (Date.now() < deadline) {
    let v = false;
    try { v = await wc.executeJavaScript(expr, true); } catch (_) { v = false; }
    if (v) return true;
    await sleep(every || 40);
  }
  return false;
}

// A boot variant is a controlled deprivation: run the identical page with ONE
// resource taken away and see whether first-contentful-paint moves. That is how
// a gate is proved rather than guessed. It is a measurement instrument; nothing
// here is a proposed change to the app.
const VARIANT = String(flag('--variant', 'none'));
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
function applyVariant(sess) {
  if (VARIANT === 'none') return;
  sess.webRequest.onBeforeRequest({ urls: ['file://*/*'] }, (details, cb) => {
    const u = String(details.url || '');
    if (VARIANT === 'noimg' && /lockup\.png$/i.test(u)) return cb({ redirectURL: TINY_PNG });
    if (VARIANT === 'nofont' && /\.woff2$/i.test(u)) return cb({ cancel: true });
    cb({});
  });
}

// The shell restores whatever tab settings name, so the tab under test must NOT
// be the restored one, or its "first open" already happened before the click.
let RESTORE_TAB = 'forge';
function armRestoreTab(tab) {
  RESTORE_TAB = tab;
  ipcMain.removeHandler('app:getUi');
  ipcMain.handle('app:getUi', () => ({ lastTab: RESTORE_TAB }));
}

async function openShell() {
  const win = new BrowserWindow({
    width: SIZE[0], height: SIZE[1], show: true, frame: false,
    backgroundColor: '#141519',
    webPreferences: {
      preload: path.join(ROOT, 'electron', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
      nodeIntegrationInSubFrames: true, backgroundThrottling: false,
    },
  });
  const wc = win.webContents;
  applyVariant(wc.session);
  // A panel that calls preventDefault in beforeunload (the Editor does) would
  // otherwise hold the window open. main.js asks the user; a harness proceeds.
  wc.on('will-prevent-unload', (e) => e.preventDefault());
  // Count every push main makes to the renderer, the other half of ipc volume.
  let pushed = 0;
  const realSend = wc.send.bind(wc);
  wc.send = (...a) => { pushed++; return realSend(...a); };
  wc.on('dom-ready', () => { wc.executeJavaScript(WATCH_FONTS, true).catch(() => {}); });
  const t0 = Date.now();
  await win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  // The Performance domain only answers once there is a page: attaching before
  // the first navigation makes Performance.enable hang for ever.
  wc.debugger.attach('1.3');
  await wc.debugger.sendCommand('Performance.enable', { timeDomain: 'threadTicks' });
  const booted = await waitFor(wc, `document.body.dataset.boot === 'ready'`, 20000, 25);
  const tBooted = Date.now();
  // Every IPC round trip the shell + its first panel make just to come up, in
  // order, with the offset from the moment loadFile was called.
  const bootIpc = {
    total: stubs.callTotal(),
    pushes: pushed,
    handoverMs: tBooted - t0,
    order: stubs.callLog.map((c) => c.channel + '@' + (c.t - t0) + 'ms'),
  };
  return { win, wc, t0, booted, bootIpc: bootIpc, pushes: () => pushed };
}

// One tab, in its own window, so "first open" is the truth.
async function measureTab(key, report) {
  let shell = null;
  armRestoreTab(key === 'forge' ? 'logs' : 'forge');
  try { shell = await openShell(); }
  catch (err) {
    report.tabs.push({ tab: key, error: 'openShell: ' + String((err && err.message) || err) });
    process.stderr.write('  ' + key + ' FAILED to open: ' + err + String.fromCharCode(10));
    return null;
  }
  const { win, wc, t0, booted } = shell;
  trace(key + ' shell booted=' + booted);
  const row = { tab: key, shellBootMs: Date.now() - t0, booted: booted, bootIpc: shell.bootIpc };
  try {
    // The shell restores whatever tab settings say, so force a known start:
    // activate a tab we are not measuring first, then measure the click.
    const other = key === 'forge' ? 'logs' : 'forge';
    if (other !== RESTORE_TAB) {
      await wc.executeJavaScript(`document.getElementById('nav-${other}').click(), true`, true);
    }
    await sleep(900);
    trace('reading timeline');
    row.timeline = await wc.executeJavaScript(READ_TIMELINE, true);
    trace('timeline ok');

    const before = await metrics(wc);
    trace('metrics before ok');
    const tClick = Date.now();
    await wc.executeJavaScript(`document.getElementById('nav-${key}').click(), true`, true);

    // "Usable" = the panel's iframe has loaded AND the renderer main thread has
    // gone quiet (two consecutive 250ms samples under 8ms of task time), which
    // is the point at which nothing more is going to appear on its own.
    let quietAt = null, loadedAt = null;
    let prev = before, quiet = 0;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      await sleep(120);   // ~240ms floor on "quiet" instead of ~750ms
      const now = await metrics(wc);
      const task = (now.TaskDuration - prev.TaskDuration) * 1000;
      prev = now;
      if (loadedAt == null) {
        const ok = await wc.executeJavaScript(
          `(() => { const f = document.getElementById('frame-${key}'); if (!f) return false;` +
          ` try { return !!(f.contentDocument && f.contentDocument.readyState === 'complete'); } catch (_) { return true; } })()`, true).catch(() => false);
        if (ok) loadedAt = Date.now();
      }
      if (task < 4) { quiet++; if (quiet >= 2 && loadedAt != null) { quietAt = Date.now(); break; } } else quiet = 0;
    }
    const after = await metrics(wc);
    trace('first-open loop done');
    // The panel's OWN first paint, read from its own PerformanceTimeline and
    // put on the same epoch clock as the click. This is the number with no
    // harness sampling floor in it: when did the tab actually appear.
    row.panel = await wc.executeJavaScript(`(() => {
      const f = document.getElementById('frame-${key}');
      try {
        const w = f.contentWindow;
        const perf = w.performance;
        const o = perf.timeOrigin;
        const paint = {};
        for (const e of perf.getEntriesByType('paint')) paint[e.name] = e.startTime;
        const nav = perf.getEntriesByType('navigation')[0] || {};
        return {
          originEpoch: o,
          firstPaintEpoch: paint['first-paint'] == null ? null : o + paint['first-paint'],
          fcpEpoch: paint['first-contentful-paint'] == null ? null : o + paint['first-contentful-paint'],
          dclEpoch: nav.domContentLoadedEventEnd ? o + nav.domContentLoadedEventEnd : null,
          loadEpoch: nav.loadEventEnd ? o + nav.loadEventEnd : null,
          nodes: w.document.getElementsByTagName('*').length,
        };
      } catch (e) { return { error: String(e && e.message || e) }; }
    })()`, true).catch((e) => ({ error: String(e) }));
    const rel = (v) => (v == null ? null : Math.round(v - tClick));
    if (row.panel && !row.panel.error) {
      row.panelMs = {
        navStart: rel(row.panel.originEpoch),
        firstPaint: rel(row.panel.firstPaintEpoch),
        fcp: rel(row.panel.fcpEpoch),
        domContentLoaded: rel(row.panel.dclEpoch),
        load: rel(row.panel.loadEpoch),
        nodes: row.panel.nodes,
      };
    }
    row.firstOpen = {
      toIframeCompleteMs: loadedAt == null ? null : loadedAt - tClick,
      toQuietMs: quietAt == null ? null : quietAt - tClick,
      scriptMs: round(((after.ScriptDuration || 0) - (before.ScriptDuration || 0)) * 1000, 1),
      layoutMs: round(((after.LayoutDuration || 0) - (before.LayoutDuration || 0)) * 1000, 1),
      styleMs: round(((after.RecalcStyleDuration || 0) - (before.RecalcStyleDuration || 0)) * 1000, 1),
      taskMs: round(((after.TaskDuration || 0) - (before.TaskDuration || 0)) * 1000, 1),
      layouts: (after.LayoutCount || 0) - (before.LayoutCount || 0),
    };

    // ---- IDLE ------------------------------------------------------------
    // --noanim is the A/B control: it stops CSS animations everywhere and
    // nothing else, so the difference between the two runs is the cost of the
    // animations alone. It is a MEASUREMENT, never a proposed fix.
    if (NO_ANIM) {
      row.noAnim = true;
      await wc.executeJavaScript(`(() => {
        const css = '*,*::before,*::after{animation:none !important}';
        const put = (d) => { try { const s = d.createElement('style'); s.textContent = css; d.head.appendChild(s); } catch (_) {} };
        put(document);
        for (const f of document.querySelectorAll('iframe')) { try { if (f.contentDocument) put(f.contentDocument); } catch (_) {} }
        return true;
      })()`, true);
      await sleep(500);
    }
    row.instrumented = await wc.executeJavaScript(INSTALL_COUNTERS, true);
    trace('counters installed: ' + JSON.stringify(row.instrumented));
    stubs.resetCalls();
    sampleProcesses();                       // prime the cpu deltas
    const c0 = await wc.executeJavaScript(READ_COUNTERS, true);
    const m0 = await metrics(wc);
    const cpuSamples = [];
    const tIdle = Date.now();
    for (let i = 0; i < SECONDS; i++) { await sleep(1000); cpuSamples.push(sampleProcesses()); }
    const secs = (Date.now() - tIdle) / 1000;
    const m1 = await metrics(wc);
    const c1 = await wc.executeJavaScript(READ_COUNTERS, true);
    trace('idle sampling done');

    const byName = {};
    for (const a of c0) byName[a.name] = a;
    const frames = c1.map((b) => {
      const a = byName[b.name] || { raf: 0, timeout: 0, interval: 0 };
      return { frame: b.name, rafPerSec: round((b.raf - a.raf) / secs, 2),
        timeoutPerSec: round((b.timeout - a.timeout) / secs, 2),
        intervalArms: b.interval - a.interval };
    }).filter((f) => f.rafPerSec || f.timeoutPerSec || f.intervalArms);

    trace('frames folded');
    const d = deltaMetrics(m0, m1);
    const cpu = {};
    for (const s of cpuSamples) {
      for (const k of Object.keys(s)) {
        const acc = cpu[k] || (cpu[k] = { vals: [], memMB: 0 });
        acc.vals.push(s[k].cpu);
        acc.memMB = round(s[k].mem / 1024, 1);
      }
    }
    const cpuOut = {};
    for (const k of Object.keys(cpu)) {
      const v = cpu[k].vals.slice().sort((a, b) => a - b);
      cpuOut[k] = {
        meanPct: round(v.reduce((a, b) => a + b, 0) / v.length, 2),
        p95Pct: round(v[Math.min(v.length - 1, Math.ceil(0.95 * v.length) - 1)], 2),
        maxPct: round(v[v.length - 1], 2),
        memMB: cpu[k].memMB,
      };
    }

    trace('cpu folded');
    // Name every element that is still animating at idle. A cost without a
    // culprit is not a finding.
    row.animating = await wc.executeJavaScript(`(() => {
      const out = [];
      const scan = (d, where) => {
        try {
          for (const a of d.getAnimations()) {
            const t = a.effect && a.effect.target;
            if (!t || !t.tagName) continue;
            const cs = getComputedStyle(t);
            if (cs.display === 'none' || cs.visibility === 'hidden') continue;
            const it = a.effect.getTiming ? a.effect.getTiming().iterations : null;
            if (a.playState !== 'running') continue;
            const cls = (t.getAttribute('class') || '').trim().split(/\s+/).slice(0, 3).join('.');
            out.push(where + ' ' + t.tagName.toLowerCase() + (t.id ? '#' + t.id : '') + (cls ? '.' + cls : '')
              + ' [' + (a.animationName || (a.effect.getKeyframes ? 'css' : '?')) + (it === Infinity ? ' infinite' : '') + ']');
          }
        } catch (_) {}
      };
      scan(document, 'shell');
      for (const f of document.querySelectorAll('iframe')) { try { if (f.contentDocument) scan(f.contentDocument, f.id); } catch (_) {} }
      return Array.from(new Set(out)).slice(0, 20);
    })()`, true).catch(() => []);
    const ipcTotal = stubs.callTotal();
    const ipcTop = Array.from(stubs.calls.entries()).sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([c, n]) => c + '=' + n);

    row.idle = {
      seconds: round(secs, 1),
      rafPerSec: round(frames.reduce((a, f) => a + (f.rafPerSec || 0), 0), 2),
      timerArmsPerSec: round(frames.reduce((a, f) => a + (f.timeoutPerSec || 0), 0), 2),
      ipcPerSec: round(ipcTotal / secs, 2),
      ipcTop: ipcTop,
      scriptMsPerSec: round((d.ScriptDuration || 0) * 1000 / secs, 2),
      taskMsPerSec: round((d.TaskDuration || 0) * 1000 / secs, 2),
      layoutMsPerSec: round((d.LayoutDuration || 0) * 1000 / secs, 2),
      layoutsPerSec: round((d.LayoutCount || 0) / secs, 2),
      styleRecalcsPerSec: round((d.RecalcStyleCount || 0) / secs, 2),
      heapMB: d.JSHeapUsedSizeMB,
      heapGrowthMB: d.JSHeapGrowthMB,
      nodes: d.Nodes, listeners: d.JSEventListeners, documents: d.Documents,
      perFrame: frames,
      cpu: cpuOut,
    };

    // ---- the same thing with the window hidden ----------------------------
    // backgroundThrottling is off by design, so an occluded window pays full
    // price for anything still running. Worth its own number.
    if (ALSO_OCCLUDED) {
      win.hide();
      stubs.resetCalls();
      sampleProcesses();
      const h0 = await metrics(wc);
      const hc0 = await wc.executeJavaScript(READ_COUNTERS, true);
      const hs = [];
      const th = Date.now();
      for (let i = 0; i < Math.min(SECONDS, 20); i++) { await sleep(1000); hs.push(sampleProcesses()); }
      const hsecs = (Date.now() - th) / 1000;
      const h1 = await metrics(wc);
      const hc1 = await wc.executeJavaScript(READ_COUNTERS, true);
      const b0 = {}; for (const a of hc0) b0[a.name] = a;
      const rafH = hc1.reduce((a, b) => a + (b.raf - ((b0[b.name] || {}).raf || 0)), 0);
      const rend = hs.map((s) => (s.renderer ? s.renderer.cpu : 0));
      row.occluded = {
        seconds: round(hsecs, 1),
        rafPerSec: round(rafH / hsecs, 2),
        scriptMsPerSec: round(((h1.ScriptDuration || 0) - (h0.ScriptDuration || 0)) * 1000 / hsecs, 2),
        ipcPerSec: round(stubs.callTotal() / hsecs, 2),
        rendererCpuMeanPct: round(rend.reduce((a, b) => a + b, 0) / Math.max(1, rend.length), 2),
      };
      win.show();
    }
    trace('row.idle built');
  } catch (err) {
    row.error = String((err && err.message) || err);
    trace('CAUGHT ' + row.error);
  } finally {
    trace('finally: detaching');
    try { wc.debugger.detach(); } catch (_) {}
    trace('finally: destroying');
    try { if (!win.isDestroyed()) win.destroy(); } catch (_) {}
    await sleep(250);
    trace('finally: done');
  }
  report.tabs.push(row);
  const i = row.idle || {};
  process.stderr.write('  ' + key.padEnd(9)
    + ' open ' + String(row.firstOpen && row.firstOpen.toQuietMs).padStart(5) + 'ms'
    + ' (script ' + String(row.firstOpen && row.firstOpen.scriptMs).padStart(6) + 'ms)'
    + '   idle raf/s ' + String(i.rafPerSec).padStart(6)
    + '  script ms/s ' + String(i.scriptMsPerSec).padStart(6)
    + '  ipc/s ' + String(i.ipcPerSec).padStart(5)
    + '  rend cpu ' + String(i.cpu && i.cpu.renderer && i.cpu.renderer.meanPct).padStart(5) + '%\n');
  return row;
}

app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
// Its own profile directory. Sharing the app's userData with a running MIDI
// Studio makes Chromium fail to open its disk caches ("Unable to move the
// cache"), and the first window then pays a multi-second stall that has nothing
// to do with the app -- which is exactly the kind of number a harness must not
// produce. A fresh profile per run also means the shader/code caches are cold
// every time, so runs are comparable to each other.
app.setPath('userData', path.join(os.tmpdir(), 'midi-studio-perf-harness'));
// Each tab is measured in its own window, so between tabs there is a moment
// with no window open at all. Electron's default answer to that is to quit the
// app, which stops the event loop mid-sweep and the run just stops. This
// harness decides when it is finished.
app.on('window-all-closed', () => {});

// ---------------------------------------------------------------------------
//  --boot N : open N fresh shells and report only the paint timeline, with
//  percentiles. This is the "what does the shell do before first paint"
//  measurement, and it needs repeats because paint gating is not deterministic.
// ---------------------------------------------------------------------------
async function bootSweep(n) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    let shell = null;
    try {
      shell = await openShell();
      // Give the paint entries and the img/font watchers time to land.
      await sleep(1500);
      const r = await shell.wc.executeJavaScript(READ_PAINT, true);
      // loadFile -> the splash handing over. Taken from openShell, NOT from the
      // clock here: this function sleeps first, and including that sleep in the
      // number would be a measurement of the harness.
      r.shellReadyMs = shell.bootIpc ? shell.bootIpc.handoverMs : null;
      r.bootIpcCount = shell.bootIpc ? shell.bootIpc.total : null;
      rows.push(r);
      process.stderr.write('  boot ' + (i + 1) + '/' + n + ': first-paint ' + r.firstPaint
        + '  fcp ' + r.fcp + '  img ' + r.imgLoadedAt + '/' + r.imgDecodedAt
        + '  fonts ' + r.fontsReadyAt + '  dcl ' + r.dcl + String.fromCharCode(10));
    } catch (err) {
      process.stderr.write('  boot ' + (i + 1) + ' FAILED ' + err + String.fromCharCode(10));
    } finally {
      try { if (shell) { shell.wc.debugger.detach(); shell.win.destroy(); } } catch (_) {}
      await sleep(300);
    }
  }
  const pctl = (v, q) => { const a = v.filter(Number.isFinite).sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.ceil(q * a.length) - 1)] : null; };
  const col = (k) => {
    const v = rows.map((r) => r[k]).filter((x) => Number.isFinite(x));
    if (!v.length) return null;
    return { mean: round(v.reduce((a, b) => a + b, 0) / v.length, 1), p95: pctl(v, 0.95), max: Math.max.apply(null, v), min: Math.min.apply(null, v) };
  };
  const out = { runs: rows.length, rows: rows };
  for (const k of ['firstPaint', 'fcp', 'imgLoadedAt', 'imgDecodedAt', 'fontsReadyAt', 'dcl', 'domComplete', 'shellReadyMs']) {
    const c = col(k); if (c) out[k] = c;
  }
  console.log('' + String.fromCharCode(10) + 'SHELL FIRST PAINT, ' + rows.length + ' fresh windows, variant=' + VARIANT + ' (ms from navigation start)');
  console.log('  ' + 'what'.padEnd(20) + 'mean'.padStart(9) + 'p95'.padStart(8) + 'max'.padStart(8) + 'min'.padStart(8));
  for (const k of ['firstPaint', 'fcp', 'imgLoadedAt', 'imgDecodedAt', 'fontsReadyAt', 'dcl', 'domComplete', 'shellReadyMs']) {
    const c = out[k]; if (!c) continue;
    console.log('  ' + k.padEnd(20) + String(c.mean).padStart(9) + String(c.p95).padStart(8) + String(c.max).padStart(8) + String(c.min).padStart(8));
  }
  const lt = rows.map((r) => (r.longTasks || []).map((t) => t.join('+')).join(' ')).filter(Boolean);
  if (lt.length) { console.log('  long tasks (start+duration ms):'); for (const l of lt) console.log('    ' + l); }
  return out;
}

app.whenReady().then(async () => {
  stubs.registerStubs();
  const BOOT_N = Number(flag('--boot', 0));
  if (BOOT_N > 0) {
    const boot = await bootSweep(BOOT_N);
    if (JSON_OUT) {
      const out = path.resolve(ROOT, JSON_OUT);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), mode: 'boot', boot: boot }, null, 2), 'utf-8');
      console.log(String.fromCharCode(10) + 'wrote ' + JSON_OUT);
    }
    console.log('');
    app.exit(0);
    return;
  }
  const report = {
    at: new Date().toISOString(), seconds: SECONDS, size: SIZE.join('x'),
    platform: os.platform() + ' ' + os.release(), cores: os.cpus().length,
    cpu: (os.cpus()[0] || {}).model || '',
    note: 'renderer measured against tools/ipc-stubs.js; electron/main.js not booted',
    tabs: [],
  };
  process.stderr.write('\nIDLE + FIRST-OPEN  ' + SECONDS + 's per tab, ' + SIZE.join('x') + '\n\n');
  for (const key of TABS) await measureTab(key, report);

  // ---- the shell boot timeline, printed once (it is the same every time) ----
  const first = report.tabs.find((t) => t.timeline) || {};
  const tl = first.timeline || {};
  console.log('\nSHELL BOOT TIMELINE (renderer clock, ms from navigation start)');
  for (const p of tl.paints || []) console.log('  ' + p.name.padEnd(26) + String(p.at).padStart(8));
  console.log('  ' + 'document.fonts.ready'.padEnd(26) + String(tl.fontsReadyAt).padStart(8));
  console.log('  ' + 'domContentLoaded'.padEnd(26) + String(tl.domContentLoaded).padStart(8));
  console.log('  ' + 'domComplete'.padEnd(26) + String(tl.domComplete).padStart(8));
  console.log('\n  slowest-finishing resources before/around first paint');
  for (const r of (tl.resources || []).slice(0, 14)) {
    console.log('    ' + String(round(r.start, 1)).padStart(7) + ' +' + String(round(r.dur, 1)).padStart(7)
      + 'ms  ' + String(Math.round(r.size / 1024) + 'KB').padStart(7) + '  ' + r.kind.padEnd(10) + r.name);
  }

  const bi = (report.tabs.find((t) => t.bootIpc) || {}).bootIpc;
  const biForge = (report.tabs.find((t) => t.tab === 'forge' && t.bootIpc) || {}).bootIpc;
  if (bi) {
    console.log(String.fromCharCode(10) + 'IPC ON THE BOOT PATH (renderer -> main, to hand-over at '
      + bi.handoverMs + 'ms): ' + bi.total + ' invocations, ' + bi.pushes + ' pushes back');
    console.log('  ' + bi.order.join('  '));
  }
  if (biForge && biForge !== bi) {
    console.log('  with Forge as the restored tab: ' + biForge.total + ' invocations');
    console.log('  ' + biForge.order.join('  '));
  }
  console.log(String.fromCharCode(10) + 'FIRST OPEN OF EACH TAB (fresh window each; ms from the click on the nav item)');
  console.log('  ' + 'tab'.padEnd(10) + 'navStart'.padStart(9) + 'paint'.padStart(8) + 'FCP'.padStart(8)
    + 'DCL'.padStart(8) + 'load'.padStart(8) + 'quiet'.padStart(8)
    + 'script'.padStart(9) + 'style'.padStart(8) + 'layout'.padStart(8) + 'task'.padStart(9) + 'nodes'.padStart(8));
  for (const t of report.tabs) {
    const f = t.firstOpen || {}; const p = t.panelMs || {};
    console.log('  ' + t.tab.padEnd(10) + String(p.navStart).padStart(9) + String(p.firstPaint).padStart(8)
      + String(p.fcp).padStart(8) + String(p.domContentLoaded).padStart(8) + String(p.load).padStart(8)
      + String(f.toQuietMs).padStart(8)
      + String(f.scriptMs).padStart(9) + String(f.styleMs).padStart(8) + String(f.layoutMs).padStart(8)
      + String(f.taskMs).padStart(9) + String(p.nodes).padStart(8));
  }
  console.log('  (script/style/layout/task are RENDERER main-thread ms charged between the click and quiet,');
  console.log('   from the DevTools Performance domain; quiet keeps a ~240ms sampling floor.)');

  console.log('\nIDLE, per tab (' + SECONDS + 's, nothing playing)');
  console.log('  ' + 'tab'.padEnd(10) + 'raf/s'.padStart(8) + 'timer/s'.padStart(9) + 'ipc/s'.padStart(8)
    + 'scriptms/s'.padStart(12) + 'taskms/s'.padStart(10) + 'layout/s'.padStart(10)
    + 'rendCPU%'.padStart(10) + 'gpuCPU%'.padStart(9) + 'heapMB'.padStart(8));
  for (const t of report.tabs) {
    const i = t.idle || {}; const c = i.cpu || {};
    console.log('  ' + t.tab.padEnd(10) + String(i.rafPerSec).padStart(8) + String(i.timerArmsPerSec).padStart(9)
      + String(i.ipcPerSec).padStart(8) + String(i.scriptMsPerSec).padStart(12) + String(i.taskMsPerSec).padStart(10)
      + String(i.layoutsPerSec).padStart(10)
      + String(c.renderer && c.renderer.meanPct).padStart(10)
      + String(c.gpu && c.gpu.meanPct).padStart(9) + String(i.heapMB).padStart(8));
  }
  for (const t of report.tabs) {
    const i = t.idle || {};
    if (t.animating && t.animating.length) console.log('  ' + t.tab + ' STILL ANIMATING AT IDLE: ' + t.animating.join(' | '));
    if (i.ipcTop && i.ipcTop.length) console.log('  ' + t.tab + ' idle ipc: ' + i.ipcTop.join(' '));
    for (const f of (i.perFrame || [])) {
      console.log('    ' + t.tab + ' / ' + f.frame + ': raf/s ' + f.rafPerSec + ' timeout/s ' + f.timeoutPerSec + ' new intervals ' + f.intervalArms);
    }
  }
  if (ALSO_OCCLUDED) {
    console.log('\nIDLE WITH THE WINDOW HIDDEN (throttling is disabled by design)');
    for (const t of report.tabs) {
      const o = t.occluded; if (!o) continue;
      console.log('  ' + t.tab.padEnd(10) + 'raf/s ' + String(o.rafPerSec).padStart(7)
        + '  script ms/s ' + String(o.scriptMsPerSec).padStart(7)
        + '  ipc/s ' + String(o.ipcPerSec).padStart(6)
        + '  rend cpu ' + String(o.rendererCpuMeanPct).padStart(6) + '%');
    }
  }

  if (JSON_OUT) {
    const out = path.resolve(ROOT, JSON_OUT);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(report, null, 2), 'utf-8');
    console.log('\nwrote ' + JSON_OUT);
  }
  console.log('');
  app.exit(0);
});

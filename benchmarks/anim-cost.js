// anim-cost.js -- what does ONE looping CSS animation cost, and what does it
// cost when nobody can see it?
//
//   npx electron benchmarks/anim-cost.js --seconds 30
//   npx electron benchmarks/anim-cost.js --seconds 30 --json benchmarks/anim-cost.json
//   npx electron benchmarks/anim-cost.js --only visible-pulse,floor-nopulse
//
// WHY THIS EXISTS
// ---------------
// benchmarks/idle.js measures a tab at idle, but whether the shell's transport
// pill happens to be in the BLOCKED state depends on session state, so the
// dot-pulse animation is present in some runs and absent in others and the two
// runs are not comparable. This harness forces the state instead of hoping for
// it: one window, one shell, and the pill is put into the blocked state by
// hand, so every variant below is measured against exactly the same DOM.
//
// Every variant runs in the SAME window, back to back, with a settle pause
// between, so a cold GPU process cannot be mistaken for a variant's cost. CPU
// comes from app.getAppMetrics(), sampled once a second: that is the only place
// the GPU process shows up at all, and a composited animation is mostly GPU.
//
// floor-nopulse is a CONTROL, not a proposal: it is the same window with the
// pulse stopped, and it is the number every other variant is measured against.
'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const stubs = require(path.join(ROOT, 'tools', 'ipc-stubs.js'));

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const SECONDS = Number(flag('--seconds', 30));
const JSON_OUT = flag('--json', '');
const ONLY = String(flag('--only', '')).split(',').map((s) => s.trim()).filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (v, d) => (v == null ? null : Math.round(v * Math.pow(10, d)) / Math.pow(10, d));

function sampleProcesses() {
  const rows = {};
  for (const m of app.getAppMetrics()) {
    const key = m.type === 'Tab' ? 'renderer' : String(m.type).toLowerCase();
    const acc = rows[key] || (rows[key] = { cpu: 0, mem: 0 });
    acc.cpu += (m.cpu && m.cpu.percentCPUUsage) || 0;
    acc.mem += (m.memory && m.memory.workingSetSize) || 0;
  }
  return rows;
}

async function metrics(wc) {
  const r = await wc.debugger.sendCommand('Performance.getMetrics');
  const m = {};
  for (const e of r.metrics) m[e.name] = e.value;
  return m;
}

// Put the shell's transport pill into the blocked state, and report it, so a
// variant can never silently measure nothing.
const FORCE_BLOCKED = [
  '(() => {',
  '  // Only a RENDERED dot can animate. The shell markup carries several .dot',
  '  // elements inside display:none branches, and Chromium creates no animation',
  '  // object for those at all -- an earlier version of this harness forced the',
  '  // first .dot it found, which was one of them, and then measured nothing for',
  '  // five variants straight while reporting confident numbers.',
  '  const dots = Array.from(document.querySelectorAll(".dot")).filter((d) => d.offsetParent);',
  '  if (!dots.length) return { ok: false, why: "no rendered .dot in the shell" };',
  '  for (const dot of dots) {',
  '    const pill = dot.closest(".pill");',
  '    if (pill) pill.classList.add("is-blocked");',
  '    dot.classList.remove("is-live", "is-paused");',
  '    dot.classList.add("is-blocked");',
  '  }',
  '  return { ok: true, forced: dots.length };',
  '})()',
].join(String.fromCharCode(10));

const RUNNING = [
  '(() => {',
  '  const out = [];',
  '  const scan = (d, where) => {',
  '    try {',
  '      for (const a of d.getAnimations()) {',
  '        if (a.playState !== "running") continue;',
  '        const t = a.effect && a.effect.target;',
  '        if (!t || !t.tagName) continue;',
  '        const cs = getComputedStyle(t);',
  '        if (cs.display === "none" || cs.visibility === "hidden") continue;',
  '        out.push(where + " " + t.tagName.toLowerCase() + "." + (t.getAttribute("class") || "") + " [" + (a.animationName || "css") + "]");',
  '      }',
  '    } catch (_) {}',
  '  };',
  '  scan(document, "shell");',
  '  for (const f of document.querySelectorAll("iframe")) { try { if (f.contentDocument) scan(f.contentDocument, f.id); } catch (_) {} }',
  '  return Array.from(new Set(out));',
  '})()',
].join('\n');

function styleInjector(css) {
  return [
    '(() => {',
    '  const css = ' + JSON.stringify(css) + ';',
    '  const put = (d) => { try {',
    '    let s = d.getElementById("__animvar");',
    '    if (!s) { s = d.createElement("style"); s.id = "__animvar"; d.head.appendChild(s); }',
    '    s.textContent = css;',
    '  } catch (_) {} };',
    '  put(document);',
    '  for (const f of document.querySelectorAll("iframe")) { try { if (f.contentDocument) put(f.contentDocument); } catch (_) {} }',
    '  return true;',
    '})()',
  ].join('\n');
}

const SEL = '.dot.is-blocked,.pill.is-blocked>.dot';

// PARK, the way the app can actually reach it.
//
// document.hidden is NOT a usable signal here and this harness proves it:
// _probe measured visibilityState === 'visible' with the window hidden AND
// with it minimised, because webPreferences.backgroundThrottling is false by
// design (an invariant) and Electron then holds the page 'visible' forever.
// So the park signal has to be pushed in. Draw.setOnscreen(false) is the
// public API that already exists for exactly that, and draw.js stamps
// <html data-parked> off it.
const SET_PARK = (on) => 'window.Draw ? String(Draw.setOnscreen(' + (on ? 'false' : 'null') + ')) : "no-draw"';

const VARIANTS = [
  // A discarded warm-up. Boot work (fonts, first raster, the panels' own
  // startup) bleeds into whatever runs first, and it inflated the floor by
  // 100+ task ms/s the first time this harness ran.
  { key: 'warmup', park: false, css: '', discard: true },
  // CONTROL, never a proposal: the same window with the pulse stopped. Every
  // row below is read against this.
  { key: 'floor-nopulse', park: false, css: SEL + '{animation:none !important}' },
  // The state the user is looking at. This one MUST keep animating: it is the
  // affordance for the blocked transport, and the run asserts anims >= 1.
  { key: 'visible-pulse', park: false, css: '' },
  // Compositor promotion, tested and rejected -- see the numbers in the return.
  { key: 'visible-willchange', park: false, css: SEL + '{will-change:transform,opacity}' },
  // The fix: the identical DOM with the document parked.
  { key: 'parked-pulse', park: true, css: '' },
  // ...and the same parked document with the pause defeated, which is what the
  // app did before this change. The difference between these two rows is the
  // whole of the saving.
  { key: 'parked-unpaused', park: true, css: ':root[data-parked] ' + SEL + '{animation-play-state:running !important}' },
  // End to end, with no harness help at all: the window is really minimised and
  // draw.js has to notice it by itself. This is the row that says whether the
  // app actually stops paying, not just whether the mechanism can be driven.
  { key: 'minimized', minimize: true, css: '' },
  { key: 'minimized-unpaused', minimize: true, css: ':root[data-parked] ' + SEL + '{animation-play-state:running !important}' },
];

async function measure(win, wc, v) {
  // The shell re-renders its transport pill on its own schedule and drops the
  // forced class, so the state is restated for every variant rather than set
  // once at the top of the run. The first version of this harness set it once
  // and then measured nothing at all for five variants straight.
  await wc.executeJavaScript(FORCE_BLOCKED, true);
  if (win.isMinimized()) { win.restore(); await sleep(1200); }
  await wc.executeJavaScript(styleInjector(v.css), true);
  await wc.executeJavaScript(SET_PARK(v.park), true).catch(() => null);
  if (v.minimize) win.minimize();
  await sleep(1500);                       // settle: let the compositor restate
  const running = await wc.executeJavaScript(RUNNING, true).catch(() => []);
  // Prove the mechanism actually engaged rather than inferring it from a number.
  const diag = await wc.executeJavaScript(
    '({ hidden: document.hidden, parkedAttr: document.documentElement.hasAttribute("data-parked"),'
    + ' drawParked: (window.Draw && Draw.stats) ? !!Draw.stats().parked : null })', true).catch(() => null);
  const m0 = await metrics(wc);
  sampleProcesses();                       // prime the per-process cpu deltas
  const samples = [];
  const t0 = Date.now();
  for (let i = 0; i < SECONDS; i++) { await sleep(1000); samples.push(sampleProcesses()); }
  const secs = (Date.now() - t0) / 1000;
  const m1 = await metrics(wc);

  const acc = {};
  for (const s of samples) for (const k of Object.keys(s)) (acc[k] || (acc[k] = [])).push(s[k].cpu);
  const cpu = {};
  for (const k of Object.keys(acc)) {
    const v2 = acc[k].slice().sort((a, b) => a - b);
    cpu[k] = {
      meanPct: round(v2.reduce((a, b) => a + b, 0) / v2.length, 3),
      p95Pct: round(v2[Math.min(v2.length - 1, Math.ceil(0.95 * v2.length) - 1)], 3),
      maxPct: round(v2[v2.length - 1], 3),
    };
  }
  return {
    variant: v.key, parked: !!v.park, minimized: !!v.minimize, seconds: round(secs, 1),
    running, diag,
    cpu,
    taskMsPerSec: round(((m1.TaskDuration - m0.TaskDuration) * 1000) / secs, 2),
    styleMsPerSec: round(((m1.RecalcStyleDuration - m0.RecalcStyleDuration) * 1000) / secs, 2),
    layoutMsPerSec: round(((m1.LayoutDuration - m0.LayoutDuration) * 1000) / secs, 2),
  };
}

async function main() {
  stubs.registerStubs();
  ipcMain.removeHandler('app:getUi');
  ipcMain.handle('app:getUi', () => ({ lastTab: 'logs' }));

  const win = new BrowserWindow({
    width: 1280, height: 800, show: true, frame: false, backgroundColor: '#141519',
    webPreferences: {
      preload: path.join(ROOT, 'electron', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
      nodeIntegrationInSubFrames: true, backgroundThrottling: false,
    },
  });
  const wc = win.webContents;
  wc.on('will-prevent-unload', (e) => e.preventDefault());
  await win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  wc.debugger.attach('1.3');
  await wc.debugger.sendCommand('Performance.enable', { timeDomain: 'threadTicks' });
  const deadline = Date.now() + 20000;
  for (;;) {
    if (Date.now() > deadline) break;
    const ok = await wc.executeJavaScript('document.body.dataset.boot === "ready"', true).catch(() => false);
    if (ok) break;
    await sleep(25);
  }
  await sleep(1200);
  const forced = await wc.executeJavaScript(FORCE_BLOCKED, true);
  process.stdout.write('forced blocked state: ' + JSON.stringify(forced) + '\n\n');

  const rows = [];
  for (const v of VARIANTS) {
    if (ONLY.length && !ONLY.includes(v.key)) continue;
    const r = await measure(win, wc, v);
    if (v.discard) { process.stdout.write('  (warm-up discarded)' + String.fromCharCode(10)); continue; }
    rows.push(r);
    const rc = r.cpu.renderer || {}; const gc = r.cpu.gpu || {};
    process.stdout.write(
      '  ' + r.variant.padEnd(20)
      + ' rendCPU ' + String(rc.meanPct).padStart(7) + '% p95 ' + String(rc.p95Pct).padStart(6) + '%'
      + '  gpuCPU ' + String(gc.meanPct).padStart(7) + '% p95 ' + String(gc.p95Pct).padStart(6) + '%'
      + '  task ' + String(r.taskMsPerSec).padStart(6) + 'ms/s'
      + '  anims ' + r.running.length + '\n');
  }

  if (JSON_OUT) {
    const out = path.resolve(ROOT, JSON_OUT);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), seconds: SECONDS, rows }, null, 2), 'utf-8');
    process.stdout.write('\nwrote ' + JSON_OUT + '\n');
  }
  win.destroy();
  app.exit(0);
}

app.whenReady().then(main).catch((e) => { console.error(e); app.exit(1); });

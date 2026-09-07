// player-render-bench.js: what the Player's visualizer costs per frame, and
// whether it allocates.
//
//   npx electron tools/player-render-bench.js
//   npx electron tools/player-render-bench.js --notes 20000 --frames 900
//   npx electron tools/player-render-bench.js --json benchmarks/player-render.json
//
// Why a real window and not jsdom: the numbers we want are canvas raster cost
// and V8 heap growth, and neither exists outside a real compositor. This boots
// the same BrowserWindow shape the app uses (the layout-audit.js pattern), then
// loads renderer/shared/tokens.js, draw.js and player/visualizer.js into a bare
// page and drives Visualizer.render() directly.
//
// Driving render() directly rather than through Draw.register is deliberate:
// Draw's whole job is to SKIP frames against a budget, so measuring through it
// measures the scheduler's restraint instead of the cost of the work. What we
// need to know is what one frame costs when it is not skipped, because that is
// the CPU the machine spends while notes are being dispatched in another
// process.
//
// Reported per run:
//   frame_ms          mean/p50/p95/p99/max for one full render()
//   heap_bytes_per_frame  V8 heap growth per frame with GC forced before and
//                     after, which is allocation the render loop is doing
//   gc_events         major/minor GC count during the window, via
//                     PerformanceObserver on 'gc' entries
//   long_frames       frames over 16.7 ms (a dropped frame at 60 Hz)
//
// The visualizer must interpolate from playback state and never drive it
// (SYNTHESIS invariant 17), so nothing here feeds anything back: the clock is
// advanced by clockSet(), exactly as a progress packet would.
'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const NOTES = Number(flag('--notes', '8000'));
const FRAMES = Number(flag('--frames', '600'));
const W = Number(flag('--width', '1280'));
const H = Number(flag('--height', '620'));
const OUT = flag('--json', '');
// Electron on Windows is a GUI subsystem binary, so console.log never reaches
// the terminal that launched it (layout-audit.js writes a JSON file for the same
// reason). Everything printed here is also appended to a log file so a run is
// readable whichever way it was started.
const LOG = path.join(ROOT, 'benchmarks', 'player-render.log');
try { fs.writeFileSync(LOG, ''); } catch (e) { /* first run, no dir */ }
const say = (line) => {
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch (e) { /* nothing to do */ }
};
process.on('uncaughtException', (e) => {
  say('UNCAUGHT ' + (e && e.stack || e));
  try { app.exit(1); } catch (_) { process.exit(1); }
});
process.on('unhandledRejection', (e) => {
  say('UNHANDLED ' + (e && e.stack || e));
  try { app.exit(1); } catch (_) { process.exit(1); }
});

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function page() {
  // A bare host page: the token layer, the draw scheduler and the visualizer,
  // inlined so there is no file:// scheme or CSP question to answer.
  return `<!doctype html><html data-theme="dark" data-onscreen="1" data-drawms="16">
<head><meta charset="utf-8"><style>
  html,body{margin:0;background:#0f1013;overflow:hidden}
  canvas{display:block;width:${W}px;height:${H}px}
</style></head>
<body><canvas id="c" width="${W}" height="${H}"></canvas>
<script>${read('renderer/shared/tokens.js')}</script>
<script>${read('renderer/shared/draw.js')}</script>
<script>${read('renderer/player/visualizer.js')}</script>
</body></html>`;
}

// The measurement, run inside the page. Kept as one string so it is obvious
// that nothing from this process leaks into the timings.
//
// The loop is driven by setTimeout, not requestAnimationFrame: an Electron
// window that has never been shown produces no compositor frames, so rAF never
// fires and the probe hangs. What is being measured is the COST of one
// render() call, and rAF only paces when it happens, so removing it changes
// nothing about the number and makes the harness deterministic.
const PROBE = (notes, frames) => `(() => {
  const stat = (a) => {
    const s = [...a].sort((x, y) => x - y), n = s.length;
    const at = (p) => s[Math.min(n - 1, Math.floor(p * n))];
    return { n, mean: +(s.reduce((x, y) => x + y, 0) / n).toFixed(4),
             p50: +at(0.5).toFixed(4), p95: +at(0.95).toFixed(4),
             p99: +at(0.99).toFixed(4), max: +s[n - 1].toFixed(4) };
  };

  // Visualizer.load() takes the engine's wire shape: [t, key, dur, note, ch].
  // A dense, realistic set -- two interleaved voices plus 4-note chords, the
  // same shape as benchmarks/fixtures/player-dense.mid.
  const evs = [];
  const dur = ${notes} / 30;
  for (let i = 0; i < ${notes}; i++) {
    const t = (i / ${notes}) * dur;
    if ((i % 7) === 0) {
      const root = 36 + (i % 12);
      for (const off of [0, 4, 7, 12]) evs.push([t, 'a', 0.35, root + off, 1]);
    } else {
      evs.push([t, 'a', 0.12, 60 + (i % 24), 0]);
    }
  }
  evs.sort((a, b) => a[0] - b[0]);

  const map = {};
  for (let n = 36; n <= 96; n++) map[n] = 'k';

  const cv = document.getElementById('c');
  const ctx = cv.getContext('2d', { alpha: false });
  const viz = new Visualizer();
  viz.load(evs, map);
  viz.startClock(dur, 0);

  const gc = { major: 0, minor: 0, total: 0 };
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        gc.total++;
        if ((e.detail && e.detail.kind) === 'major') gc.major++; else gc.minor++;
      }
    }).observe({ entryTypes: ['gc'] });
  } catch (e) { gc.unsupported = true; }

  const heapNow = () => (performance.memory ? performance.memory.usedJSHeapSize : 0);
  const visible = () => {
    // How many notes this frame actually paints, so cost can be read per note
    // rather than per frame.
    const el = viz.elapsed();
    let c = 0;
    for (let i = 0; i < viz.events.length; i++) {
      const e = viz.events[i];
      if (e.t > el + viz.lookahead) break;
      if (e.t + e.dur >= el - 0.25) c++;
    }
    return c;
  };

  return new Promise((resolve, reject) => {
    const times = [];
    let i = 0, heap0 = 0, vis = 0;
    const WARM = 60;   // first frames build the LayerCache and JIT the paths
    const step = () => {
      try {
        // Advance the clock the way a progress packet does. The visualizer
        // interpolates; it is never the source of time.
        viz.clockSet({ elapsed: (i / 60) % dur, frozen_elapsed: null });
        const t0 = performance.now();
        viz.render(ctx, ${W}, ${H});
        const t1 = performance.now();
        if (i === WARM) { heap0 = heapNow(); vis = visible(); }
        if (i >= WARM) times.push(t1 - t0);
        i++;
        if (i >= ${frames} + WARM) {
          const heap1 = heapNow();
          const s = stat(times);
          resolve({
            frames: s.n, notes: evs.length, notes_visible_per_frame: vis,
            frame_ms: s,
            us_per_visible_note: vis ? +((s.mean * 1000) / vis).toFixed(2) : null,
            long_frames_16_7ms: times.filter((x) => x > 16.7).length,
            long_frames_33ms: times.filter((x) => x > 33).length,
            heap_start: heap0, heap_end: heap1,
            heap_growth_bytes: heap1 - heap0,
            heap_bytes_per_frame: +((heap1 - heap0) / s.n).toFixed(1),
            gc,
          });
          return;
        }
        setTimeout(step, 0);
      } catch (e) { reject(String(e && e.stack || e)); }
    };
    step();
  });
})()`;

app.commandLine.appendSwitch('js-flags', '--expose-gc');
app.disableHardwareAcceleration ? null : null;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: W + 40, height: H + 60, show: false,
    webPreferences: { backgroundThrottling: false, offscreen: false },
  });
  const out = { when: new Date().toISOString(), notes: NOTES, frames: FRAMES,
                size: [W, H], runs: {} };
  try {
    say('boot: writing host page');
    const html = page();
    const hostFile = path.join(ROOT, 'benchmarks', '.player-render-host.html');
    fs.writeFileSync(hostFile, html);
    say('boot: host page ' + html.length + ' bytes -> ' + hostFile);
    await win.loadFile(hostFile);
    say('boot: loaded');
    await new Promise((r) => setTimeout(r, 600));
    const ok = await win.webContents.executeJavaScript(
      'typeof Visualizer + "/" + typeof Draw + "/" + typeof Tokens', true);
    say('boot: globals ' + ok);
    win.webContents.on('render-process-gone', (_e, d) => say('RENDERER GONE ' + JSON.stringify(d)));

    out.runs.visualizer = await win.webContents.executeJavaScript(PROBE(NOTES, FRAMES), true);
    console.log('\n=== Player visualizer render cost ===');
    const r = out.runs.visualizer;
    say(`  ${r.notes} notes total, ${r.notes_visible_per_frame} visible per frame, `
      + `${r.frames} timed frames at ${W}x${H}`);
    say(`  frame_ms   mean ${r.frame_ms.mean}  p50 ${r.frame_ms.p50}  `
      + `p95 ${r.frame_ms.p95}  p99 ${r.frame_ms.p99}  max ${r.frame_ms.max}`);
    say(`  dropped-frame candidates: ${r.long_frames_16_7ms} over 16.7ms, `
      + `${r.long_frames_33ms} over 33ms`);
    say(`  heap growth ${r.heap_growth_bytes} B over ${r.frames} frames `
      + `= ${r.heap_bytes_per_frame} B/frame`);
    say(`  ${r.us_per_visible_note} us per visible note`);
    say(`  GC entries: ${JSON.stringify(r.gc)}`);
  } catch (e) {
    out.error = String(e && e.stack || e);
    say('ERROR ' + out.error);
  } finally {
    try { win.destroy(); } catch (e) { /* already gone */ }
  }
  if (OUT) {
    fs.writeFileSync(path.resolve(ROOT, OUT), JSON.stringify(out, null, 2));
    console.log('\nwrote ' + OUT);
  }
  app.exit(out.error ? 1 : 0);
});

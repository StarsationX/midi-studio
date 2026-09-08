// editor-idle-after-gesture.js: after a gesture ends, does the Editor go back
// to sleep?
//
//   npx electron benchmarks/editor-idle-after-gesture.js
//
// renderer/review/review.js raises the canvases' draw rate for the duration of
// a gesture (Draw.setLive) and releases it again on pointerup, pointercancel and
// a short timeout for the gestures that have no release event. A reference that
// is taken and never given back would leave the panel asking for frames forever,
// which is the one way that change could cost anything, so this measures the
// resting repaint rate BEFORE any gesture and AFTER each kind of gesture: a
// scroll burst, a wheel zoom, a marquee, a note drag, and a marquee that is
// CANCELLED rather than released.
//
// Counting is done by marking the roll canvas's own clearRect, the same way
// benchmarks/editor-interact.js does, so nothing in renderer/ is modified.
'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures');
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const FILE = path.join(FIXTURES, flag('--file', 'big-10k.mid'));
const REST_MS = Number(flag('--rest', '2000'));
const JSON_AT = flag('--json', '');

const HANDLERS = {
  'app:getUi': () => ({ ok: true, ui: {} }),
  'app:settings': () => ({ ok: true, settings: {} }),
  'settings:get': () => ({ ok: true, value: null }),
  'settings:set': () => ({ ok: true }),
  'review:pick': () => '',
  'review:load': () => ({ ok: false, error: 'harness uses the renderer reader' }),
  'review:saveProject': () => ({ ok: false, canceled: true }),
  'review:exportMidi': () => ({ ok: false, canceled: true }),
  'library:list': () => ({ dirs: [], extra: [], files: [], truncated: false }),
  'shell:openPath': () => ({ ok: true }),
};

app.on('window-all-closed', () => {});

const INSTALL = `(() => {
  const P = { draws: 0 };
  window.__I = P;
  const rc = document.getElementById('roll').getContext('2d');
  const cr = rc.clearRect;
  rc.clearRect = function (a, b, c, d) { P.draws++; return cr.call(this, a, b, c, d); };
  const roll = document.getElementById('roll');
  const scroller = document.getElementById('roll-scroll');
  const pe = (type, x, y, extra) => roll.dispatchEvent(new PointerEvent(type, Object.assign({
    bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: 'mouse',
    button: type === 'pointermove' ? -1 : 0, buttons: 1, clientX: x, clientY: y, isPrimary: true }, extra || {})));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Frames counted over a window in which nothing at all happens.
  P.rest = async (ms) => { P.draws = 0; await sleep(ms); return P.draws; };

  P.scroll = async () => {
    for (let i = 0; i < 20; i++) { scroller.scrollLeft += 24; await sleep(8); }
  };
  P.zoom = async () => {
    for (let i = 0; i < 20; i++) {
      scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true,
        ctrlKey: true, deltaY: -40, clientX: 500, clientY: 300 }));
      await sleep(8);
    }
  };
  P.marquee = async () => {
    const r = roll.getBoundingClientRect();
    pe('pointerdown', r.left + 300, r.top + 200);
    for (let i = 0; i < 20; i++) { pe('pointermove', r.left + 300 + i * 12, r.top + 200 + i * 6); await sleep(8); }
    pe('pointerup', r.left + 540, r.top + 320);
  };
  P.marqueeCancel = async () => {
    const r = roll.getBoundingClientRect();
    pe('pointerdown', r.left + 300, r.top + 200);
    for (let i = 0; i < 10; i++) { pe('pointermove', r.left + 300 + i * 12, r.top + 200 + i * 6); await sleep(8); }
    pe('pointercancel', r.left + 420, r.top + 260);
  };
  P.selectAllDrag = async () => {
    document.getElementById('s-all').click();
    await sleep(60);
    const r = roll.getBoundingClientRect();
    // press on a note: the widest note near the start of the song
    const ex = document.getElementById('roll-extent');
    pe('pointerdown', r.left + 200, r.top + 200);
    for (let i = 0; i < 20; i++) { pe('pointermove', r.left + 200 + i * 6, r.top + 200); await sleep(8); }
    pe('pointerup', r.left + 320, r.top + 200);
  };
  return 'ok';
})()`;

(async () => {
  await app.whenReady();
  for (const [ch, fn] of Object.entries(HANDLERS)) {
    ipcMain.removeHandler(ch);
    ipcMain.handle(ch, async (_e, a) => { try { return await fn(a); } catch (e) { return { ok: false, error: String(e) }; } });
  }
  for (const ch of ['win:minimize', 'win:maximize', 'win:unmaximize', 'win:toggleMaximize', 'win:close']) {
    ipcMain.removeAllListeners(ch); ipcMain.on(ch, () => {});
  }

  const win = new BrowserWindow({ width: 1600, height: 1000, show: true,
    webPreferences: { preload: path.join(ROOT, 'electron', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
      nodeIntegrationInSubFrames: true, backgroundThrottling: false } });
  const out = { at: new Date().toISOString(), file: path.basename(FILE), restMs: REST_MS, rest: {} };
  try {
    await win.loadFile(path.join(ROOT, 'renderer', 'review', 'index.html'));
    win.focus(); win.webContents.focus();
    await new Promise((r) => setTimeout(r, 900));
    const okInstall = await win.webContents.executeJavaScript(INSTALL);
    if (okInstall !== 'ok') throw new Error('probe install failed');
    await win.webContents.executeJavaScript(`window.openReviewProject(${JSON.stringify(FILE)})`);
    await new Promise((r) => setTimeout(r, 800));

    const rest = async (label, before) => {
      if (before) await win.webContents.executeJavaScript('window.__I.' + before + '()');
      await new Promise((r) => setTimeout(r, 400));   // let any release timer expire
      const n = await win.webContents.executeJavaScript(`window.__I.rest(${REST_MS})`);
      out.rest[label] = n;
      console.log('  rest after ' + label.padEnd(16) + n + ' roll repaints in ' +
        (REST_MS / 1000) + 's  = ' + (n / (REST_MS / 1000)).toFixed(2) + ' fps');
      return n;
    };
    console.log('\nresting repaint rate (0 = the panel went back to sleep)');
    await rest('open', null);
    await rest('scroll', 'scroll');
    await rest('wheel zoom', 'zoom');
    await rest('marquee', 'marquee');
    await rest('marquee cancel', 'marqueeCancel');
    await rest('note drag', 'selectAllDrag');
    const worst = Math.max(...Object.values(out.rest));
    out.pass = worst === 0;
    console.log('\n' + (out.pass ? 'PASS: every gesture released the draw rate'
      : 'FAIL: something is still asking for frames at rest (worst ' + worst + ')'));
  } catch (e) {
    process.stderr.write('FATAL ' + ((e && e.stack) || e) + '\n');
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
  }
  if (JSON_AT) fs.writeFileSync(JSON_AT, JSON.stringify(out, null, 2));
  app.exit(out.pass ? 0 : 1);
})();

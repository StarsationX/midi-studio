// editor-ipc-shapes.js: how much of the Editor's open latency is the IPC hop
// itself, and which payload shape is cheapest to hand a large document to the
// renderer.
//
//   npx electron benchmarks/editor-ipc-shapes.js
//   npx electron benchmarks/editor-ipc-shapes.js --json benchmarks/editor-ipc-shapes.json
//
// Three shapes, each measured twice -- once over raw ipcRenderer and once through
// a contextBridge preload, because the app's preload uses contextBridge and that
// adds a SECOND deep copy on top of the IPC structured clone:
//
//   objects  the document exactly as electron/main.js returns it today
//   str      the same document as one JSON string, JSON.parse'd in the renderer
//   cols     six typed arrays (pitch/velocity/channel/unterminated as Uint8,
//            start/end as Float64) plus a small meta object, with the renderer
//            rebuilding the very same note objects the editor works on -- so the
//            comparison is like for like and includes the rebuild
//
// Nothing in electron/ or renderer/ is touched: the channels here are the
// harness's own, and the documents come from
// benchmarks/editor-load-candidate-lib.js so the note distribution is a real
// transcription's.
//
// Run it ALONE. Two Electron instances at once was enough to make these numbers
// (and the editor-interact run) meaningless.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const ROOT = require('path').resolve(__dirname, '..');
const load = require('./editor-load-candidate-lib.js');
app.on('window-all-closed', () => {});
const docs = {};
for (const [k, f] of [['2k','normal.mid'],['10k','big-10k.mid'],['50k','huge-50k.mid'],['120k','massive-120k.mid']]) {
  docs[k] = load(fs.readFileSync(require('path').join(ROOT, 'benchmarks', 'fixtures') + '/' + f), require('path').join(ROOT, 'benchmarks', 'fixtures') + '/' + f);
}
let cur = '2k';
const strCache = {};
ipcMain.handle('v:objects', () => ({ ok: true, data: { documents: { clean: docs[cur] } } }));
ipcMain.handle('v:string', () => {
  if (!strCache[cur]) strCache[cur] = JSON.stringify({ documents: { clean: docs[cur] } });
  return { ok: true, json: strCache[cur] };
});
const colCache = {};
ipcMain.handle('v:columns', () => {
  if (colCache[cur]) return colCache[cur];
  const n = docs[cur].notes;
  const pitch = new Uint8Array(n.length), vel = new Uint8Array(n.length), ch = new Uint8Array(n.length), un = new Uint8Array(n.length);
  const start = new Float64Array(n.length), end = new Float64Array(n.length);
  for (let i = 0; i < n.length; i++) { pitch[i]=n[i].pitch; vel[i]=n[i].velocity; ch[i]=n[i].channel; un[i]=n[i].unterminated?1:0; start[i]=n[i].start; end[i]=n[i].end; }
  const d = docs[cur];
  colCache[cur] = { ok: true, meta: { path: d.path, name: d.name, bpm: d.bpm, bpmEstimated: d.bpmEstimated, duration: d.duration, programs: d.programs, count: n.length },
    pitch: pitch.buffer, vel: vel.buffer, ch: ch.buffer, un: un.buffer, start: start.buffer, end: end.buffer };
  return colCache[cur];
});
const BODY = (call) => `(async () => {
  const t = async (fn, post) => {
    const runs = []; let n = 0;
    for (let i = 0; i < 5; i++) { const a = performance.now(); const r = await fn(); n = post(r); runs.push(performance.now() - a); }
    runs.sort((x,y)=>x-y);
    return { mean: Math.round(runs.reduce((a,b)=>a+b,0)/runs.length*10)/10, max: Math.round(runs[runs.length-1]*10)/10, notes: n };
  };
  const C = ${call};
  const objects = await t(C.objects, (r) => r.data.documents.clean.notes.length);
  const str = await t(C.string, (r) => JSON.parse(r.json).documents.clean.notes.length);
  const cols = await t(C.columns, (r) => {
    const p = new Uint8Array(r.pitch), v = new Uint8Array(r.vel), c = new Uint8Array(r.ch), u = new Uint8Array(r.un);
    const s = new Float64Array(r.start), e = new Float64Array(r.end);
    const notes = new Array(r.meta.count);
    for (let i = 0; i < r.meta.count; i++) {
      const o = { id: 'n' + (i+1), pitch: p[i], start: s[i], end: e[i], velocity: v[i], channel: c[i] };
      if (u[i]) o.unterminated = true;
      notes[i] = o;
    }
    return notes.length;
  });
  return { objects, str, cols };
})()`;
app.whenReady().then(async () => {
  const out = { raw: {}, contextBridge: {} };
  const raw = new BrowserWindow({ width: 700, height: 500, show: false, webPreferences: { contextIsolation: false, nodeIntegration: true } });
  await raw.loadURL('data:text/html,<title>v</title>');
  const bridged = new BrowserWindow({ width: 700, height: 500, show: false, webPreferences: { preload: require('path').join(__dirname, 'editor-ipc-shapes-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false } });
  await bridged.loadURL('data:text/html,<title>v</title>');
  for (const k of Object.keys(docs)) {
    cur = k;
    out.raw[k] = await raw.webContents.executeJavaScript(BODY("{ objects: () => require('electron').ipcRenderer.invoke('v:objects'), string: () => require('electron').ipcRenderer.invoke('v:string'), columns: () => require('electron').ipcRenderer.invoke('v:columns') }"), true);
    out.contextBridge[k] = await bridged.webContents.executeJavaScript(BODY("window.v"), true);
  }
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--json');
  const at = i >= 0 && argv[i + 1] ? argv[i + 1] : '';
  const pad = (v) => String(v).padStart(8);
  console.log('');
  console.log('size  shape      raw ipcRenderer      through contextBridge');
  console.log('                 mean      max        mean      max');
  for (const k of Object.keys(out.raw)) {
    for (const v of ['objects', 'str', 'cols']) {
      console.log('  ' + k.padEnd(6) + v.padEnd(9) + pad(out.raw[k][v].mean) + pad(out.raw[k][v].max) +
        '   ' + pad(out.contextBridge[k][v].mean) + pad(out.contextBridge[k][v].max) + '  ms   notes=' + out.raw[k][v].notes);
    }
  }
  if (at) { fs.writeFileSync(require('path').resolve(at), JSON.stringify(out, null, 2)); console.log(String.fromCharCode(10) + 'wrote ' + require('path').resolve(at)); }
  raw.destroy(); bridged.destroy();
  setTimeout(()=>app.exit(0), 300);
});

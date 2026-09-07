// startup.js -- how long does MIDI Studio take to be on screen and usable?
//
//   node benchmarks/startup.js                 5 runs, prints a table
//   node benchmarks/startup.js --runs 10
//   node benchmarks/startup.js --json benchmarks/startup.json
//   node benchmarks/startup.js --cold          longer settle between runs
//
// WHAT IT MEASURES, and why it is trustworthy
// -------------------------------------------
// It launches the REAL app -- electron/main.js, the real window, the real
// renderer -- and reads the milestones out of the app's OWN boot log
// (%TEMP%\midi-studio-boot.log). Nothing here re-implements startup, and no
// timing comes from this script's own guesswork: t0 is the instant before
// spawn(), every other number is a timestamp the app itself wrote.
//
// The main process has always written its half (boot:session, boot:window,
// boot:painted...). The renderer's half (ui:script, ui:fcp, ui:handover,
// ui:tab.<key>.ready) is forwarded into the same log through the additive
// app:bootMark channel, fire-and-forget, so instrumenting the boot path does
// not slow the boot path.
//
// THE THREE NUMBERS THAT MATTER
//   painted     spawn -> boot:painted        the window is on screen
//   handover    spawn -> ui:handover         the splash is gone, the shell is live
//   tab.ready   spawn -> ui:tab.<t>.ready    the restored tab reported in
//
// The run is killed as soon as it is interactive (plus a grace for trailing
// marks), so the python sidecar barely starts and nothing is left behind; the
// script verifies that at the end.
'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BOOT_LOG = path.join(os.tmpdir(), 'midi-studio-boot.log');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const RUNS = Number(flag('--runs', 5));
const JSON_OUT = flag('--json', '');
const SETTLE_MS = argv.includes('--cold') ? 6000 : 2000;
const READY_TIMEOUT = 45000;
const GRACE_MS = 900;          // let trailing ui: marks land after handover

// The milestones, in the order they should happen. `key` is what we print;
// `match` finds the line in the boot log.
const MILESTONES = [
  ['main.eval',    (l) => l.indexOf('--- boot ---') >= 0,    'main.js starts evaluating (Electron + node bootstrap is everything before this)'],
  ['lock',         (l) => l.indexOf('gotLock=') === 0,       'single-instance lock resolved'],
  ['whenReady',    (l) => l === 'whenReady fired',           'Chromium is up'],
  ['session',      (l) => l === 'boot:session',              'Settings loaded, overlay + IPC wired'],
  ['jobs',         (l) => l === 'boot:jobs',                 'orphan-job reaping done'],
  ['window',       (l) => l === 'boot:window',               'createWindow() called'],
  ['loadFile',     (l) => l.indexOf('window created;') === 0, 'renderer/index.html handed to Chromium'],
  ['painted',      (l) => l === 'boot:painted',              'WINDOW ON SCREEN (ready-to-show)'],
  ['ui.script',    (l) => l.indexOf('ui:script') === 0,      'shell.js begins executing'],
  ['ui.fcp',       (l) => l.indexOf('ui:fcp') === 0,         'first contentful paint (the splash)'],
  ['ui.interface', (l) => l.indexOf('ui:interface') === 0,   'shell chrome rendered'],
  ['tab.src',      (l) => /^ui:tab\.[a-z]+\.src/.test(l),    'the restored tab iframe is given its src'],
  ['tab.ready',    (l) => /^ui:tab\.[a-z]+\.ready/.test(l),  'that tab announced frame:ready'],
  ['ui.session',   (l) => l.indexOf('ui:session') === 0,     'session restored, tab activated'],
  ['handover',     (l) => l.indexOf('ui:handover') === 0,    'SHELL INTERACTIVE (splash hands over)'],
  ['engine',       (l) => l === 'boot:engine',               'python sidecar spawn begins (deliberately +1200ms)'],
];

const pct = (sorted, p) => {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p / 100 * sorted.length) - 1));
  return sorted[i];
};
const stat = (vals) => {
  const v = vals.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  return {
    n: v.length,
    mean: Math.round(v.reduce((a, b) => a + b, 0) / v.length),
    p50: Math.round(pct(v, 50)), p95: Math.round(pct(v, 95)),
    p99: Math.round(pct(v, 99)), max: Math.round(v[v.length - 1]), min: Math.round(v[0]),
  };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function running(image) {
  if (process.platform !== 'win32') return [];
  const out = spawnSync('tasklist.exe', ['/FI', 'IMAGENAME eq ' + image, '/NH'], { encoding: 'utf-8', windowsHide: true });
  return String(out.stdout || '').split(/\r?\n/).filter((l) => l.toLowerCase().indexOf(image.toLowerCase()) >= 0);
}
function killTree(pid) {
  if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else { try { process.kill(-pid, 'SIGKILL'); } catch (_) {} }
}

// Only ever read the bytes THIS run appended, so a log with a hundred previous
// boots in it cannot contaminate a measurement.
function tailFrom(offset) {
  let size = 0;
  try { size = fs.statSync(BOOT_LOG).size; } catch (_) { return { text: '', size: offset }; }
  if (size <= offset) return { text: '', size: size };
  const fd = fs.openSync(BOOT_LOG, 'r');
  const buf = Buffer.alloc(size - offset);
  fs.readSync(fd, buf, 0, buf.length, offset);
  fs.closeSync(fd);
  return { text: buf.toString('utf-8'), size: size };
}

function parse(text, t0) {
  const rows = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = /^(\d{10,})\s+(.*)$/.exec(raw.trim());
    if (!m) continue;
    rows.push({ at: Number(m[1]), line: m[2] });
  }
  const out = { _lines: rows.length };
  for (const spec of MILESTONES) {
    const hit = rows.find((r) => spec[1](r.line));
    if (hit) out[spec[0]] = hit.at - t0;
  }
  const tabHit = rows.find((r) => /^ui:tab\.[a-z]+\.ready/.test(r.line));
  if (tabHit) out._tab = /^ui:tab\.([a-z]+)\./.exec(tabHit.line)[1];
  return out;
}

async function oneRun(index) {
  let offset = 0;
  try { offset = fs.statSync(BOOT_LOG).size; } catch (_) { offset = 0; }

  const t0 = Date.now();
  const child = spawn(ELECTRON, ['.'], {
    cwd: ROOT, windowsHide: false, detached: process.platform !== 'win32',
    stdio: ['ignore', 'ignore', 'ignore'],
  });

  let text = '', done = false;
  const deadline = Date.now() + READY_TIMEOUT;
  while (Date.now() < deadline) {
    await sleep(25);
    text = tailFrom(offset).text;
    if (/^\d+\s+ui:handover/m.test(text)) { done = true; break; }
  }
  await sleep(GRACE_MS);
  text = tailFrom(offset).text;
  killTree(child.pid);
  await sleep(SETTLE_MS);

  const row = parse(text, t0);
  row._ok = done;
  process.stderr.write('  run ' + (index + 1) + '/' + RUNS + ': painted ' + (row.painted == null ? '?' : row.painted)
    + 'ms, interactive ' + (row.handover == null ? '?' : row.handover) + 'ms' + (done ? '' : '  (TIMED OUT)') + '\n');
  return row;
}

(async () => {
  if (!fs.existsSync(ELECTRON)) { console.error('electron not found at ' + ELECTRON); process.exit(2); }
  const stale = running('electron.exe');
  if (stale.length) { console.error('Refusing to run: ' + stale.length + ' electron.exe already running. Close MIDI Studio first.'); process.exit(2); }

  const runs = [];
  for (let i = 0; i < RUNS; i++) runs.push(await oneRun(i));

  const report = {
    at: new Date().toISOString(), runs: RUNS, platform: os.platform() + ' ' + os.release(),
    cpu: (os.cpus()[0] || {}).model || '', cores: os.cpus().length, packaged: false,
    tab: runs.map((r) => r._tab).find(Boolean) || '',
    milestones: {}, deltas: {}, raw: runs,
  };

  for (const spec of MILESTONES) {
    const s = stat(runs.map((r) => r[spec[0]]));
    if (s) report.milestones[spec[0]] = Object.assign({ why: spec[2] }, s);
  }
  for (let i = 1; i < MILESTONES.length; i++) {
    const a = MILESTONES[i - 1][0], b = MILESTONES[i][0];
    const s = stat(runs.map((r) => (Number.isFinite(r[a]) && Number.isFinite(r[b]) ? r[b] - r[a] : NaN)));
    if (s) report.deltas[a + ' -> ' + b] = s;
  }

  const pad = (s, n) => String(s).padEnd(n);
  const num = (s, n) => String(s).padStart(n);
  console.log('\nSTARTUP  ' + RUNS + ' runs  (unpackaged, ' + report.cores + ' cores)  restored tab: ' + (report.tab || '?') + '\n');
  console.log(pad('milestone', 14) + num('mean', 7) + num('p95', 7) + num('p99', 7) + num('max', 7) + '   since spawn');
  console.log('-'.repeat(100));
  for (const spec of MILESTONES) {
    const m = report.milestones[spec[0]];
    if (!m) { console.log(pad(spec[0], 14) + num('--', 7) + ' '.repeat(21) + '   (never reached)'); continue; }
    console.log(pad(spec[0], 14) + num(m.mean, 7) + num(m.p95, 7) + num(m.p99, 7) + num(m.max, 7) + '   ' + m.why);
  }
  console.log('\nGAPS (ms)');
  for (const k of Object.keys(report.deltas)) {
    const v = report.deltas[k];
    if (v.mean < 1 && v.max < 3) continue;
    console.log('  ' + pad(k, 30) + num(v.mean, 6) + '   p95 ' + num(v.p95, 5) + '  max ' + num(v.max, 5));
  }

  const leftEl = running('electron.exe'), leftPy = running('python.exe');
  console.log('\nleft behind: electron.exe=' + leftEl.length + ' python.exe=' + leftPy.length);
  if (JSON_OUT) {
    fs.writeFileSync(path.resolve(ROOT, JSON_OUT), JSON.stringify(report, null, 2));
    console.log('wrote ' + JSON_OUT);
  }
})();

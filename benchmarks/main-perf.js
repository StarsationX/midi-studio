// main-perf.js -- the MAIN-PROCESS hot paths, measured in isolation.
//
//   node benchmarks/main-perf.js                        all groups
//   node benchmarks/main-perf.js --only reap,gamewatch
//   node benchmarks/main-perf.js --json benchmarks/main-perf.json
//
// Groups
//   reap      what reapOrphanJobs() costs, and how much of it BLOCKS the thread
//             that has to create the window. Seeded with a fixed number of dead
//             pids so the number does not depend on what the last session left.
//   gamewatch what one GameWatch.probe() cycle costs in the common (no game
//             running) case -- the case that repeats forever at idle.
//   adopt     the registry read on the boot path: blocking vs overlapped.
//   pump      the provisioner's stdout pump against a carriage-return-only
//             stream (a pip download bar), lines emitted and bytes retained.
//   bootlog   appendFileSync cost per boot mark, and the live log's size.
//
// Every number is wall clock from process.hrtime.bigint() around the REAL
// function exported by the REAL module -- nothing here re-implements the app.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const ONLY = flag('--only') ? flag('--only').split(',').map((s) => s.trim()).filter(Boolean) : null;
const JSON_OUT = flag('--json', '');
const REPS = Number(flag('--reps', 8));
const want = (g) => !ONLY || ONLY.includes(g);

const results = [];
function record(group, row) { results.push(Object.assign({ group }, row)); }
const now = () => Number(process.hrtime.bigint()) / 1e6;

function stats(a) {
  if (!a.length) return { n: 0 };
  const s = [...a].sort((x, y) => x - y);
  const at = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return {
    n: s.length,
    mean: +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(3),
    p50: +at(0.5).toFixed(3), p95: +at(0.95).toFixed(3), p99: +at(0.99).toFixed(3),
    max: +s[s.length - 1].toFixed(3), min: +s[0].toFixed(3),
  };
}

// electron/paths.js needs the electron app object; the only thing this harness
// wants from it is the jobs file, so it is pointed at a scratch copy instead.
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-mainperf-'));
const JOBS = path.join(SCRATCH, 'forge-jobs.json');

// ---- reap -------------------------------------------------------------------
// Dead pids: reapOrphanJobs asks tasklist about each one and gets "no tasks",
// which is the shape of a normal boot after an unclean exit.
const DEAD_PIDS = [999001, 999002, 999003];

function loadRunner() {
  const runnerPath = require.resolve(path.join(ROOT, 'electron', 'forge-runner.js'));
  const pathsPath = require.resolve(path.join(ROOT, 'electron', 'paths.js'));
  delete require.cache[runnerPath];
  delete require.cache[pathsPath];
  const paths = require(pathsPath);
  paths.forgeJobsFile = () => JOBS;
  return require(runnerPath);
}

async function groupReap() {
  const runner = loadRunner();
  const blocked = [];
  const wall = [];
  for (let i = 0; i < REPS; i++) {
    fs.writeFileSync(JOBS, JSON.stringify(DEAD_PIDS));
    // "blocked" is how long the calling thread cannot do anything else: for a
    // synchronous reap that is the whole thing, for an async one it is only the
    // spawn setup. That distinction is the entire point of the change.
    const t0 = now();
    const r = runner.reapOrphanJobs();
    const t1 = now();
    await Promise.resolve(r);
    const t2 = now();
    blocked.push(t1 - t0);
    wall.push(t2 - t0);
  }
  const isPromise = typeof (runner.reapOrphanJobs() || {}).then === 'function';
  record('reap', { name: 'reapOrphanJobs(3 dead pids): calling thread BLOCKED', unit: 'ms', ...stats(blocked) });
  record('reap', { name: 'reapOrphanJobs(3 dead pids): wall clock to completion', unit: 'ms', ...stats(wall) });
  record('reap', { name: 'reapOrphanJobs returns a promise (does not block the boot path)', unit: 'bool', value: isPromise ? 1 : 0 });
}

// ---- gamewatch --------------------------------------------------------------
async function groupGameWatch() {
  const gw = require(path.join(ROOT, 'electron', 'gamewatch.js'));
  if (!gw.probe) {
    record('gamewatch', { name: 'probe() is not exported; cannot measure', unit: 'bool', value: 0 });
    return;
  }
  const cycles = [];
  const spawns = [];
  let sawGame = '';
  for (let i = 0; i < REPS; i++) {
    const before = gw.probeSpawnCount ? gw.probeSpawnCount() : null;
    const t0 = now();
    const found = await gw.probe();
    cycles.push(now() - t0);
    if (before != null) spawns.push(gw.probeSpawnCount() - before);
    if (found) sawGame = found;
  }
  if (sawGame) record('gamewatch', { name: `a watched game IS running (${sawGame}) -- the no-game cost is the one that repeats forever`, unit: 'bool', value: 1 });
  record('gamewatch', { name: 'one GameWatch.probe() cycle', unit: 'ms', ...stats(cycles) });
  if (spawns.length) record('gamewatch', { name: 'child processes spawned per probe cycle', unit: 'procs', ...stats(spawns) });
}

// ---- adopt ------------------------------------------------------------------
const REG_ARGS = ['query', 'HKCU\\Software\\StarsationX\\MIDI Studio', '/v', 'ForgeStorageDir'];
async function groupAdopt() {
  const sync = [];
  const asyncBlocked = [];
  const asyncWall = [];
  for (let i = 0; i < REPS; i++) {
    let t0 = now();
    try { spawnSync('reg.exe', REG_ARGS, { windowsHide: true, encoding: 'utf-8', timeout: 5000 }); } catch (_) {}
    sync.push(now() - t0);
    t0 = now();
    const p = new Promise((res) => execFile('reg.exe', REG_ARGS, { windowsHide: true, timeout: 5000 }, () => res()));
    asyncBlocked.push(now() - t0);
    await p;
    asyncWall.push(now() - t0);
  }
  record('adopt', { name: 'reg.exe query, spawnSync (blocks the boot path)', unit: 'ms', ...stats(sync) });
  record('adopt', { name: 'reg.exe query, execFile: calling thread BLOCKED', unit: 'ms', ...stats(asyncBlocked) });
  record('adopt', { name: 'reg.exe query, execFile: wall clock', unit: 'ms', ...stats(asyncWall) });
  const src = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf-8');
  record('adopt', { name: 'adoptInstallerForgePath still uses spawnSync', unit: 'bool',
    value: /function adoptInstallerForgePath[\s\S]{0,900}?spawnSync\(/.test(src) ? 1 : 0 });
}

// ---- pump -------------------------------------------------------------------
// A pip download bar rewrites ONE line with \r and never sends \n. A pump that
// only splits on \n shows nothing and grows without bound.
function crStream(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push('\rDownloading torch: ' + i + '%  ');
  return out;
}
function groupPump() {
  const prov = fs.readFileSync(path.join(ROOT, 'electron', 'forge-provisioner.js'), 'utf-8');
  const usesShared = /makePump/.test(prov);
  const runner = require(path.join(ROOT, 'electron', 'forge-runner.js'));
  let lines = 0;
  let buf = '';
  // The provisioner's own pump, whichever one the source currently installs.
  const legacy = (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (l.trim()) lines += 1;
    }
  };
  const shared = runner.makePump ? runner.makePump(() => { lines += 1; }) : null;
  const pump = usesShared && shared ? shared : legacy;
  const chunks = crStream(20000);
  const t0 = now();
  for (const c of chunks) pump(c);
  const dt = now() - t0;
  record('pump', {
    name: 'provisioner stdout pump, 20k carriage-return chunks (' + (usesShared ? 'shared makePump' : 'inline newline-only pump') + ')',
    unit: 'ms', value: +dt.toFixed(3), msPerChunk: +(dt / chunks.length).toFixed(4),
    linesEmitted: lines, bytesRetained: usesShared ? 0 : buf.length,
  });
  record('pump', { name: 'forge-provisioner uses the shared carriage-return pump', unit: 'bool', value: usesShared ? 1 : 0 });
  record('pump', { name: 'forge-provisioner writes to its log synchronously per chunk', unit: 'bool',
    value: /fs\.writeSync\(this\._logFd, c\)/.test(prov) ? 1 : 0 });
}

// ---- bootlog ----------------------------------------------------------------
function groupBootLog() {
  const f = path.join(SCRATCH, 'boot.log');
  const times = [];
  for (let i = 0; i < 400; i++) {
    const t0 = now();
    fs.appendFileSync(f, Date.now() + ' boot:mark' + i + '\n');
    times.push(now() - t0);
  }
  record('bootlog', { name: 'fs.appendFileSync, one boot mark', unit: 'ms', ...stats(times) });
  const live = path.join(os.tmpdir(), 'midi-studio-boot.log');
  let size = 0;
  let lines = 0;
  try { const t = fs.readFileSync(live, 'utf-8'); size = t.length; lines = t.split('\n').length; } catch (_) {}
  record('bootlog', { name: 'live %TEMP%/midi-studio-boot.log', unit: 'bytes', value: size, lines });
  const src = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf-8');
  record('bootlog', { name: 'main.js caps the boot log', unit: 'bool', value: /BOOT_LOG_MAX/.test(src) ? 1 : 0 });
}

(async () => {
  if (want('reap')) await groupReap();
  if (want('gamewatch')) await groupGameWatch();
  if (want('adopt')) await groupAdopt();
  if (want('pump')) groupPump();
  if (want('bootlog')) groupBootLog();

  let last = '';
  for (const r of results) {
    if (r.group !== last) { console.log('\n[' + r.group + ']'); last = r.group; }
    const nums = r.n
      ? `mean ${r.mean}  p50 ${r.p50}  p95 ${r.p95}  p99 ${r.p99}  max ${r.max}  (n=${r.n})`
      : `${r.value}${r.unit && r.unit !== 'bool' ? ' ' + r.unit : ''}`;
    const extra = [];
    for (const k of ['msPerChunk', 'linesEmitted', 'bytesRetained', 'lines']) if (r[k] != null) extra.push(`${k}=${r[k]}`);
    console.log('  ' + r.name + '\n    ' + nums + (extra.length ? '   ' + extra.join(' ') : ''));
  }
  if (JSON_OUT) {
    const out = path.isAbsolute(JSON_OUT) ? JSON_OUT : path.join(ROOT, JSON_OUT.replace(/^\.\//, ''));
    fs.writeFileSync(out, JSON.stringify({ when: new Date().toISOString(), reps: REPS, results }, null, 2));
    console.log('\nwrote ' + JSON_OUT);
  }
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch (_) {}
})();

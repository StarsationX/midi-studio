// fanout-bench.js -- what does main.js's broadcast() actually cost, and how
// much of it lands in a document that has no listener?
//
//   node_modules/electron/dist/electron.exe benchmarks/fanout-bench.js \
//       --json benchmarks/fanout.json
//   ... --no-subs      the SAME run with the subscription filter disabled
//
// It opens the REAL renderer/index.html with the REAL preload, opens all six
// tabs so every frame exists and has run its script, and then broadcasts
// through a verbatim copy of main.js's broadcast() -- once filtered by
// electron/fanout.js (the module main.js uses) and once unfiltered, so the two
// numbers are the same code path with one predicate changed.
//
// Subscriptions arrive on the additive 'app:subscribe' channel, registered here
// exactly as main.js registers it.
'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const stubs = require(path.join(ROOT, 'tools', 'ipc-stubs.js'));
const fanout = require(path.join(ROOT, 'electron', 'fanout.js'));

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const JSON_OUT = flag('--json', '');
const REPS = Number(flag('--reps', 2000));
const TABS = ['forge', 'library', 'player', 'review', 'audition', 'logs'];

// The six channels invariant 4 names as having to reach subframes, with the
// payload shape each really carries.
const CHANNELS = [
  ['engine-event', { event: 'progress', position: 12.345, notes: 812, total: 2044 }],
  ['forge:status', { event: 'forge.log', line: 'Separating stems: 42%', level: 'info' }],
  ['engine-error', 'Player engine failed to start: spawn ENOENT'],
  ['library-changed', 'C:\\Users\\x\\Documents\\MIDI Studio'],
  ['game-active', { game: 'RobloxPlayerBeta.exe', rule: 'easy' }],
  ['overlay-state', { open: true, x: 40, y: 40 }],
];

const now = () => Number(process.hrtime.bigint()) / 1e6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stats(a) {
  const s = [...a].sort((x, y) => x - y);
  const at = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return { n: s.length, mean: +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(4),
    p50: +at(0.5).toFixed(4), p95: +at(0.95).toFixed(4), p99: +at(0.99).toFixed(4),
    max: +s[s.length - 1].toFixed(4) };
}

function waitFor(wc, expr, timeout) {
  const deadline = Date.now() + timeout;
  return (async () => {
    while (Date.now() < deadline) {
      const ok = await wc.executeJavaScript(expr, true).catch(() => false);
      if (ok) return true;
      await sleep(60);
    }
    return false;
  })();
}

// Verbatim from electron/main.js broadcast(), minus the library invalidation
// and the Perch send (a separate window, which the frame walk never reaches and
// which this bench does not open). `filter` is the one thing that varies.
function broadcastLike(wc, channel, payload, filter) {
  let sends = 0;
  wc.send(channel, payload); sends++;
  const main = wc.mainFrame;
  if (main) for (const f of main.framesInSubtree) {
    if (f !== main && (!filter || fanout.frameWants(f, channel))) {
      try { f.send(channel, payload); sends++; } catch (_) {}
    }
  }
  return sends;
}

app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

app.whenReady().then(async () => {
  stubs.registerStubs();
  // Exactly as main.js does it.
  ipcMain.on('app:subscribe', (e, channel) => {
    if (channel == null) fanout.markReady(e.senderFrame);
    else fanout.noteSubscription(e.senderFrame, channel);
  });

  const win = new BrowserWindow({
    width: 1280, height: 820, show: false, frame: false, backgroundColor: '#141519',
    webPreferences: {
      preload: path.join(ROOT, 'electron', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
      nodeIntegrationInSubFrames: true, backgroundThrottling: false,
    },
  });
  const wc = win.webContents;
  wc.on('will-prevent-unload', (e) => e.preventDefault());
  await win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  await waitFor(wc, `document.body.dataset.boot === 'ready'`, 25000);

  // Open every tab so all seven frames exist AND have run their scripts. This
  // is the state that flatters the OLD behaviour most: with tabs unopened the
  // src-less iframes still counted as frames but could never have listeners.
  for (const t of TABS) {
    await wc.executeJavaScript(`(document.getElementById('nav-${t}')||{click(){}}).click(), true`, true).catch(() => {});
    await sleep(1200);
  }
  await sleep(1500);

  const frames = wc.mainFrame ? wc.mainFrame.framesInSubtree : [];
  const report = {
    when: new Date().toISOString(),
    framesInSubtree: frames.length,
    frames: frames.map((f) => ({
      url: String(f.url || '').split('/').slice(-2).join('/'),
      isMain: f === wc.mainFrame,
      subscriptions: fanout.subscriptionsOf(f),
    })),
    channels: [],
    timing: {},
  };

  for (const [channel, payload] of CHANNELS) {
    let selected = 1;                                    // the shell frame, always
    for (const f of frames) if (f !== wc.mainFrame && fanout.frameWants(f, channel)) selected++;
    report.channels.push({ channel, sendsBefore: frames.length, sendsAfter: selected,
      wastedBefore: frames.length - selected,
      savedPercent: +(100 * (frames.length - selected) / frames.length).toFixed(1) });
  }

  // Timing: the same broadcast, filtered and unfiltered, interleaved so a load
  // spike lands on both.
  const unfiltered = [];
  const filtered = [];
  let sendsUnfiltered = 0;
  let sendsFiltered = 0;
  const [ch, pl] = CHANNELS[0];                          // engine-event: 20/s during playback
  for (let i = 0; i < REPS; i++) {
    let t0 = now();
    sendsUnfiltered += broadcastLike(wc, ch, pl, false);
    unfiltered.push(now() - t0);
    t0 = now();
    sendsFiltered += broadcastLike(wc, ch, pl, true);
    filtered.push(now() - t0);
  }
  report.timing = {
    channel: ch, reps: REPS,
    unfiltered: { ...stats(unfiltered), sendsPerBroadcast: +(sendsUnfiltered / REPS).toFixed(2) },
    filtered: { ...stats(filtered), sendsPerBroadcast: +(sendsFiltered / REPS).toFixed(2) },
  };

  console.log(`frames in subtree: ${report.framesInSubtree}`);
  for (const f of report.frames) {
    console.log(`  ${f.isMain ? '[shell] ' : '        '}${f.url}  subs=${f.subscriptions ? f.subscriptions.join(',') : '(never reported -> receives everything)'}`);
  }
  console.log('\nsends per broadcast, by channel');
  for (const c of report.channels) {
    console.log(`  ${c.channel.padEnd(16)} ${c.sendsBefore} -> ${c.sendsAfter}   (${c.savedPercent}% of the sends were going nowhere)`);
  }
  const u = report.timing.unfiltered;
  const f2 = report.timing.filtered;
  console.log(`\n${REPS} broadcasts of ${ch}`);
  console.log(`  unfiltered  mean ${u.mean}  p95 ${u.p95}  p99 ${u.p99}  max ${u.max}   ${u.sendsPerBroadcast} sends each`);
  console.log(`  filtered    mean ${f2.mean}  p95 ${f2.p95}  p99 ${f2.p99}  max ${f2.max}   ${f2.sendsPerBroadcast} sends each`);

  if (JSON_OUT) {
    fs.writeFileSync(path.join(ROOT, JSON_OUT.replace(/^\.\//, '')), JSON.stringify(report, null, 2));
    console.log(`\nwrote ${JSON_OUT}`);
  }
  win.destroy();
  app.quit();
}).catch((e) => { console.error(e); app.exit(1); });

'use strict';
// Node-only regressions for the anonymous public-player download contract.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const M = require('../electron/musescore-download');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'midi-score-tests-'));
const source = 'https://musescore.com/user/40298614/scores/38165006';
const asset = 'https://s3w.musescore.com/musescore.scoredata/g/example/score.mid?temporary=public-player-url';
const midi = Buffer.from('4d546864000000060000000101e04d54726b0000000d00903c648360803c0000ff2f00', 'hex');
let checks = 0;
const check = (condition, label) => { assert.ok(condition, label); checks++; };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function mockRuntime(body = { body: midi.toString('base64'), base64Encoded: true }) {
  const windows = [], commands = [], partitions = [];
  class Browser extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.dead = false; windows.push(this);
      const debug = new EventEmitter();
      debug.attach = () => {};
      debug.detach = () => {};
      debug.sendCommand = async (method, params) => { commands.push({ method, params }); return method === 'Network.getResponseBody' ? await body : {}; };
      this.webContents = new EventEmitter();
      Object.assign(this.webContents, { debugger: debug, setWindowOpenHandler: fn => { this.popup = fn; }, setAudioMuted: () => {}, getTitle: () => 'Example song | MuseScore.com', executeJavaScript: async () => false });
    }
    isDestroyed() { return this.dead; }
    destroy() { this.dead = true; this.emit('closed'); }
    async loadURL(url) { this.loaded = url; }
  }
  const runtime = { BrowserWindow: Browser, session: { fromPartition: (id, options) => {
    partitions.push({ id, options });
    return { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, on() {}, closeAllConnections: async () => {}, clearStorageData: async () => {} };
  } } };
  return { windows, commands, partitions, runtime };
}

async function runJob(opts = {}, body) {
  const mock = mockRuntime(body), events = [], dir = path.join(scratch, 'job-' + Math.random().toString(36).slice(2));
  const job = M.startDownload({ url: source, outDir: dir, timeoutMs: 3000, emit: e => events.push(e), ...opts }, mock.runtime);
  await wait(1);
  const send = (method, params) => mock.windows[0].webContents.debugger.emit('message', {}, method, params);
  const receive = async (response = { status: 200, url: asset }, length = midi.length) => {
    send('Network.responseReceived', { requestId: 'midi', response });
    send('Network.loadingFinished', { requestId: 'midi', encodedDataLength: length });
    await wait(1);
  };
  return { ...mock, dir, events, job, send, receive, done: () => events.filter(e => e.event === 'forge.done') };
}

(async () => {
  check(M.scoreInfo(source).playerUrl === source + '/piano-tutorial', 'Canonical public player route');
  check(M.scoreInfo('https://www.musescore.com/artist/scores/123?x=1').id === '123', 'Named score URL');
  for (const bad of ['https://musescore.com.evil.example/a', 'https://notmusescore.com/a', 'javascript://musescore.com/a']) check(!M.isMuseScoreUrl(bad), 'Reject misleading host: ' + bad);
  for (const bad of ['https://user:password@musescore.com/user/1/scores/2', 'https://musescore.com:444/user/1/scores/2', 'https://musescore.com/upgrade']) {
    assert.throws(() => M.scoreInfo(bad)); checks++;
  }
  check(M.isMidiResponse({ status: 200, url: asset }), 'Accept actual public MIDI response');
  for (const response of [{ status: 403, url: asset }, { status: 200, url: 'http://s3w.musescore.com/score.mid' }, { status: 200, url: 'https://musescore.com.evil.test/score.mid' }, { status: 200, url: 'https://musescore.com/score.mp3' }]) check(!M.isMidiResponse(response), 'Ignore non-MIDI or rejected responses');
  check(M.validateMidi(midi).notes === 1, 'Validate original SMF events');
  for (const bytes of [Buffer.from('<html>Login</html>'), midi.subarray(0, midi.length - 3), Buffer.alloc(M.MAX_MIDI_BYTES + 1)]) { assert.throws(() => M.validateMidi(bytes)); checks++; }
  const saved = M.saveMidi(midi, scratch, '../../CON <> score | MuseScore.com', '123');
  const again = M.saveMidi(midi, scratch, '../../CON <> score | MuseScore.com', '123');
  check(path.dirname(saved.downloadedPath) === scratch && saved.downloadedPath !== again.downloadedPath, 'Sanitized unique output stays inside chosen folder');
  check(fs.readFileSync(saved.downloadedPath).equals(midi), 'Original response bytes unchanged');
  {
    const t = await runJob();
    const prefs = t.windows[0].options.webPreferences;
    check(prefs.nodeIntegration === false && prefs.contextIsolation && prefs.sandbox && prefs.webSecurity && !prefs.preload, 'Remote page isolated from app privileges');
    check(!t.partitions[0].id.startsWith('persist:') && !t.partitions[0].options.cache, 'Anonymous ephemeral browser session');
    check(t.windows[0].loaded === source + '/piano-tutorial' && t.windows[0].popup().action === 'deny', 'Normal player loads with popups blocked');
    await t.receive(); await t.receive();
    check(t.done().length === 1 && t.done()[0].ok && t.windows[0].dead, 'Successful capture finishes once and closes browser');
    check(fs.readFileSync(t.done()[0].result.downloadedPath).equals(midi), 'Captured body saved unchanged');
    check(t.commands.every(c => ['Network.enable', 'Network.getResponseBody'].includes(c.method)), 'Only response observation commands, no request replay or credentials');
  }
  {
    const t = await runJob({}, { body: Buffer.from('<html>Denied</html>').toString('base64'), base64Encoded: true });
    await t.receive();
    check(t.done().length === 1 && !t.done()[0].ok && !fs.existsSync(t.dir), 'HTML cannot be reported or saved as MIDI');
  }
  {
    const t = await runJob(); await t.receive({ status: 200, url: asset }, M.MAX_MIDI_BYTES + 1);
    check(!t.done()[0].ok && !t.commands.some(c => c.method === 'Network.getResponseBody'), 'Oversized response rejected before body retrieval');
  }
  {
    let resolve;
    const t = await runJob({}, new Promise(r => { resolve = r; }));
    await t.receive(); t.job.cancel(); resolve({ body: midi.toString('base64'), base64Encoded: true }); await wait(1);
    check(t.done().length === 1 && t.done()[0].error === 'cancelled' && !fs.existsSync(t.dir), 'Cancellation wins while response body is pending');
  }
  {
    const t = await runJob({ timeoutMs: 15 }); await wait(30); t.job.cancel();
    check(t.done().length === 1 && /did not deliver/.test(t.done()[0].error) && t.windows[0].dead, 'Timeout finishes once and cleans up browser');
  }
  {
    const events = [], mock = mockRuntime();
    const job = M.startDownload({ url: source, emit: e => events.push(e) }, mock.runtime);
    job.cancel(); await wait(1);
    check(!mock.windows.length && events.length === 1 && events[0].error === 'cancelled', 'Early cancellation never opens a browser');
  }
  {
    let options, cancelled = false;
    const mod = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/forge-runner.js'), 'utf8'), {
      module: mod, process, setTimeout, URL,
      require: name => name === './paths' ? { forgeEnvPython: () => { throw new Error('Must not consult Python'); } }
        : name === './musescore-download' ? { startDownload: opts => { options = opts; return { cancel: () => { cancelled = true; options.emit({ event: 'forge.done', ok: false, error: 'cancelled' }); } }; } } : require(name),
    });
    const events = [], runner = new mod.exports.ForgeRunner({ emit: e => events.push(e) });
    const id = runner.ytDownload({ url: source, outDir: scratch });
    check(options && runner.isRunning(), 'MuseScore routes to bundled browser without Python setup');
    runner.cancel(id);
    check(cancelled && !runner.isRunning() && events[0].jobId === id, 'Runner cancellation and job cleanup use browser job');
  }
  console.log(JSON.stringify({ passed: true, checks }));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  const target = path.resolve(scratch);
  assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
  assert.ok(path.basename(target).startsWith('midi-score-tests-'));
  fs.rmSync(target, { recursive: true, force: true });
});

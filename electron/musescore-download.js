// Save the original MIDI response delivered to MuseScore's anonymous public player.
// The browser performs its normal playback requests. This module observes the
// resulting response body; it never creates tokens or replays site requests.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const MidiParse = require('../renderer/shared/midi-parse');

const MAX_MIDI_BYTES = 16 * 1024 * 1024;
const TIMEOUT_MS = 90000;

function isMuseScoreUrl(value) {
  try {
    const u = new URL(value), host = u.hostname.toLowerCase().replace(/\.$/, '');
    return /^https?:$/.test(u.protocol) && (host === 'musescore.com' || host.endsWith('.musescore.com'));
  } catch (_) { return false; }
}

function scoreInfo(value) {
  if (!isMuseScoreUrl(value)) throw new Error('Enter a MuseScore score URL.');
  const u = new URL(value);
  if (u.username || u.password || u.port) throw new Error('Enter a MuseScore score URL without credentials or a custom port.');
  const match = u.pathname.match(/^\/((?:user\/\d+)|[^/]+)\/scores\/(\d{1,20})(?:\/piano-tutorial)?\/?$/);
  if (!match || !/[1-9]/.test(match[2])) throw new Error('Enter the full MuseScore score URL, including /scores/ and its number.');
  const url = `https://musescore.com/${match[1]}/scores/${match[2]}`;
  return { id: match[2], url, playerUrl: url + '/piano-tutorial' };
}

function isMidiResponse(response) {
  if (!response || response.status !== 200) return false;
  try {
    const u = new URL(response.url), host = u.hostname.toLowerCase();
    const site = host === 'musescore.com' || host.endsWith('.musescore.com')
      || host === 'cdn.ustatik.com' || host.endsWith('.wasabisys.com')
      || host === 's3.ultimate-guitar.com';
    return u.protocol === 'https:' && site && /\/score\.midi?$/i.test(u.pathname);
  } catch (_) { return false; }
}

function validateMidi(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 14 || bytes.length > MAX_MIDI_BYTES || bytes.toString('ascii', 0, 4) !== 'MThd') {
    throw new Error('The public player did not return a valid MIDI file.');
  }
  // The same strict parser used by Editor checks every track and event before
  // any response bytes become a file. The original bytes are saved unchanged.
  const doc = MidiParse.parse(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), 'score.mid');
  if (!doc.notes.length) throw new Error('The public player returned a MIDI file without notes.');
  return { notes: doc.notes.length, duration: doc.duration };
}

function safeName(title, scoreId) {
  let name = String(title || '').replace(/\s*[|–-]\s*(?:piano tutorial|MuseScore\.com).*$/i, '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 100);
  if (!name || /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)/i.test(name)) name = 'MuseScore';
  return `${name} [${scoreId}]`;
}

function saveMidi(bytes, outDir, title, scoreId) {
  const metadata = validateMidi(bytes);
  const dir = path.resolve(outDir || path.join(os.homedir(), 'Documents', 'MIDI Studio'));
  fs.mkdirSync(dir, { recursive: true });
  const name = safeName(title, scoreId);
  for (let n = 0; n < 10000; n++) {
    const dest = path.join(dir, `${name}${n ? ` (${n + 1})` : ''}.mid`);
    let fd;
    try { fd = fs.openSync(dest, 'wx'); }
    catch (error) { if (error.code === 'EEXIST') continue; throw error; }
    try { fs.writeFileSync(fd, bytes); }
    catch (error) { fs.closeSync(fd); fs.unlinkSync(dest); throw error; }
    fs.closeSync(fd);
    return { downloadedPath: dest, source: 'musescore-public-player', scoreId, ...metadata };
  }
  throw new Error('Too many copies of this MIDI in the output folder.');
}

function startDownload({ url, outDir, emit, timeoutMs = TIMEOUT_MS }, runtime) {
  const { BrowserWindow, session } = runtime || require('electron');
  const score = scoreInfo(url);
  let win, isolated, done = false, timer, triggerTimer, completing = false;
  const requests = new Set();
  const progress = (message, percent) => { if (!done) emit({ event: 'forge.progress', stage: 'Download', percent, message }); };
  const finish = (error, result) => {
    if (done) return;
    done = true;
    clearTimeout(timer); clearInterval(triggerTimer);
    if (win && !win.isDestroyed()) {
      try { win.webContents.debugger.detach(); } catch (_) {}
      win.destroy();
    }
    if (isolated) {
      if (isolated.closeAllConnections) isolated.closeAllConnections().catch(() => {});
      if (isolated.clearStorageData) isolated.clearStorageData().catch(() => {});
    }
    if (result) emit({ event: 'forge.progress', stage: 'Done', percent: 100, message: 'Original MIDI saved' });
    emit({ event: 'forge.done', ok: !!result, ...(result ? { result } : { error: String(error && error.message || error || 'Download failed.') }) });
  };
  const job = { cancel: () => finish('cancelled') };
  // Yield so the runner can register this cancellable job before it completes.
  Promise.resolve().then(async () => {
    if (done) return;
    const partition = 'musescore-player-' + crypto.randomBytes(12).toString('hex');
    isolated = session.fromPartition(partition, { cache: false });
    isolated.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    isolated.setPermissionCheckHandler(() => false);
    isolated.on('will-download', (event) => event.preventDefault());
    win = new BrowserWindow({ width: 1100, height: 800, show: false, title: 'MuseScore MIDI download',
      webPreferences: { session: isolated, nodeIntegration: false, contextIsolation: true,
        sandbox: true, webSecurity: true, backgroundThrottling: false, autoplayPolicy: 'user-gesture-required' } });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.setAudioMuted(true);
    win.webContents.on('will-navigate', (event, destination) => {
      if (!isMuseScoreUrl(destination)) event.preventDefault();
    });
    win.on('closed', () => finish('cancelled'));
    timer = setTimeout(() => finish('The public player did not deliver a MIDI file. The score may require verification, sign-in, or have no public MIDI playback.'), timeoutMs);
    progress('Loading MuseScore’s public player', 5);
    // CDP commands may not resolve until a target has completed its first
    // navigation. Initialize it on an inert document before enabling capture.
    await win.loadURL('about:blank');
    if (done) return;
    const debug = win.webContents.debugger;
    debug.attach('1.3');
    debug.on('message', async (_event, method, params) => {
      if (done || completing) return;
      if (method === 'Network.responseReceived' && isMidiResponse(params.response)) {
        requests.add(params.requestId);
        progress('Receiving the public player’s MIDI', 65);
      } else if (method === 'Network.loadingFinished' && requests.delete(params.requestId)) {
        if (params.encodedDataLength > MAX_MIDI_BYTES) { finish('The public player MIDI exceeds the 16 MB limit.'); return; }
        completing = true;
        try {
          const response = await debug.sendCommand('Network.getResponseBody', { requestId: params.requestId });
          if (done) return;
          if (response.body.length > Math.ceil(MAX_MIDI_BYTES * 4 / 3) + 4) throw new Error('The public player MIDI exceeds the 16 MB limit.');
          const bytes = Buffer.from(response.body, response.base64Encoded ? 'base64' : 'utf8');
          const result = saveMidi(bytes, outDir, win.webContents.getTitle(), score.id);
          finish(null, result);
        } catch (error) { finish(error); }
      } else if (method === 'Network.loadingFailed') requests.delete(params.requestId);
    });
    await debug.sendCommand('Network.enable', { maxTotalBufferSize: MAX_MIDI_BYTES * 2, maxResourceBufferSize: MAX_MIDI_BYTES });
    if (done) return;
    // This is the site's ordinary public piano-roll route. No private API is called.
    await win.loadURL(score.playerUrl);
    if (done) return;
    progress('Waiting for the player’s MIDI', 35);
    let attempts = 0;
    triggerTimer = setInterval(() => {
      if (done || ++attempts > 20) { clearInterval(triggerTimer); return; }
      // Some site versions fetch the MIDI only when the normal piano-roll
      // control is enabled. Activate that visible control once, without fetching
      // any extra endpoint or touching a sign-in/challenge form.
      win.webContents.executeJavaScript(`(() => {
        const el = document.querySelector('[title="Show piano roll"], [aria-label="Show piano roll"]');
        if (el && el.getClientRects().length && !el.disabled) { el.click(); return true; }
        return false;
      })()`, true).then((clicked) => { if (clicked) clearInterval(triggerTimer); }).catch(() => {});
    }, 750);
  }).catch((error) => finish(error));
  return job;
}

module.exports = { isMuseScoreUrl, scoreInfo, isMidiResponse, validateMidi, safeName, saveMidi, startDownload, MAX_MIDI_BYTES };

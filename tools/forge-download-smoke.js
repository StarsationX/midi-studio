'use strict';

// electron tools/forge-download-smoke.js <scratch-dir> [screenshot]
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const scratch = path.resolve(process.argv[2] || path.join(root, 'work/forge-download-smoke'));
fs.mkdirSync(scratch, { recursive: true });
app.setPath('userData', path.join(scratch, 'profile-' + Date.now()));
app.disableHardwareAcceleration();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const score = 'https://musescore.com/user/40298614/scores/38165006';
let checks = 0;
function check(condition, message) { assert.ok(condition, message); checks++; }

app.whenReady().then(async () => {
  require('./ipc-stubs').registerStubs();
  const external = [], downloads = [], cancelled = [];
  let downloadError = '';
  ipcMain.removeHandler('app:openExternal');
  ipcMain.handle('app:openExternal', (_ev, url) => external.push(url));
  ipcMain.removeHandler('forge:yt');
  ipcMain.handle('forge:yt', (_ev, args) => {
    if (downloadError) throw new Error(downloadError);
    downloads.push(args); return 'download-' + downloads.length;
  });
  ipcMain.removeHandler('forge:cancel');
  ipcMain.handle('forge:cancel', (_ev, id) => { cancelled.push(id); return true; });
  const win = new BrowserWindow({ width: 936, height: 606, show: false, frame: false,
    webPreferences: { preload: path.join(root, 'electron/preload.js'), contextIsolation: true,
      sandbox: false, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
  const run = code => win.webContents.executeJavaScript(`(() => { const $ = id => document.getElementById(id); ${code} })()`, true);
  const setUrl = value => run(`$('url').value = ${JSON.stringify(value)}; $('url').dispatchEvent(new Event('input'));`);
  const click = async id => { await run(`$('${id}').click();`); await delay(60); };
  const enter = async () => { await run(`$('url').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));`); await delay(60); };
  const nav = () => run('return window.__nav;');
  const done = async payload => { win.webContents.send('forge:status', { event: 'forge.done', ...payload }); await delay(100); };
  await win.loadFile(path.join(root, 'renderer/forge/index.html'));
  await run(`window.__nav = []; const send = Bus.send; Bus.send = (type, payload, opts) => { if (type.startsWith('nav:')) window.__nav.push({ type, payload }); return send(type, payload, opts); };`);
  check(await run(`return $('score-help').hidden && $('fetch').hidden;`), 'Empty input has no download action');
  check(await run(`return !$('score-open') && !$('score-midi');`), 'Manual browser fallback was removed');
  for (const url of ['https://example.com/a', 'https://musescore.com.evil.test/a', 'https://evil-musescore.com/a', 'file://musescore.com/a', 'javascript://musescore.com/a', 'musescore.com/a']) {
    await setUrl(url);
    check(await run(`return $('score-help').hidden && $('fetch').textContent === 'Fetch';`), 'Non-MuseScore HTTP URL never claims MIDI capture: ' + url);
  }
  for (const url of [score, 'http://www.musescore.com/user/1/scores/2', 'https://MUSESCORE.COM/user/1/scores/2', 'https://musescore.com./user/1/scores/2']) {
    await setUrl(url);
    check(await run(`return !$('score-help').hidden && !$('fetch').hidden && $('fetch').textContent === 'Get MIDI' && $('url-label').textContent === 'MuseScore MIDI' && $('url').getAttribute('aria-describedby') === 'score-help-text';`), 'MuseScore URL offers direct MIDI download: ' + url);
  }
  await setUrl(score);
  check(await run(`const h = $('score-help').getBoundingClientRect(), rail = $('tp-input').getBoundingClientRect(); return h.width > 180 && h.left >= rail.left && h.right <= rail.right && $('score-help').scrollWidth <= $('score-help').clientWidth;`), 'MIDI guidance fits compact rail');
  check(await run(`const input = $('url'), b = $('fetch'); return parseFloat(getComputedStyle(input).paddingRight) >= b.getBoundingClientRect().width + 8;`), 'Get MIDI button does not overlap URL text');
  if (process.argv[3]) {
    await run(`$('score-help').scrollIntoView({ block: 'nearest' });`);
    await delay(100);
    const screenshot = path.resolve(process.argv[3]);
    fs.mkdirSync(path.dirname(screenshot), { recursive: true });
    fs.writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG());
  }
  await click('fetch');
  check(downloads.length === 1 && downloads[0].url === score && external.length === 0, 'Get MIDI starts a downloader job without opening an external browser');
  await enter(); await click('fetch');
  check(downloads.length === 1, 'Repeated Enter/click cannot duplicate a busy download');
  await done({ ok: true, result: { downloadedPath: 'C:\\Music\\original.MIDI' } });
  check((await nav()).length === 1 && (await nav())[0].type === 'nav:open-editor' && (await nav())[0].payload.midiPath === 'C:\\Music\\original.MIDI', 'Downloaded original MIDI opens Editor once');
  check(await run(`return $('song-title').textContent === 'Your next idea starts here';`), 'Original MIDI never becomes audio transcription input');
  check(await run(`return $('url').value === '' && $('score-help').hidden;`), 'Success clears URL');
  await setUrl(score); await enter();
  check(downloads.length === 2 && external.length === 0, 'Enter starts direct MIDI download');
  await done({ ok: false, error: 'Public player did not provide MIDI.\nHint: No file was saved.' });
  check(await run(`return $('url').value === ${JSON.stringify(score)} && !$('errcard').hidden && $('err-msg').textContent.includes(String.fromCharCode(10) + 'Hint:') && getComputedStyle($('err-msg')).whiteSpace === 'pre-line';`), 'Failure retains URL and readable diagnostics');
  check((await nav()).length === 1, 'Failed download never opens Editor');
  await click('fetch'); await click('cancel');
  check(cancelled.length === 1 && cancelled[0] === 'download-3', 'Cancel targets the active MIDI download');
  await done({ ok: false, error: 'cancelled' });
  check(await run(`return $('url').value === ${JSON.stringify(score)} && $('errcard').hidden && !$('fetch').disabled;`), 'Cancellation preserves retryable URL without an error card');
  downloadError = 'Could not create player'; await click('fetch');
  check(await run(`return !$('errcard').hidden && $('err-msg').textContent.includes('Could not create player') && !$('fetch').disabled;`), 'Start failure resets busy state and reports cause');
  downloadError = '';
  await setUrl('https://example.com/audio');
  check(await run(`return !$('fetch').hidden && $('fetch').textContent === 'Fetch' && $('score-help').hidden && $('url-label').textContent === 'Or download audio from a link';`), 'Ordinary audio URL restores audio action');
  await click('fetch');
  check(downloads.length === 4 && downloads[3].url === 'https://example.com/audio', 'Ordinary audio download is preserved');
  await done({ ok: true, result: { downloadedPath: 'C:\\Music\\recording.mp3' } });
  check(await run(`return $('song-title').textContent === 'recording';`), 'Downloaded audio still loads as Forge input');
  check(external.length === 0, 'No tested download used the external-browser workaround');
  console.log(JSON.stringify({ checks, passed: true }));
  win.destroy(); app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });

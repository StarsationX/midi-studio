// tools/library-smoke.js: a standalone Electron harness for the Library tab.
//
//   npx electron tools/library-smoke.js
//
// It loads renderer/library/index.html with the REAL preload against a temp
// folder of generated .mid files and a fake settings store, runs its assertions
// inside the page, prints PASS/FAIL lines and exits non-zero on any failure.
// It deliberately does NOT boot electron/main.js: no python sidecar, no other
// tabs, nothing touched outside os.tmpdir().
//
// The window MUST be visible and unthrottled -- Chromium suspends
// requestAnimationFrame in a hidden window and every VList paint is
// rAF-scheduled, so a hidden window reports empty lists that are actually fine.
//
// What it guards (all four were shipped broken once):
//   * the grid commits the real column count the first time Grid is clicked
//   * `play` stays tri-state: buttons omit it, only a row activation asks true
//   * a favourite whose file has gone is listed, marked and counted
//   * moving the keyboard cursor debounces the roll read instead of one
//     full-file parse per row
'use strict';
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = process.env.MS_ROOT || path.join(__dirname, '..');
const library = require(path.join(ROOT, 'electron', 'library.js'));

// ---- a temp folder of real, minimal MIDI files -----------------------------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-libharness-'));
function midi(notes) {
  const trk = [];
  for (let i = 0; i < notes; i++) {
    trk.push(0x00, 0x90, 60 + (i % 12), 0x64);
    trk.push(0x60, 0x80, 60 + (i % 12), 0x00);
  }
  trk.push(0x00, 0xff, 0x2f, 0x00);
  const body = Buffer.from(trk);
  const head = Buffer.alloc(14);
  head.write('MThd', 0, 'ascii');
  head.writeUInt32BE(6, 4);
  head.writeUInt16BE(0, 8);
  head.writeUInt16BE(1, 10);
  head.writeInt16BE(480, 12);
  const th = Buffer.alloc(8);
  th.write('MTrk', 0, 'ascii');
  th.writeUInt32BE(body.length, 4);
  return Buffer.concat([head, th, body]);
}
const names = [];
for (let i = 0; i < 24; i++) {
  const n = 'song ' + (i + 1) + '.mid';
  names.push(n);
  fs.writeFileSync(path.join(dir, n), midi(4 + i));
}
// one Forge-looking output with a sidecar, so hasAudio is exercised
fs.writeFileSync(path.join(dir, 'forged.mid'), midi(9));
fs.writeFileSync(path.join(dir, 'forged.midstudio.json'),
  JSON.stringify({ sourceAudio: path.join(dir, 'nope.wav'), pipeline: 'balanced', createdAt: new Date().toISOString() }));

const GONE = path.join(dir, 'unplugged drive song.mid');   // favourited, never created
let ui = { libraryFavorites: [path.join(dir, 'song 1.mid'), GONE] };

const dirs = () => [dir, dir];
ipcMain.handle('library:list', async () => {
  const r = await library.cachedScan(dirs(), []);
  return { dirs: dirs(), extra: [], files: r.files, truncated: r.truncated };
});
ipcMain.handle('library:scan', async (e) => {
  const r = await library.cachedScan(dirs(), [], (files) => {
    try { e.senderFrame.send('library-progress', { scanId: 1, kind: 'scan', files }); } catch (_) {}
  });
  const st = library.userState();
  return { scanId: 1, dirs: dirs(), extra: [], files: r.files, truncated: r.truncated,
    // A synthetic nearly-full drive, so the low-space signalling is exercised
    // instead of depending on whatever this machine happens to have free.
    storage: Object.assign({}, library.storageFor(dir),
      { root: 'Z:', totalBytes: 500e9, freeBytes: 2e9, usedBytes: 498e9 }),
    tags: st.tags, usage: st.usage, indexing: false };
});
let rollReads = 0;
ipcMain.handle('library:meta', async (_e, p) => {
  if (p && p.roll) rollReads++;
  return library.metaFor((p || {}).paths, { roll: (p || {}).roll });
});
ipcMain.handle('library:setTags', (_e, p) => ({ ok: true, tags: library.setTags(p.path, p.tags) }));
ipcMain.handle('library:usage', (_e, p) => ({ ok: true, usage: library.recordUsage(p.path, p.kind, p.at) }));
ipcMain.handle('library:index', async () => ({ ok: true, total: 0 }));
ipcMain.handle('library:delete', async () => ({ ok: true, trashed: [], failed: [] }));
ipcMain.handle('library:addFolder', async () => ({ ok: false, canceled: true }));
ipcMain.handle('library:removeFolder', () => ({ ok: true }));
ipcMain.handle('library:reveal', () => {});
ipcMain.handle('app:getUi', () => ui);
ipcMain.handle('app:setUi', (_e, patch) => { ui = Object.assign({}, ui, patch); return { ok: true }; });
ipcMain.handle('shell:openPath', () => ({ ok: true }));
ipcMain.handle('shell:showItem', () => ({ ok: true }));
void shell;

const results = [];
app.on('window-all-closed', () => app.quit());

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    // Must be VISIBLE and unthrottled: Chromium suspends requestAnimationFrame in
    // a hidden window, and every VList paint is rAF-scheduled.
    width: 1920, height: 1080, show: true,
    webPreferences: { preload: path.join(ROOT, 'electron', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
      backgroundThrottling: false }
  });
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) results.push('CONSOLE(' + level + '): ' + message);
  });
  await win.loadFile(path.join(ROOT, 'renderer', 'library', 'index.html'));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(2500);

  const script = `(async () => {
    const out = [];
    const T = (name, cond, extra) => out.push((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  [' + extra + ']' : ''));
    const $ = (id) => document.getElementById(id);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    T('the table rendered rows', $('rows').querySelectorAll('.lrow').length > 5,
      $('rows').querySelectorAll('.lrow').length + ' rows');

    // ---- 1. grid column count on the FIRST switch --------------------------
    document.querySelector('#viewmode button[data-mode="grid"]').click();
    await wait(120);
    const cols = getComputedStyle($('cards')).getPropertyValue('--cards').trim();
    const shelf = $('cards').querySelector('.lib-shelf:not([hidden])');
    T('grid picks the real column count on first use (not 3)', Number(cols) >= 6, '--cards=' + cols);
    T('the first shelf holds that many cards', shelf && shelf.children.length === Number(cols),
      shelf ? shelf.children.length + ' cards' : 'no shelf');
    T('every card is out of the tab order', [...$('cards').querySelectorAll('.lib-card')].length > 0
      && [...$('cards').querySelectorAll('.lib-card')].every((c) => c.tabIndex === -1));
    document.querySelector('#viewmode button[data-mode="list"]').click();
    await wait(80);

    // ---- 2. play is tri-state ---------------------------------------------
    const sent = [];
    $('rows').querySelector('.lrow:not([hidden])').click();
    await wait(60);
    const realSend = window.Bus.send;
    window.Bus.send = function (type, payload) { sent.push([type, payload]); return 0; };
    $('a-player').disabled = false;
    $('a-player').click();
    const btn = sent.find((s) => s[0] === 'nav:open-player');
    T('the Send to Player BUTTON omits play', btn && !('play' in btn[1]), btn ? JSON.stringify(btn[1]) : 'nothing sent');
    sent.length = 0;
    const row = $('rows').querySelector('.lrow:not([hidden])');
    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const act = sent.find((s) => s[0] === 'nav:open-player');
    T('activating a row still asks for play', act && act[1].play === true, act ? JSON.stringify(act[1]) : 'nothing sent');
    window.Bus.send = realSend;

    // ---- 3. a favourite whose file is gone -------------------------------
    [...document.querySelectorAll('#views .lrow')].find((r) => r.dataset.view === 'favorites').click();
    await wait(120);
    const favCount = document.querySelector('#views [data-count="favorites"]').textContent;
    const rows = [...$('rows').querySelectorAll('.lrow:not([hidden])')];
    const miss = rows.filter((r) => r.classList.contains('is-missing'));
    T('the Favorites count includes the missing favourite', favCount === '2', 'count=' + favCount);
    T('the missing favourite has a row', miss.length === 1, miss.length + ' missing rows of ' + rows.length);
    T('that row shows the word MISSING', !!miss[0] && !miss[0].querySelector('.lib-misstag').hidden);
    if (miss[0]) {
      miss[0].click();
      await wait(200);
      T('the inspector marks the path chip', $('p-path').classList.contains('is-missing'));
      T('the art plate says so', $('art-empty').textContent === 'File not found', $('art-empty').textContent);
      T('every file action is off but Favorite',
        $('a-player').disabled && $('a-listen').disabled && $('a-editor').disabled &&
        $('a-reveal').disabled && $('a-delete').disabled && $('a-preview').disabled && !$('a-fav').disabled);
    }

    // ---- 4. roving tabindex on the sidebar listboxes ---------------------
    const vrows = [...document.querySelectorAll('#views .lrow')];
    T('the views listbox is one tab stop', vrows.filter((r) => r.tabIndex === 0).length === 1,
      vrows.map((r) => r.tabIndex).join(','));
    const frows = [...document.querySelectorAll('#folders .lrow')];
    T('the folders listbox is one tab stop', frows.length === 0 || frows.filter((r) => r.tabIndex === 0).length === 1,
      frows.map((r) => r.tabIndex).join(','));

    // ---- 5. delete uses the app dialog, not window.confirm ---------------
    let nativeConfirm = false;
    window.confirm = () => { nativeConfirm = true; return false; };
    [...document.querySelectorAll('#views .lrow')].find((r) => r.dataset.view === 'all').click();
    await wait(150);
    $('rows').querySelector('.lrow:not([hidden])').click();
    await wait(120);
    $('a-delete').click();
    await wait(60);
    T('no native confirm was used', !nativeConfirm);
    T('the .dlg-scrim opened instead', !$('confirm-scrim').hidden && $('confirm-scrim').classList.contains('dlg-scrim'));
    T('focus is inside the dialog', $('confirm-scrim').contains(document.activeElement),
      document.activeElement && document.activeElement.id);
    $('confirm-scrim').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wait(260);
    T('Escape closes it', $('confirm-scrim').hidden);

    // ---- 9. a missing favourite refuses a hand-off ----------------------
    [...document.querySelectorAll('#views .lrow')].find((r) => r.dataset.view === 'favorites').click();
    await wait(200);
    const gone = [...$('rows').querySelectorAll('.lrow:not([hidden])')].find((r) => r.classList.contains('is-missing'));
    if (gone) {
      gone.click();
      await wait(120);
      const sent2 = [];
      const rs = window.Bus.send;
      window.Bus.send = function (t, p) { sent2.push(t); return 0; };
      $('a-player').disabled = false;
      $('a-player').click();
      window.Bus.send = rs;
      T('sending a missing file warns instead of handing off',
        !sent2.includes('nav:open-player') && sent2.includes('ui:toast'), sent2.join(','));
      gone.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 200 }));
      await wait(80);
      const menu = document.querySelector('.menu.is-open');
      const labels = menu ? [...menu.querySelectorAll('.menu-text')].map((n) => n.textContent) : [];
      T('its menu offers only un-favourite and copy',
        labels.length === 2 && labels[0] === 'Remove from Favorites' && labels[1] === 'Copy path', labels.join(' / '));
      if (window.Menu) window.Menu.close();
    } else { T('a missing favourite row exists for the menu test', false); }

    // ---- 7. hasAudio reaches the renderer -------------------------------
    [...document.querySelectorAll('#views .lrow')].find((r) => r.dataset.view === 'all').click();
    await wait(150);
    const q = $('q');
    q.value = 'forged';
    q.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(250);
    const forgedRow = $('rows').querySelector('.lrow:not([hidden])');
    T('the sidecar row is found', !!forgedRow, forgedRow ? forgedRow.textContent : '');
    if (forgedRow) {
      forgedRow.click();
      await wait(60);
      T('Preview is offered before the roll arrives (hasAudio)', !$('a-preview').disabled);
    }

    // ---- 8. low disk space is a word, not only a colour -----------------
    T('the low-space state is marked on the block', $('store').classList.contains('is-low'));
    T('and says so in words', !$('store-low').hidden && /Low/.test($('store-sub').textContent),
      $('store-sub').textContent);
    T('and in the meter aria-valuetext',
      /low space/.test($('store-meter').getAttribute('aria-valuetext') || ''),
      $('store-meter').getAttribute('aria-valuetext'));

    // ---- 9. the History disclosure is wired -----------------------------
    $('tab-history').click();
    const head = document.querySelector('#pane-history .insp-sec-head');
    head.click();
    T('collapsing History actually hides its body',
      head.getAttribute('aria-expanded') === 'false' && $('sec-hist').hidden);
    return out.join('\\n');
  })()`;

  let text = '';
  try { text = await win.webContents.executeJavaScript(script, true); }
  catch (error) { text = 'HARNESS ERROR: ' + String(error && error.message || error); }
  console.log(text);

  // ---- the roll read is debounced (counted in THIS process) ---------------
  const before = rollReads;
  const moves = await win.webContents.executeJavaScript(`(async () => {
    const host = document.getElementById('rows');
    const cur = () => { const c = host.querySelector('.lrow.is-cursor'); return c ? c.dataset.index : '?'; };
    document.getElementById('q').value = '';
    document.getElementById('q').dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 250));
    host.focus();
    const from = cur();
    for (let i = 0; i < 20; i++) host.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
    return from + ' -> ' + cur();
  })()`, true);
  await wait(900);
  const reads = rollReads - before;
  const okReads = reads <= 2 && / -> /.test(moves) && moves.split(' -> ')[0] !== moves.split(' -> ')[1];
  console.log((okReads ? 'PASS  ' : 'FAIL  ')
    + '20 cursor moves cause one trailing roll read, not 20  [' + reads + ' reads, cursor ' + moves + ']');
  if (!okReads) text += ' FAIL';
  if (results.length) console.log(results.join('\n'));
  try { library.flush(); } catch (_) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  win.destroy();
  app.exit(/FAIL|ERROR/.test(text) ? 1 : 0);
});

setTimeout(() => { console.log('HARNESS TIMEOUT'); app.exit(2); }, 45000);

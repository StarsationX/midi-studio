'use strict';

// Run with Electron: electron tools/editor-events-smoke.js <scratch-directory>
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const scratch = path.resolve(process.argv[2] || path.join(root, 'work/editor-events-smoke'));
const captures = process.argv[3] ? path.resolve(process.argv[3]) : null;
fs.mkdirSync(scratch, { recursive: true });
app.setPath('userData', path.join(scratch, 'profile-' + Date.now()));
app.disableHardwareAcceleration();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let checks = 0;
function check(condition, message) { assert.ok(condition, message); checks++; }

app.whenReady().then(async () => {
  const stubs = require('./ipc-stubs');
  stubs.registerStubs();
  const fixture = stubs.reviewPayload();
  fixture.project.sourceAudio = '';
  fixture.project.previewAudio = '';
  for (const note of fixture.documents.clean.notes) { note.start += 2; note.end += 2; }
  fixture.documents.clean.controllers = [{ time: 0.25, channel: 0, controller: 64, value: 127 }];
  fixture.documents.clean.markers = [{ time: 0.5, name: 'Intro' }];
  let saved = null, exported = null;
  ipcMain.removeHandler('review:load');
  ipcMain.handle('review:load', () => ({ ok: true, data: fixture }));
  ipcMain.removeHandler('review:saveProject');
  ipcMain.handle('review:saveProject', (_ev, data) => { saved = data; return { ok: true, projectPath: stubs.REVIEW_PROJECT, project: data.project }; });
  ipcMain.removeHandler('review:exportMidi');
  ipcMain.handle('review:exportMidi', (_ev, data) => { exported = data; return { ok: true, path: 'test-export.mid' }; });
  const win = new BrowserWindow({ width: 1440, height: 940, show: false, frame: false,
    webPreferences: { preload: path.join(root, 'electron/preload.js'), contextIsolation: true,
      sandbox: false, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
  const errors = [];
  win.webContents.on('console-message', (_ev, level, message) => { if (level >= 3) { errors.push(message); console.error(message); } });
  const run = async (code) => {
    try { return await win.webContents.executeJavaScript(`(() => { const $ = id => document.getElementById(id); ${code} })()`, true); }
    catch (error) { throw new Error(code + '\n' + error.message); }
  };
  const snapshot = () => run('return window.__review.snapshot();');
  const click = async (id) => { await run(`$('${id}').click();`); await delay(80); };
  const set = (id, value) => run(`$('${id}').value = ${JSON.stringify(String(value))};`);
  const submit = (id) => run(`$('${id}').requestSubmit();`);
  await win.loadFile(path.join(root, 'renderer/review/index.html'));
  await run(`window.__review.forcePython = true; return window.openReviewProject('fixture.mid');`);
  await delay(400);
  check((await snapshot()).controllers.length === 1, 'Load controller events');
  check((await snapshot()).markers[0].name === 'Intro', 'Load markers');
  check(await run(`return document.querySelectorAll('#lane-pick button:not(:disabled)').length === 6;`), 'All six lanes enabled');

  await run(`document.querySelector('[data-lane="mod"]').click();`);
  await set('cc-time', 1.25); await set('cc-value', 80); await submit('cc-form');
  check((await snapshot()).controllers.some((e) => e.controller === 1 && e.time === 1.25 && e.value === 80), 'Create modulation point');
  await set('cc-time', 2); await set('cc-value', 0); await submit('cc-form');
  check((await snapshot()).controllers.some((e) => e.controller === 1 && e.time === 2 && e.value === 0), 'Move point and retain zero value');
  await click('undo');
  check((await snapshot()).controllers.some((e) => e.time === 1.25 && e.value === 80), 'Undo controller edit');
  await click('redo');
  check((await snapshot()).controllers.some((e) => e.time === 2 && e.value === 0), 'Redo controller edit');
  await click('cc-new'); await set('cc-time', 3); await set('cc-value', 40); await submit('cc-form');
  check((await snapshot()).controllers.filter((e) => e.controller === 1).length === 2, 'Add second point without replacing first');
  await run(`$('auto').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));`);
  check((await snapshot()).controllers.some((e) => e.time === 3 && e.value === 41), 'Keyboard adjusts controller point');
  await click('cc-delete');
  check(!(await snapshot()).controllers.some((e) => e.time === 3), 'Delete controller point');
  await click('undo');
  check((await snapshot()).controllers.some((e) => e.time === 3 && e.value === 41), 'Undo controller deletion');

  for (const [lane, cc] of [['volume', 7], ['pan', 10], ['expr', 11], ['sustain', 64]]) {
    await run(`document.querySelector('[data-lane="${lane}"]').click();`);
    await set('cc-channel', 2); await run(`$('cc-channel').dispatchEvent(new Event('change'));`);
    await set('cc-time', 4); await set('cc-value', 100); await submit('cc-form');
    check((await snapshot()).controllers.some((e) => e.controller === cc && e.channel === 2 && e.value === 100), lane + ' channel editing');
  }

  await run(`document.querySelector('[data-lane="mod"]').click();`);
  await set('cc-channel', 3); await run(`$('cc-channel').dispatchEvent(new Event('change'));`);
  const pointer = (type, t, value) => run(`const canvas = $('auto'), rect = canvas.getBoundingClientRect(), host = $('auto-host'); const shift = Math.max(0, host.offsetLeft - $('roll-scroll').offsetLeft); host.dispatchEvent(new PointerEvent('${type}', { bubbles: true, pointerId: 1, button: 0, clientX: rect.left + 60 + ${t} * Number($('zoom').value) - $('roll-scroll').scrollLeft - shift, clientY: rect.top + rect.height - (${value} / 127) * (rect.height - 6) }));`);
  await pointer('pointerdown', 1, 60);
  check((await snapshot()).controllers.some((e) => e.channel === 3), 'Canvas adds controller point');
  await run(`$('auto').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));`);
  check(!(await snapshot()).controllers.some((e) => e.channel === 3), 'Escape restores controller gesture');
  await pointer('pointerdown', 1, 60); await pointer('pointermove', 1.5, 90); await pointer('pointercancel', 1.5, 90);
  check(!(await snapshot()).controllers.some((e) => e.channel === 3), 'Pointer cancellation restores controller gesture');
  await pointer('pointerdown', 1, 60); await pointer('pointermove', 1.5, 90); await pointer('pointerup', 1.5, 90);
  check((await snapshot()).controllers.filter((e) => e.channel === 3).length === 1, 'Select drag moves a single controller point');
  const beforeCancel = (await snapshot()).controllers;
  await pointer('pointerdown', beforeCancel.find((e) => e.channel === 3).time, 90);
  await pointer('pointermove', 2, 20); await pointer('pointercancel', 2, 20);
  assert.deepEqual((await snapshot()).controllers, beforeCancel); checks++;
  await click('undo');
  check(!(await snapshot()).controllers.some((e) => e.channel === 3), 'Whole controller drag is one undo step');
  await click('redo');
  check((await snapshot()).controllers.some((e) => e.channel === 3), 'Redo restores controller drag');

  await click('tab-markers');
  await set('marker-name', 'Verse'); await click('marker-add');
  check((await snapshot()).markers.some((m) => m.name === 'Verse' && m.time === 0), 'Add marker at playhead');
  await set('marker-name', 'Chorus'); await set('marker-time', 8.5); await submit('marker-form');
  check((await snapshot()).markers.some((m) => m.name === 'Chorus' && m.time === 8.5), 'Rename and move marker');
  await click('undo');
  check((await snapshot()).markers.some((m) => m.name === 'Verse' && m.time === 0), 'Undo marker edit');
  await click('redo');
  const orderedMarkers = (await snapshot()).markers;
  check(orderedMarkers.every((m, i) => !i || orderedMarkers[i - 1].time <= m.time), 'Redo keeps markers in chronological order');
  await run(`Array.from(document.querySelectorAll('.marker-row')).find((el) => el.textContent.includes('Chorus')).click();`);
  await click('marker-delete');
  check(!(await snapshot()).markers.some((m) => m.name === 'Chorus'), 'Delete marker');
  await click('undo');
  check((await snapshot()).markers.some((m) => m.name === 'Chorus'), 'Undo marker deletion');

  await click('a-save');
  check(saved && saved.documents.clean.controllers.length === (await snapshot()).controllers.length, 'Save includes controller edits');
  check(saved.documents.clean.markers.some((m) => m.name === 'Chorus'), 'Save includes markers');
  await click('a-more');
  await run(`Array.from(document.querySelectorAll('.menu-item')).find((el) => el.textContent.includes('Export MIDI')).click();`);
  await delay(80);
  check(exported && exported.document.markers.some((m) => m.name === 'Chorus'), 'Export includes marker edits');
  check(exported.document.controllers.length === saved.documents.clean.controllers.length, 'Export includes controller edits');

  await run(`Array.from(document.querySelectorAll('#src-list .lrow')).find((el) => el.textContent.toLowerCase().includes('quantised')).click();`);
  check((await snapshot()).markers.length === 0 && (await snapshot()).controllers.length === 0, 'Other take has independent events');
  await run(`Array.from(document.querySelectorAll('#src-list .lrow')).find((el) => el.textContent.toLowerCase().includes('clean')).click();`);
  check((await snapshot()).markers.some((m) => m.name === 'Chorus'), 'Switching back retains marker edits');
  const afterSwitch = await snapshot();
  await click('redo'); await click('undo');
  assert.deepEqual((await snapshot()).markers, afterSwitch.markers); checks++;

  await click('tab-props');
  const beforeStretch = await snapshot();
  await set('stretch', 200); await click('x-stretch');
  const stretched = await snapshot();
  check(stretched.markers.find((m) => m.name === 'Chorus').time === 17, 'Whole-take stretch moves markers');
  check(stretched.controllers[0].time === beforeStretch.controllers[0].time * 2, 'Whole-take stretch moves controllers');
  check(stretched.notes[0].start === 4 && stretched.controllers[0].time === 0.5, 'Stretch preserves pre-note controller timing and lead-in');
  await click('undo');
  check((await snapshot()).markers.find((m) => m.name === 'Chorus').time === 8.5, 'Undo stretch restores event times');

  await run(`Array.from(document.querySelectorAll('#markers button')).find((el) => el.textContent.includes('Take start')).click(); $('roll-scroll').scrollLeft = 0; $('roll-scroll').dispatchEvent(new Event('scroll'));`);
  for (const [time, value] of [[3, 40], [5, 80]]) {
    await click('cc-new'); await set('cc-time', time); await set('cc-value', value); await submit('cc-form');
  }

  for (const [width, height] of [[1440, 940], [1040, 700], [936, 506]]) {
    win.setSize(width, height); await delay(600);
    const geometry = await run(`const roll = $('roll').getBoundingClientRect(), lane = $('auto').getBoundingClientRect(), left = $('left-pane').getBoundingClientRect(), centre = document.querySelector('.ed-centre').getBoundingClientRect(); return { roll: roll.height, lane: lane.height, laneBottom: lane.bottom, paneBottom: centre.bottom, left: left.width, fits: document.documentElement.scrollWidth <= innerWidth && lane.bottom <= innerHeight };`);
    check(geometry.roll > 80 && geometry.lane > 40 && geometry.left >= 220 && geometry.fits && geometry.laneBottom <= geometry.paneBottom + 1,
      'Usable, unclipped markers and CC layout at ' + width + 'x' + height + ': ' + JSON.stringify(geometry));
    const toolbar = await run(`const bar = document.querySelector('.ed-tools').getBoundingClientRect(); return Array.from(document.querySelectorAll('.ed-tools button,.ed-tools select')).filter((el) => el.getBoundingClientRect().width > 0).map((el) => { const r = el.getBoundingClientRect(); return { id: el.id || el.textContent.trim(), visible: r.left >= bar.left && r.right <= bar.right + 1 && r.top >= bar.top && r.bottom <= bar.bottom + 1 }; });`);
    check(toolbar.every((control) => control.visible), 'Every editing toolbar action remains visible at ' + width + 'x' + height + ': ' + JSON.stringify(toolbar.filter((control) => !control.visible)));
    if (captures) {
      fs.mkdirSync(captures, { recursive: true });
      fs.writeFileSync(path.join(captures, 'editor-events-' + width + '.png'), (await win.webContents.capturePage()).toPNG());
    }
  }
  check(errors.length === 0, 'No renderer errors: ' + errors.join('\n'));
  console.log(JSON.stringify({ passed: checks, errors }));
  win.destroy(); app.exit(0);
}).catch((error) => { console.error(error.stack); app.exit(1); });

// layout-audit.js: find clipping, overlap and overflow across every page.
//
//   npx electron tools/layout-audit.js               1920x1080 and 1040x700
//   npx electron tools/layout-audit.js --sizes 2560x1440
//   npx electron tools/layout-audit.js --shot        also write PNGs
//   npx electron tools/layout-audit.js --only shell,forge
//   npx electron tools/layout-audit.js --states default,palette
//
// Loads each renderer page in a real Electron window with the real preload and
// reports, per page, per size and per STATE:
//   OVERFLOW  in-flow content wider/taller than its own non-scrolling box, so
//             text or a control is genuinely being cut off
//   POPOVER   the same measurement, but the overflow comes from an out-of-flow
//             box (an absolutely positioned child, or an abs ::before/::after
//             such as a data-tip bubble). A popup is MEANT to leave its anchor,
//             so this is a separate, quieter bucket -- but it is still reported,
//             because a popup that leaves the WINDOW shows up as an OVERFLOW on
//             <body> and this is how you find which popup did it.
//   ESCAPE    an element whose painted box extends past its clipping ancestor
//   OVERLAP   two static siblings that visually intersect
//   OFFSCREEN an element that sits outside the viewport entirely
//   truncated an element that clips a single line with an ellipsis (which is a
//             legitimate answer to text that does not fit) but offers no title,
//             aria-label or data-tip, so the full string cannot be read at all
//   CONSOLE   any console error or warning the page emitted
//
// Three things make the numbers trustworthy:
//
//  1. IPC IS ANSWERED. electron/main.js is not booted (it would spawn the
//     sidecar, scan the disk and open the real window), so every channel the
//     pages invoke on load is answered here by a stub that returns the same
//     SHAPE main.js returns, filled with realistic data: a few hundred library
//     files with names/sizes/mtimes, a provisioned Forge env with a GPU, a
//     loaded MIDI document with a few thousand notes. An unpopulated page hides
//     exactly the defects we are hunting -- a chip reading "Idle" is narrower
//     than one reading a real song title.
//  2. EVERY PAGE IS ISOLATED. Load, settle, setup, probe and capture all run
//     inside a try/catch, the window is always destroyed in a finally, and a
//     failure becomes a result row instead of aborting the run.
//  3. STATES. A panel that only clips once its content is real is the common
//     case, so a page may declare extra states: open the settings sheet, open
//     the palette, expand the log drawer, switch a pane, select a row. Each one
//     is probed in its own right.
//
// It stays deliberately noisy about real geometry and quiet about intent: a
// container that can actually scroll is excluded, as is anything marked hidden.
//
// The summary is printed AND written to benchmarks/layout-audit.json.
'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : '';
};
const WANT_SHOTS = argv.includes('--shot');
const SIZES = flag('--sizes')
  ? flag('--sizes').split(',').map((s) => s.split('x').map(Number))
  : [[1920, 1080], [1040, 700]];
const ONLY = flag('--only') ? flag('--only').split(',').map((s) => s.trim()).filter(Boolean) : null;
const ONLY_STATES = flag('--states') ? flag('--states').split(',').map((s) => s.trim()).filter(Boolean) : null;
const SETTLE = Number(flag('--settle')) || 1400;

// ===========================================================================
//  FIXTURES + IPC STUBS -- shared with the performance harnesses.
//  See tools/ipc-stubs.js: realistic data in main.js's exact return shapes.
// ===========================================================================
const stubs = require('./ipc-stubs');
const {
  HOME, OUT_DIR, EXTRA_DIR, FORGE_DIR, SONGS,
  HANDLERS, invoked, registerStubs,
  makeLibraryFiles, makeDocument, reviewPayload,
  LIB_FILES, STORAGE, LIB_TAGS, LIB_USAGE, FORGE_SETTINGS, OVERLAY_CFG, REVIEW_PROJECT,
} = stubs;

// ===========================================================================
//  THE PROBE -- runs inside the page, returns plain data only
// ===========================================================================
const PROBE = `(() => {
  const out = { overflow: [], popover: [], escape: [], overlap: [], offscreen: [], truncated: [] };
  const vw = innerWidth, vh = innerHeight;

  const label = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    const c = (el.getAttribute('class') || '').trim().split(/\\s+/).filter(Boolean).slice(0, 3);
    if (c.length) s += '.' + c.join('.');
    const t = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40);
    return t ? s + '  "' + t + '"' : s;
  };

  const visible = (el, cs) =>
    cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.01 &&
    el.offsetWidth > 0 && el.offsetHeight > 0;

  const scrolls = (cs) => /auto|scroll/.test(cs.overflowX + ' ' + cs.overflowY);
  const clips  = (cs) => /hidden|clip|auto|scroll/.test(cs.overflowX + ' ' + cs.overflowY);
  const outOfFlow = (cs) => cs.position === 'absolute' || cs.position === 'fixed';

  // A single-line run that clips with an ellipsis is TRUNCATING ON PURPOSE, and
  // the design system says that is one of the legitimate answers to text that
  // does not fit (.u-truncate, .aitem-name, .pathchip-dir, .lrow-name...).
  // Reporting those as clipping made the real cut-off text impossible to find.
  // The one thing that IS still wrong is truncating with no way to read the
  // whole string, so those land in their own quiet bucket instead.
  const ellipsis = (cs) =>
    cs.textOverflow === 'ellipsis' && /hidden|clip/.test(cs.overflowX) && /nowrap|pre$/.test(cs.whiteSpace);
  const hasFullText = (el) =>
    !!(el.title || el.getAttribute('aria-label') || el.dataset.tip ||
       (el.parentElement && (el.parentElement.title || el.parentElement.dataset.tip)) ||
       el.closest('[title]'));

  // Is this element's scroll overflow caused by something OUT OF FLOW -- an
  // absolutely positioned child, or an abs ::before/::after such as a data-tip
  // bubble? A popup is meant to be bigger than its anchor, so that is a
  // different finding from text being cut off. <html>/<body> are exempt: the
  // page itself must never overflow, whatever caused it.
  // How much do the IN-FLOW children alone stick out of the padding box? This is
  // what decides OVERFLOW vs POPOVER, and it has to be measured rather than
  // guessed: "does this element contain anything absolutely positioned" put the
  // whole titlebar in the popover bucket because of one 1px .nav-ind, and hid a
  // genuine 133px overflow whose cause was the in-flow window-control group.
  // Direct children only: a grandchild that overflows a non-clipping child is
  // reported on that child in its own right, so the chain is never lost.
  const inflowOverflow = (el, cs, r) => {
    const kids = el.children;
    if (!kids.length) return { dw: el.scrollWidth - el.clientWidth, dh: el.scrollHeight - el.clientHeight };
    const bl = parseFloat(cs.borderLeftWidth) || 0;
    const bt = parseFloat(cs.borderTopWidth) || 0;
    const right = r.left + bl + el.clientWidth;
    const bottom = r.top + bt + el.clientHeight;
    let dw = 0, dh = 0;
    for (const k of kids) {
      if (k.hasAttribute('hidden')) continue;
      const kcs = getComputedStyle(k);
      if (outOfFlow(kcs) || kcs.display === 'none' || kcs.visibility === 'hidden') continue;
      const kr = k.getBoundingClientRect();
      if (kr.width < 1 && kr.height < 1) continue;
      if (kr.right - right > dw) dw = kr.right - right;
      if (kr.bottom - bottom > dh) dh = kr.bottom - bottom;
    }
    return { dw, dh };
  };

  const all = Array.from(document.querySelectorAll('*'));
  for (const el of all) {
    if (el.closest('[hidden]') || el.hasAttribute('hidden')) continue;
    const cs = getComputedStyle(el);
    if (!visible(el, cs)) continue;
    const r = el.getBoundingClientRect();
    // 1x1 is the screen-reader-only pattern (.u-hidden-visually): its content is
    // MEANT to be far bigger than its box.
    if (r.width <= 1 || r.height <= 1) continue;

    // 1. Content bigger than its own box, in a box that cannot scroll to reveal
    //    it. That is text or a control being cut off.
    //    A form field is exempt: an <input>'s content is the user's own value and
    //    the field scrolls it natively as you type, so "value wider than the box"
    //    is normal operation, not clipping. (A 300px-long project name in a 132px
    //    field is a wide value, not a layout defect.)
    if (!scrolls(cs) && !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) {
      const dw = el.scrollWidth - el.clientWidth;
      const dh = el.scrollHeight - el.clientHeight;
      // 1px is rounding; a canvas manages its own bitmap.
      const cut = ellipsis(cs);
      // <html>/<body> keep the RAW figure: whatever caused it, the page itself
      // must never be wider or taller than the window, and this is the one
      // headline that says a popup has escaped the viewport.
      const page = el === document.body || el === document.documentElement;
      if (el.tagName !== 'CANVAS' && page && (dw > 1 || dh > 1)) {
        out.overflow.push({ el: label(el), dw, dh, w: Math.round(r.width), h: Math.round(r.height) });
      } else if (el.tagName !== 'CANVAS' && ((cut ? 0 : dw) > 1 || dh > 1)) {
        const flow = inflowOverflow(el, cs, r);
        // The in-flow figure can never exceed the real one; clamp so a rounding
        // difference in a rect cannot invent an overflow.
        const fdw = Math.min(dw, Math.max(0, Math.round(flow.dw)));
        const fdh = Math.min(dh, Math.max(0, Math.round(flow.dh)));
        if ((cut ? 0 : fdw) > 1 || fdh > 1) {
          out.overflow.push({ el: label(el), dw: fdw, dh: fdh, w: Math.round(r.width), h: Math.round(r.height) });
        } else {
          out.popover.push({ el: label(el), dw, dh, w: Math.round(r.width), h: Math.round(r.height) });
        }
      }
      if (cut && dw > 1 && !hasFullText(el)) {
        out.truncated.push({ el: label(el), dw, w: Math.round(r.width) });
      }
    }

    // 2. Painted box escaping the nearest clipping ancestor.
    let anc = el.parentElement;
    while (anc && anc !== document.body) {
      const acs = getComputedStyle(anc);
      if (clips(acs)) {
        const ar = anc.getBoundingClientRect();
        const outL = ar.left - r.left, outR = r.right - ar.right;
        const outT = ar.top - r.top,  outB = r.bottom - ar.bottom;
        // Ignore the scroll axis: content is meant to extend along it.
        const bad = Math.max(
          /auto|scroll/.test(acs.overflowX) ? 0 : Math.max(outL, outR),
          /auto|scroll/.test(acs.overflowY) ? 0 : Math.max(outT, outB)
        );
        if (bad > 1 && !outOfFlow(cs)) out.escape.push({ el: label(el), by: Math.round(bad), inside: label(anc) });
        break;
      }
      anc = anc.parentElement;
    }

    // 3. Wholly outside the viewport -- and NOT because a scroll container it
    //    lives in happens to be scrolled somewhere else. Content below the fold
    //    of a scrolling rail is not a defect; a fixed or absolutely placed box
    //    parked off the window is. This check used to report every element of
    //    every panel's scrolled-out inspector section, ~130 rows of pure noise
    //    that buried the four window buttons genuinely pushed off the titlebar.
    if (r.right < -1 || r.bottom < -1 || r.left > vw + 1 || r.top > vh + 1) {
      let scrollable = false;
      for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
        if (/auto|scroll/.test(getComputedStyle(a).overflowX + ' ' + getComputedStyle(a).overflowY)) { scrollable = true; break; }
      }
      if (!scrollable && !el.closest('.vlist, .dlg-scrim, .menu, .toast-host, .toasts, .splash, .pal-scrim')) {
        out.offscreen.push({ el: label(el), x: Math.round(r.left), y: Math.round(r.top) });
      }
    }
  }

  // 4. Sibling overlap among in-flow leaf-ish elements. Positioned things are
  //    meant to overlap, so only static siblings count.
  const seen = new Set();
  for (const el of all) {
    const kids = Array.from(el.children).filter((k) => {
      if (k.hasAttribute('hidden')) return false;
      const cs = getComputedStyle(k);
      return visible(k, cs) && cs.position === 'static' && cs.float === 'none';
    });
    for (let i = 0; i < kids.length; i++) {
      for (let j = i + 1; j < kids.length; j++) {
        const a = kids[i].getBoundingClientRect(), b = kids[j].getBoundingClientRect();
        const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (ox > 1 && oy > 1) {
          const key = label(kids[i]) + '|' + label(kids[j]);
          if (seen.has(key)) continue;
          seen.add(key);
          out.overlap.push({ a: label(kids[i]), b: label(kids[j]), ox: Math.round(ox), oy: Math.round(oy) });
        }
      }
    }
  }
  return out;
})()`;

// ===========================================================================
//  PAGES AND THEIR STATES
//  A state is { name, js?, main? }. `js` is evaluated in the page (a setup
//  script: open a sheet, switch a pane, select a row); `main` is an async fn
//  given the BrowserWindow, for pushing the events main.js would push. States
//  run in order in ONE window, each building on the last, and each is probed.
// ===========================================================================

const push = (win, channel, payload) => { try { win.webContents.send(channel, payload); } catch (_) {} };

// Wait for the page to be QUIET, not for a guessed number of milliseconds.
// Every render in the app is coalesced through a rAF (renderStrip, renderLog,
// VList.invalidate), so a fixed timeout caught a half-applied frame now and
// then -- a VList whose sizer had grown but whose rows had not moved yet showed
// up as a 306px overflow that was gone on the next run. Two frames plus a beat
// is enough for a rAF that schedules another rAF.
const SETTLE_JS = `new Promise((r) => requestAnimationFrame(() =>
  requestAnimationFrame(() => setTimeout(r, 120))))`;
async function settle(win) {
  try { await win.webContents.executeJavaScript(SETTLE_JS, true); }
  catch (_) { await new Promise((r) => setTimeout(r, 250)); }
}

// Fill the shell's activity strip, log and transport the way a working session
// would: a Forge job in flight, log traffic including errors, an update on
// offer, a game detected, and a real song playing with a long title.
const shellBusy = async (win) => {
  push(win, 'forge:status', { event: 'forge.job', jobId: 'j1', name: SONGS[1], kind: 'file' });
  push(win, 'forge:status', { event: 'forge.log', jobId: 'j1', line: `input: ${path.join(EXTRA_DIR, SONGS[1] + '.wav')}` });
  for (let i = 0; i < 40; i++) {
    push(win, 'forge:status', {
      event: 'forge.log', jobId: 'j1',
      line: i % 9 === 8
        ? `WARNING: onset model fell back to CPU for segment ${i} (cuda out of memory, 148 MiB short)`
        : `[demucs] separating stem ${i + 1}/40  ${path.join(EXTRA_DIR, SONGS[i % SONGS.length] + '.wav')}`,
      level: i % 17 === 16 ? 'error' : 'info',
    });
  }
  push(win, 'forge:status', { event: 'forge.progress', jobId: 'j1', stage: 'Separating stems (demucs htdemucs_ft)', percent: 41 });
  push(win, 'engine-error', 'Sidecar reported: could not launch the keypress engine (pywin32 missing)');
  push(win, 'update-status', { state: 'available', version: '2.28.0', current: '2.27.1', percent: 0, staged: false, canSelfUpdate: true });
  push(win, 'game-active', { name: 'RobloxPlayerBeta' });
  await new Promise((r) => setTimeout(r, 250));
};

const SHELL_TRANSPORT = `(() => {
  if (!window.Bus) return 'no bus';
  const caps = { seek: true, rate: true, loop: true, queue: true, volume: true, transpose: true,
                 target: 'Roblox - Grand Piano', notes: 4821 };
  window.Bus.send('transport:claim', { owner: 'player', caps: caps }, { local: true });
  window.Bus.send('transport:state', { owner: 'player', status: 'playing', position: 74.312,
    duration: 263.482, rate: 1.25, loop: { a: 40, b: 180 },
    label: ${JSON.stringify(SONGS[1])}, dirty: false, caps: caps }, { local: true });
  return 'ok';
})()`;

const settingsPane = (pane) => `(() => {
  const scrim = document.getElementById('set-scrim');
  if (scrim && scrim.hidden) document.getElementById('settings-btn').click();
  const b = document.querySelector('#set-nav button[data-pane="' + ${JSON.stringify(pane)} + '"]');
  if (b) b.click();
  return ${JSON.stringify(pane)};
})()`;

const PAGES = [
  {
    name: 'shell', file: 'renderer/index.html',
    states: [
      { name: 'boot' },
      { name: 'busy', main: shellBusy, js: SHELL_TRANSPORT },
      { name: 'palette', js: `(() => {
          document.getElementById('search-trigger').click();
          const i = document.getElementById('pal-input');
          i.value = 'no';
          i.dispatchEvent(new Event('input', { bubbles: true }));
          return 'ok';
        })()` },
      { name: 'palette-empty', js: `(() => {
          const i = document.getElementById('pal-input');
          i.value = 'zzzzqqqq';
          i.dispatchEvent(new Event('input', { bubbles: true }));
          return 'ok';
        })()` },
      { name: 'settings-appearance', js: `(() => {
          document.getElementById('pal-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          const s = document.getElementById('pal-scrim'); if (s) s.hidden = true;
          document.getElementById('settings-btn').click();
          return 'ok';
        })()` },
      { name: 'settings-playback', js: settingsPane('playback') },
      { name: 'settings-performance', js: `(() => {
          const b = document.querySelector('#set-nav button[data-pane="performance"]');
          if (b) b.click();
          const t = document.getElementById('s-perf-toggle');
          if (t && t.getAttribute('aria-expanded') !== 'true') t.click();
          return 'ok';
        })()` },
      { name: 'settings-forge', js: settingsPane('forge') },
      { name: 'settings-storage', js: settingsPane('storage') },
      { name: 'settings-updates', js: settingsPane('updates') },
      { name: 'settings-overlay', js: settingsPane('overlay') },
      { name: 'settings-about', js: settingsPane('about') },
      {
        // THE UNWATCHED RUN. Frames are lazy, so the Logs tab may never have
        // been opened when a Forge job produces its output -- and that output
        // must not be lost. These lines are pushed while renderer/logs/ has
        // never been loaded at all; the logs-tab state below then opens the tab
        // and checks every one of them arrived in the catch-up log:sync.
        name: 'logs-unwatched',
        js: `(async () => {
          if (document.getElementById('frame-logs').getAttribute('src')) return 'FAIL: the Logs frame was already loaded';
          for (let i = 0; i < 60; i++) {
            window.Bus.send(window.Bus.TYPES.FORGE_STATUS,
              { event: 'forge.log', jobId: 'j-unwatched', line: 'unwatched line ' + i }, { local: true });
          }
          for (let i = 0; i < 8; i++) await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 20)));
          return 'pushed 60 lines with the Logs frame never loaded';
        })()`,
      },
      {
        // End to end, and the only place the shell -> Logs path is exercised as
        // a whole: switch to the tab, push real lines through the shell's one
        // public door (ui:status), then read the numbers back out of the frame.
        // It proves the shell still owns the buffer, that the publish arrives
        // BATCHED (hundreds of lines, one message), that the list is
        // virtualised, and that both filters and the search work on real data.
        name: 'logs-tab',
        // Exactly the route Ctrl+6 takes when focus is inside a panel: main's
        // before-input-event forwards 'shell-shortcut' with {tab}, because the
        // stage swallowed the keydown. The two key maps are asserted equal in
        // run-tests.js; this is the delivery end of that pair.
        main: async (win) => { win.webContents.send('shell-shortcut', { tab: 'logs' }); },
        js: `(async () => {
          document.getElementById('set-close').click();
          const viaMain = document.getElementById('nav-logs').getAttribute('aria-selected') === 'true';
          document.getElementById('nav-logs').click();
          const fr = document.getElementById('frame-logs');
          const ready = () => { try { return fr.contentWindow && fr.contentWindow.Bus && fr.contentWindow.document.getElementById('counts'); } catch (_) { return null; } };
          for (let i = 0; i < 100 && !ready(); i++) await new Promise((r) => setTimeout(r, 100));
          if (!ready()) return 'FAIL: the Logs frame never came up';
          const w = fr.contentWindow, doc = w.document;
          let appends = 0, appended = 0;
          w.Bus.on(w.Bus.TYPES.LOG_APPEND, (p) => { appends++; appended += ((p && p.lines) || []).length; });
          for (let i = 0; i < 400; i++) {
            w.Bus.send(w.Bus.TYPES.UI_STATUS, { frame: 'logs', text: 'harness line ' + i, severity: i % 40 === 0 ? 'err' : 'info' });
          }
          for (let i = 0; i < 20; i++) await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 20)));
          const nodes = doc.querySelectorAll('#list .lrow').length;
          const all = doc.getElementById('counts').textContent;
          const q0 = doc.getElementById('q');
          q0.value = 'unwatched line';
          q0.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 300));
          const caught = doc.getElementById('counts').textContent;
          q0.value = '';
          q0.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 250));
          doc.getElementById('f-level').value = 'error';
          doc.getElementById('f-level').dispatchEvent(new Event('change', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 120));
          const errOnly = doc.getElementById('counts').textContent;
          doc.getElementById('f-level').value = 'all';
          doc.getElementById('f-level').dispatchEvent(new Event('change', { bubbles: true }));
          const q = doc.getElementById('q');
          q.value = 'line 17';
          q.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 300));
          const searched = doc.getElementById('counts').textContent;
          const strip = document.getElementById('as-errors').hidden ? 'hidden' : document.getElementById('as-log-count').textContent;
          if (appends === 0) return 'FAIL: no log:append reached the Logs tab';
          if (appended < 400) return 'FAIL: only ' + appended + ' of 400 lines arrived';
          if (appends > 8) return 'FAIL: ' + appends + ' messages for ' + appended + ' lines -- the publish is not batched';
          if (nodes > 120) return 'FAIL: ' + nodes + ' row nodes -- the list is not virtualised';
          if (!viaMain) return 'FAIL: the shell-shortcut tab message did not select the Logs tab';
          if (caught.indexOf('60 of') !== 0) return 'FAIL: the unwatched lines did not survive: ' + caught;
          return 'Ctrl+6 via main: ok | unwatched catch-up: ' + caught + ' | ' + appended + ' lines in ' + appends + ' batched message(s) | ' + nodes + ' row nodes | all: '
               + all + ' | errors: ' + errOnly + ' | search "line 17": ' + searched + ' | strip errors: ' + strip;
        })()`,
      },
      {
        // WHAT'S NEW, both sources. First the installed release, parsed from the
        // real CHANGELOG.md: this is the state that catches a heading, a section
        // or a bullet overflowing its column.
        name: 'whatsnew',
        js: `(async () => {
          const c = document.getElementById('set-close'); if (c) c.click();
          document.getElementById('version-chip').click();
          for (let i = 0; i < 60 && document.getElementById('wn-secs').children.length === 0; i++) {
            await new Promise((r) => setTimeout(r, 50));
          }
          const secs = [...document.querySelectorAll('#wn-secs .wn-sec-h')].map((h) => h.firstChild.textContent);
          const items = document.querySelectorAll('#wn-secs .wn-item').length;
          if (!secs.length) return 'FAIL: no sections rendered (fallback: '
            + document.getElementById('wn-fb-msg').textContent + ')';
          const trapped = document.activeElement && document.getElementById('wn-dlg').contains(document.activeElement);
          return 'v' + document.getElementById('wn-ver').textContent + ' '
            + document.getElementById('wn-name').textContent + ' '
            + document.getElementById('wn-date').textContent
            + ' | ' + secs.join(', ') + ' | ' + items + ' bullets | focus inside: ' + trapped;
        })()`,
      },
      {
        // Then the notes for an update on OFFER. They come from the status the
        // updater already sent, never a second request, and they have to be
        // labelled as a version the user is NOT running.
        name: 'whatsnew-available',
        main: async (win) => {
          push(win, 'update-status', {
            state: 'available', version: '3.1.0', current: '3.0.0', size: 96 * 1024 * 1024,
            canSelfUpdate: true, htmlUrl: 'https://github.com/StarsationX/midi-studio/releases/tag/v3.1.0',
            notes: '### New\n- **Stem picker.** Choose which separated stem is transcribed.\n'
              + '- Drum maps can be edited in the Editor.\n\n### Fixed\n'
              + '- The Library scan no longer restarts when a tag is written mid-scan.\n'
              + '- Perch remembered a monitor that was no longer attached.\n',
          });
          await new Promise((r) => setTimeout(r, 250));
        },
        js: `(async () => {
          const modes = document.getElementById('wn-modes');
          if (modes.hidden) return 'FAIL: the two-source toggle never appeared';
          document.getElementById('wn-mode-available').click();
          await new Promise((r) => setTimeout(r, 120));
          const offer = document.getElementById('wn-offer');
          if (offer.hidden) return 'FAIL: the offered notes are not labelled as a version being offered';
          const items = document.querySelectorAll('#wn-secs .wn-item').length;
          return 'offered ' + document.getElementById('wn-ver').textContent + ' | '
            + items + ' bullets | ' + offer.textContent;
        })()`,
      },
    ],
  },
  {
    name: 'forge', file: 'renderer/forge/index.html',
    states: [
      { name: 'default' },
      {
        name: 'running',
        main: async (win) => {
          push(win, 'forge:status', { event: 'forge.job', jobId: 'j1', name: SONGS[1], kind: 'file' });
          push(win, 'forge:status', { event: 'forge.progress', jobId: 'j1', stage: 'Transcribing piano (transkun)', percent: 63 });
          for (let i = 0; i < 24; i++) {
            push(win, 'forge:status', { event: 'forge.log', jobId: 'j1', line: `[transkun] frame ${i * 512} / 12288  ${SONGS[i % SONGS.length]}` });
          }
          await new Promise((r) => setTimeout(r, 200));
        },
      },
    ],
  },
  {
    name: 'editor', file: 'renderer/review/index.html',
    states: [
      { name: 'default' },
      // The Editor boots empty and only ever loads a document from a user
      // action, so its whole working layout -- piano roll, track list,
      // inspector, candidate switcher -- is invisible to an audit that just
      // loads the page. This clicks its own Open button; review:pick and
      // review:load answer with the 3200-note fixture project.
      { name: 'loaded', js: `(() => {
          const b = document.getElementById('empty-open');
          if (!b) return 'no #empty-open';
          b.click();
          return new Promise((r) => setTimeout(() => r('opened'), 1200));
        })()` },
    ],
  },
  {
    name: 'player', file: 'renderer/player/index.html',
    states: [
      { name: 'default' },
      {
        name: 'loaded',
        main: async (win) => {
          push(win, 'engine-event', { event: 'ready' });
          push(win, 'engine-event', WINDOWS_EVENT);
          push(win, 'engine-event', MIDI_LOADED);
          await new Promise((r) => setTimeout(r, 300));
        },
      },
      {
        name: 'playing',
        main: async (win) => {
          push(win, 'engine-event', { event: 'playback_started', duration: MIDI_LOADED.duration });
          push(win, 'engine-event', { event: 'progress', t: 74.312, sent: 812, total: 2600 });
          await new Promise((r) => setTimeout(r, 200));
        },
      },
    ],
  },
  {
    name: 'selfmidi', file: 'renderer/audition/index.html',
    states: [
      { name: 'default' },
      {
        name: 'loaded',
        main: async (win) => {
          push(win, 'engine-event', { event: 'ready' });
          push(win, 'engine-event', MIDI_LOADED);
          await new Promise((r) => setTimeout(r, 300));
        },
      },
    ],
  },
  {
    name: 'logs', file: 'renderer/logs/index.html',
    states: [
      // The empty state, then a realistic buffer. The page only ever receives
      // lines over the bus, so the fill posts a real log:sync envelope at
      // itself: in the top window parent === window, which is exactly the
      // source bus.js trusts.
      { name: 'default' },
      {
        name: 'filled',
        js: `(() => {
          const SRC = ['forge', 'setup', 'player', 'app', 'update', 'library'];
          const LVL = ['info', 'info', 'info', 'ok', 'warn', 'error'];
          const TEXT = [
            'Input: C:\\Users\\stars\\Music\\Clair de Lune (Debussy, 1905) - remastered.flac',
            'Separating stems with demucs htdemucs_ft, batch 2, 12 threads',
            'transcribe 46% eta 00:02:41',
            'Player engine ready.',
            'onnxruntime: falling back to CPU for one operator, this is slower',
            'Failed Clair de Lune.flac: CUDA out of memory (tried to allocate 2.10 GiB)'
          ];
          const lines = [];
          for (let i = 0; i < 480; i++) {
            const d = new Date(Date.now() - (480 - i) * 900);
            lines.push({
              id: i + 1, src: SRC[i % SRC.length], level: LVL[i % LVL.length],
              text: TEXT[i % TEXT.length],
              clock: String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0')
            });
          }
          window.postMessage({ ns: 'midi-studio', v: 1, kind: 'event', type: 'log:sync',
            payload: { lines, cap: 600, seq: lines.length } }, location.origin);
          return 'posted ' + lines.length;
        })()`,
      },
      {
        name: 'filtered-empty',
        js: `(() => {
          const q = document.getElementById('q');
          q.value = 'zzzznotathing';
          q.dispatchEvent(new Event('input', { bubbles: true }));
          return 'filtered';
        })()`,
      },
    ],
  },
  {
    name: 'library', file: 'renderer/library/index.html',
    states: [
      { name: 'default' },
      {
        name: 'row-selected',
        js: `(() => {
          const row = document.querySelector('.vlist .lrow, .vlist [role="option"]');
          if (!row) return 'no rows';
          row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          return 'clicked';
        })()`,
      },
    ],
  },
];

// ===========================================================================
//  RUNNER
// ===========================================================================

app.commandLine.appendSwitch('disable-renderer-backgrounding');
// The first run of this harness died with a crashpad "not connected" abort part
// way through, which took every page after it down with it. Nothing here needs
// the crash reporter, and no page is audited after the process is gone.
app.commandLine.appendSwitch('disable-crash-reporter');
app.commandLine.appendSwitch('no-sandbox');
app.disableHardwareAcceleration();
// THE BUG THAT KILLED THE FIRST RUN. Every page is audited in its own window and
// the window is destroyed before the next one opens, so between two pages there
// are zero windows -- and Electron's default 'window-all-closed' behaviour quits
// the app on Windows. The run ended, quietly and with exit code 0, after
// whichever page happened to be first (crashpad then complained it was "not
// connected" on the way down). Owning this event is what makes the loop finish.
app.on('window-all-closed', () => { /* the runner decides when we are done */ });

function countOf(res) {
  return res.overflow.length + res.escape.length + res.overlap.length + res.offscreen.length;
}

function printState(pageName, stateName, res, console_, popovers) {
  const n = countOf(res) + console_.length;
  const tail = [
    n ? `${n}` : 'clean',
    popovers ? `${popovers} popover` : '',
    res.truncated.length ? `${res.truncated.length} untitled-truncation` : '',
  ].filter(Boolean).join(', ');
  console.log(`\n-- ${pageName} / ${stateName}  (${tail})`);
  for (const c of console_.slice(0, 12)) console.log(`   ${c}`);
  for (const o of res.overflow.slice(0, 14)) {
    const w = o.dw > 1 ? `${o.dw}px wide` : '';
    const h = o.dh > 1 ? `${o.dh}px tall` : '';
    console.log(`   OVERFLOW  ${o.el}  content exceeds box by ${[w, h].filter(Boolean).join(', ')}  (box ${o.w}x${o.h})`);
  }
  for (const o of res.escape.slice(0, 12)) console.log(`   ESCAPE    ${o.el}  ${o.by}px outside  ${o.inside}`);
  for (const o of res.overlap.slice(0, 12)) console.log(`   OVERLAP   ${o.a}\n             over  ${o.b}   (${o.ox}x${o.oy}px)`);
  for (const o of res.offscreen.slice(0, 8)) console.log(`   OFFSCREEN ${o.el}  at ${o.x},${o.y}`);
  for (const o of res.truncated.slice(0, 6)) {
    console.log(`   truncated ${o.el}  clipped by ${o.dw}px with an ellipsis but no title/aria-label  (box ${o.w})`);
  }
  for (const o of res.popover.slice(0, 6)) {
    const w = o.dw > 1 ? `${o.dw}px wide` : '';
    const h = o.dh > 1 ? `${o.dh}px tall` : '';
    console.log(`   popover   ${o.el}  out-of-flow child exceeds anchor by ${[w, h].filter(Boolean).join(', ')}`);
  }
  const more = [
    res.overflow.length > 14 && `${res.overflow.length - 14} more overflow`,
    res.escape.length > 12 && `${res.escape.length - 12} more escape`,
    res.overlap.length > 12 && `${res.overlap.length - 12} more overlap`,
    res.popover.length > 6 && `${res.popover.length - 6} more popover`,
  ].filter(Boolean);
  if (more.length) console.log(`   ... ${more.join(', ')}`);
}

async function auditPage(page, w, h, report) {
  const file = path.join(ROOT, page.file);
  if (!fs.existsSync(file)) {
    console.log(`\n-- ${page.name}: MISSING ${page.file}`);
    report.push({ page: page.name, size: `${w}x${h}`, state: '-', failed: `missing ${page.file}`, counts: {} });
    return 1;
  }

  let win = null;
  let problems = 0;
  const console_ = [];

  try {
    win = new BrowserWindow({
      width: w, height: h, show: true, frame: false, backgroundColor: '#141519',
      webPreferences: {
        preload: path.join(ROOT, 'electron', 'preload.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: false,
        nodeIntegrationInSubFrames: true, backgroundThrottling: false,
      },
    });

    win.webContents.on('console-message', (_e, level, message, line, src) => {
      if (level >= 2) console_.push(`${level === 3 ? 'ERROR' : 'WARN '} ${message}  (${path.basename(src || '')}:${line})`);
    });
    win.webContents.on('did-fail-load', (_e, code, desc, url) => {
      console_.push(`ERROR did-fail-load ${code} ${desc} ${url}`);
    });
    win.webContents.on('render-process-gone', (_e, details) => {
      console_.push(`ERROR render-process-gone ${details && details.reason}`);
    });

    await win.loadFile(file);
    // Let fonts settle, canvases size themselves and the boot IPC answer.
    await new Promise((r) => setTimeout(r, SETTLE));
    await settle(win);

    const states = (page.states || [{ name: 'default' }])
      .filter((s) => !ONLY_STATES || ONLY_STATES.includes(s.name));

    for (const state of states) {
      const taken = console_.splice(0, console_.length);   // console since the last state
      try {
        if (state.main) await state.main(win);
        if (state.js) {
          const r = await win.webContents.executeJavaScript(state.js, true);
          // A setup script may return a note ("no rows", a diagnostic dump);
          // printing it is how you tell "the state was set up" from "the
          // selector missed and the state never happened".
          if (r != null && r !== 'ok' && r !== state.name) console.log(`   setup(${state.name}) -> ${String(r).slice(0, 400)}`);
        }
        if (state.main || state.js) await settle(win);

        const res = await win.webContents.executeJavaScript(PROBE, true);
        const mine = taken.concat(console_.splice(0, console_.length));
        const n = countOf(res) + mine.length;
        problems += n;
        printState(page.name, state.name, res, mine, res.popover.length);
        report.push({
          page: page.name, size: `${w}x${h}`, state: state.name,
          counts: {
            overflow: res.overflow.length, popover: res.popover.length, escape: res.escape.length,
            overlap: res.overlap.length, offscreen: res.offscreen.length, console: mine.length,
            truncated: res.truncated.length,
          },
          problems: n,
          console: mine, overflow: res.overflow, popover: res.popover,
          escape: res.escape, overlap: res.overlap, offscreen: res.offscreen,
          truncated: res.truncated,
        });

        if (WANT_SHOTS) {
          const img = await win.webContents.capturePage();
          fs.writeFileSync(path.join(ROOT, 'benchmarks', 'shots', `${page.name}-${state.name}-${w}x${h}.png`), img.toPNG());
        }
      } catch (err) {
        console.log(`\n-- ${page.name} / ${state.name}: STATE FAILED  ${err && err.message}`);
        problems++;
        report.push({ page: page.name, size: `${w}x${h}`, state: state.name, failed: String(err && err.message || err), counts: {} });
      }
    }
  } catch (err) {
    console.log(`\n-- ${page.name}: PAGE FAILED  ${err && err.message}`);
    problems++;
    report.push({ page: page.name, size: `${w}x${h}`, state: '-', failed: String(err && err.message || err), counts: {} });
  } finally {
    // Always, whatever happened above: one page must never take the run down.
    try { if (win && !win.isDestroyed()) win.destroy(); } catch (_) {}
    await new Promise((r) => setTimeout(r, 120));
  }
  return problems;
}

app.whenReady().then(async () => {
  registerStubs();
  if (WANT_SHOTS) fs.mkdirSync(path.join(ROOT, 'benchmarks', 'shots'), { recursive: true });

  const report = [];
  let problems = 0;
  const pages = PAGES.filter((p) => !ONLY || ONLY.includes(p.name));

  for (const [w, h] of SIZES) {
    console.log(`\n${'='.repeat(70)}\n  ${w} x ${h}\n${'='.repeat(70)}`);
    for (const page of pages) problems += await auditPage(page, w, h, report);
  }

  // ---- per-page roll-up ---------------------------------------------------
  const byPage = new Map();
  for (const row of report) {
    const k = row.page;
    const acc = byPage.get(k) || { page: k, overflow: 0, popover: 0, escape: 0, overlap: 0, offscreen: 0, console: 0, truncated: 0, failed: 0 };
    if (row.failed) acc.failed++;
    for (const key of ['overflow', 'popover', 'escape', 'overlap', 'offscreen', 'console', 'truncated']) acc[key] += (row.counts && row.counts[key]) || 0;
    byPage.set(k, acc);
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log('  per page (all sizes, all states)');
  console.log(`${'='.repeat(70)}`);
  for (const a of byPage.values()) {
    const bits = ['overflow', 'escape', 'overlap', 'offscreen', 'console', 'popover', 'truncated']
      .filter((k) => a[k]).map((k) => `${k} ${a[k]}`);
    console.log(`  ${a.page.padEnd(10)} ${a.failed ? `FAILED x${a.failed}  ` : ''}${bits.length ? bits.join(', ') : 'clean'}`);
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    sizes: SIZES.map(([w, h]) => `${w}x${h}`),
    problems,
    stubChannelsInvoked: Array.from(invoked).sort(),
    stubChannelsUnused: Object.keys(HANDLERS).filter((c) => !invoked.has(c)).sort(),
    perPage: Array.from(byPage.values()),
    results: report,
  };
  const outFile = path.join(ROOT, 'benchmarks', 'layout-audit.json');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(summary, null, 2), 'utf-8');

  console.log(`\n${problems ? problems + ' problems' : 'clean'}   ->  benchmarks/layout-audit.json\n`);
  app.exit(problems ? 1 : 0);
});

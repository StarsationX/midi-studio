// Perch, the overlay window's renderer.
//
// It owns no playback state of its own. It listens to the same engine-event
// stream the Player tab listens to and draws it, so there is exactly one clock
// and the two windows cannot disagree about where in the song you are.
'use strict';

const $ = (id) => document.getElementById(id);
const root = document.documentElement;
const card = $('card');
const bridge = window.perch || {};

// The Visualizer no longer owns a canvas or a context: the caller fits the
// canvas and hands it a 2D context in CSS pixels. Perch keeps its own 30fps
// loop rather than joining the Draw scheduler, because this window is not a
// panel of the shell and has no on-screen budget pushed into it.
const viz = new Visualizer();
const vizCanvas = $('viz');

let totalDuration = 0;
let playing = false;
let paused = false;
let focusLost = false;
let playedCount = 0;
let totalNotes = 0;
let songName = '';
let autoShown = false;   // opened by a Play, not by the user
let cfg = {
  mode: 'full', opacity: 0.92, clickThrough: false, locked: false,
  autoShow: true, autoHide: true, lookahead: 3, showKeys: true, showTransport: true,
};

// ---------------------------------------------------------------------------
// Painting
// ---------------------------------------------------------------------------

// "3s", "3.5s": the same reading Settings > Overlay shows for the same value.
function fmtSeconds(v) {
  const n = Math.round(Number(v) * 2) / 2;
  return (Number.isInteger(n) ? String(n) : n.toFixed(1)) + 's';
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------
// Perch is its own window, so the shell's skinFrame() never reaches it. The
// shell keeps the current preset and any custom accent in localStorage; both
// windows share the origin, so the value is here on first paint and the
// storage event brings every later change (Electron and WebView2 alike).
const SKIN_KEY = 'midi-studio:skin';
const ACCENT_KEYS = ['--accent', '--accent-2', '--accent-deep', '--accent-ink', '--accent-soft', '--accent-line', '--ok'];
function applySkin(raw) {
  let skin = null;
  try { skin = raw ? JSON.parse(raw) : null; } catch (_) { skin = null; }
  const theme = (skin && typeof skin.theme === 'string') ? skin.theme : '';
  if (theme) root.dataset.theme = theme; else delete root.dataset.theme;
  const vars = skin && skin.vars && typeof skin.vars === 'object' ? skin.vars : null;
  for (const k of ACCENT_KEYS) {
    const v = vars && typeof vars[k] === 'string' ? vars[k] : '';
    if (v) root.style.setProperty(k, v); else root.style.removeProperty(k);
  }
  if (window.Tokens) window.Tokens.refresh();
}
// Channel 1 and the hit line are the accent, so the roll repaints with it.
if (window.Tokens) window.Tokens.onChange(() => viz.retheme());
try { applySkin(localStorage.getItem(SKIN_KEY)); } catch (_) {}
window.addEventListener('storage', (e) => { if (e.key === SKIN_KEY) applySkin(e.newValue); });

function fmtClock(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Idle / playing / paused / blocked. "Blocked" is focus loss: playback has
// stopped and is waiting for the user to do something, which is a different
// thing from a pause they asked for and has to look different.
function stateName() {
  if (focusLost && playing) return 'blocked';
  if (playing && paused) return 'paused';
  if (playing) return 'playing';
  return 'idle';
}

function paintChrome() {
  card.dataset.state = stateName();
  const blocked = stateName() === 'blocked';
  $('veil').hidden = !blocked;
  const go = playing && !paused;
  $('t-play').innerHTML = Icon.svg(go ? 'pause' : 'play', go ? 12 : 13);
  $('t-play').title = go ? 'Pause' : 'Play';
  $('t-play').setAttribute('aria-label', go ? 'Pause' : 'Play');
  $('song').textContent = songName || 'No file';
  $('song').title = songName || '';
  $('t-count').textContent = `${playedCount}/${totalNotes}`;
  // The strip is the whole readout in slim mode, so it cannot sit on an empty
  // placeholder until the first note lands.
  $('strip-note').textContent = totalNotes ? `${playedCount}/${totalNotes} notes` : 'No file';
}

let lastFrameAt = 0;
let rafId = 0;
function frame(now) {
  rafId = requestAnimationFrame(frame);
  // 30fps is plenty for an overlay and leaves the frame budget to the game
  // underneath, which is the thing actually being looked at.
  if (now - lastFrameAt < 32) return;
  lastFrameAt = now;

  const elapsed = viz.elapsed();
  if (cfg.mode === 'full' && vizCanvas && vizCanvas.clientWidth > 0) {
    const fit = window.Draw.fitCanvas(vizCanvas, vizCanvas.clientWidth, vizCanvas.clientHeight,
      { contextAttributes: { alpha: false } });
    if (fit && fit.ctx) viz.render(fit.ctx, fit.w, fit.h);
  }

  $('clock').textContent = totalDuration
    ? `${fmtClock(elapsed)} / ${fmtClock(totalDuration)}`
    : fmtClock(elapsed);
  $('strip-time').textContent = `${fmtClock(elapsed)} / ${fmtClock(totalDuration)}`;
  const pct = totalDuration > 0 ? Math.max(0, Math.min(100, 100 * elapsed / totalDuration)) : 0;
  $('meter-fill').style.width = pct + '%';
}
rafId = requestAnimationFrame(frame);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function applyConfig(next) {
  cfg = { ...cfg, ...(next || {}) };
  root.dataset.mode = cfg.mode;
  root.dataset.transport = cfg.showTransport === false ? '0' : '1';
  card.dataset.locked = cfg.locked ? '1' : '0';
  // Tauri's drag region (Electron's is the CSS app-region, keyed off the same flag).
  $('head').setAttribute('data-tauri-drag-region', cfg.locked ? 'false' : 'deep');
  // The visualizer takes a speed multiplier off a 3 second baseline; the user
  // thinks in seconds of music, so convert at the boundary.
  viz.setStyle({
    speed: 3 / Math.max(1, Math.min(12, cfg.lookahead || 3)),
    keys: cfg.showKeys !== false,
  });

  $('m-opacity').value = Math.round(cfg.opacity * 100);
  $('m-opacity-val').textContent = Math.round(cfg.opacity * 100) + '%';
  $('m-lookahead').value = cfg.lookahead;
  $('m-lookahead-val').textContent = fmtSeconds(cfg.lookahead);
  $('m-click').checked = !!cfg.clickThrough;
  $('m-lock').checked = !!cfg.locked;
  $('m-keys').checked = cfg.showKeys !== false;
  $('m-transport').checked = cfg.showTransport !== false;
  $('m-autoshow').checked = cfg.autoShow !== false;
  $('m-autohide').checked = cfg.autoHide !== false;
  for (const b of $('m-mode').querySelectorAll('button')) {
    b.setAttribute('aria-checked', String(b.dataset.mode === cfg.mode));
  }
  paintChrome();
}

const push = (patch) => { applyConfig({ ...cfg, ...patch }); bridge.apply && bridge.apply(patch); };

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

function onEngineEvent(evt) {
  if (!evt || !evt.event) return;
  switch (evt.event) {
    case 'midi_loaded':
      viz.load(evt.events, evt.note_to_key);
      totalDuration = evt.duration || 0;
      totalNotes = (evt.events || []).length;
      playedCount = 0;
      paintChrome();
      break;

    case 'now_playing':          // synthesised by the main process from the
      songName = evt.name || ''; // load/play command, which is where the
      paintChrome();             // filename actually lives
      if (evt.autoShown) autoShown = true;
      break;

    case 'countdown':
      $('count').hidden = false;
      $('count').textContent = String(evt.i);
      break;

    case 'playback_started':
      $('count').hidden = true;
      playing = true; paused = false; focusLost = false;
      autoShown = false;
      viz.startClock(totalDuration, evt.start_elapsed || 0);
      paintChrome();
      break;

    case 'progress':
      viz.clockSet({ elapsed: evt.elapsed, frozen_elapsed: evt.frozen_elapsed });
      playedCount = evt.played || 0;
      if (evt.total_notes) totalNotes = evt.total_notes;
      if (!!evt.focus_lost !== focusLost || !!evt.user_paused !== paused) {
        focusLost = !!evt.focus_lost;
        paused = !!evt.user_paused;
        paintChrome();
      }
      $('strip-note').textContent = `${playedCount}/${totalNotes} notes`;
      break;

    case 'playback_done':
      $('count').hidden = true;
      playing = false; paused = false; focusLost = false;
      viz.stopClock();
      paintChrome();
      if (cfg.autoHide !== false) bridge.close && bridge.close();
      break;

    // A Play that fails before it starts ("Target window no longer exists.")
    // never reaches playback_done; the Perch it opened goes with it.
    case 'error':
      if (playing || !autoShown) break;
      autoShown = false;
      $('count').hidden = true;
      bridge.close && bridge.close();
      break;
  }
}

if (bridge.onEngineEvent) bridge.onEngineEvent(onEngineEvent);
if (bridge.onConfig) bridge.onConfig(applyConfig);

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

// Transport goes out as a synthetic hotkey, which is the path the Player tab
// already handles. That keeps queue and playlist logic in one place instead of
// giving the overlay a second, slightly different copy of it.
const command = (name) => bridge.command && bridge.command(name);
$('t-play').addEventListener('click', () => command(playing && !paused ? 'pause' : 'play'));
$('t-stop').addEventListener('click', () => command('stop'));
$('t-next').addEventListener('click', () => command('next_track'));
$('t-prev').addEventListener('click', () => command('prev_track'));
$('btn-close').addEventListener('click', () => bridge.close && bridge.close());

const menu = $('menu');
$('btn-menu').addEventListener('click', () => {
  menu.hidden = !menu.hidden;
  $('btn-menu').setAttribute('aria-expanded', String(!menu.hidden));
});
// Anywhere outside closes it. A settings sheet left open covers the roll.
document.addEventListener('mousedown', (e) => {
  if (menu.hidden) return;
  if (menu.contains(e.target) || $('btn-menu').contains(e.target)) return;
  menu.hidden = true;
  $('btn-menu').setAttribute('aria-expanded', 'false');
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !menu.hidden) {
    menu.hidden = true;
    $('btn-menu').setAttribute('aria-expanded', 'false');
  }
});

$('m-mode').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-mode]');
  if (b) push({ mode: b.dataset.mode });
});
$('m-snap').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-snap]');
  if (b && bridge.snap) bridge.snap(b.dataset.snap);
});
$('m-opacity').addEventListener('input', (e) => push({ opacity: Number(e.target.value) / 100 }));
$('m-lookahead').addEventListener('input', (e) => push({ lookahead: Number(e.target.value) }));
$('m-click').addEventListener('change', (e) => push({ clickThrough: e.target.checked }));
$('m-lock').addEventListener('change', (e) => push({ locked: e.target.checked }));
$('m-keys').addEventListener('change', (e) => push({ showKeys: e.target.checked }));
$('m-transport').addEventListener('change', (e) => push({ showTransport: e.target.checked }));
$('m-autoshow').addEventListener('change', (e) => push({ autoShow: e.target.checked }));
$('m-autohide').addEventListener('change', (e) => push({ autoHide: e.target.checked }));

// The frameless window has only a few pixels of OS resize border, which is
// hard to hit on purpose. The visible grip drives the same resize by hand.
(function dragToResize() {
  const grip = $('grip');
  let from = null;
  grip.addEventListener('mousedown', (e) => {
    if (cfg.locked) return;
    e.preventDefault();
    from = { x: e.screenX, y: e.screenY, w: window.outerWidth, h: window.outerHeight };
  });
  window.addEventListener('mousemove', (e) => {
    if (!from) return;
    const w = Math.max(120, from.w + (e.screenX - from.x));
    const h = Math.max(52, from.h + (e.screenY - from.y));
    bridge.resize && bridge.resize(Math.round(w), Math.round(h));
  });
  window.addEventListener('mouseup', () => { from = null; });
})();

if (bridge.ready) bridge.ready();

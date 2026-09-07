// player/app.js — the Player panel.
//
// This tab types simulated keystrokes into another application, so timing is
// the product and everything else is decoration. Two rules follow from that and
// they are the reason this file is shaped the way it is:
//
//   1. PRESENTATION NEVER DRIVES TIMING. The Python sidecar owns the clock and
//      the keypresses. Everything on screen interpolates from the progress
//      packets it sends. If every canvas in this file stopped drawing, not one
//      keystroke would change.
//   2. NOTHING ALLOCATES IN A LOOP. A garbage collection runs on the same
//      thread that has to service a 20Hz progress stream and dispatch key
//      events, so a few hundred throwaway objects per frame is a *timing* bug.
//      Control values are mirrored into module variables, colours and gradients
//      are precomputed, the static parts of both canvases live in offscreen
//      layers, and localStorage is written on a trailing debounce, never per
//      pointermove.
//
// The draw budget belongs to the shared scheduler: Draw applies the user's
// base, the x3 game raise, the 250ms unfocused clamp and the >=30fps playback
// floor exactly once each, and parks every consumer when this frame is off
// screen. This file registers consumers and calls invalidate(); it never
// computes a budget and never opens a rAF of its own.
//
// The floor is an ALLOWANCE, not a heartbeat. Draw is strictly dirty-driven, so
// a consumer that only invalidates on an engine packet runs at the packet rate
// (20Hz) however generous the budget is. The roll therefore re-invalidates
// itself at the end of its own draw while the notes are moving, which is the
// documented way to animate here: dirty is cleared before draw runs, so that
// asks for the NEXT frame and cannot spin inside the current one.

(() => {
  'use strict';

  const T = window.Bus.TYPES;
  const FRAME = 'player';
  const api = window.api || {};
  const studio = window.studio || {};
  const Lib = window.PlayerLibrary || null;
  const $ = (id) => document.getElementById(id);

  // Everything that has to be undone when this document goes away.
  const disposers = [];
  const keep = (fn) => { if (typeof fn === 'function') disposers.push(fn); return fn; };
  function on(target, type, handler, opts) {
    target.addEventListener(type, handler, opts);
    keep(() => target.removeEventListener(type, handler, opts));
  }
  const timers = new Set();
  function later(fn, ms) {
    const id = setTimeout(() => { timers.delete(id); fn(); }, ms);
    timers.add(id);
    return id;
  }

  // One rAF per burst, last value wins. For painting.
  function coalesce(fn) {
    let armed = false, args = null;
    return (...a) => {
      args = a;
      if (armed) return;
      armed = true;
      requestAnimationFrame(() => { armed = false; fn(...args); });
    };
  }
  // Trailing edge, last value wins. For writes. flush() INVOKES, cancel() drops.
  function debounce(fn, ms) {
    let t = 0, last = null;
    const w = (...a) => {
      last = a;
      clearTimeout(t);
      t = setTimeout(() => { t = 0; const p = last; last = null; fn(...p); }, ms);
    };
    w.flush = () => { if (!t) return; clearTimeout(t); t = 0; const p = last; last = null; if (p) fn(...p); };
    w.cancel = () => { clearTimeout(t); t = 0; last = null; };
    w.pending = () => !!t;
    return w;
  }
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  // A key pressed inside a text field, a select or a capture widget belongs to
  // that control, never to the transport or a hotkey.
  function inFormControl(el) {
    return !!el && (
      el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' ||
      el.isContentEditable || el.classList.contains('hk-slot')
    );
  }
  // Space and Home are ACTIVATION keys, so the set that owns them is wider than
  // the set that owns typing: every .switch, .checkbox and segment here is a
  // <button> that Chromium activates from the space keydown default, and the
  // scrubber and the song map answer Home/End/arrows themselves. Same shape as
  // the shell's isFormFocus (shell.js §0), which is what this has to agree with.
  // Deliberately NOT used for the panic hotkey: a safety key must still fire
  // while a button happens to hold focus.
  function ownsActivationKeys(el) {
    if (!el) return false;
    if (inFormControl(el)) return true;
    return el.tagName === 'BUTTON' || el.getAttribute('role') === 'slider'
      || el === mapHost || el.id === 'map-host';
  }
  const base = (p) => window.Fmt.basename(p || '');
  const clock = (s) => window.Fmt.clock(s);

  // ==========================================================================
  // 1. SETTINGS
  // Same v3 key and the same field names, so an existing install keeps its
  // playlist, its hotkeys and its target. Writes are debounced: the old version
  // stringified the whole object (a 200-entry playlist included) from ~30
  // handlers, tempo/colour/fall-speed 'input' among them, i.e. a synchronous
  // localStorage write per pointermove.
  // ==========================================================================
  const SETTINGS_KEY = 'midi-player.settings.v3';
  const DEFAULTS = {
    midiPath: '', mapping: 'roblox', customMappingPath: '',
    tempo: 1.0, countdown: 0, stats: false, sustain: true,
    playHotkey: '<f6>', stopHotkey: '<f7>', pauseHotkey: '<f8>',
    tempoUpHotkey: '', tempoDownHotkey: '', tempoSetHotkey: '',
    seekFwdHotkey: '', seekBackHotkey: '', nextHotkey: '', prevHotkey: '',
    panicHotkey: '',
    transpose: 0, tempoStep: 0.1, tempoPreset: 1.0, seekStep: 5,
    targetHint: '', autoPickTarget: true,
    openSection: 'source', leftClosed: '',
    noteColor: '', fallSpeed: 1,
    mapCollapsed: true, railSections: '',
    recentFiles: [], playlist: [], playlistCurrent: '', queueLoop: false,
    hand: 'both', handSplit: 60, chordStaggerMs: 0,
    rangeLoop: false, rampStart: 100, rampStep: 5
  };
  let settings;
  try {
    settings = Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'));
  } catch (_) {
    settings = Object.assign({}, DEFAULTS);
  }
  const persist = () => {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (_) { /* private mode */ }
  };
  const saveSettings = debounce(persist, 350);
  keep(() => saveSettings.flush());

  // Four stacked cards, every one of them collapsible and all of them open by
  // default. The column scrolls, so 'everything closed' is a legal state and
  // needs no defending; only what the user shut is remembered.
  const LEFT_TABS = ['song', 'target', 'playback', 'prefs'];

  // Mirrored control values. Read these in the scheduled paths; never a DOM
  // control, and never a getComputedStyle.
  let mapping = settings.mapping || 'roblox';
  let customMappingPath = settings.customMappingPath || '';
  let tempo = clamp(Number(settings.tempo) || 1, 0.25, 3);
  let transposeVal = clamp(settings.transpose | 0, -24, 24);
  let countdownVal = clamp(settings.countdown | 0, 0, 10);
  let chordStaggerVal = clamp(settings.chordStaggerMs | 0, 0, 30);
  let handVal = ['both', 'right', 'left'].indexOf(settings.hand) >= 0 ? settings.hand : 'both';
  let handSplitVal = clamp(settings.handSplit | 0 || 60, 24, 108);
  let sustainVal = settings.sustain !== false;
  let statsVal = !!settings.stats;
  let queueLoopVal = !!settings.queueLoop;
  let seekStepVal = Math.max(1, Math.abs(Number(settings.seekStep)) || 5);
  let tempoStepVal = Math.max(0.01, Math.abs(Number(settings.tempoStep)) || 0.1);
  let tempoPresetVal = clamp(Number(settings.tempoPreset) || 1, 0.25, 3);
  let fallSpeedVal = clamp(Number(settings.fallSpeed) || 1, 0.25, 4);
  let noteColorVal = settings.noteColor || '';
  let autoPickVal = settings.autoPickTarget !== false;
  let rangeLoopVal = !!settings.rangeLoop;
  let rampStartVal = clamp(settings.rampStart | 0 || 100, 25, 100);
  let rampStepVal = clamp(settings.rampStep | 0 || 5, 1, 50);
  const TEMPO_MIN = 0.25, TEMPO_MAX = 3;

  // ==========================================================================
  // 2. RUNTIME STATE
  // ==========================================================================
  let windows = [];
  let targetHwnd = null;
  let lastMidiPath = '';
  let totalDuration = 0;
  let totalNotes = 0;
  let bpm = 0;
  let bpmEstimate = 0;          // what the note spacing implies, when it disagrees
  let keysMapped = 0;
  let channelMask = 0;
  let isPlaying = false;
  let isPaused = false;
  let isCounting = false;
  let isFocusLost = false;
  let playedNotes = 0;
  let pendingRestartAt = null;      // seconds, set by a live tempo change
  let pendingSeekAfterLoad = null;  // seconds, pre-seek after the next load
  let pendingAutoTranspose = false;
  let autoPlayNext = false;
  let userStopped = false;
  // A stop WE sent to rebuild the session while paused. playback_done carries no
  // "why", so without this the renderer reads that stop as the natural end of
  // the song and does what a natural end does: reset the clock to zero, log a
  // "Sent X / Y keys" summary and START THE NEXT TRACK — which focuses the game
  // window and types keys nobody asked for. pendingRestartAt covers the same
  // thing for the not-paused case; this covers paused, where there is no
  // restart position because a paused song must never auto-resume (invariant 15).
  let restarting = false;
  let testMode = false;             // a Test-notes pass: no queue advance, no summary
  let practice = null;              // {target, pct} while a ramp is running
  let lastMidiLoaded = null;        // kept whole: a late-opening Perch needs it
  let lastReport = null;
  let collapsedSharps = 0;
  let unmappedCount = 0;
  let mappingDescription = '';
  let lastInput = '';
  let engineReady = false;
  let spaceTransport = true;

  let tracks = [];
  let curIdx = -1;
  let queueUndo = null;

  const viz = new window.Visualizer();

  // ==========================================================================
  // 3. TALKING TO THE APP
  // The shell owns the log drawer and the toasts. This panel never grows its
  // own. Engine 'log'/'error' events are already picked up by the shell from
  // IPC, so forwarding them here would log everything twice.
  // ==========================================================================
  function say(text, severity) {
    if (!text) return;
    window.Bus.send(T.UI_STATUS, { frame: FRAME, text: String(text), severity: severity || 'info' });
  }
  function toast(severity, title, message, key) {
    window.Bus.send(T.UI_TOAST, { severity, title, message: message || '', key: key || '' });
  }
  function fail(text) { say(text, 'err'); toast('err', text); }

  // ==========================================================================
  // 4. DRAW CONSUMERS
  // Three: the roll, the song map, and the 56px pitch thumbnail in Now Playing.
  // Each is registered with the shared scheduler, so each parks off screen and
  // each honours the one budget.
  // ==========================================================================
  const vizHost = $('viz-host');
  const vizCanvas = $('viz');
  const mapHost = $('map-host');
  const mapCanvas = $('map-canvas');
  const artHost = $('art-host');
  const artCanvas = $('art');

  let overviewEvents = [];
  let overviewVersion = 0;
  let pendingScrub = null;        // seek coalesced to the render loop
  let lastMapAsk = 0;

  const mapLayer = new window.Draw.LayerCache({ alpha: false });
  const artLayer = new window.Draw.LayerCache({ alpha: false });

  const vizHandle = window.Draw.register({
    key: 'player:viz',
    el: vizHost,
    idleMs: 60,
    draw: (ts) => {
      // A scrub is applied once per frame instead of once per mousemove: the
      // old version fired seek IPC per pointer event and reset the cull cursor
      // to 0 each time.
      if (pendingScrub !== null) {
        const t = pendingScrub; pendingScrub = null;
        viz.seek(t);
        requestSeek(t);
      }
      const fit = window.Draw.fitCanvas(vizCanvas, vizHost.clientWidth, vizHost.clientHeight,
        { contextAttributes: { alpha: false } });
      viz.render(fit.ctx, fit.w, fit.h);
      paintPosition(viz.elapsed());
      // The map only needs the playhead moved, and only ~12 times a second.
      // Draw clamps a non-live consumer to its idleMs, so asking every frame
      // still costs one map repaint per 80ms.
      if (ts - lastMapAsk >= 80) { lastMapAsk = ts; mapHandle.invalidate(); }
      // Ask for the NEXT frame while the notes are actually moving. Draw is
      // dirty-driven: setLive(true) only lifts the idle clamp, it does not make
      // a consumer animate. Without this the roll redrew once per engine
      // 'progress' packet -- 20Hz, ~7px steps -- and the >=30fps playback floor
      // (invariant 2) plus the local extrapolating clock (invariant 17) were
      // both inert, because there was never a frame between two packets for the
      // extrapolation to land in. dirty is cleared before draw runs, so this
      // schedules one more frame and cannot spin inside this one.
      if (isPlaying && !isPaused && !viz.isFrozen()) vizHandle.invalidate();
    }
  });
  keep(() => vizHandle.dispose());

  const mapHandle = window.Draw.register({
    key: 'player:map',
    el: mapHost,
    idleMs: 80,
    draw: () => drawMap()
  });
  keep(() => mapHandle.dispose());

  const artHandle = window.Draw.register({
    key: 'player:art',
    el: artHost,
    idleMs: 400,
    draw: () => drawArt()
  });
  keep(() => artHandle.dispose());

  keep(window.Tokens.onChange(() => {
    viz.retheme();
    mapLayer.invalidate();
    artLayer.invalidate();
    vizHandle.invalidate(); mapHandle.invalidate(); artHandle.invalidate();
  }));

  // A divider commit and a window resize both need the canvases re-measured
  // before the next paint, or a stretched surface shows for a frame.
  const onResize = coalesce(() => {
    vizHandle.invalidate(); mapHandle.invalidate(); artHandle.invalidate();
  });
  on(window, 'resize', onResize);

  // ---- the song map --------------------------------------------------------
  // Up to 6000 bars, redrawn every 80ms while playing, when only the playhead
  // and the range shading move. The bars go to an offscreen layer keyed by the
  // note data, the zoom window, the size and the theme; per frame this blits
  // and draws two moving things.
  const zoom = window.TimelineZoom
    ? window.TimelineZoom(mapHost, () => totalDuration, () => mapHandle.invalidate())
    : {
      start: () => 0, span: () => totalDuration || 1, zoomed: () => false, follow() {}, reset() {},
      xFor: (t, w) => (t / (totalDuration || 1)) * w,
      timeAt: (x, w) => (x / w) * (totalDuration || 0)
    };

  function paintMapBars(ctx, info) {
    const w = info.w, h = info.h;
    ctx.fillStyle = window.Tokens.get('bg-2', '#0f1013');
    ctx.fillRect(0, 0, w, h);
    if (totalDuration <= 0 || !overviewEvents.length) return;

    ctx.beginPath();
    const divisions = clamp(Math.floor(w / 100), 4, 12);
    for (let i = 1; i < divisions; i++) {
      const x = Math.round((i / divisions) * w) + 0.5;
      ctx.moveTo(x, 0); ctx.lineTo(x, h);
    }
    ctx.strokeStyle = window.Tokens.get('line', '#2b2e36');
    ctx.lineWidth = 1;
    ctx.stroke();

    const step = Math.max(1, Math.ceil(overviewEvents.length / 6000));
    const span = zoom.span() || 1;
    ctx.fillStyle = window.Tokens.get('accent', '#b8e62e');
    ctx.globalAlpha = 0.68;
    for (let i = 0; i < overviewEvents.length; i += step) {
      const e = overviewEvents[i];
      const x = zoom.xFor(e[0], w);
      if (x < -12 || x > w) continue;
      const y = h - 5 - ((e[3] - 21) / 87) * (h - 10);
      const bw = Math.min(12, Math.max(1, (Math.max(0.03, e[2]) / span) * w));
      ctx.fillRect(x, y, bw, 1.5);
    }
    ctx.globalAlpha = 1;
  }

  function drawMap() {
    const w = mapHost.clientWidth, h = mapHost.clientHeight;
    if (w < 8 || h < 8) return;
    const fit = window.Draw.fitCanvas(mapCanvas, w, h, { contextAttributes: { alpha: false } });
    const ctx = fit.ctx;
    const version = overviewVersion + '|' + zoom.start().toFixed(3) + '|' + zoom.span().toFixed(3) +
      '|' + window.Tokens.themeKey();
    mapLayer.paint(fit.w, fit.h, version, paintMapBars);
    mapLayer.blit(ctx, 0, 0, fit.w, fit.h);
    if (totalDuration <= 0) return;

    const range = playbackRange();
    if (range.enabled && range.valid !== false) {
      const sx = zoom.xFor(range.start, fit.w), ex = zoom.xFor(range.end, fit.w);
      ctx.fillStyle = 'rgba(0,0,0,.5)';
      ctx.fillRect(0, 0, Math.max(0, sx), fit.h);
      ctx.fillRect(ex, 0, Math.max(0, fit.w - ex), fit.h);
      ctx.fillStyle = window.Tokens.rgba('accent', 0.09);
      ctx.fillRect(sx, 0, Math.max(1, ex - sx), fit.h);
      ctx.strokeStyle = window.Tokens.get('accent', '#b8e62e');
      ctx.fillStyle = window.Tokens.get('accent', '#b8e62e');
      ctx.lineWidth = 2;
      for (const x of [sx, ex]) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, fit.h); ctx.stroke();
        ctx.fillRect(x - 4, 0, 8, 9);
        ctx.fillRect(x - 4, fit.h - 9, 8, 9);
      }
    }
    const playhead = clamp(viz.elapsed(), 0, totalDuration);
    if (isPlaying) zoom.follow(playhead);
    const px = Math.round(zoom.xFor(playhead, fit.w)) + 0.5;
    ctx.strokeStyle = '#ffffff';
    ctx.globalAlpha = 0.75;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, fit.h); ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // ---- the Now Playing thumbnail ------------------------------------------
  // A MIDI carries no cover art, so the "art" is the song itself: pitch up,
  // time across. Drawn once per load into a cached layer.
  function paintArt(ctx, info) {
    const w = info.w, h = info.h;
    ctx.fillStyle = window.Tokens.get('bg-2', '#0f1013');
    ctx.fillRect(0, 0, w, h);
    if (!overviewEvents.length || totalDuration <= 0) return;
    const step = Math.max(1, Math.ceil(overviewEvents.length / 900));
    ctx.fillStyle = window.Tokens.get('accent', '#b8e62e');
    ctx.globalAlpha = 0.8;
    for (let i = 0; i < overviewEvents.length; i += step) {
      const e = overviewEvents[i];
      const x = (e[0] / totalDuration) * (w - 2) + 1;
      const y = h - 2 - ((e[3] - 21) / 87) * (h - 4);
      ctx.fillRect(x, y, 1, 1);
    }
    ctx.globalAlpha = 1;
  }
  function drawArt() {
    const w = artHost.clientWidth, h = artHost.clientHeight;
    if (w < 4 || h < 4) return;
    const fit = window.Draw.fitCanvas(artCanvas, w, h, { contextAttributes: { alpha: false } });
    artLayer.paint(fit.w, fit.h, overviewVersion + '|' + window.Tokens.themeKey(), paintArt);
    artLayer.blit(fit.ctx, 0, 0, fit.w, fit.h);
  }

  // ==========================================================================
  // 5. THE ENGINE ADAPTER
  // The only place that talks to the sidecar.
  // ==========================================================================
  function send(msg) {
    if (!api.send) return;
    try { api.send(msg); } catch (e) { fail('The player engine did not accept that command.'); }
  }

  function resolveMapping() {
    return mapping === '__custom__' ? (customMappingPath || 'roblox') : mapping;
  }

  // hand / hand_split / chord_stagger_ms change WHICH notes exist and WHEN they
  // fire, so they ship with every load_midi, play AND export_sheet. Leave one
  // out and the visualizer, the keys sent and the VP sheet disagree.
  function playOpts() {
    return { hand: handVal, hand_split: handSplitVal, chord_stagger_ms: chordStaggerVal };
  }

  function loadMidi() {
    if (!lastMidiPath) return;
    pushRecent(lastMidiPath);
    send({
      cmd: 'load_midi',
      path: lastMidiPath,
      mapping: resolveMapping(),
      tempo,
      transpose: transposeVal,
      auto_transpose: !!pendingAutoTranspose,
      ...playOpts()
    });
    pendingAutoTranspose = false;
  }

  function sendPlay(startAt, countdown) {
    if (!lastMidiPath) { fail('Open a MIDI file first.'); return false; }
    if (targetHwnd === null) {
      fail('Pick the game window on the Target tab first.');
      showTab('target');
      return false;
    }
    const range = playbackRange();
    if (range.enabled && range.valid === false) { fail('Playback range: the stop time must be after the start.'); return false; }
    let at = Number(startAt) || 0;
    if (range.enabled && (at < range.start || at >= range.end)) at = range.start;
    // Cleared HERE, not in doPlay(), because this is the one place playback
    // actually begins: the queue's autoPlayNext, a practice pass and the
    // tempo-restart all come through here without going near doPlay. A Stop
    // pressed while idle emits no playback_done (the engine has no session to
    // report), so a flag left set here suppressed the queue advance, the
    // sent/dropped summary and the reset-to-zero of the NEXT song.
    userStopped = false;
    restarting = false;
    send({
      cmd: 'play',
      midi_path: lastMidiPath,
      target_hwnd: targetHwnd,
      mapping: resolveMapping(),
      tempo,
      transpose: transposeVal,
      countdown: Number(countdown) || 0,
      stats: statsVal,
      sustain: sustainVal,
      start_at: at,
      end_at: range.enabled ? range.end : null,
      ...playOpts()
    });
    return true;
  }

  // Loading a track is not playing it: starting the engine also focuses the
  // game window, so playback only ever begins on an explicit ask.
  function doPlay() {
    if (isPlaying) return;
    // A second {cmd:'play'} while the count-in is running makes the engine's
    // command reader block in session_thread.join(1.0) before dropping it, and
    // that thread is the one that has to stay free to answer the next Stop.
    if (isCounting) return;
    testMode = false;
    const range = playbackRange();
    let preSeek = viz.elapsed();
    if (range.enabled && range.valid !== false && (preSeek < range.start || preSeek >= range.end)) preSeek = range.start;
    if (startPracticeIfAsked()) {
      say(`Practice: ${practice.pct}% to 100%, +${rampStepVal}% per pass.`);
      loadMidi();                     // rescale the roll to the ramped tempo
      preSeek = range.start;
    }
    sendPlay(preSeek > 0.25 ? preSeek : 0, countdownVal);
  }

  function doPause() {
    if (!isPlaying || isPaused) return;
    isPaused = true;
    paintTransport();
    send({ cmd: 'pause' });
    reportState();
  }
  function doResume() {
    if (!isPlaying || !isPaused) return;
    isPaused = false;
    paintTransport();
    send({ cmd: 'resume' });
    reportState();
  }
  function doTogglePause() {
    if (!isPlaying) { doPlay(); return; }
    if (isPaused) doResume(); else doPause();
  }

  // A user stop ALWAYS sends {cmd:'stop'}, even when the UI thinks nothing is
  // playing, so a tempo-restart session that was just dispatched dies instead
  // of carrying on. userStopped then suppresses the queue advance, the
  // sent/dropped summary and the practice loop.
  function doStop() {
    pendingRestartAt = null;
    pendingSeekAfterLoad = null;
    restarting = false;             // a user stop outranks a restart in flight
    userStopped = true;
    testMode = false;
    send({ cmd: 'stop' });
    endPractice();
  }

  function doPanic() {
    doStop();
    toast('warn', 'Panic', 'Playback stopped and every held key released.');
    say('Panic: playback stopped, all keys released.', 'warn');
  }

  // Throttled seek, ~30Hz. The visualizer has already moved locally.
  let pendingSeek = null;
  let lastSeekAt = 0;
  let seekTimer = 0;
  function flushSeek() {
    if (pendingSeek === null) return;
    const t = pendingSeek; pendingSeek = null;
    lastSeekAt = performance.now();
    send({ cmd: 'seek', time: t });
  }
  function requestSeek(t) {
    pendingSeek = t;
    const now = performance.now();
    if (now - lastSeekAt >= 33) { flushSeek(); return; }
    if (seekTimer) return;
    seekTimer = later(() => { seekTimer = 0; flushSeek(); }, 33);
  }
  keep(() => { if (seekTimer) clearTimeout(seekTimer); });

  // Every seek path drag-locks the roll, moves it locally, sends the seek and
  // releases the lock 250ms after the last one, so a stale progress packet
  // cannot yank the playhead back.
  let dragUnlock = 0;
  function lockDrag() {
    viz.setDragLock(true);
    if (dragUnlock) clearTimeout(dragUnlock);
    dragUnlock = 0;
  }
  function releaseDragSoon() {
    if (dragUnlock) clearTimeout(dragUnlock);
    dragUnlock = later(() => { dragUnlock = 0; viz.setDragLock(false); }, 250);
  }
  keep(() => { if (dragUnlock) clearTimeout(dragUnlock); });

  function seekTo(t, { fromDrag } = {}) {
    if (totalDuration <= 0) return;
    const next = clamp(t, 0, totalDuration);
    lockDrag();
    if (fromDrag) {
      pendingScrub = next;              // applied once, in the render loop
      vizHandle.invalidate();
    } else {
      viz.seek(next);
      requestSeek(next);
      vizHandle.invalidate();
      mapHandle.invalidate();
      paintPosition(next);
      releaseDragSoon();
      // A seek is an edge, not a sample (§11.4): while idle or paused no
      // progress packets arrive, so nothing else would ever correct the bottom
      // transport's readout and thumb. A drag reports once on release instead,
      // in endScrub -- never per frame.
      reportState();
    }
  }
  function seekRelative(delta) {
    if (totalDuration <= 0) return;
    seekTo(viz.elapsed() + delta);
  }

  function requestWindows() { send({ cmd: 'list_windows' }); }

  // ==========================================================================
  // 6. THE TRANSPORT OWNER
  // caps is ONE piece of panel state, always sent whole: the merge replaces it
  // wholesale, so a partial send would disable the scrub bar and the knobs.
  // ==========================================================================
  const caps = {
    seek: true, rate: true, queue: true,
    repeat: 'off', transpose: 0, notes: 0,
    sub: '', target: '', blockedWhy: ''
  };
  let xport = null;

  function transportStatus() {
    if (isCounting) return 'counting';
    if (isPlaying) return isPaused ? 'paused' : (isFocusLost ? 'blocked' : 'playing');
    if (!lastMidiPath) return 'blocked';
    if (targetHwnd === null) return 'blocked';
    return 'idle';
  }
  function blockedWhy() {
    if (!lastMidiPath) return 'No song';
    if (targetHwnd === null) return 'No target';
    if (isFocusLost) return 'Lost focus';
    return 'Blocked';
  }

  function reportState() {
    // Only the current owner may report state; a parked panel writing position
    // into a transport that now belongs to someone else is exactly what the
    // ownership rule exists to stop.
    if (!xport || !xport.isOwner()) return;
    caps.repeat = queueLoopVal ? 'all' : 'off';
    caps.transpose = transposeVal;
    caps.notes = totalNotes;
    caps.target = targetLabel();
    caps.sub = mappingSubtitle();
    caps.blockedWhy = blockedWhy();
    xport.update({
      status: transportStatus(),
      position: viz.elapsed(),
      duration: totalDuration,
      rate: tempo,
      label: lastMidiPath ? base(lastMidiPath) : '',
      caps: Object.assign({}, caps)
    });
  }

  function claimTransport() {
    if (xport && xport.isOwner()) return;
    xport = window.Transport.claim(FRAME, {
      play: () => doPlay(),
      pause: () => doPause(),
      stop: () => doStop(),
      toggle: () => doTogglePause(),
      seek: (s) => seekTo(s),
      rate: (r) => setTempo(r),
      next: () => skipTrack(1),
      prev: () => skipTrack(-1),
      position: () => viz.elapsed(),
      park: () => {
        // Stop the clock's reporting and give Space back. The engine is not
        // stopped: parking is a UI handover, not a user stop.
        spaceBound = false;
      }
    }, Object.assign({}, caps));
    spaceBound = true;
    reportState();
  }
  keep(() => { if (xport) xport.release(); });

  // ==========================================================================
  // 7. LEFT COLUMN: the four setup cards
  // ==========================================================================
  const cardHeads = LEFT_TABS.map((k) => $('tab-' + k));
  const cardBodies = LEFT_TABS.map((k) => $('panel-' + k));
  const leftClosed = new Set(String(settings.leftClosed || '').split(',').filter(Boolean));

  function paintCard(i) {
    const open = !leftClosed.has(LEFT_TABS[i]);
    cardHeads[i].setAttribute('aria-expanded', open ? 'true' : 'false');
    cardBodies[i].hidden = !open;
  }
  function setCard(key, open) {
    const i = LEFT_TABS.indexOf(key);
    if (i < 0) return;
    if (open) leftClosed.delete(key); else leftClosed.add(key);
    settings.leftClosed = [...leftClosed].join(',');
    saveSettings();
    paintCard(i);
  }
  // Reveal: open the card and scroll it into view. Every caller that used to
  // switch tabs wants exactly this.
  function showTab(key, { focus } = {}) {
    const i = LEFT_TABS.indexOf(key);
    if (i < 0) return;
    setCard(key, true);
    try { cardHeads[i].scrollIntoView({ block: 'nearest' }); } catch (_) {}
    if (focus) cardHeads[i].focus();
  }
  cardHeads.forEach((btn, i) => {
    const key = LEFT_TABS[i];
    on(btn, 'click', () => setCard(key, leftClosed.has(key)));
    on(btn, 'keydown', (e) => {
      let next = -1;
      if (e.key === 'ArrowDown') next = (i + 1) % LEFT_TABS.length;
      else if (e.key === 'ArrowUp') next = (i + LEFT_TABS.length - 1) % LEFT_TABS.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = LEFT_TABS.length - 1;
      else return;
      e.preventDefault();
      cardHeads[next].focus();
    });
    paintCard(i);
  });

  // Right rail disclosure sections, persisted as a compact string.
  const RAIL_SECS = ['now', 'map', 'tools'];
  const railClosed = new Set(String(settings.railSections || '').split(',').filter(Boolean));
  RAIL_SECS.forEach((k) => {
    const head = $('sec-' + k + '-head'), body = $('sec-' + k + '-body');
    const paint = () => {
      const open = !railClosed.has(k);
      head.setAttribute('aria-expanded', open ? 'true' : 'false');
      body.hidden = !open;
    };
    on(head, 'click', () => {
      if (railClosed.has(k)) railClosed.delete(k); else railClosed.add(k);
      settings.railSections = [...railClosed].join(',');
      saveSettings();
      paint();
      if (k === 'now') artHandle.invalidate();
    });
    paint();
  });

  // ==========================================================================
  // 8. SONG: open, queue, recents
  // ==========================================================================
  const queueList = window.VList($('queue-list'), {
    rowHeight: window.Tokens.num('h-row-lg', 40),
    selectable: true,
    ariaLabel: 'Play queue',
    key: (it) => it.path,
    createRow() {
      const n = document.createElement('div');
      n.className = 'lrow is-lg';
      n.innerHTML =
        '<span class="lrow-index"></span>' +
        '<span class="lrow-main"><span class="lrow-name"></span><span class="lrow-sub"></span></span>' +
        '<span class="lrow-actions">' +
          '<button class="btn btn-icon is-sm is-bare" data-action="play" tabindex="-1" aria-label="Play this song"></button>' +
          '<button class="btn btn-icon is-sm is-bare" data-action="up" tabindex="-1" aria-label="Move up"></button>' +
          '<button class="btn btn-icon is-sm is-bare" data-action="down" tabindex="-1" aria-label="Move down"></button>' +
          '<button class="btn btn-icon is-sm is-bare" data-action="remove" tabindex="-1" aria-label="Remove from queue"></button>' +
        '</span>';
      const acts = n.lastElementChild.children;
      acts[0].innerHTML = window.Icon.svg('play', 11);
      acts[1].innerHTML = window.Icon.svg('up', 12);
      acts[2].innerHTML = window.Icon.svg('down', 12);
      acts[3].innerHTML = window.Icon.svg('close', 11);
      return n;
    },
    renderRow(n, it, i) {
      const current = i === curIdx;
      // The current row is marked is-playing (tint plus the lime edge bar);
      // aria-selected belongs to VList's own selection model.
      n.classList.toggle('is-playing', current);
      const idx = n.children[0];
      if (current && isPlaying) { idx.innerHTML = window.Icon.svg('play', 10); }
      else { idx.textContent = String(i + 1); }
      const main = n.children[1];
      main.children[0].textContent = it.name;
      main.children[1].textContent = it.folder;
      const acts = n.children[2].children;
      acts[1].disabled = i === 0;
      acts[2].disabled = i === tracks.length - 1;
      const locked = current && isPlaying;
      acts[3].disabled = locked;
      acts[3].setAttribute('aria-label', locked ? 'Stop playback before removing the current song' : 'Remove from queue');
      n.setAttribute('aria-label', `${i + 1}. ${it.name}${current ? ' — current' : ''}`);
      n.title = it.path;
    },
    // A row click loads; the row's play button is what starts it.
    onClick: (it, i) => selectFromQueue(i),
    onActivate: (it, i) => playTrack(i, true),
    onAction: (action, it, i) => {
      if (action === 'play') playTrack(i, true);
      else if (action === 'up') moveTrack(i, i - 1);
      else if (action === 'down') moveTrack(i, i + 1);
      else if (action === 'remove') removeTrack(i);
    },
    onContextMenu: (it, i, ev) => {
      ev.preventDefault();
      window.Menu.open([
        { group: it.name },
        { label: 'Play', key: 'Enter', icon: 'play', run: () => playTrack(i, true) },
        { label: 'Load without playing', run: () => selectFromQueue(i) },
        { sep: true },
        { label: 'Move up', icon: 'up', disabled: i === 0, run: () => moveTrack(i, i - 1) },
        { label: 'Move down', icon: 'down', disabled: i === tracks.length - 1, run: () => moveTrack(i, i + 1) },
        { label: 'Remove', icon: 'close', danger: true, disabled: i === curIdx && isPlaying, run: () => removeTrack(i) },
        { sep: true },
        { label: 'Send to the Editor', icon: 'send', run: () => window.Bus.send(T.NAV_OPEN_EDITOR, { midiPath: it.path }) },
        { label: 'Reveal in Explorer', icon: 'folder', run: () => window.Bus.send(T.FILE_REVEAL, { path: it.path }) }
      ], { x: ev.clientX, y: ev.clientY, ariaLabel: it.name, returnFocusTo: queueList.host });
    }
  });
  keep(() => queueList.destroy());

  // Alt+Arrow reorders from the keyboard, the same as the two buttons.
  on(queueList.host, 'keydown', (e) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    const i = queueList.cursor();
    if (i < 0) return;
    e.preventDefault();
    e.stopPropagation();
    moveTrack(i, i + (e.key === 'ArrowUp' ? -1 : 1));
  });

  on(window, 'midi-studio:density', () => {
    queueList.rowHeight(window.Tokens.num('h-row-lg', 40));
    if (songsList) songsList.rowHeight(window.Tokens.num('h-row', 28));
  });

  function trackItem(p) { return { path: p, name: base(p), folder: window.Fmt.dirname(p) }; }

  function persistPlaylist() {
    settings.playlist = tracks.slice(0, 200);
    settings.playlistCurrent = tracks[curIdx] || '';
    saveSettings();
  }

  const renderQueue = () => {
    // Persisting is not a render step: it used to run inside it.
    queueList.setItems(tracks.map(trackItem));
    const n = tracks.length;
    $('queue-count').textContent = n ? String(n) : '';
    const tc = $('tab-song-count');
    tc.hidden = !n;
    tc.textContent = String(n);
    $('queue-empty').hidden = n > 0;
    queueList.host.hidden = n === 0;
    $('tr-prev').disabled = n < 2;
    $('tr-next').disabled = n < 2;
  };

  function rememberQueue() {
    queueUndo = { tracks: tracks.slice(), curPath: tracks[curIdx] || null };
    $('queue-undo').hidden = false;
  }

  function moveTrack(from, to) {
    if (to < 0 || to >= tracks.length || from === to) return;
    rememberQueue();
    const currentPath = tracks[curIdx];
    const [item] = tracks.splice(from, 1);
    tracks.splice(to, 0, item);
    curIdx = currentPath ? tracks.indexOf(currentPath) : -1;
    persistPlaylist();
    renderQueue();
    queueList.setCursor(to, { scroll: true });
  }

  function removeTrack(i) {
    rememberQueue();
    const removingCurrent = i === curIdx;
    tracks.splice(i, 1);
    if (removingCurrent) {
      if (tracks.length) { selectTrack(Math.min(i, tracks.length - 1), false); return; }
      curIdx = -1;
      clearLoaded();
    } else if (i < curIdx) curIdx--;
    persistPlaylist();
    renderQueue();
  }

  function addToQueue(paths, { announce } = {}) {
    const known = new Set(tracks.map((p) => p.toLowerCase()));
    const add = [];
    for (const p of paths || []) {
      if (!p || !/\.midi?$/i.test(p)) continue;
      const lower = p.toLowerCase();
      if (known.has(lower)) continue;
      known.add(lower);
      add.push(p);
    }
    if (!add.length) return 0;
    rememberQueue();
    const first = tracks.length;
    tracks.push(...add);
    persistPlaylist();
    renderQueue();
    if (announce) {
      say(add.length === 1 ? `Queued ${base(add[0])}.` : `Queued ${add.length} MIDI files.`);
    }
    if (!isPlaying && curIdx < 0) selectTrack(first, false);
    return add.length;
  }

  function selectTrack(i, andPlay) {
    if (i < 0 || i >= tracks.length) return;
    curIdx = i;
    autoPlayNext = !!andPlay;
    const p = tracks[i];
    const changed = p !== lastMidiPath;
    lastMidiPath = p;
    settings.midiPath = p;
    persistPlaylist();
    if (changed) resetRange();
    paintSong();
    renderQueue();
    loadMidi();
  }

  function selectFromQueue(i) {
    if (i === curIdx) return;
    if (isPlaying) { userStopped = true; send({ cmd: 'stop' }); }
    selectTrack(i, false);
  }

  function playTrack(i, forcePlay) {
    if (i === curIdx && !isPlaying && totalDuration > 0) { doPlay(); return; }
    const keepGoing = isPlaying;
    if (isPlaying) { userStopped = true; send({ cmd: 'stop' }); }
    selectTrack(i, forcePlay || keepGoing);
  }

  function skipTrack(direction) {
    if (!tracks.length) return;
    const from = curIdx >= 0 ? curIdx : 0;
    playTrack((from + direction + tracks.length) % tracks.length, isPlaying);
  }

  // The natural end of a track moves to the next row. That is one of the four
  // explicit asks, so it may start the engine.
  function advanceQueue() {
    if (curIdx < 0) return false;
    let next = curIdx + 1;
    if (next >= tracks.length) {
      if (!queueLoopVal) return false;
      next = 0;
    }
    selectTrack(next, true);
    return true;
  }

  function clearLoaded() {
    lastMidiPath = '';
    settings.midiPath = '';
    totalDuration = 0; totalNotes = 0; bpm = 0; bpmEstimate = 0;
    overviewEvents = []; overviewVersion++;
    lastMidiLoaded = null; lastReport = null;
    collapsedSharps = 0; unmappedCount = 0; keysMapped = 0; channelMask = 0;
    viz.load([], {});
    resetRange();
    $('viz-empty').classList.remove('is-hidden');
    $('time-total').textContent = clock(0);
    paintSong(); paintStats(); paintMappingStatus(); paintPosition(0);
    mapLayer.invalidate(); artLayer.invalidate();
    vizHandle.invalidate(); mapHandle.invalidate(); artHandle.invalidate();
    reportState();
    saveSettings();
  }

  // Public entry for the hand-off router, the queue, the recents and drops.
  function setMidiFile(path, andPlay) {
    if (!path) return;
    let i = tracks.findIndex((p) => p.toLowerCase() === path.toLowerCase());
    if (i < 0) { tracks.push(path); i = tracks.length - 1; }
    if (isPlaying) { userStopped = true; send({ cmd: 'stop' }); }
    selectTrack(i, !!andPlay);
    if (!andPlay) say(`Loaded ${base(path)}. Press Play when you are ready.`);
  }
  // Kept as a global on purpose: it is the documented legacy hand-off contract,
  // and it costs nothing to honour it as well as frame:ready.
  window.setMidiFile = setMidiFile;

  async function pickMidi(intoQueue) {
    if (!api.pickMidi) return;
    let r = null;
    try { r = await api.pickMidi(); } catch (_) { return; }
    const paths = (Array.isArray(r) ? r : [r]).filter(Boolean);
    if (!paths.length) return;
    if (intoQueue) { addToQueue(paths, { announce: true }); return; }
    setMidiFile(paths[0]);
    if (paths.length > 1) addToQueue(paths.slice(1), { announce: true });
  }

  on($('open-midi'), 'click', () => pickMidi(false));
  on($('viz-open'), 'click', () => pickMidi(false));
  on($('queue-add'), 'click', () => pickMidi(true));
  on($('open-audio'), 'click', () => {
    window.Bus.send(T.NAV_OPEN_FORGE, {});
    say('Audio has to be transcribed before it can be played. Opening Forge.');
  });
  on($('song-reveal'), 'click', () => { if (lastMidiPath) window.Bus.send(T.FILE_REVEAL, { path: lastMidiPath }); });
  on($('queue-clear'), 'click', () => {
    if (!tracks.length) return;
    rememberQueue();
    const current = tracks[curIdx];
    tracks = current ? [current] : [];
    curIdx = current ? 0 : -1;
    persistPlaylist();
    renderQueue();
  });
  // Single-level undo that doubles as redo: the snapshot is swapped, not popped.
  on($('queue-undo'), 'click', () => {
    if (!queueUndo) return;
    const now = { tracks: tracks.slice(), curPath: tracks[curIdx] || null };
    tracks = queueUndo.tracks.slice();
    curIdx = queueUndo.curPath ? tracks.indexOf(queueUndo.curPath) : -1;
    queueUndo = now;
    persistPlaylist();
    if (curIdx >= 0 && tracks[curIdx] !== lastMidiPath) selectTrack(curIdx, false);
    else renderQueue();
  });

  function setQueueLoop(on_) {
    queueLoopVal = !!on_;
    settings.queueLoop = queueLoopVal;
    saveSettings();
    $('queue-loop').setAttribute('aria-pressed', queueLoopVal ? 'true' : 'false');
    $('loop-playback').setAttribute('aria-checked', queueLoopVal ? 'true' : 'false');
    reportState();
  }
  on($('queue-loop'), 'click', () => setQueueLoop(!queueLoopVal));
  on($('loop-playback'), 'click', () => setQueueLoop(!queueLoopVal));

  // ---- recents ------------------------------------------------------------
  const MAX_RECENTS = 8;
  function pushRecent(p) {
    if (!p) return;
    const list = (settings.recentFiles || []).filter((x) => x !== p);
    list.unshift(p);
    settings.recentFiles = list.slice(0, MAX_RECENTS);
    saveSettings();
    renderRecents();
  }
  function renderRecents() {
    const list = settings.recentFiles || [];
    $('recent-block').hidden = list.length === 0;
    const host = $('recent-list');
    host.textContent = '';
    for (const p of list.slice(0, 5)) {
      const row = document.createElement('div');
      row.className = 'lrow';
      row.tabIndex = 0;
      row.title = p;
      row.innerHTML = '<span class="lrow-main"><span class="lrow-name"></span></span>';
      row.firstElementChild.firstElementChild.textContent = base(p);
      const open = () => setMidiFile(p);
      row.addEventListener('click', open);
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); open(); } });
      host.appendChild(row);
    }
  }
  on($('recent-clear'), 'click', () => { settings.recentFiles = []; saveSettings(); renderRecents(); });

  // ---- "See all" -----------------------------------------------------------
  // Recents plus every MIDI in the transcription folder, from midi-library.js.
  let songsList = null;
  let songsAll = [];
  let songsFiltered = [];
  const songsScrim = $('songs-scrim');
  let songsReturnFocus = null;

  function songRows() {
    const seen = new Set();
    const rows = [];
    for (const p of settings.recentFiles || []) {
      const k = p.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      rows.push({ path: p, name: base(p), sub: 'Recent', recent: true });
    }
    for (const f of (Lib ? Lib.files() : [])) {
      const k = f.path.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      rows.push({ path: f.path, name: f.name, sub: f.dir, recent: false });
    }
    return rows;
  }

  function paintSongs() {
    const q = $('songs-search').value.trim().toLowerCase();
    songsFiltered = q
      ? songsAll.filter((r) => r.name.toLowerCase().includes(q) || r.sub.toLowerCase().includes(q))
      : songsAll.slice();
    songsList.setItems(songsFiltered);
    $('songs-empty').hidden = songsFiltered.length > 0;
    $('songs-empty-msg').textContent = songsAll.length
      ? 'Nothing matches that.'
      : 'No songs yet. Transcribe one in Forge, or open a file from the Song tab.';
    $('songs-count').textContent = window.Fmt.count(songsFiltered.length, 'song', 'songs');
    const dirName = Lib ? Lib.dirName() : '';
    $('songs-sub').textContent = dirName ? 'from ' + dirName : '';
    $('songs-search').parentElement.classList.toggle('has-value', !!q);
    const sel = songsList.selectedItems()[0];
    $('songs-open').disabled = !sel;
    $('songs-queue').disabled = !sel;
  }

  function openSongs() {
    if (!songsList) {
      songsList = window.VList($('songs-list'), {
        rowHeight: window.Tokens.num('h-row', 28),
        ariaLabel: 'All songs',
        key: (it) => it.path,
        createRow() {
          const n = document.createElement('div');
          n.className = 'lrow';
          n.innerHTML = '<span class="lrow-main"><span class="lrow-name"></span></span><span class="lrow-meta"></span>';
          return n;
        },
        renderRow(n, it) {
          n.children[0].children[0].textContent = it.name;
          n.children[1].textContent = it.recent ? 'recent' : '';
          n.title = it.path;
          n.setAttribute('aria-label', it.name);
        },
        onSelectionChange: () => paintSongs(),
        onActivate: (it) => { chooseSong(it, false); }
      });
      keep(() => songsList.destroy());
    }
    songsReturnFocus = document.activeElement;
    songsAll = songRows();
    songsScrim.hidden = false;
    requestAnimationFrame(() => songsScrim.classList.add('is-open'));
    paintSongs();
    const last = Lib ? Lib.last() : '';
    if (last) songsList.scrollToKey(last, 'center');
    $('songs-search').focus();
    if (Lib) Lib.ready().then(() => { if (!songsScrim.hidden) { songsAll = songRows(); paintSongs(); } });
  }

  function closeSongs() {
    songsScrim.classList.remove('is-open');
    later(() => { songsScrim.hidden = true; }, window.Tokens.ms('motion-fast', 120));
    if (songsReturnFocus && songsReturnFocus.focus) songsReturnFocus.focus();
  }

  function chooseSong(it, queueOnly) {
    if (!it) return;
    if (Lib) Lib.remember(it.path);
    if (queueOnly) addToQueue([it.path], { announce: true });
    else { setMidiFile(it.path); closeSongs(); }
  }

  on($('recent-all'), 'click', openSongs);
  on($('open-songs'), 'click', openSongs);
  on($('songs-close'), 'click', closeSongs);
  on($('songs-open'), 'click', () => chooseSong(songsList.selectedItems()[0], false));
  on($('songs-queue'), 'click', () => chooseSong(songsList.selectedItems()[0], true));
  on($('songs-search'), 'input', coalesce(paintSongs));
  on($('songs-search-clear'), 'click', () => { $('songs-search').value = ''; paintSongs(); $('songs-search').focus(); });
  on($('songs-refresh'), 'click', () => { if (Lib) Lib.refresh().then(() => { songsAll = songRows(); paintSongs(); }); });
  on($('songs-folder'), 'click', () => { if (Lib) Lib.pickFolder().then(() => { songsAll = songRows(); paintSongs(); }); });
  on(songsScrim, 'pointerdown', (e) => { if (e.target === songsScrim) closeSongs(); });
  on(songsScrim, 'keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSongs(); return; }
    if (e.key !== 'Tab') return;
    // A modal traps focus: without this, Tab walks into the panel behind it.
    const f = songsScrim.querySelectorAll('button:not(:disabled), input, [tabindex="0"]');
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  if (Lib) {
    Lib.watch();
    keep(Lib.onChange(() => { if (!songsScrim.hidden) { songsAll = songRows(); paintSongs(); } }));
    // watch() installs a studio.onLibraryChanged subscription, so it is one of
    // this document's listeners and has to come down with the rest of them.
    // dispose() drops the subscription and the onChange list in one call.
    keep(() => Lib.dispose());
  }

  // ==========================================================================
  // 9. TARGET
  // ==========================================================================
  const APP_HINTS = [
    { re: /robloxplayerbeta|\broblox\b/i, label: 'Roblox' },
    { re: /virtual.?piano/i, label: 'Virtual Piano' },
    { re: /chrome|msedge|firefox|opera|brave/i, label: 'Browser' }
  ];

  function selectedWindow() {
    if (targetHwnd === null) return null;
    return windows.find((w) => Number(w.hwnd) === Number(targetHwnd)) || null;
  }
  function targetLabel() {
    const w = selectedWindow();
    if (!w) return '';
    return (w.process || '').replace(/\.exe$/i, '') || w.title || '';
  }

  function populateWindows(previousHwnd) {
    const sel = $('target-select');
    sel.textContent = '';
    if (!windows.length) {
      const o = document.createElement('option');
      o.value = ''; o.textContent = 'No windows found — press refresh';
      sel.appendChild(o);
      targetHwnd = null;
      paintTarget();
      return;
    }
    const ph = document.createElement('option');
    ph.value = ''; ph.textContent = 'Choose a target window…';
    sel.appendChild(ph);
    let best = -1, bestScore = 0;
    windows.forEach((w, i) => {
      const o = document.createElement('option');
      o.value = String(w.hwnd);
      const proc = (w.process || '?').replace(/\.exe$/i, '');
      o.textContent = `${proc} — ${w.title}`;
      o.title = `${w.process || ''}  ${w.title || ''}`;
      sel.appendChild(o);
      const hay = `${w.process || ''} ${w.title || ''}`.toLowerCase();
      let score = 0;
      if (previousHwnd && Number(previousHwnd) === Number(w.hwnd)) score = 200;
      else if (autoPickVal && settings.targetHint && hay.includes(String(settings.targetHint).toLowerCase())) score = 100;
      else if (autoPickVal && /robloxplayerbeta|virtual.?piano/.test(hay)) score = 50;
      else if (autoPickVal && /\broblox\b|\bpiano\b/.test(hay)) score = 25;
      if (score > bestScore) { bestScore = score; best = i; }
    });
    if (best >= 0) { targetHwnd = Number(windows[best].hwnd); sel.value = String(targetHwnd); }
    else if (targetHwnd !== null && windows.some((w) => Number(w.hwnd) === Number(targetHwnd))) sel.value = String(targetHwnd);
    else { targetHwnd = null; sel.value = ''; }
    paintTarget();
  }

  function paintTarget() {
    const w = selectedWindow();
    const app = $('target-app');
    const iconEl = $('target-icon');
    const dot = $('target-dot');
    const line = $('target-status');
    app.classList.toggle('is-ready', !!w);
    if (w) {
      const proc = (w.process || '').replace(/\.exe$/i, '');
      const hint = APP_HINTS.find((h) => h.re.test(`${w.process || ''} ${w.title || ''}`));
      $('target-name').textContent = hint ? hint.label : (proc || w.title || 'Window');
      $('target-name').title = w.title || '';
      $('target-sub').textContent = w.title || '';
      $('target-sub').title = w.title || '';
      // There is no window-icon channel in the engine, so the tile is a
      // monogram taken from the process name rather than a fabricated icon.
      iconEl.textContent = (proc || w.title || '?').trim().charAt(0).toUpperCase();
    } else {
      $('target-name').textContent = 'No window selected';
      $('target-sub').textContent = 'Pick the window the keys should be typed into.';
      $('target-sub').title = 'Pick the window the keys should be typed into.';
      iconEl.innerHTML = window.Icon.svg('keyboard', 18);
    }
    let text, kind;
    if (!w) { text = 'No window selected'; kind = 'warn'; dot.className = 'dot warn'; }
    else if (isFocusLost) { text = 'Waiting for the target — it lost focus'; kind = 'err'; dot.className = 'dot is-blocked'; }
    else { text = 'Window detected and ready'; kind = 'ok'; dot.className = 'dot ok'; }
    $('target-status-text').textContent = text;
    line.classList.toggle('is-warn', kind === 'warn');
    line.classList.toggle('is-err', kind === 'err');
    $('focus-target').disabled = !w;
    $('tr-focus').hidden = !(isFocusLost && w);
    paintStats();
  }

  on($('target-select'), 'change', (e) => {
    const v = e.target.value;
    targetHwnd = v === '' ? null : Number(v);
    const w = selectedWindow();
    if (w) { settings.targetHint = w.process || w.title || ''; saveSettings(); }
    paintTarget();
    reportState();
  });
  // Enumerating windows mid-playback is exactly the work that must not happen,
  // so a focus refresh is throttled and never runs while notes are going out.
  let lastWindowRefresh = 0;
  on($('target-select'), 'focus', () => {
    const now = Date.now();
    if (!isPlaying && now - lastWindowRefresh > 2000) { lastWindowRefresh = now; requestWindows(); }
  });
  on($('target-refresh'), 'click', () => { lastWindowRefresh = Date.now(); requestWindows(); });
  on($('focus-target'), 'click', () => focusTarget());
  on($('tr-focus'), 'click', () => focusTarget());
  function focusTarget() {
    if (targetHwnd === null) { showTab('target'); fail('Pick the game window first.'); return; }
    send({ cmd: 'refocus' });
    say('Focusing the target window.');
  }
  on($('auto-pick'), 'click', () => {
    autoPickVal = !autoPickVal;
    settings.autoPickTarget = autoPickVal;
    saveSettings();
    $('auto-pick').setAttribute('aria-checked', autoPickVal ? 'true' : 'false');
  });

  // ==========================================================================
  // 10. PLAYBACK SETTINGS
  // ==========================================================================
  const mappingSelect = $('mapping-select');

  function addCustomMappingOption(p) {
    const existing = [...mappingSelect.options].find((o) => o.value === '__custom__');
    if (existing) existing.remove();
    const opt = document.createElement('option');
    opt.value = '__custom__';
    opt.textContent = 'custom: ' + base(p);
    opt.title = p;
    mappingSelect.appendChild(opt);
  }

  function mappingFamily() {
    const m = mapping === '__custom__' ? (customMappingPath || '') : mapping;
    if (/drums/i.test(m)) return 'Drum kit';
    if (/virtualpiano/i.test(m)) return 'Virtual Piano';
    if (/roblox/i.test(m)) return 'Roblox';
    return 'Custom';
  }
  function mappingName() {
    return mapping === '__custom__' ? base(customMappingPath) || 'custom' : mapping;
  }
  function mappingSubtitle() {
    return `${mappingFamily()} · ${keysMapped || 0} keys`;
  }

  on(mappingSelect, 'change', () => {
    if (mappingSelect.value === '__custom__') { mapping = '__custom__'; }
    else { mapping = mappingSelect.value; }
    settings.mapping = mapping;
    saveSettings();
    paintSong(); paintStats(); paintMappingStatus();
    reportState();
    if (lastMidiPath) loadMidi();
  });
  on($('mapping-browse'), 'click', async () => {
    if (!api.pickMapping) return;
    let p = null;
    try { p = await api.pickMapping(); } catch (_) { return; }
    if (!p) return;
    useCustomMapping(p);
  });
  function useCustomMapping(p) {
    customMappingPath = p;
    mapping = '__custom__';
    settings.customMappingPath = p;
    settings.mapping = '__custom__';
    saveSettings();
    addCustomMappingOption(p);
    mappingSelect.value = '__custom__';
    paintSong(); paintStats(); paintMappingStatus();
    say(`Custom mapping: ${base(p)}.`);
    if (lastMidiPath) loadMidi();
  }
  // Re-homed from the deleted songs-folder module. Without it, custom mappings
  // stop surviving updates, because the only folder that does is this one.
  on($('mapping-folder'), 'click', () => {
    if (!studio.openMappingsDir) { fail('This build cannot open the mappings folder.'); return; }
    try { studio.openMappingsDir(); } catch (_) {}
  });

  // ---- tempo ---------------------------------------------------------------
  const tempoRange = $('tempo');

  function paintTempo() {
    // Never rewrite the box under a half-typed number.
    if (document.activeElement !== tempoRange) tempoRange.value = tempo.toFixed(2);
    $('tr-tempo').textContent = tempo.toFixed(2) + '×';
    showBpm();
    paintStats();
  }

  function showBpm() {
    const box = $('tempo-bpm');
    if (!bpm) {
      box.value = '';
      box.disabled = true;
      $('tempo-bpm-src').textContent = 'source —';
      $('tempo-bpm-guess').hidden = true;
      return;
    }
    box.disabled = false;
    // Never rewrite it mid-type: 17 on the way to 174 got rewritten and the
    // caret jumped.
    if (document.activeElement !== box) box.value = String(Math.round(bpm * tempo));
    $('tempo-bpm-src').textContent = 'source ' + Math.round(bpm);
    // Every transcription this app makes is stamped 120 BPM by the library that
    // writes it, true or not, so offer the note-spacing estimate rather than
    // overriding the file behind the user's back.
    const guess = Math.round(bpmEstimate || 0);
    const differs = guess > 0 && Math.abs(guess - Math.round(bpm)) >= 3;
    const btn = $('tempo-bpm-guess');
    btn.hidden = !differs;
    if (differs) {
      btn.textContent = 'Sounds like ' + guess;
      btn.title = `The file says ${Math.round(bpm)} BPM, but the gaps between notes suggest ${guess}. Use this as the source tempo instead.`;
    }
  }

  function setBpm(target) {
    const want = Number(target);
    if (!bpm || !Number.isFinite(want) || want <= 0) { showBpm(); return; }
    const scale = want / bpm;
    if (scale < TEMPO_MIN || scale > TEMPO_MAX) {
      // Say why, rather than silently clamping to a tempo nobody asked for.
      say(`${Math.round(want)} BPM needs a ${scale.toFixed(2)}× tempo, outside the ${TEMPO_MIN}–${TEMPO_MAX}× range. Clamped.`, 'warn');
    }
    setTempo(scale);
    showBpm();
  }

  // A live tempo change stops and restarts at the equivalent musical position.
  // Event times are baked at parse time, so reloading the visualizer while the
  // engine keeps the old timeline puts the roll and the keys out of step.
  function setTempo(t) {
    const next = Math.round(clamp(Number(t) || 1, TEMPO_MIN, TEMPO_MAX) * 100) / 100;
    const prev = tempo;
    if (next === prev) return;
    tempo = next;
    settings.tempo = next;
    saveSettings();
    paintTempo();
    paintPractice();
    say(`Tempo ${next.toFixed(2)}×.`);
    reportState();
    if (isPlaying && !isPaused) {
      pendingRestartAt = viz.elapsed() * prev / next;
      send({ cmd: 'stop' });
    } else if (isPlaying && isPaused) {
      // Paused: never auto-resume. End the session and pre-seek instead. This is
      // OUR stop, not a natural end and not a user stop, so it is flagged: see
      // `restarting`.
      pendingSeekAfterLoad = viz.elapsed() * prev / next;
      restarting = true;
      send({ cmd: 'stop' });
      loadMidi();
    } else if (lastMidiPath) {
      loadMidi();
    }
  }
  function nudgeTempo(delta) { setTempo(tempo + delta); }

  // Paint on input (rAF-coalesced), commit on change.
  const paintTempoLive = coalesce(() => {
    $('tr-tempo').textContent = tempo.toFixed(2) + '×';
    showBpm();
  });
  on(tempoRange, 'input', () => {
    tempo = clamp(parseFloat(tempoRange.value) || 1, TEMPO_MIN, TEMPO_MAX);
    paintTempoLive();
  });
  on(tempoRange, 'change', () => {
    const wanted = clamp(parseFloat(tempoRange.value) || 1, TEMPO_MIN, TEMPO_MAX);
    tempo = settings.tempo;                 // let setTempo see the real delta
    setTempo(wanted);
    // A focused range input answers arrow keys for as long as it holds focus,
    // and those keys were meant for the game.
    tempoRange.blur();
  });
  on($('tempo-reset'), 'click', () => setTempo(1));
  on($('tempo-bpm'), 'change', (e) => setBpm(e.target.value));
  on($('tempo-bpm'), 'keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
  on($('tempo-bpm'), 'blur', () => showBpm());
  on($('tempo-bpm-guess'), 'click', () => {
    if (!bpmEstimate) return;
    say(`Source tempo set to ${Math.round(bpmEstimate)} BPM (was ${Math.round(bpm)}).`);
    bpm = bpmEstimate;
    bpmEstimate = 0;
    showBpm();
    paintStats();
  });

  // ---- transpose -----------------------------------------------------------
  const transposeRange = $('transpose');
  function paintTranspose() {
    if (document.activeElement !== transposeRange) transposeRange.value = String(transposeVal);
    $('tr-transpose').textContent = (transposeVal > 0 ? '+' : '') + transposeVal;
  }
  function applyTranspose(value, auto) {
    transposeVal = clamp(Math.round(Number(value) || 0), -24, 24);
    settings.transpose = transposeVal;
    pendingAutoTranspose = !!auto;
    saveSettings();
    paintTranspose();
    reportState();
    if (!lastMidiPath) return;
    if (isPlaying) restartForOpts(); else loadMidi();
  }
  const paintTransposeLive = coalesce(paintTranspose);
  on(transposeRange, 'input', () => {
    transposeVal = clamp(Math.round(Number(transposeRange.value) || 0), -24, 24);
    paintTransposeLive();
  });
  on(transposeRange, 'change', (e) => { applyTranspose(e.target.value, false); transposeRange.blur(); });
  on($('transpose-fit'), 'click', () => applyTranspose(0, true));
  on($('transpose-reset'), 'click', () => applyTranspose(0, false));

  // Changing which notes exist while playing has to go through the same
  // stop-and-restart as a tempo change, or the engine keeps the old timeline.
  function restartForOpts() {
    if (!isPlaying) { if (lastMidiPath) loadMidi(); return; }
    if (isPaused) {
      pendingSeekAfterLoad = viz.elapsed();
      restarting = true;            // our own stop, not the end of the song
      send({ cmd: 'stop' });
      loadMidi();
    } else {
      pendingRestartAt = viz.elapsed();
      send({ cmd: 'stop' });
    }
  }

  // ---- steppers ------------------------------------------------------------
  // One delegated handler for every +/- pair on the page.
  const STEP_FIELDS = {
    countdown: { min: 0, max: 10, int: true, apply: (v) => { countdownVal = v; settings.countdown = v; $('tr-countdown').textContent = v + 's'; } },
    'chord-stagger': { min: 0, max: 30, int: true, apply: (v) => { chordStaggerVal = v; settings.chordStaggerMs = v; paintMappingStatus(); if (lastMidiPath) restartForOpts(); } },
    'hand-split': { min: 24, max: 108, int: true, apply: (v) => { handSplitVal = v; settings.handSplit = v; paintHandSplit(); if (lastMidiPath) restartForOpts(); } },
    'tempo-step': { min: 0.01, max: 1, int: false, apply: (v) => { tempoStepVal = v; settings.tempoStep = v; } },
    'tempo-preset': { min: 0.25, max: 3, int: false, apply: (v) => { tempoPresetVal = v; settings.tempoPreset = v; } },
    'seek-step': { min: 1, max: 60, int: true, apply: (v) => { seekStepVal = v; settings.seekStep = v; } },
    'ramp-start': { min: 25, max: 100, int: true, apply: (v) => { rampStartVal = v; settings.rampStart = v; paintPractice(); } },
    'ramp-step': { min: 1, max: 50, int: true, apply: (v) => { rampStepVal = v; settings.rampStep = v; } }
  };
  function commitStep(id) {
    const spec = STEP_FIELDS[id];
    const input = $(id);
    let v = spec.int ? parseInt(input.value, 10) : parseFloat(input.value);
    if (!Number.isFinite(v)) v = spec.min;
    v = clamp(v, spec.min, spec.max);
    if (!spec.int) v = Math.round(v * 100) / 100;
    input.value = String(v);
    spec.apply(v);
    saveSettings();
    reportState();
  }
  Object.keys(STEP_FIELDS).forEach((id) => on($(id), 'change', () => commitStep(id)));
  on(document, 'click', (e) => {
    const btn = e.target.closest ? e.target.closest('.stepper-btn[data-for]') : null;
    if (!btn) return;
    const id = btn.dataset.for;
    const input = $(id);
    if (!input) return;
    const step = parseFloat(btn.dataset.step) || 1;
    const spec = STEP_FIELDS[id];
    // Tempo and Transpose own their own commit path (a restart, a re-load).
    // Nudge the box and let their input/change handlers do the rest, so there
    // is still exactly one code path per value.
    if (!spec) {
      const lo = parseFloat(input.min), hi = parseFloat(input.max);
      let n = parseFloat(input.value);
      if (!Number.isFinite(n)) n = Number.isFinite(lo) ? lo : 0;
      n = Math.round((n + step) * 100) / 100;
      if (Number.isFinite(lo)) n = Math.max(lo, n);
      if (Number.isFinite(hi)) n = Math.min(hi, n);
      input.value = String(n);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    let v = (spec.int ? parseInt(input.value, 10) : parseFloat(input.value));
    if (!Number.isFinite(v)) v = spec.min;
    input.value = String(clamp(spec.int ? v + step : Math.round((v + step) * 100) / 100, spec.min, spec.max));
    commitStep(id);
  });

  // ---- hands ---------------------------------------------------------------
  function paintHandSplit() {
    $('hand-split-label').textContent = window.Fmt.note(handSplitVal);
    $('hand-split').disabled = handVal === 'both';
    $('hand-split-row').classList.toggle('is-off', handVal === 'both');
  }
  const handButtons = [...$('hand-group').querySelectorAll('[role="radio"]')];
  function setHand(next, { focus } = {}) {
    handVal = next;
    settings.hand = next;
    saveSettings();
    handButtons.forEach((b) => {
      const sel = b.dataset.hand === next;
      b.setAttribute('aria-checked', sel ? 'true' : 'false');
      b.tabIndex = sel ? 0 : -1;
      if (sel && focus) b.focus();
    });
    paintHandSplit();
    if (lastMidiPath) restartForOpts();
  }
  handButtons.forEach((b, i) => {
    on(b, 'click', () => setHand(b.dataset.hand));
    on(b, 'keydown', (e) => {
      let n = -1;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') n = (i + 1) % handButtons.length;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') n = (i + handButtons.length - 1) % handButtons.length;
      else return;
      e.preventDefault();
      setHand(handButtons[n].dataset.hand, { focus: true });
    });
  });

  // ---- switches ------------------------------------------------------------
  on($('sustain'), 'click', () => {
    sustainVal = !sustainVal;
    settings.sustain = sustainVal;
    saveSettings();
    $('sustain').setAttribute('aria-checked', sustainVal ? 'true' : 'false');
  });
  on($('stats'), 'click', () => {
    statsVal = !statsVal;
    settings.stats = statsVal;
    saveSettings();
    $('stats').setAttribute('aria-checked', statsVal ? 'true' : 'false');
  });

  // ---- visualizer style ----------------------------------------------------
  function applyVizStyle() {
    $('fall-speed-label').textContent = fallSpeedVal.toFixed(2) + '×';
    $('fall-speed').style.setProperty('--p', String((fallSpeedVal - 0.25) / 3.75));
    $('note-color').classList.toggle('is-off', !noteColorVal);
    viz.setStyle({ speed: fallSpeedVal, color: noteColorVal || null });
    vizHandle.invalidate();
  }
  const applyVizStyleLive = coalesce(applyVizStyle);
  on($('fall-speed'), 'input', () => {
    fallSpeedVal = clamp(parseFloat($('fall-speed').value) || 1, 0.25, 4);
    applyVizStyleLive();
  });
  on($('fall-speed'), 'change', () => { settings.fallSpeed = fallSpeedVal; saveSettings(); });
  on($('note-color'), 'input', () => {
    noteColorVal = $('note-color').value;
    applyVizStyleLive();
  });
  on($('note-color'), 'change', () => { settings.noteColor = noteColorVal; saveSettings(); });
  on($('note-color-reset'), 'click', () => {
    noteColorVal = '';
    settings.noteColor = '';
    saveSettings();
    applyVizStyle();
  });

  // ==========================================================================
  // 11. HOTKEYS
  // Ten global bindings live in the engine; empty means UNBOUND for every one
  // of them, including play, pause and stop, so those keys can be freed for the
  // game. Focusing a capture widget suspends the globals, or pressing the key
  // being rebound fires its old action.
  // ==========================================================================
  // The pynput tables, the e.code translation, the human label and the capture
  // box itself are SHARED (window.Hotkey, CONTRACT §9.7): the engine's syntax and
  // "a focused box suspends the globals" are not this panel's private business,
  // and Perch already replays transport as a synthetic hotkey. What stays here is
  // the list of slots, the row layout and what each name does.
  const HK = window.Hotkey;
  const hkLabel = (combo) => HK.label(combo);
  const keyEventToPynput = (e) => HK.toPynput(e);

  // name: the engine's hotkey slot ('' => handled in this document only).
  const HOTKEYS = [
    { id: 'play', setting: 'playHotkey', label: 'Play / resume', engine: 'play' },
    { id: 'pause', setting: 'pauseHotkey', label: 'Pause / resume', engine: 'pause' },
    { id: 'stop', setting: 'stopHotkey', label: 'Stop', engine: 'stop' },
    { id: 'tempo-up', setting: 'tempoUpHotkey', label: 'Tempo up', engine: 'tempo_up' },
    { id: 'tempo-down', setting: 'tempoDownHotkey', label: 'Tempo down', engine: 'tempo_down' },
    { id: 'tempo-set', setting: 'tempoSetHotkey', label: 'Tempo to preset', engine: 'tempo_set' },
    { id: 'seek-fwd', setting: 'seekFwdHotkey', label: 'Seek forward', engine: 'seek_fwd' },
    { id: 'seek-back', setting: 'seekBackHotkey', label: 'Seek back', engine: 'seek_back' },
    { id: 'next', setting: 'nextHotkey', label: 'Next song', engine: 'next_track' },
    { id: 'prev', setting: 'prevHotkey', label: 'Previous song', engine: 'prev_track' },
    { id: 'panic', setting: 'panicHotkey', label: 'Panic (all notes off)', engine: '' }
  ];

  const els = {};
  function buildHotkeyRow(spec) {
    const row = document.createElement('div');
    row.className = 'p-hk-row' + (spec.engine ? '' : ' is-local');
    const label = document.createElement('span');
    label.className = 'p-hk-label';
    label.id = 'hk-label-' + spec.id;
    label.textContent = spec.label;

    // The shared widget owns the capture, the unbind button, the ARIA and the
    // pynput syntax; this panel owns the row and what happens on capture and on
    // commit — suspending the engine's globals while a box is focused is the
    // owner's job because only the owner can talk to the engine.
    const widget = HK.create({
      id: 'hotkey-' + spec.id,
      label: spec.label,
      describedBy: label.id,
      value: settings[spec.setting] || '',
      onCapture: () => suspendHotkeys(),
      onCommit: () => applyHotkeys()
    });
    widget.spec = spec;
    keep(() => widget.dispose());
    row.append(label, widget.el);
    $('hotkeys').appendChild(row);
    return widget;
  }
  HOTKEYS.forEach((spec) => {
    const w = buildHotkeyRow(spec);
    const camel = spec.id.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    els['hk' + camel.charAt(0).toUpperCase() + camel.slice(1)] = w;
  });
  // Every one of these captures a key. next/prev were declared once and never
  // wired up, which is why they are named here explicitly.
  const HK_INPUTS = [els.hkPlay, els.hkPause, els.hkStop, els.hkTempoUp, els.hkTempoDown,
    els.hkTempoSet, els.hkSeekFwd, els.hkSeekBack, els.hkNext, els.hkPrev, els.hkPanic];

  function engineHotkeys(all) {
    const out = { cmd: 'set_hotkeys' };
    for (const spec of HOTKEYS) {
      if (!spec.engine) continue;
      const w = HK_INPUTS.find((x) => x.spec.id === spec.id);
      out[spec.engine] = all === false ? '' : (w ? w.value() : '');
    }
    return out;
  }
  function sendHotkeys() {
    send(engineHotkeys(true));
    const parts = [];
    for (const w of HK_INPUTS) {
      if (!w.value()) continue;
      parts.push(`${w.spec.label} ${hkLabel(w.value())}`);
    }
    $('hotkey-status').textContent = parts.length
      ? parts.join('   ·   ')
      : 'Nothing bound. Use the controls on screen, or bind a key above.';
  }
  // Suspend the globals while a capture widget is focused.
  function suspendHotkeys() { send(engineHotkeys(false)); }
  function applyHotkeys() {
    for (const w of HK_INPUTS) settings[w.spec.setting] = w.value();
    saveSettings();
    sendHotkeys();
  }
  on($('hotkey-clear-all'), 'click', () => {
    for (const w of HK_INPUTS) w.set('');
    applyHotkeys();
    say('All hotkeys unbound.');
  });

  // The engine dispatches the ten global ones; Perch's transport arrives on the
  // same path, so queue and tempo logic lives in exactly one place.
  function runHotkey(name) {
    lastInput = `${name} · ${window.Fmt.stamp(Date.now()).slice(11)}`;
    $('ms-last').textContent = lastInput;
    $('ms-last').title = lastInput;
    switch (name) {
      case 'play': if (isPlaying && isPaused) doResume(); else doPlay(); break;
      case 'stop': doStop(); break;
      case 'pause': doTogglePause(); break;
      case 'tempo_up': nudgeTempo(tempoStepVal); break;
      case 'tempo_down': nudgeTempo(-tempoStepVal); break;
      case 'tempo_set': setTempo(tempoPresetVal); break;
      case 'next_track': skipTrack(1); break;
      case 'prev_track': skipTrack(-1); break;
      case 'seek_fwd': seekRelative(seekStepVal); break;
      case 'seek_back': seekRelative(-seekStepVal); break;
      default: break;
    }
  }

  // Panic has no engine slot, so it is bound in this document. That means it
  // answers while MIDI Studio has focus; Stop is the global one and releases
  // every held key too.
  on(window, 'keydown', (e) => {
    const w = els.hkPanic;
    if (!w || !w.value()) return;
    if (inFormControl(document.activeElement)) return;
    if (keyEventToPynput(e) !== w.value()) return;
    e.preventDefault();
    doPanic();
  });

  // ==========================================================================
  // 12. THE SONG MAP: range, practice loop, pointer and keyboard
  // ==========================================================================
  function parseRangeTime(raw) {
    const text = String(raw || '').trim();
    if (!text) return null;
    const parts = text.split(':');
    if (parts.length > 3 || parts.some((p) => p.trim() === '' || !isFinite(Number(p)))) return NaN;
    let seconds = 0;
    for (const part of parts) seconds = seconds * 60 + Number(part);
    return seconds >= 0 ? seconds : NaN;
  }
  function formatRangeTime(seconds) {
    const s = Math.max(0, Number(seconds) || 0);
    const whole = Math.floor(s);
    const frac = s - whole;
    const tail = frac >= 0.005 ? (Math.round(frac * 100) / 100).toString().slice(1) : '';
    return `${Math.floor(whole / 60)}:${window.Fmt.pad2(whole % 60)}${tail}`;
  }
  let rangeOn = false;
  function playbackRange() {
    if (!rangeOn || totalDuration <= 0) return { enabled: false, start: 0, end: totalDuration };
    const rawStart = parseRangeTime($('range-start').value);
    const rawEnd = parseRangeTime($('range-end').value);
    if (Number.isNaN(rawStart) || Number.isNaN(rawEnd)) return { enabled: true, valid: false, start: 0, end: totalDuration };
    const start = clamp(rawStart || 0, 0, totalDuration);
    const end = clamp(rawEnd == null ? totalDuration : rawEnd, 0, totalDuration);
    return { enabled: true, valid: end > start, start, end };
  }
  function paintRange() {
    const range = playbackRange();
    const valid = !range.enabled || range.valid !== false;
    const off = !rangeOn || totalDuration <= 0;
    $('range-start').disabled = off;
    $('range-end').disabled = off;
    $('range-full').disabled = off;
    $('range-enabled').disabled = totalDuration <= 0;
    const sum = $('range-summary');
    sum.classList.toggle('is-error', !valid);
    sum.textContent = !valid ? 'Stop must be after start'
      : range.enabled ? `${formatRangeTime(range.start)} – ${formatRangeTime(range.end)} · ${formatRangeTime(range.end - range.start)}`
        : 'Full song';
    const bar = $('scrub-range');
    if (range.enabled && valid && totalDuration > 0) {
      bar.hidden = false;
      bar.style.setProperty('--a', String(range.start / totalDuration));
      bar.style.setProperty('--w', String((range.end - range.start) / totalDuration));
    } else {
      bar.hidden = true;
    }
    mapHandle.invalidate();
    return valid;
  }
  function setRange(start, end) {
    if (totalDuration <= 0) return;
    const s = clamp(start, 0, totalDuration);
    const e = clamp(Math.max(s + 0.01, end), 0, totalDuration);
    rangeOn = true;
    $('range-enabled').setAttribute('aria-checked', 'true');
    $('range-start').value = formatRangeTime(s);
    $('range-end').value = formatRangeTime(e);
    paintRange();
  }
  function resetRange() {
    rangeOn = false;
    $('range-enabled').setAttribute('aria-checked', 'false');
    $('range-start').value = '0:00';
    $('range-end').value = '';
    paintRange();
  }
  on($('range-enabled'), 'click', () => {
    if (totalDuration <= 0) return;
    rangeOn = !rangeOn;
    $('range-enabled').setAttribute('aria-checked', rangeOn ? 'true' : 'false');
    if (rangeOn && !$('range-end').value) $('range-end').value = formatRangeTime(totalDuration);
    paintRange();
    paintPractice();
  });
  const paintRangeLive = coalesce(paintRange);
  on($('range-start'), 'input', paintRangeLive);
  on($('range-end'), 'input', paintRangeLive);
  on($('range-full'), 'click', resetRange);

  // practice loop
  function paintPractice() {
    const on_ = rangeLoopVal;
    $('practice-row').classList.toggle('is-off', !on_);
    $('range-loop').setAttribute('aria-checked', on_ ? 'true' : 'false');
    $('ramp-start').disabled = !on_;
    $('ramp-step').disabled = !on_;
    $('practice-summary').textContent = !on_ ? ''
      : practice ? `pass at ${practice.pct}%`
        : rampStartVal < 100 ? `${rampStartVal}% to 100%` : 'looping';
  }
  on($('range-loop'), 'click', () => {
    rangeLoopVal = !rangeLoopVal;
    settings.rangeLoop = rangeLoopVal;
    saveSettings();
    paintPractice();
  });
  function startPracticeIfAsked() {
    if (!rangeLoopVal || !playbackRange().enabled || rampStartVal >= 100 || practice) return false;
    practice = { target: tempo, pct: rampStartVal };
    applyRampTempo();
    return true;
  }
  // The ramp writes the slider without persisting: the user's own target tempo
  // has to come back when the loop ends.
  function applyRampTempo() {
    const t = clamp(practice.target * practice.pct / 100, TEMPO_MIN, TEMPO_MAX);
    tempo = Math.round(t * 100) / 100;
    paintTempo();
    paintPractice();
  }
  function nextPracticePass() {
    const range = playbackRange();
    if (practice && practice.pct < 100) {
      practice.pct = Math.min(100, practice.pct + rampStepVal);
      applyRampTempo();
      say(`Practice pass at ${practice.pct}% (${tempo.toFixed(2)}×).`);
      loadMidi();                        // rescale the roll for the new tempo
    }
    sendPlay(range.start, 0);
  }
  function endPractice() {
    if (!practice) return;
    const t = practice.target;
    practice = null;
    tempo = t;
    settings.tempo = t;
    saveSettings();
    paintTempo();
    paintPractice();
    if (lastMidiPath) loadMidi();
  }

  // ---- map pointer ---------------------------------------------------------
  let mapDrag = null;
  function mapTime(clientX, rect) {
    return clamp(zoom.timeAt(clientX - rect.left, rect.width), 0, totalDuration);
  }
  on(mapHost, 'pointerdown', (e) => {
    if (e.button !== 0 || totalDuration <= 0) return;
    const rect = window.Draw.measure(mapHost);   // cached for the whole gesture
    const range = playbackRange();
    const x = e.clientX - rect.left;
    const sx = range.enabled ? zoom.xFor(range.start, rect.w) : -100;
    const ex = range.enabled ? zoom.xFor(range.end, rect.w) : -100;
    const mode = Math.abs(x - sx) < 10 ? 'start' : Math.abs(x - ex) < 10 ? 'end' : 'select';
    mapDrag = { mode, rect: { left: rect.left, width: rect.w }, anchor: mapTime(e.clientX, { left: rect.left, width: rect.w }), x: e.clientX, moved: false };
    mapHost.setPointerCapture(e.pointerId);
    mapHandle.setLive(true);
    document.body.classList.add('is-resizing');
  });
  on(mapHost, 'pointermove', (e) => {
    if (!mapDrag) return;
    const t = mapTime(e.clientX, mapDrag.rect);
    if (Math.abs(e.clientX - mapDrag.x) > 3) mapDrag.moved = true;
    const range = playbackRange();
    if (mapDrag.mode === 'start') setRange(Math.min(t, range.end - 0.01), range.end);
    else if (mapDrag.mode === 'end') setRange(range.start, Math.max(t, range.start + 0.01));
    else if (mapDrag.moved) setRange(Math.min(mapDrag.anchor, t), Math.max(mapDrag.anchor, t));
  });
  on(mapHost, 'pointerup', (e) => {
    if (!mapDrag) return;
    // An unmoved click in select mode is a seek, not a zero-width selection.
    if (!mapDrag.moved && mapDrag.mode === 'select') seekTo(mapTime(e.clientX, mapDrag.rect));
    mapDrag = null;
    mapHandle.setLive(false);
    document.body.classList.remove('is-resizing');
    mapHandle.invalidate();
  });
  on(mapHost, 'pointercancel', () => {
    mapDrag = null; mapHandle.setLive(false); document.body.classList.remove('is-resizing');
  });
  on(mapHost, 'keydown', (e) => {
    if (totalDuration <= 0) return;
    let next = viz.elapsed();
    if (e.key === 'ArrowLeft') next -= e.shiftKey ? 10 : 1;
    else if (e.key === 'ArrowRight') next += e.shiftKey ? 10 : 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = totalDuration;
    else return;
    e.preventDefault();
    // This element answered the key. Without this the window handler below sees
    // the same Home and stops playback as well as seeking.
    e.stopPropagation();
    seekTo(next);
  });

  // song-map collapse: still dispatches a synthetic resize, because the
  // canvases only re-measure on that event.
  function applyMapCollapsed() {
    const c = !!settings.mapCollapsed;
    $('map').classList.toggle('is-collapsed', c);
    $('map-toggle').setAttribute('aria-expanded', c ? 'false' : 'true');
    $('map-body').hidden = c;
    // A grip for a panel that is not there would drag nothing.
    $('map-grip').style.visibility = c ? 'hidden' : '';
  }
  on($('map-toggle'), 'click', () => {
    settings.mapCollapsed = !settings.mapCollapsed;
    saveSettings();
    applyMapCollapsed();
    window.dispatchEvent(new Event('resize'));
  });

  // ==========================================================================
  // 13. THE SCRUBBER
  // ==========================================================================
  const scrub = $('scrub');
  let scrubbing = false;
  let scrubRect = null;

  function scrubTime(clientX) {
    if (!scrubRect || totalDuration <= 0) return 0;
    return clamp((clientX - scrubRect.left) / scrubRect.w, 0, 1) * totalDuration;
  }
  on(scrub, 'pointerdown', (e) => {
    if (e.button !== 0 || totalDuration <= 0) return;
    scrubbing = true;
    scrubRect = window.Draw.measure(scrub);      // one rect for the gesture
    scrub.classList.add('is-dragging');
    scrub.setPointerCapture(e.pointerId);
    vizHandle.setLive(true);          // a drag is an animation, not an idle view
    seekTo(scrubTime(e.clientX), { fromDrag: true });
    e.preventDefault();
  });
  on(scrub, 'pointermove', (e) => {
    if (!scrubbing) {
      if (totalDuration <= 0) return;
      const r = window.Draw.measure(scrub);
      const p = clamp((e.clientX - r.left) / r.w, 0, 1);
      scrub.style.setProperty('--h', String(p));
      const tip = $('scrub-tip');
      tip.hidden = false;
      tip.textContent = clock(p * totalDuration);
      tip.style.setProperty('--tip', String(clamp(e.clientX - r.left, 20, r.w - 20)));
      return;
    }
    seekTo(scrubTime(e.clientX), { fromDrag: true });
  });
  on(scrub, 'pointerleave', () => {
    if (scrubbing) return;
    scrub.style.setProperty('--h', '0');
    $('scrub-tip').hidden = true;
  });
  const endScrub = () => {
    if (!scrubbing) return;
    scrubbing = false;
    scrub.classList.remove('is-dragging');
    scrub.style.setProperty('--h', '0');
    $('scrub-tip').hidden = true;
    if (pendingScrub !== null) { const t = pendingScrub; pendingScrub = null; viz.seek(t); requestSeek(t); }
    if (pendingSeek !== null) flushSeek();
    vizHandle.setLive(isPlaying);
    releaseDragSoon();
    reportState();          // the end of the gesture is the edge worth sending
  };
  on(scrub, 'pointerup', endScrub);
  on(scrub, 'pointercancel', endScrub);
  on(window, 'blur', endScrub);
  on(scrub, 'keydown', (e) => {
    if (totalDuration <= 0) return;
    let next = viz.elapsed();
    if (e.key === 'ArrowLeft') next -= 5;
    else if (e.key === 'ArrowRight') next += 5;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = totalDuration;
    else return;
    e.preventDefault();
    e.stopPropagation();      // the slider answered it; the transport must not
    seekTo(next);
  });

  // ==========================================================================
  // 14. PAINTING
  // Split into a per-frame part (position only, transforms and one clock
  // string) and event-driven parts. Nothing here reads a token or a computed
  // style: Tokens is cached and the transforms are custom properties.
  // ==========================================================================
  let lastElapsedText = '';
  let lastPct = -1;
  function paintPosition(elapsed) {
    // A non-finite ratio writes --p: NaN, which makes scaleX() invalid, which
    // drops the declaration entirely and paints the fill at FULL width. An
    // unknown position has to read as zero, not as a finished song.
    let p = totalDuration > 0 ? clamp(elapsed / totalDuration, 0, 1) : 0;
    if (!Number.isFinite(p)) p = 0;
    // One write: --p is set on .p-scrub and inherited by the fill and the
    // cursor layer, both of which are pure transforms.
    scrub.style.setProperty('--p', p.toFixed(5));
    const pct = Math.round(p * 100);
    if (pct !== lastPct) {
      lastPct = pct;
      scrub.setAttribute('aria-valuenow', String(pct));
      scrub.setAttribute('aria-valuetext', `${clock(elapsed)} of ${clock(totalDuration)}`);
    }
    const text = clock(elapsed);
    if (text !== lastElapsedText) {
      lastElapsedText = text;
      $('time-elapsed').textContent = text;
      $('now-pos').textContent = `${text} / ${clock(totalDuration)}`;
    }
  }

  function paintSong() {
    const has = !!lastMidiPath;
    const name = has ? base(lastMidiPath) : 'No song loaded';
    $('head-song').textContent = name;
    $('head-song').title = has ? lastMidiPath : '';
    $('now-name').textContent = has ? name : 'Nothing loaded';
    // Every truncating run on this page carries the whole string in a title:
    // an ellipsis is a legitimate answer to a name that does not fit, but only
    // if the full name is still readable somewhere.
    $('now-name').title = has ? lastMidiPath : '';
    $('now-folder').textContent = has ? window.Fmt.dirname(lastMidiPath) : '';
    $('now-folder').title = has ? lastMidiPath : '';
    const chip = $('song-path');
    chip.hidden = !has;
    if (has) {
      // No trailing separator: .pathchip-dir clips from the left in rtl, so a
      // trailing slash renders at the front of the string.
      $('song-dir').textContent = window.Fmt.dirname(lastMidiPath);
      $('song-name').textContent = name;
      chip.title = lastMidiPath;
    }
    $('head-dur').textContent = has ? clock(totalDuration) : '--:--';
    $('head-notes').textContent = window.Fmt.count(totalNotes, 'note', 'notes');
    $('head-bpm').textContent = bpm ? window.Fmt.bpm(bpm * tempo) + ' BPM' : '-- BPM';
    $('head-mapping').textContent = mappingName();
    $('head-mapping').title = mapping === '__custom__' ? customMappingPath : mappingName();
    $('chip-piano').textContent = /drums/i.test(mappingName()) ? 'Drums' : 'Piano';
    $('chip-mapping').textContent = keysMapped ? `${mappingName()} · ${keysMapped}` : mappingName();
    $('now-meta').textContent = has
      ? `${clock(totalDuration)} · ${totalNotes} notes · ${window.Fmt.bpm(bpm)} BPM`
      : '';
    const nowWin = selectedWindow();
    $('now-target').textContent = targetLabel() || '—';
    $('now-target').title = nowWin ? `${nowWin.process || ''}  ${nowWin.title || ''}`.trim() : '';
    $('viz-empty').classList.toggle('is-hidden', has);
    $('map-empty').hidden = has && overviewEvents.length > 0;
    $('tr-play').disabled = !has;
    $('tool-sheet').disabled = !has;
    $('tool-reload').disabled = !has;
    $('tool-test').disabled = !has;
  }

  function instrumentLabel() {
    if (!totalNotes) return '—';
    if (/drums/i.test(mappingName())) return 'Drum kit';
    const drums = (channelMask & (1 << 9)) !== 0;
    const others = channelMask & ~(1 << 9);
    if (drums && others) return 'Piano + drums';
    if (drums) return 'Drum kit';
    let n = 0;
    for (let c = 0; c < 16; c++) if (channelMask & (1 << c)) n++;
    return n > 1 ? `Piano · ${n} parts` : 'Piano';
  }

  function paintStats() {
    $('st-notes').textContent = (isPlaying || isCounting)
      ? `${playedNotes} / ${totalNotes}` : (totalNotes ? String(totalNotes) : '0');
    $('st-length').textContent = totalDuration ? clock(totalDuration) : '--:--';
    $('st-tempo').textContent = `${tempo.toFixed(2)}× · ${bpm ? window.Fmt.bpm(bpm * tempo) : '--'} BPM`;
    $('st-instrument').textContent = instrumentLabel();
    $('st-mapping').textContent = mappingName();
    $('st-mapping').title = mapping === '__custom__' ? customMappingPath : mappingName();

    // The one indicator that says keystrokes are leaving this app right now.
    const pill = $('st-live'), dot = $('st-live-dot'), text = $('st-live-text');
    let cls = 'pill p-live', dcls = 'dot', word = 'Idle';
    if (isCounting) { cls += ' is-ok'; dcls = 'dot is-live'; word = 'Count in'; }
    else if (isPlaying && isFocusLost) { cls += ' is-blocked'; dcls = 'dot is-blocked'; word = 'Target not focused'; }
    else if (isPlaying && isPaused) { cls += ' is-warn'; dcls = 'dot is-paused'; word = 'Paused'; }
    else if (isPlaying) { cls += ' is-ok'; dcls = 'dot is-live'; word = 'Sending to game'; }
    pill.className = cls;
    dot.className = dcls;
    text.textContent = word;
    pill.setAttribute('aria-label', 'Playback: ' + word);
    $('now-sent').textContent = `${playedNotes} / ${totalNotes}`;
  }

  function paintTransport() {
    const live = isPlaying && !isPaused;
    const btn = $('tr-play');
    $('tr-play-ic').innerHTML = window.Icon.svg(live ? 'pause' : 'play', 16);
    $('tr-play-text').textContent = live ? 'Pause' : (isPaused ? 'Resume' : 'Play');
    btn.setAttribute('aria-label', live ? 'Pause' : (isPaused ? 'Resume' : 'Play'));
    // Disabled during the count-in too: isPlaying is still false there, so this
    // button would send a second play into a session that is already starting.
    btn.disabled = !lastMidiPath || isCounting;
    // Stop is NEVER disabled. A user stop always has to reach the engine, even
    // when this UI believes nothing is playing, so a tempo-restart session that
    // was dispatched a moment ago dies instead of carrying on.
    $('tr-stop').disabled = false;
    $('tr-countdown').textContent = countdownVal + 's';

    const pill = $('head-status'), dot = $('head-dot'), text = $('head-status-text');
    let cls = 'pill', dcls = 'dot', word = 'Idle';
    if (isCounting) { cls += ' is-ok'; dcls = 'dot is-live'; word = 'Count in'; }
    else if (isPlaying && isFocusLost) { cls += ' is-blocked'; dcls = 'dot is-blocked'; word = 'Waiting for target'; }
    else if (isPlaying && isPaused) { cls += ' is-warn'; dcls = 'dot is-paused'; word = 'Paused'; }
    else if (isPlaying) { cls += ' is-ok'; dcls = 'dot is-live'; word = 'Playing'; }
    else if (!lastMidiPath) { word = 'No song'; }
    else if (targetHwnd === null) { cls += ' is-warn'; dcls = 'dot warn'; word = 'No target'; }
    else { word = 'Ready'; }
    pill.className = cls;
    dot.className = dcls;
    text.textContent = word;
    paintStats();
  }

  // Both warnings render on load, BEFORE Play, which is the only time they are
  // any use.
  function paintMappingStatus() {
    $('ms-preset').textContent = mappingName();
    $('ms-preset').title = mapping === '__custom__' ? customMappingPath : mappingName();
    $('ms-keys').textContent = String(keysMapped || 0);
    $('ms-desc').textContent = mappingDescription || '';
    // The same description, next to the picker that chose it. The warnings stay
    // on the rail: they belong with Status, not with the control.
    $('mapping-note').textContent = mappingDescription
      || (lastMidiPath ? '' : 'Load a song to see what this preset can reach.');
    $('ms-status').textContent = !lastMidiPath ? 'No song'
      : targetHwnd === null ? 'No target window'
        : unmappedCount ? 'Ready, some notes skipped'
          : 'Ready';

    // The 36-key layout has no black keys, so every sharp lands on the white
    // key below: it is mapped, therefore never reported out of range, and
    // wrong. Without this note a first-timer blames the transcription.
    const sharps = $('warn-sharps');
    if (collapsedSharps > 0) {
      sharps.hidden = false;
      sharps.classList.add('is-warn');
      $('warn-sharps-text').textContent =
        `${collapsedSharps} black-key ${collapsedSharps === 1 ? 'note' : 'notes'} will play as the white key below. ` +
        'If your piano takes Shift for sharps, pick roblox61.';
    } else {
      sharps.hidden = true;
    }

    // Ghosting: most keyboards start dropping keys past ~6 at once.
    const drop = $('warn-drop');
    const r = lastReport;
    if (r) {
      const parts = [];
      if (r.big_chords > 0) parts.push(`${r.big_chords} chord${r.big_chords === 1 ? '' : 's'} over ${r.ghost_limit} keys (widest ${r.max_chord})`);
      if (r.short_notes > 0) parts.push(`${r.short_notes} note${r.short_notes === 1 ? '' : 's'} under 30ms`);
      if (parts.length) {
        drop.hidden = false;
        drop.classList.add('is-warn');
        const tip = r.big_chords > 0 && !chordStaggerVal ? ' Set Chord roll to 5–10ms if notes go missing.' : '';
        $('warn-drop-text').textContent = parts.join(' · ') + '.' + tip;
      } else {
        drop.hidden = false;
        drop.classList.remove('is-warn');
        $('warn-drop-text').textContent = `Widest chord ${r.max_chord} keys. Nothing likely to drop.`;
      }
    } else {
      drop.hidden = true;
    }

    const un = $('warn-unmapped');
    if (unmappedCount > 0) {
      un.hidden = false;
      un.classList.add('is-warn');
      $('warn-unmapped-text').textContent =
        `${unmappedCount} ${unmappedCount === 1 ? 'note is' : 'notes are'} outside this mapping's range and will not be sent.`;
    } else {
      un.hidden = true;
    }
    const rw = $('range-warning');
    rw.hidden = unmappedCount === 0;
    rw.textContent = unmappedCount ? `${unmappedCount} notes out of range at this transpose.` : '';
  }

  // ==========================================================================
  // 15. TOOLS + the overflow menu
  // ==========================================================================
  // Always forces the virtualpiano mapping, whichever preset is selected, and
  // still ships playOpts so the sheet matches what the keys will do.
  function exportSheet() {
    if (!lastMidiPath) { fail('Open a MIDI file first.'); return; }
    send({
      cmd: 'export_sheet',
      path: lastMidiPath,
      mapping: 'virtualpiano',
      transpose: transposeVal,
      ...playOpts()
    });
  }
  on($('tool-sheet'), 'click', exportSheet);
  on($('tool-panic'), 'click', doPanic);
  on($('tool-reload'), 'click', () => {
    if (!lastMidiPath) return;
    loadMidi();
    say(`Reloaded ${mappingName()}.`);
  });
  // A two-second pass into the target: the honest way to check the window, the
  // mapping and the keystrokes without inventing an engine command.
  on($('tool-test'), 'click', () => {
    if (!lastMidiPath) { fail('Open a MIDI file first.'); return; }
    if (isPlaying) { fail('Stop playback first.'); return; }
    if (targetHwnd === null) { fail('Pick the game window first.'); showTab('target'); return; }
    const range = playbackRange();
    const from = range.enabled && range.valid !== false ? range.start : 0;
    userStopped = false;
    testMode = true;
    send({
      cmd: 'play',
      midi_path: lastMidiPath,
      target_hwnd: targetHwnd,
      mapping: resolveMapping(),
      tempo,
      transpose: transposeVal,
      countdown: 0,
      stats: false,
      sustain: sustainVal,
      start_at: from,
      end_at: Math.min(totalDuration, from + 2),
      ...playOpts()
    });
    say('Test: sending two seconds to the target.');
  });

  on($('head-menu'), 'click', (e) => {
    const has = !!lastMidiPath;
    window.Menu.open([
      { label: 'Open MIDI file…', icon: 'folder', run: () => pickMidi(false) },
      { sep: true },
      { label: 'Reveal in Explorer', icon: 'folder', disabled: !has, run: () => window.Bus.send(T.FILE_REVEAL, { path: lastMidiPath }) },
      { label: 'Send to the Editor', icon: 'send', disabled: !has, run: () => window.Bus.send(T.NAV_OPEN_EDITOR, { midiPath: lastMidiPath }) },
      { label: 'Listen in Self MIDI', icon: 'play', disabled: !has, run: () => window.Bus.send(T.NAV_OPEN_SELFMIDI, { midiPath: lastMidiPath, play: false }) },
      { sep: true },
      { label: 'Copy VirtualPiano sheet', disabled: !has, run: exportSheet },
      { label: 'Reload mapping', icon: 'refresh', disabled: !has, run: () => { loadMidi(); say('Mapping reloaded.'); } },
      { label: 'Open mappings folder', icon: 'gear', run: () => { if (studio.openMappingsDir) studio.openMappingsDir(); } },
      { sep: true },
      { label: 'Show the song map', checked: !settings.mapCollapsed, run: () => $('map-toggle').click() },
      { sep: true },
      { label: 'Panic (all notes off)', icon: 'stop', danger: true, run: doPanic }
    ], { anchor: $('head-menu'), ariaLabel: 'Player actions', returnFocusTo: $('head-menu') });
  });

  on($('tr-play'), 'click', () => (isPlaying ? doTogglePause() : doPlay()));
  on($('tr-stop'), 'click', doStop);
  on($('tr-prev'), 'click', () => skipTrack(-1));
  on($('tr-next'), 'click', () => skipTrack(1));

  // ==========================================================================
  // 16. DRAG AND DROP
  // ==========================================================================
  let dragDepth = 0;
  const hasFiles = (e) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
  function veil(on_) { document.documentElement.dataset.drop = on_ ? 'on' : ''; }
  on(window, 'dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; veil(true); });
  on(window, 'dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  on(window, 'dragleave', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) veil(false); });
  on(window, 'drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    veil(false);
    const files = e.dataTransfer && e.dataTransfer.files;
    if (!files || !files.length) return;
    const paths = [];
    for (const f of files) {
      try { paths.push(api.getDroppedFilePath(f)); } catch (_) { /* not a real file */ }
    }
    const midis = paths.filter((p) => /\.midi?$/i.test(p));
    const json = paths.find((p) => /\.json$/i.test(p) && !/\.midstudio\.json$/i.test(p));
    if (midis.length) { addToQueue(midis, { announce: true }); return; }
    if (json) { useCustomMapping(json); return; }
    // Anything else is not ours: the shell's router knows where audio goes.
    const rest = paths.filter(Boolean);
    if (rest.length) window.Bus.send(T.FILE_DROPPED, { paths: rest, kind: 'other', frame: FRAME });
  });

  // ==========================================================================
  // 17. ENGINE EVENTS
  // One channel only: IPC. The shell also mirrors a couple of these onto the
  // bus, and listening to both would handle everything twice.
  // ==========================================================================
  if (api.onEngineError) keep(api.onEngineError((m) => fail(String(m))));

  if (api.onEngineEvent) keep(api.onEngineEvent((evt) => {
    if (!evt || !evt.event) return;
    switch (evt.event) {
      case 'ready':
        // main re-broadcasts the last 'ready' after a frame appears, so this
        // has to stay idempotent.
        engineReady = true;
        sendHotkeys();
        requestWindows();
        if (lastMidiPath) loadMidi();
        reportState();
        break;

      case 'windows': {
        const prev = targetHwnd;
        windows = Array.isArray(evt.windows) ? evt.windows : [];
        populateWindows(prev);
        paintTransport();
        paintMappingStatus();
        reportState();
        break;
      }

      case 'midi_loaded': {
        lastMidiLoaded = evt;            // a late-opening Perch needs it whole
        const events = evt.events || [];
        viz.load(events, evt.note_to_key || {});
        overviewEvents = events;
        overviewVersion++;
        totalDuration = evt.duration || 0;
        totalNotes = events.length;
        bpm = evt.bpm || 0;
        bpmEstimate = evt.bpm_estimate || 0;
        keysMapped = Object.keys(evt.note_to_key || {}).length;
        collapsedSharps = evt.collapsed_sharps | 0;
        unmappedCount = (evt.unmapped && evt.unmapped.length) | 0;
        mappingDescription = evt.mapping_description || '';
        lastReport = evt.report || null;
        playedNotes = 0;
        channelMask = 0;
        for (let i = 0; i < events.length; i++) channelMask |= 1 << (events[i][4] | 0);

        if (typeof evt.transpose === 'number' && evt.transpose !== transposeVal) {
          transposeVal = evt.transpose;
          settings.transpose = transposeVal;
          saveSettings();
          paintTranspose();
          say(`Auto-transposed ${transposeVal > 0 ? '+' : ''}${transposeVal} semitones to fit the mapping.`);
        }
        if (unmappedCount) {
          say(`${unmappedCount} notes fall outside the mapping range: ${(evt.unmapped || []).join(', ')}`, 'warn');
        }
        mapLayer.invalidate();
        artLayer.invalidate();
        paintSong(); paintTempo(); paintStats(); paintTransport(); paintMappingStatus();
        paintRange(); paintPosition(0);
        $('time-total').textContent = clock(totalDuration);
        vizHandle.invalidate(); mapHandle.invalidate(); artHandle.invalidate();
        if (pendingSeekAfterLoad !== null) {
          viz.seek(Math.min(pendingSeekAfterLoad, totalDuration));
          pendingSeekAfterLoad = null;
          paintPosition(viz.elapsed());
        }
        renderQueue();
        reportState();
        if (autoPlayNext) { autoPlayNext = false; sendPlay(0, 0); }
        break;
      }

      case 'countdown':
        isCounting = true;
        paintTransport();
        $('head-status-text').textContent = `Starting in ${evt.i}…`;
        $('st-live-text').textContent = `Starting in ${evt.i}…`;
        reportState();
        break;

      case 'playback_started':
        isPlaying = true;
        isPaused = false;
        isCounting = false;
        totalDuration = evt.duration || totalDuration;
        totalNotes = evt.total_notes || totalNotes;
        bpm = evt.bpm || bpm;
        bpmEstimate = evt.bpm_estimate || 0;
        playedNotes = 0;
        viz.startClock(totalDuration, evt.start_elapsed || 0);
        vizHandle.setLive(true);
        vizHandle.invalidate();
        $('time-total').textContent = clock(totalDuration);
        paintSong(); paintTempo(); paintTransport(); paintStats();
        renderQueue();
        reportState();
        break;

      case 'progress':
        viz.clockSet({ elapsed: evt.elapsed, frozen_elapsed: evt.frozen_elapsed });
        if (typeof evt.user_paused === 'boolean' && evt.user_paused !== isPaused) {
          isPaused = evt.user_paused;
          paintTransport();
        }
        if (!!evt.focus_lost !== isFocusLost) {
          isFocusLost = !!evt.focus_lost;
          paintTarget();
          paintTransport();
        }
        if (evt.played !== playedNotes) {
          playedNotes = evt.played | 0;
          $('st-notes').textContent = `${playedNotes} / ${totalNotes}`;
          $('now-sent').textContent = `${playedNotes} / ${totalNotes}`;
        }
        // ~20Hz in, ~20Hz out: the bottom transport owns no clock, so the
        // owner sets the cadence and this is the sanctioned ceiling.
        reportState();
        vizHandle.invalidate();
        break;

      case 'playback_done': {
        const wasTest = testMode;
        // A session WE ended to rebuild it: a tempo restart (pendingRestartAt)
        // or a paused rebuild (restarting). Neither is the end of the song, so
        // neither may reset the clock, log a summary, advance the queue or start
        // a practice pass. playback_done carries no flag of its own, so this is
        // the only thing that can tell them apart.
        const selfRestart = pendingRestartAt !== null || restarting;
        restarting = false;
        testMode = false;
        isPlaying = false;
        isPaused = false;
        isCounting = false;
        isFocusLost = false;
        viz.stopClock();
        vizHandle.setLive(false);
        vizHandle.invalidate();
        // A natural end left the clock parked at the duration, so the next Play
        // seeked to the end and instantly "finished" again.
        if (!selfRestart && !userStopped && !evt.crashed && !wasTest) viz.seek(0);
        if (evt.crashed) fail('The player engine stopped unexpectedly. Playback has been reset.');
        paintTransport(); paintStats(); paintTarget();
        if (evt.stats) {
          const s = evt.stats;
          say(`Timing: ${s.notes} notes, mean ${window.Fmt.ms(s.mean_ms, { digits: 2 })}, ` +
            `median ${window.Fmt.ms(s.median_ms, { digits: 2 })}, stdev ${s.stdev_ms.toFixed(2)}ms, ` +
            `max ${window.Fmt.ms(s.max_ms, { digits: 2 })}, over 5ms ${s.over_5ms} ` +
            `(${(100 * s.over_5ms / Math.max(1, s.notes)).toFixed(1)}%)`);
        }
        if (!userStopped && !evt.crashed && !wasTest && !selfRestart && typeof evt.sent === 'number') {
          const dropped = evt.total - evt.sent;
          say(`Sent ${evt.sent} / ${evt.total} keys` + (dropped > 0 ? ` (${dropped} not sent)` : ''),
            dropped > 0 ? 'warn' : 'info');
        }
        if (pendingRestartAt !== null) {
          const at = pendingRestartAt;
          pendingRestartAt = null;
          loadMidi();                 // reload the timeline at the new tempo
          sendPlay(at, 0);            // no countdown on a tempo restart
        } else if (selfRestart) {
          // A paused rebuild: the pre-seek is applied by the midi_loaded that is
          // already in flight and the panel stays stopped. Nothing to start.
        } else if (!userStopped && !evt.crashed && !wasTest && rangeLoopVal && playbackRange().enabled) {
          nextPracticePass();
        } else if (!userStopped && !evt.crashed && !wasTest) {
          advanceQueue();
        }
        if (userStopped || evt.crashed) endPractice();
        userStopped = false;
        // Only the end of a session may claim every note went out; a session we
        // ended ourselves to rebuild it has not sent the rest of the song.
        if (!selfRestart) {
          playedNotes = totalNotes;
          $('st-notes').textContent = String(totalNotes);
          $('now-sent').textContent = `${totalNotes} / ${totalNotes}`;
        }
        renderQueue();
        reportState();
        break;
      }

      case 'sheet_exported': {
        const notes = evt.notes | 0;
        const skipped = evt.unmapped | 0;
        if (navigator.clipboard) navigator.clipboard.writeText(evt.text || '').catch(() => {});
        toast('ok', 'VP sheet copied', `${notes} notes` + (skipped ? `, ${skipped} out of range skipped` : ''));
        say(`VP sheet saved to ${evt.path} (${notes} notes` + (skipped ? `, ${skipped} skipped` : '') + '). Copied to the clipboard.');
        break;
      }

      case 'hotkey':
        runHotkey(evt.name);
        break;

      default:
        break;
    }
  }));

  // The Perch overlay can be opened mid-song, after midi_loaded is long gone.
  // This tab is the only frame that kept the payload, so it answers with both
  // that and a synthetic playback_started carrying the current position.
  if (api.onOverlayWantsState) keep(api.onOverlayWantsState(() => {
    if (lastMidiLoaded && api.replayToOverlay) api.replayToOverlay(lastMidiLoaded);
    if (isPlaying && api.replayToOverlay) {
      api.replayToOverlay({ event: 'playback_started', start_elapsed: viz.elapsed() });
    }
  }));

  // A finished transcription: the shell offers it on the activity strip and
  // sends it here with queue:true. Nothing to duplicate.

  // ==========================================================================
  // 18. THE SHELL: hand-off, keys, commands
  // ==========================================================================
  keep(window.Bus.on(T.NAV_OPEN_PLAYER, (p) => {
    if (!p) return;
    if (p.mappingPath) useCustomMapping(p.mappingPath);
    if (Array.isArray(p.paths) && p.paths.length) addToQueue(p.paths, { announce: true });
    if (!p.midiPath) return;
    if (p.queue && lastMidiPath) { addToQueue([p.midiPath], { announce: true }); return; }
    setMidiFile(p.midiPath, !!p.play);
  }));

  keep(window.Bus.on(T.NAV_ACTIVATED, (p) => {
    if (!p || p.tab !== FRAME) return;
    claimTransport();
    readUiPrefs();
    vizHandle.invalidate(); mapHandle.invalidate(); artHandle.invalidate();
  }));

  keep(window.Bus.on(T.FILE_OPEN, (p) => {
    if (!p || p.from !== FRAME || !p.path) return;
    // Our own hand-off echoing back: flash the row it came from.
    const i = tracks.findIndex((x) => x.toLowerCase() === String(p.path).toLowerCase());
    if (i >= 0) queueList.scrollToIndex(i, 'nearest');
  }));

  // "Space toggles transport" is not mirrored onto the bus, so it is read at
  // boot and again whenever this tab is activated.
  function readUiPrefs() {
    if (!studio.getUi) return;
    studio.getUi().then((ui) => { spaceTransport = !ui || ui.spaceTransport !== false; }).catch(() => {});
  }

  // Space and Home never reach the shell while focus is inside this frame.
  let spaceBound = false;
  on(window, 'keydown', (e) => {
    if (!spaceBound || !xport || !xport.isOwner()) return;
    if (ownsActivationKeys(document.activeElement)) return;
    if (e.key === ' ' && spaceTransport) { e.preventDefault(); window.Transport.toggle(); }
    else if (e.key === 'Home') { e.preventDefault(); window.Transport.stop(); }
  });

  window.Commands.setScope(FRAME);
  keep(window.Commands.registerAll([
    { id: 'player.open', label: 'Open a MIDI file', group: 'Player', keywords: ['browse', 'load', 'midi'], run: () => pickMidi(false) },
    { id: 'player.play', label: 'Play', group: 'Player', keywords: ['start'], enabled: () => !!lastMidiPath, run: () => doPlay() },
    { id: 'player.stop', label: 'Stop playback', group: 'Player', run: () => doStop() },
    { id: 'player.panic', label: 'Panic — all notes off', group: 'Player', danger: true, keywords: ['stuck', 'release', 'keys'], run: () => doPanic() },
    { id: 'player.focusTarget', label: 'Focus the target window', group: 'Player', keywords: ['game', 'roblox', 'window'], run: () => focusTarget() },
    { id: 'player.mapping', label: 'Change the mapping preset', group: 'Player', keywords: ['keys', 'layout', 'roblox', 'virtualpiano'], run: () => { showTab('playback'); mappingSelect.focus(); } },
    { id: 'player.openMappings', label: 'Open the mappings folder', group: 'Player', keywords: ['custom', 'json'], run: () => { if (studio.openMappingsDir) studio.openMappingsDir(); } },
    { id: 'player.reloadMapping', label: 'Reload the mapping', group: 'Player', enabled: () => !!lastMidiPath, run: () => { loadMidi(); say('Mapping reloaded.'); } },
    { id: 'player.copySheet', label: 'Copy the VirtualPiano sheet', group: 'Player', keywords: ['export', 'vp', 'clipboard'], enabled: () => !!lastMidiPath, run: exportSheet },
    { id: 'player.testNotes', label: 'Test notes into the target', group: 'Player', enabled: () => !!lastMidiPath, run: () => $('tool-test').click() },
    { id: 'player.refreshWindows', label: 'Refresh the window list', group: 'Player', run: () => { lastWindowRefresh = Date.now(); requestWindows(); } },
    { id: 'player.queueUndo', label: 'Undo the last queue change', group: 'Player', enabled: () => !!queueUndo, run: () => $('queue-undo').click() },
    { id: 'player.clearQueue', label: 'Clear the queue', group: 'Player', run: () => $('queue-clear').click() },
    { id: 'player.songs', label: 'Browse all songs', group: 'Player', keywords: ['library', 'transcribed'], run: openSongs },
    // The bottom transport drives these two by id (section 11.4).
    { id: 'player.repeat', label: 'Repeat the queue', group: 'Player', run: (arg) => setQueueLoop(arg === 'all' || arg === 'one' || arg === true) },
    { id: 'player.transpose', label: 'Transpose', group: 'Player', run: (arg) => applyTranspose(Number(arg) || 0, false) }
  ]));

  // ==========================================================================
  // 19. BOOT
  // ==========================================================================
  function restoreUI() {
    mappingSelect.value = [...mappingSelect.options].some((o) => o.value === mapping) ? mapping : 'roblox';
    if (customMappingPath) {
      addCustomMappingOption(customMappingPath);
      if (mapping === '__custom__') mappingSelect.value = '__custom__';
    }
    $('countdown').value = String(countdownVal);
    $('chord-stagger').value = String(chordStaggerVal);
    $('hand-split').value = String(handSplitVal);
    $('tempo-step').value = String(tempoStepVal);
    $('tempo-preset').value = String(tempoPresetVal);
    $('seek-step').value = String(seekStepVal);
    $('ramp-start').value = String(rampStartVal);
    $('ramp-step').value = String(rampStepVal);
    $('fall-speed').value = String(fallSpeedVal);
    $('note-color').value = noteColorVal || '#b8e62e';
    $('sustain').setAttribute('aria-checked', sustainVal ? 'true' : 'false');
    $('stats').setAttribute('aria-checked', statsVal ? 'true' : 'false');
    $('auto-pick').setAttribute('aria-checked', autoPickVal ? 'true' : 'false');
    $('queue-loop').setAttribute('aria-pressed', queueLoopVal ? 'true' : 'false');
    $('loop-playback').setAttribute('aria-checked', queueLoopVal ? 'true' : 'false');
    $('range-loop').setAttribute('aria-checked', rangeLoopVal ? 'true' : 'false');
    $('tr-countdown').textContent = countdownVal + 's';
    setHand(handVal);
    paintTempo();
    paintTranspose();
    paintHandSplit();
    applyVizStyle();
    applyMapCollapsed();
    paintPractice();
    renderRecents();

    // The playlist and the current row survive a restart.
    const saved = Array.isArray(settings.playlist)
      ? settings.playlist.filter((p) => typeof p === 'string' && /\.midi?$/i.test(p))
      : [];
    tracks = [...new Map(saved.map((p) => [p.toLowerCase(), p])).values()];
    if (settings.midiPath && !tracks.some((p) => p.toLowerCase() === settings.midiPath.toLowerCase())) {
      tracks.unshift(settings.midiPath);
    }
    const currentPath = settings.playlistCurrent || settings.midiPath || '';
    curIdx = tracks.findIndex((p) => p.toLowerCase() === currentPath.toLowerCase());
    if (curIdx < 0 && tracks.length) curIdx = 0;
    if (curIdx >= 0) { lastMidiPath = tracks[curIdx]; settings.midiPath = lastMidiPath; }
    renderQueue();
    populateWindows(null);
    resetRange();
    paintSong(); paintStats(); paintTransport(); paintMappingStatus();
    paintPosition(0);
    sendHotkeys();
    window.Icon.apply(document);
  }

  restoreUI();
  readUiPrefs();
  claimTransport();
  window.Transport.sync().catch(() => {});
  vizHandle.invalidate();
  mapHandle.invalidate();
  artHandle.invalidate();

  // The handshake. Any hand-off queued while this document was loading is
  // drained the moment this lands.
  window.Bus.send(T.FRAME_READY, { frame: FRAME, title: 'Player' });

  // Ask once in case the engine was already up before this frame existed; main
  // also re-broadcasts its last 'ready', and the handler is idempotent.
  if (!engineReady) requestWindows();

  // ==========================================================================
  // 20. TEARDOWN
  // Every listener, timer, observer, Draw consumer, VList and layer created
  // above is undone here.
  // ==========================================================================
  let torn = false;
  function teardown() {
    if (torn) return;
    torn = true;
    saveSettings.flush();
    for (const id of timers) clearTimeout(id);
    timers.clear();
    for (let i = disposers.length - 1; i >= 0; i--) {
      try { disposers[i](); } catch (_) { /* keep tearing down */ }
    }
    disposers.length = 0;
    mapLayer.dispose();
    artLayer.dispose();
    viz.dispose();
    window.Menu.close();
  }
  window.addEventListener('pagehide', teardown);
  window.addEventListener('beforeunload', teardown);
  on(document, 'visibilitychange', () => { if (document.hidden) saveSettings.flush(); });
})();

// Renderer-side glue: wires DOM controls to the Python sidecar via the
// `window.api` bridge. Owns settings persistence, the visualizer's render
// loop, scrubber UX, log routing, accordion sidebar.

const $ = (id) => document.getElementById(id);
const els = {
  // sidebar — source
  midiPath: $('midi-path'),
  midiBrowse: $('midi-browse'),
  queueField: $('queue-field'),
  queueList: $('queue-list'),
  queueCount: $('queue-count'),
  queueClear: $('queue-clear'),
  queueLoop: $('queue-loop'),
  recentField: $('recent-field'),
  recentSelect: $('recent-select'),
  recentClear: $('recent-clear'),
  targetSelect: $('target-select'),
  targetRefresh: $('target-refresh'),
  autoPickTarget: $('auto-pick-target'),
  mappingSelect: $('mapping-select'),
  mappingBrowse: $('mapping-browse'),
  // sidebar — playback
  tempo: $('tempo'),
  tempoLabel: $('tempo-label'),
  countdown: $('countdown'),
  stats: $('stats'),
  sustain: $('sustain'),
  noteColor: $('note-color'),
  noteColorReset: $('note-color-reset'),
  fallSpeed: $('fall-speed'),
  fallSpeedLabel: $('fall-speed-label'),
  // sidebar — hotkeys
  hkPlay: $('hotkey-play'),
  hkStop: $('hotkey-stop'),
  hkPause: $('hotkey-pause'),
  hkTempoUp: $('hotkey-tempo-up'),
  hkTempoDown: $('hotkey-tempo-down'),
  hkTempoSet: $('hotkey-tempo-set'),
  hkSeekFwd: $('hotkey-seek-fwd'),
  hkSeekBack: $('hotkey-seek-back'),
  tempoStep: $('tempo-step'),
  tempoPreset: $('tempo-preset'),
  seekStep: $('seek-step'),
  hkApply: $('hotkey-apply'),
  hkStatus: $('hotkey-status'),
  // header
  headerStatus: $('header-status'),
  statusText: $('status-text'),
  // transport — buttons
  play: $('play'),
  pause: $('pause'),
  stop: $('stop'),
  // transport — times
  timeElapsed: $('time-elapsed'),
  timeTotal: $('time-total'),
  // track info strip
  trackStrip: $('track-strip'),
  trackName: $('track-name'),
  trackMeta: $('track-meta'),
  // scrubber
  scrubber: $('scrubber'),
  scrubFill: $('scrubber-fill'),
  scrubHover: $('scrubber-hover'),
  scrubThumb: $('scrubber-thumb'),
  scrubTooltip: $('scrubber-tooltip'),
  // viz / log
  vizCanvas: $('viz'),
  vizEmpty: $('viz-empty'),
  logPanel: $('log-panel'),
  logHeader: $('log-header'),
  log: $('log'),
  logClear: $('log-clear'),
  // updater
  versionBadge: $('version-badge'),
  updateBanner: $('update-banner'),
  updateTitle: $('update-title'),
  updateSub: $('update-sub'),
  updateProgress: $('update-progress'),
  updateProgressBar: $('update-progress-bar'),
  updateApply: $('update-apply'),
  updateDismiss: $('update-dismiss'),
};

const SETTINGS_KEY = 'midi-player.settings.v3';
const settings = Object.assign({
  midiPath: '',
  mapping: 'roblox',
  customMappingPath: '',
  tempo: 1.0,
  countdown: 0,
  stats: false,
  sustain: true,
  playHotkey: '<f6>',
  stopHotkey: '<f7>',
  pauseHotkey: '<f8>',
  tempoUpHotkey: '',
  tempoDownHotkey: '',
  tempoSetHotkey: '',
  seekFwdHotkey: '',
  seekBackHotkey: '',
  tempoStep: 0.1,
  tempoPreset: 1.0,
  seekStep: 5,
  targetHint: '',
  openSection: 'source',
  noteColor: '',            // '' = per-channel rainbow
  fallSpeed: 1,
  logCollapsed: true,
  recentFiles: [],          // most-recent-first list of MIDI paths
  autoPickTarget: true,     // auto-select the remembered target on launch
}, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'));

const MAX_RECENTS = 8;

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

// --------------------------------------------------------------------------
// Mutable runtime state
// --------------------------------------------------------------------------
let windows = [];
let lastMidiPath = null;
let totalDuration = 0;
let totalNotes = 0;
let bpm = 0;
let isPlaying = false;
let isPaused = false;
let isFocusLost = false;
let pendingRestartAt = null;   // seconds; set by a live tempo change
let pendingSeekAfterLoad = null; // seconds; pre-seek viz after next midi_loaded
const viz = new Visualizer(els.vizCanvas);

// --------------------------------------------------------------------------
// Logging
// --------------------------------------------------------------------------
function log(level, message) {
  const stamp = new Date().toLocaleTimeString([], { hour12: false });
  const span = document.createElement('span');
  span.className = `l-${level || 'info'}`;
  const ts = document.createElement('span');
  ts.className = 'l-time';
  ts.textContent = `[${stamp}] `;
  span.appendChild(ts);
  span.appendChild(document.createTextNode(message + '\n'));
  els.log.appendChild(span);
  els.log.scrollTop = els.log.scrollHeight;
}

// --------------------------------------------------------------------------
// Initial UI setup from settings
// --------------------------------------------------------------------------
function applySettingsToUI() {
  els.midiPath.value = settings.midiPath || '';
  if (settings.customMappingPath && settings.mapping === '__custom__') {
    addCustomMappingOption(settings.customMappingPath);
  }
  els.mappingSelect.value =
    [...els.mappingSelect.options].some(o => o.value === settings.mapping)
      ? settings.mapping : 'roblox';
  els.tempo.value = settings.tempo;
  els.tempoLabel.textContent = `${Number(settings.tempo).toFixed(2)}×`;
  els.countdown.value = settings.countdown;
  els.stats.checked = !!settings.stats;
  els.sustain.checked = settings.sustain !== false;
  els.noteColor.value = settings.noteColor || '#b8e62e';
  els.fallSpeed.value = settings.fallSpeed || 1;
  applyVizStyle();
  setHotkeyInput(els.hkPlay, settings.playHotkey);
  setHotkeyInput(els.hkStop, settings.stopHotkey);
  setHotkeyInput(els.hkPause, settings.pauseHotkey);
  setHotkeyInput(els.hkTempoUp, settings.tempoUpHotkey || '');
  setHotkeyInput(els.hkTempoDown, settings.tempoDownHotkey || '');
  setHotkeyInput(els.hkTempoSet, settings.tempoSetHotkey || '');
  setHotkeyInput(els.hkSeekFwd, settings.seekFwdHotkey || '');
  setHotkeyInput(els.hkSeekBack, settings.seekBackHotkey || '');
  els.tempoStep.value = settings.tempoStep;
  els.tempoPreset.value = settings.tempoPreset;
  els.seekStep.value = settings.seekStep;
  els.autoPickTarget.checked = settings.autoPickTarget !== false;

  // Open the persisted section
  document.querySelectorAll('.section').forEach((sec) => {
    // 'hotkeys' was renamed to 'settings'; keep old saved state working.
    const open = settings.openSection === 'hotkeys' ? 'settings' : settings.openSection;
    sec.classList.toggle('is-open', sec.dataset.section === open);
  });

  // Log collapse state
  els.logPanel.classList.toggle('is-collapsed', !!settings.logCollapsed);

  // Recent files dropdown
  renderRecents();
  renderQueue();

  // If a previous MIDI was loaded, restore the track-strip placeholder.
  if (settings.midiPath) {
    lastMidiPath = settings.midiPath;
    tracks = [settings.midiPath];
    curIdx = 0;
    els.midiPath.value = settings.midiPath;
  }
  updateTrackStrip();
}

function addCustomMappingOption(p) {
  const existing = [...els.mappingSelect.options].find(o => o.value === '__custom__');
  if (existing) existing.remove();
  const opt = document.createElement('option');
  opt.value = '__custom__';
  opt.textContent = `custom — ${p.split(/[\\/]/).pop()}`;
  opt.dataset.path = p;
  els.mappingSelect.appendChild(opt);
}

// --------------------------------------------------------------------------
// Accordion sidebar
// --------------------------------------------------------------------------
function initAccordion() {
  document.querySelectorAll('.section').forEach((sec) => {
    const head = sec.querySelector('.section-head');
    head.addEventListener('click', () => {
      const wasOpen = sec.classList.contains('is-open');
      document.querySelectorAll('.section').forEach(s => s.classList.remove('is-open'));
      if (!wasOpen) {
        sec.classList.add('is-open');
        settings.openSection = sec.dataset.section;
      } else {
        settings.openSection = null;
      }
      saveSettings();
    });
  });
}

// --------------------------------------------------------------------------
// Engine event handlers
// --------------------------------------------------------------------------
window.api.onEngineError((m) => log('error', m));

window.api.onEngineEvent((evt) => {
  switch (evt.event) {
    case 'ready':
      log('info', 'Engine ready.');
      sendHotkeys();
      requestWindows();
      if (curIdx >= 0) loadMidi();     // restore last session's file for real
      break;

    case 'log':
      log(evt.level || 'info', evt.message);
      break;

    case 'windows':
      windows = evt.windows;
      populateWindows();
      break;

    case 'midi_loaded':
      viz.load(evt.events, evt.note_to_key);
      totalDuration = evt.duration;
      totalNotes = evt.events.length;
      bpm = evt.bpm;
      els.vizEmpty.classList.add('is-hidden');
      log('info', `Loaded "${lastMidiPath?.split(/[\\/]/).pop()}" — `
        + `${evt.events.length} events, ${evt.duration.toFixed(1)}s, `
        + `~${evt.bpm.toFixed(1)} BPM`);
      if (evt.unmapped && evt.unmapped.length) {
        log('warn',
          `Skipped ${evt.unmapped.length} notes outside the mapping range: `
          + `[${evt.unmapped.join(', ')}]`);
      }
      updateTrackStrip();
      els.timeTotal.textContent = fmtClock(totalDuration);
      els.timeElapsed.textContent = fmtClock(0);
      els.scrubFill.style.width = '0%';
      els.scrubThumb.style.left = '0%';
      if (pendingSeekAfterLoad !== null) {
        viz.seek(Math.min(pendingSeekAfterLoad, totalDuration));
        pendingSeekAfterLoad = null;
      }
      renderQueue();
      if (autoPlayNext) { autoPlayNext = false; sendPlay(0, 0); }
      break;

    case 'countdown':
      log('info', `Starting in ${evt.i}…`);
      setStatus('paused', `Starting in ${evt.i}…`);
      break;

    case 'playback_started':
      isPlaying = true;
      isPaused = false;
      els.play.disabled = true;
      els.pause.disabled = false;
      els.stop.disabled = false;
      setPauseButton(false);
      totalDuration = evt.duration;
      totalNotes = evt.total_notes;
      bpm = evt.bpm;
      viz.startClock(evt.duration, evt.start_elapsed || 0);
      setStatus('playing', 'Playing');
      renderQueue();
      updateTrackStrip();
      break;

    case 'progress':
      viz.clockSet({
        elapsed: evt.elapsed,
        frozen_elapsed: evt.frozen_elapsed,
      });
      onProgress(evt);
      break;

    case 'playback_done':
      isPlaying = false;
      isPaused = false;
      els.play.disabled = false;
      els.pause.disabled = true;
      els.stop.disabled = true;
      setPauseButton(false);
      viz.stopClock();
      setStatus('idle', 'Idle');
      if (evt.stats) {
        const s = evt.stats;
        log('info',
          `Timing: notes=${s.notes}  mean=${fmtMs(s.mean_ms)}  ` +
          `median=${fmtMs(s.median_ms)}  stdev=${s.stdev_ms.toFixed(2)}ms  ` +
          `max=${fmtMs(s.max_ms)}  >5ms=${s.over_5ms} ` +
          `(${(100*s.over_5ms/s.notes).toFixed(1)}%)`);
      }
      // Reset notes counter on the track strip
      const tn = document.getElementById('track-notes');
      if (tn) tn.textContent = `${totalNotes} / ${totalNotes}`;
      // A live tempo change stops the session, then resumes here at the
      // same musical position rescaled to the new tempo.
      if (pendingRestartAt !== null) {
        const at = pendingRestartAt;
        pendingRestartAt = null;
        loadMidi();                 // reload events/visualizer at new tempo
        sendPlay(at, 0);            // no countdown on a tempo restart
      } else if (!userStopped) {
        advanceQueue();             // natural end -> next row in the playlist
      }
      userStopped = false;
      renderQueue();                // drop the ▶ marker back to a row number
      break;

    case 'hotkey':
      if (evt.name === 'play') {
        if (isPlaying && isPaused) doResume();
        else doPlay();
      } else if (evt.name === 'stop') doStop();
      else if (evt.name === 'pause') doTogglePause();
      else if (evt.name === 'tempo_up') nudgeTempo(+(settings.tempoStep || 0.1));
      else if (evt.name === 'tempo_down') nudgeTempo(-(settings.tempoStep || 0.1));
      else if (evt.name === 'tempo_set') setTempo(settings.tempoPreset || 1.0);
      else if (evt.name === 'seek_fwd') seekRelative(+(settings.seekStep || 5));
      else if (evt.name === 'seek_back') seekRelative(-(settings.seekStep || 5));
      break;

    case 'error':
      log('error', evt.message);
      break;
  }
});

function fmtMs(v) { return (v >= 0 ? '+' : '') + v.toFixed(2) + 'ms'; }

function onProgress(evt) {
  if (typeof evt.user_paused === 'boolean' && evt.user_paused !== isPaused) {
    isPaused = evt.user_paused;
    setPauseButton(isPaused);
  }
  isFocusLost = !!evt.focus_lost;

  if (!isPlaying) {
    setStatus('idle', 'Idle');
  } else if (isFocusLost) {
    setStatus('blocked', 'Paused · focus lost');
  } else if (isPaused) {
    setStatus('paused', 'Paused');
  } else {
    setStatus('playing', 'Playing');
  }

  const tn = document.getElementById('track-notes');
  if (tn) tn.textContent = `${evt.played} / ${totalNotes}`;
}

function setStatus(kind, text) {
  els.headerStatus.classList.remove('is-playing', 'is-paused', 'is-blocked');
  if (kind === 'playing') els.headerStatus.classList.add('is-playing');
  else if (kind === 'paused') els.headerStatus.classList.add('is-paused');
  else if (kind === 'blocked') els.headerStatus.classList.add('is-blocked');
  els.statusText.textContent = text;
}

// Icon-only Pause/Resume button — swap glyph + tint instead of label text.
const ICON_PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zm8 0h4v14h-4z" fill="currentColor"/></svg>';
const ICON_PLAY  = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>';
function setPauseButton(paused) {
  if (paused) {
    els.pause.innerHTML = ICON_PLAY;
    els.pause.classList.add('is-resume');
    els.pause.title = 'Resume (F8)';
    els.pause.setAttribute('aria-label', 'Resume');
  } else {
    els.pause.innerHTML = ICON_PAUSE;
    els.pause.classList.remove('is-resume');
    els.pause.title = 'Pause (F8)';
    els.pause.setAttribute('aria-label', 'Pause');
  }
}

function fmtClock(s) {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60), r = Math.floor(s % 60);
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

function updateTrackStrip() {
  if (!lastMidiPath || totalDuration === 0) {
    els.trackStrip.classList.add('is-empty');
    els.trackName.textContent = 'No file loaded';
    els.trackMeta.innerHTML = '';
    return;
  }
  els.trackStrip.classList.remove('is-empty');
  els.trackName.textContent = lastMidiPath.split(/[\\/]/).pop();
  els.trackMeta.innerHTML = `
    <span>${fmtClock(totalDuration)}</span>
    <span class="track-sep"></span>
    <span>${bpm.toFixed(1)} BPM</span>
    <span class="track-sep"></span>
    <span id="track-notes">0 / ${totalNotes}</span>
  `;
}

// --------------------------------------------------------------------------
// UI actions
// --------------------------------------------------------------------------
els.midiBrowse.addEventListener('click', async () => {
  const r = await window.api.pickMidi();
  addToQueue(Array.isArray(r) ? r : [r]);
});

els.recentSelect.addEventListener('change', () => {
  const p = els.recentSelect.value;
  if (p) setMidiFile(p);
});
els.recentClear.addEventListener('click', () => {
  settings.recentFiles = [];
  saveSettings();
  renderRecents();
});
els.autoPickTarget.addEventListener('change', () => {
  settings.autoPickTarget = els.autoPickTarget.checked;
  saveSettings();
});

els.targetRefresh.addEventListener('click', () => requestWindows());

els.mappingSelect.addEventListener('change', () => {
  if (els.mappingSelect.value === '__custom__') return;
  settings.mapping = els.mappingSelect.value;
  saveSettings();
  loadMidi();
});

els.mappingBrowse.addEventListener('click', async () => {
  const p = await window.api.pickMapping();
  if (!p) return;
  settings.customMappingPath = p;
  settings.mapping = '__custom__';
  addCustomMappingOption(p);
  els.mappingSelect.value = '__custom__';
  saveSettings();
  loadMidi();
});

els.tempo.addEventListener('input', () => {
  settings.tempo = parseFloat(els.tempo.value);
  els.tempoLabel.textContent = `${settings.tempo.toFixed(2)}×`;
  saveSettings();
});
els.tempo.addEventListener('change', () => loadMidi());

els.countdown.addEventListener('change', () => {
  settings.countdown = parseInt(els.countdown.value, 10) || 0;
  saveSettings();
});

els.stats.addEventListener('change', () => {
  settings.stats = els.stats.checked;
  saveSettings();
});

els.sustain.addEventListener('change', () => {
  settings.sustain = els.sustain.checked;
  saveSettings();
});

els.hkApply.addEventListener('click', () => {
  const hk = (el) => (el.dataset.hk || '').trim();
  settings.playHotkey = hk(els.hkPlay) || '<f6>';
  settings.stopHotkey = hk(els.hkStop) || '<f7>';
  settings.pauseHotkey = hk(els.hkPause) || '<f8>';
  settings.tempoUpHotkey = hk(els.hkTempoUp);
  settings.tempoDownHotkey = hk(els.hkTempoDown);
  settings.tempoSetHotkey = hk(els.hkTempoSet);
  settings.seekFwdHotkey = hk(els.hkSeekFwd);
  settings.seekBackHotkey = hk(els.hkSeekBack);
  saveSettings();
  sendHotkeys();
});

els.seekStep.addEventListener('change', () => {
  settings.seekStep = Math.max(1, Math.abs(parseFloat(els.seekStep.value)) || 5);
  els.seekStep.value = settings.seekStep;
  saveSettings();
});

els.tempoStep.addEventListener('change', () => {
  settings.tempoStep = Math.abs(parseFloat(els.tempoStep.value)) || 0.1;
  els.tempoStep.value = settings.tempoStep;
  saveSettings();
});
els.tempoPreset.addEventListener('change', () => {
  settings.tempoPreset = parseFloat(els.tempoPreset.value) || 1.0;
  els.tempoPreset.value = settings.tempoPreset;
  saveSettings();
});

// ---- hotkey capture: click a box, press the key, done -----------------
// Maps a DOM KeyboardEvent to pynput GlobalHotKeys syntax. Letters/digits
// stay bare ("q"), F-keys and named keys use <...>, anything else (+, -,
// numpad, media keys) falls back to the Windows virtual-key code <NNN>,
// which pynput accepts natively.
const PYNPUT_NAMED = {
  ' ': '<space>', 'Enter': '<enter>', 'Tab': '<tab>',
  'Home': '<home>', 'End': '<end>', 'Insert': '<insert>',
  'PageUp': '<page_up>', 'PageDown': '<page_down>',
  'ArrowUp': '<up>', 'ArrowDown': '<down>',
  'ArrowLeft': '<left>', 'ArrowRight': '<right>',
  'Pause': '<pause>', 'ScrollLock': '<scroll_lock>',
  'CapsLock': '<caps_lock>', 'NumLock': '<num_lock>',
  'PrintScreen': '<print_screen>',
};

// e.code -> unshifted character, so Shift+; still binds as ';' and not ':'.
const CODE_CHAR = {
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
  Backslash: '\\', BracketLeft: '[', BracketRight: ']',
  Minus: '-', Equal: '=', Backquote: '`', IntlBackslash: '`',
};

function keyEventToPynput(e) {
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return null;
  const mods = [];
  if (e.ctrlKey) mods.push('<ctrl>');
  if (e.altKey) mods.push('<alt>');
  if (e.shiftKey) mods.push('<shift>');
  let base;
  if (/^F\d{1,2}$/.test(e.key)) {
    base = `<${e.key.toLowerCase()}>`;
  } else if (/^[a-z0-9]$/i.test(e.key) && !e.code.startsWith('Numpad')) {
    base = e.key.toLowerCase();
  } else if (PYNPUT_NAMED[e.key]) {
    base = PYNPUT_NAMED[e.key];
  } else if (CODE_CHAR[e.code]) {
    base = CODE_CHAR[e.code];
  } else if (e.key && e.key.length === 1 && !e.code.startsWith('Numpad')) {
    base = e.key.toLowerCase();
  } else if (e.keyCode) {
    base = `<${e.keyCode}>`;   // virtual-key code fallback (e.g. +/−/numpad)
  } else {
    return null;
  }
  return [...mods, base].join('+');
}

const HK_LABEL = {
  '<space>': 'Space', '<enter>': 'Enter', '<tab>': 'Tab', '<esc>': 'Esc',
  '<home>': 'Home', '<end>': 'End', '<insert>': 'Insert', '<delete>': 'Delete',
  '<page_up>': 'PgUp', '<page_down>': 'PgDn',
  '<up>': '\u2191', '<down>': '\u2193', '<left>': '\u2190', '<right>': '\u2192',
  '<ctrl>': 'Ctrl', '<alt>': 'Alt', '<shift>': 'Shift', '<cmd>': 'Win',
  '<pause>': 'Pause', '<scroll_lock>': 'ScrLk', '<caps_lock>': 'Caps',
  '<num_lock>': 'NumLk', '<print_screen>': 'PrtSc',
};

// pynput syntax -> what a person would write on a sticky note.
function hkLabel(combo) {
  if (!combo) return '';
  return combo.split('+').map((part) => {
    if (HK_LABEL[part]) return HK_LABEL[part];
    const m = /^<f(\d{1,2})>$/.exec(part);
    if (m) return 'F' + m[1];
    const vk = /^<(\d+)>$/.exec(part);
    if (vk) return 'key ' + vk[1];        // numpad / media -- no nicer name
    return part.length === 1 ? part.toUpperCase() : part;
  }).join('+');
}

// Both halves of a capture box: dataset.hk is the truth, .value is for humans.
function setHotkeyInput(input, combo) {
  input.dataset.hk = combo || '';
  input.value = hkLabel(combo);
}

function initHotkeyCapture(input) {
  input.addEventListener('focus', () => {
    input.dataset.prev = input.dataset.hk || '';
    input.value = '';
    input.placeholder = 'press a key…';
    suspendHotkeys();
  });
  input.addEventListener('blur', () => {
    if (!input.value) setHotkeyInput(input, input.dataset.prev || '');
    input.placeholder = 'unset';
    sendHotkeys();               // restore active bindings
  });
  input.addEventListener('keydown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') { input.blur(); return; }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      input.dataset.prev = '';
      input.blur();
      return;
    }
    const combo = keyEventToPynput(e);
    if (!combo) return;          // modifier-only press — keep listening
    setHotkeyInput(input, combo);
    input.dataset.prev = combo;
    input.blur();
  });
}
[els.hkPlay, els.hkStop, els.hkPause,
 els.hkTempoUp, els.hkTempoDown, els.hkTempoSet,
 els.hkSeekFwd, els.hkSeekBack].forEach(initHotkeyCapture);

// ---- seek hotkey action -----------------------------------------------
// Same flow as the scrubber's arrow keys: drag-lock the visualizer so stale
// progress packets can't yank it back, seek, then release.
function seekRelative(delta) {
  if (totalDuration <= 0) return;
  const next = Math.max(0, Math.min(totalDuration, viz.elapsed() + delta));
  viz.setDragLock(true);
  viz.seek(next);
  requestSeek(next);
  setTimeout(() => viz.setDragLock(false), 250);
}

// ---- tempo hotkey actions ---------------------------------------------
function nudgeTempo(delta) {
  setTempo((parseFloat(els.tempo.value) || 1.0) + delta);
}

function setTempo(t) {
  const min = parseFloat(els.tempo.min), max = parseFloat(els.tempo.max);
  t = Math.round(Math.max(min, Math.min(max, t)) * 100) / 100;
  const prev = parseFloat(els.tempo.value) || 1.0;
  if (t === prev) return;
  els.tempo.value = t;
  settings.tempo = t;
  els.tempoLabel.textContent = `${t.toFixed(2)}×`;
  saveSettings();
  log('info', `Tempo → ${t.toFixed(2)}×`);
  if (isPlaying && !isPaused) {
    // Event times are baked at parse time, so restart the session at the
    // equivalent musical position under the new tempo scale.
    pendingRestartAt = viz.elapsed() * prev / t;
    window.api.send({ cmd: 'stop' });
  } else if (isPlaying && isPaused) {
    // Paused: never auto-resume. End the session and pre-seek the scrubber
    // to the equivalent spot — the next Play picks it up from there.
    pendingSeekAfterLoad = viz.elapsed() * prev / t;
    window.api.send({ cmd: 'stop' });
    loadMidi();
  } else {
    loadMidi();
  }
}

els.play.addEventListener('click', doPlay);
els.pause.addEventListener('click', doTogglePause);
els.stop.addEventListener('click', doStop);

// Log header (anywhere except Clear) toggles collapse.
els.logHeader.addEventListener('click', (e) => {
  if (e.target.closest('#log-clear')) return;
  els.logPanel.classList.toggle('is-collapsed');
  settings.logCollapsed = els.logPanel.classList.contains('is-collapsed');
  saveSettings();
});
els.logClear.addEventListener('click', (e) => {
  e.stopPropagation();
  els.log.textContent = '';
});

els.targetSelect.addEventListener('change', () => {
  const idx = parseInt(els.targetSelect.value, 10);
  if (!Number.isNaN(idx) && windows[idx]) {
    settings.targetHint = windows[idx].process || windows[idx].title;
    saveSettings();
  }
});

// --------------------------------------------------------------------------
// Commands -> sidecar
// --------------------------------------------------------------------------
function sendHotkeys() {
  window.api.send({
    cmd: 'set_hotkeys',
    play: settings.playHotkey,
    stop: settings.stopHotkey,
    pause: settings.pauseHotkey,
    tempo_up: settings.tempoUpHotkey || '',
    tempo_down: settings.tempoDownHotkey || '',
    tempo_set: settings.tempoSetHotkey || '',
    seek_fwd: settings.seekFwdHotkey || '',
    seek_back: settings.seekBackHotkey || '',
  });
  const parts = [
    `Play ${hkLabel(settings.playHotkey)}`,
    `Pause ${hkLabel(settings.pauseHotkey)}`,
    `Stop ${hkLabel(settings.stopHotkey)}`,
  ];
  if (settings.tempoUpHotkey) parts.push(`T+ ${hkLabel(settings.tempoUpHotkey)}`);
  if (settings.tempoDownHotkey) parts.push(`T− ${hkLabel(settings.tempoDownHotkey)}`);
  if (settings.tempoSetHotkey) parts.push(`T= ${hkLabel(settings.tempoSetHotkey)}`);
  if (settings.seekFwdHotkey) parts.push(`→ ${hkLabel(settings.seekFwdHotkey)}`);
  if (settings.seekBackHotkey) parts.push(`← ${hkLabel(settings.seekBackHotkey)}`);
  els.hkStatus.textContent = parts.join('   ·   ');
}

// Suspend global hotkeys while a capture box is focused so pressing the
// key being (re)bound doesn't fire its old action.
function suspendHotkeys() {
  window.api.send({ cmd: 'set_hotkeys', play: '', stop: '', pause: '',
                    tempo_up: '', tempo_down: '', tempo_set: '',
                    seek_fwd: '', seek_back: '' });
}

function requestWindows() { window.api.send({ cmd: 'list_windows' }); }

function resolveMappingArg() {
  if (els.mappingSelect.value === '__custom__') {
    const opt = [...els.mappingSelect.options].find(o => o.value === '__custom__');
    return opt ? opt.dataset.path : 'roblox';
  }
  return els.mappingSelect.value;
}

function loadMidi() {
  const p = els.midiPath.value;
  if (!p) return;
  lastMidiPath = p;
  pushRecent(p);
  window.api.send({
    cmd: 'load_midi',
    path: p,
    mapping: resolveMappingArg(),
    tempo: parseFloat(els.tempo.value),
  });
}

// Put a path in the box and hand it to the engine. Playlist bookkeeping lives
// in selectTrack() -- call that (or setMidiFile) rather than this directly.
function loadPath(p) {
  els.midiPath.value = p;
  settings.midiPath = p;
  saveSettings();
  loadMidi();
}

// Recent files — most-recent-first, de-duplicated, capped.
function pushRecent(p) {
  if (!p) return;
  const list = (settings.recentFiles || []).filter(x => x !== p);
  list.unshift(p);
  settings.recentFiles = list.slice(0, MAX_RECENTS);
  saveSettings();
  renderRecents();
}

function renderRecents() {
  const list = settings.recentFiles || [];
  els.recentField.style.display = list.length ? '' : 'none';
  els.recentSelect.innerHTML = '<option value="">— recent files —</option>';
  for (const p of list) {
    const o = document.createElement('option');
    o.value = p;
    o.textContent = p.split(/[\\/]/).pop();
    o.title = p;
    els.recentSelect.appendChild(o);
  }
}

// ---- visualizer style -----------------------------------------------------
function applyVizStyle() {
  const speed = parseFloat(els.fallSpeed.value) || 1;
  els.fallSpeedLabel.textContent = `${speed.toFixed(2)}\u00d7`;
  els.noteColor.classList.toggle('is-off', !settings.noteColor);
  viz.setStyle({ speed, color: settings.noteColor || null });
}

els.noteColor.addEventListener('input', () => {
  settings.noteColor = els.noteColor.value;
  saveSettings();
  applyVizStyle();
});
els.noteColorReset.addEventListener('click', () => {
  settings.noteColor = '';          // back to the per-channel palette
  saveSettings();
  applyVizStyle();
});
els.fallSpeed.addEventListener('input', () => {
  settings.fallSpeed = parseFloat(els.fallSpeed.value) || 1;
  saveSettings();
  applyVizStyle();
});

// ---- play queue -----------------------------------------------------------
// A playlist, not a consume-queue: tracks stay in the list once played, one row
// is the current track, and any row can be clicked to jump to it. Session-only.
let tracks = [], curIdx = -1, userStopped = false, autoPlayNext = false;

function renderQueue() {
  els.queueCount.textContent = tracks.length ? `(${tracks.length})` : '';
  els.queueList.innerHTML = '';
  if (!tracks.length) {
    const li = document.createElement('li');
    li.className = 'q-empty';
    li.textContent = 'Empty \u2014 drop or browse .mid files to build a playlist.';
    els.queueList.appendChild(li);
    return;
  }
  tracks.forEach((path, i) => els.queueList.appendChild(queueRow(path, i)));
}

function queueRow(path, i) {
  const li = document.createElement('li');
  const isCurrent = i === curIdx;
  if (isCurrent) li.className = 'is-current';
  li.title = isCurrent ? path : path + '\n(click to play)';

  const num = document.createElement('span');
  num.className = 'q-num';
  num.textContent = isCurrent && isPlaying ? '\u25b6' : String(i + 1);

  const n = document.createElement('span');
  n.className = 'qn'; n.textContent = path.split(/[\\/]/).pop();

  const x = document.createElement('button');
  x.className = 'qx'; x.type = 'button'; x.title = 'Remove'; x.textContent = '\u2715';
  x.addEventListener('click', (e) => { e.stopPropagation(); removeTrack(i); });

  li.append(num, n, x);
  li.addEventListener('click', () => playTrack(i));
  return li;
}

// Load a track. Plays it too when `andPlay`, once 'midi_loaded' comes back.
function selectTrack(i, andPlay) {
  if (i < 0 || i >= tracks.length) return;
  curIdx = i;
  autoPlayNext = !!andPlay;
  loadPath(tracks[i]);
  renderQueue();
}

// Clicking a row: jump to it, and keep playing if we already were.
function playTrack(i) {
  if (i === curIdx && !isPlaying && totalDuration > 0) { doPlay(); return; }
  const keepGoing = isPlaying;
  if (isPlaying) { userStopped = true; window.api.send({ cmd: 'stop' }); }
  selectTrack(i, keepGoing);
}

function removeTrack(i) {
  tracks.splice(i, 1);
  if (i === curIdx) curIdx = -1;          // loaded file is no longer in the list
  else if (i < curIdx) curIdx--;
  renderQueue();
}

// Append files; load the first new one if nothing is loaded / playing.
function addToQueue(paths) {
  const ps = (paths || []).filter(p => p && /\.midi?$/i.test(p));
  if (!ps.length) return;
  const first = tracks.length;
  tracks.push(...ps);
  renderQueue();
  if (!isPlaying && curIdx < 0) selectTrack(first, false);
}

// Public entry for browse / recents / library / the Forge hand-off: put the file
// in the playlist (or find it there) and make it current.
function setMidiFile(path) {
  if (!path) return;
  let i = tracks.indexOf(path);
  if (i < 0) { tracks.push(path); i = tracks.length - 1; }
  const keepGoing = isPlaying;
  if (isPlaying) { userStopped = true; window.api.send({ cmd: 'stop' }); }
  selectTrack(i, keepGoing);
}

// Natural end of a track -> the next row. Returns true if it took over.
function advanceQueue() {
  if (curIdx < 0) return false;
  let next = curIdx + 1;
  if (next >= tracks.length) {
    if (!els.queueLoop.checked) return false;
    next = 0;                              // loop wraps; a lone track repeats
  }
  selectTrack(next, true);
  return true;
}

els.queueClear.addEventListener('click', () => { tracks = []; curIdx = -1; renderQueue(); });

function selectedTarget() {
  const idx = parseInt(els.targetSelect.value, 10);
  return Number.isNaN(idx) ? null : windows[idx];
}

function sendPlay(startAt, countdown) {
  const path = els.midiPath.value;
  const target = selectedTarget();
  if (!path) { log('error', 'Pick a MIDI file first.'); return; }
  if (!target) { log('error', 'Pick a target window first (Refresh).'); return; }
  window.api.send({
    cmd: 'play',
    midi_path: path,
    target_hwnd: target.hwnd,
    mapping: resolveMappingArg(),
    tempo: parseFloat(els.tempo.value),
    countdown: countdown,
    stats: !!els.stats.checked,
    sustain: !!els.sustain.checked,
    start_at: startAt,
  });
}

function doPlay() {
  if (isPlaying) return;
  userStopped = false;
  // If the user pre-seeked via the scrubber before pressing Play, start
  // playback from that position instead of t=0.
  const preSeek = viz.elapsed();
  sendPlay(preSeek > 0.25 ? preSeek : 0, parseInt(els.countdown.value, 10) || 0);
}

function doStop()  {
  // User stop wins over a pending tempo restart. Always send the stop —
  // even if the UI thinks nothing is playing — so a restart session that
  // was just dispatched gets killed instead of continuing.
  pendingRestartAt = null;
  pendingSeekAfterLoad = null;
  userStopped = true;               // suppresses queue advance in playback_done
  window.api.send({ cmd: 'stop' });
}
function doPause() {
  if (!isPlaying || isPaused) return;
  isPaused = true;
  setPauseButton(true);
  setStatus('paused', 'Paused');
  window.api.send({ cmd: 'pause' });
}
function doResume() {
  if (!isPlaying || !isPaused) return;
  isPaused = false;
  setPauseButton(false);
  setStatus('playing', 'Playing');
  window.api.send({ cmd: 'resume' });
}
function doTogglePause() {
  if (!isPlaying) return;
  isPaused ? doResume() : doPause();
}

// Throttled seek (~30 Hz)
let pendingSeek = null;
let lastSeekSentAt = 0;
function requestSeek(t) {
  pendingSeek = t;
  const now = performance.now();
  if (now - lastSeekSentAt >= 33) flushSeek();
  else if (!flushSeek._scheduled) {
    flushSeek._scheduled = true;
    setTimeout(() => { flushSeek._scheduled = false; flushSeek(); }, 33);
  }
}
function flushSeek() {
  if (pendingSeek === null) return;
  const t = pendingSeek; pendingSeek = null;
  lastSeekSentAt = performance.now();
  window.api.send({ cmd: 'seek', time: t });
}

// --------------------------------------------------------------------------
// Target windows dropdown
// --------------------------------------------------------------------------
function populateWindows() {
  els.targetSelect.innerHTML = '';
  if (!windows.length) {
    const o = document.createElement('option');
    o.value = ''; o.textContent = '— no windows found —';
    els.targetSelect.appendChild(o);
    return;
  }
  let preselect = -1;
  windows.forEach((w, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    const proc = (w.process || '?').padEnd(28).slice(0, 28);
    o.textContent = `${proc} | ${w.title}`;
    els.targetSelect.appendChild(o);
    if (settings.autoPickTarget !== false && settings.targetHint &&
        ((w.process || '') + ' ' + (w.title || ''))
        .toLowerCase()
        .includes(settings.targetHint.toLowerCase())) {
      if (preselect === -1) preselect = i;
    }
  });
  if (preselect >= 0) els.targetSelect.value = String(preselect);
}

// --------------------------------------------------------------------------
// Scrubber — YouTube-style: hover preview, click-to-seek, drag-to-scrub
// --------------------------------------------------------------------------
let isDragging = false;

function scrubberRect() { return els.scrubber.getBoundingClientRect(); }

function clientXToTime(clientX) {
  if (totalDuration <= 0) return 0;
  const r = scrubberRect();
  const pct = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
  return pct * totalDuration;
}

function updateHoverIndicator(clientX, isOverBar) {
  if (totalDuration <= 0) {
    els.scrubHover.style.width = '0%';
    return;
  }
  const r = scrubberRect();
  const pct = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
  if (isOverBar) els.scrubHover.style.width = `${pct * 100}%`;
  const t = pct * totalDuration;
  els.scrubTooltip.textContent = fmtClock(t);
  const tooltipX = Math.max(20, Math.min(r.width - 20, clientX - r.left));
  els.scrubTooltip.style.left = `${tooltipX}px`;
}

els.scrubber.addEventListener('mousemove', (e) => {
  if (isDragging) return;
  updateHoverIndicator(e.clientX, true);
});
els.scrubber.addEventListener('mouseleave', () => {
  if (!isDragging) els.scrubHover.style.width = '0%';
});
els.scrubber.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || totalDuration <= 0) return;
  isDragging = true;
  els.scrubber.classList.add('is-dragging');
  viz.setDragLock(true);              // ignore stale progress packets
  const t = clientXToTime(e.clientX);
  viz.seek(t);
  requestSeek(t);
  e.preventDefault();
});
window.addEventListener('mousemove', (e) => {
  if (!isDragging) return;
  updateHoverIndicator(e.clientX, false);
  const t = clientXToTime(e.clientX);
  viz.seek(t);
  requestSeek(t);
});
window.addEventListener('mouseup', () => {
  if (!isDragging) return;
  isDragging = false;
  els.scrubber.classList.remove('is-dragging');
  if (pendingSeek !== null) flushSeek();
  // Hold the drag lock briefly after release so the engine has time to
  // process the final seek before its progress packets can yank the
  // visualizer back to wherever it was a moment ago.
  setTimeout(() => viz.setDragLock(false), 250);
});

els.scrubber.addEventListener('keydown', (e) => {
  if (totalDuration <= 0) return;
  let next = viz.elapsed();
  if (e.key === 'ArrowLeft')  next -= 5;
  else if (e.key === 'ArrowRight') next += 5;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End')  next = totalDuration;
  else return;
  e.preventDefault();
  next = Math.max(0, Math.min(totalDuration, next));
  viz.setDragLock(true);
  viz.seek(next);
  requestSeek(next);
  setTimeout(() => viz.setDragLock(false), 250);
});

// --------------------------------------------------------------------------
// Drag-and-drop
// --------------------------------------------------------------------------
const dropOverlay = document.getElementById('drop-overlay');
let dragDepth = 0;
function setOverlay(on) { dropOverlay.classList.toggle('active', on); }

window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
  e.preventDefault();
  dragDepth++;
  setOverlay(true);
});
window.addEventListener('dragover', (e) => {
  if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('dragleave', (e) => {
  if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
  e.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) setOverlay(false);
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  setOverlay(false);
  const files = e.dataTransfer && e.dataTransfer.files;
  if (!files || !files.length) return;
  const paths = [];
  for (const f of files) {
    try { paths.push(window.api.getDroppedFilePath(f)); } catch (_) {}
  }
  const midis = paths.filter(p => /\.midi?$/i.test(p));
  const json = paths.find(p => /\.json$/i.test(p));
  if (midis.length) {
    log('info', midis.length === 1 ? `Dropped MIDI: ${midis[0].split(/[\\/]/).pop()}`
                                   : `Dropped ${midis.length} MIDI files`);
    addToQueue(midis);
  } else if (json) {
    settings.customMappingPath = json;
    settings.mapping = '__custom__';
    addCustomMappingOption(json);
    els.mappingSelect.value = '__custom__';
    saveSettings();
    log('info', `Dropped mapping: ${json.split(/[\\/]/).pop()}`);
    loadMidi();
  } else {
    log('warn', 'Drop ignored — only .mid/.midi/.json files are supported.');
  }
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop',     (e) => e.preventDefault());

// --------------------------------------------------------------------------
// Render loop
// --------------------------------------------------------------------------
function frame() {
  viz.render();
  const elapsed = viz.elapsed();

  if (totalDuration > 0) {
    const pct = Math.max(0, Math.min(100, 100 * elapsed / totalDuration));
    els.scrubFill.style.width = pct + '%';
    els.scrubThumb.style.left = pct + '%';
    els.scrubber.setAttribute('aria-valuenow', pct.toFixed(0));
  } else {
    els.scrubFill.style.width = '0%';
    els.scrubThumb.style.left = '0%';
  }
  els.timeElapsed.textContent = fmtClock(elapsed);

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// --------------------------------------------------------------------------
// Boot
// --------------------------------------------------------------------------
// --------------------------------------------------------------------------
// Updater
// --------------------------------------------------------------------------
(async function initUpdater() {
  let version = '?';
  try { version = await window.api.getVersion(); } catch (_) {}
  els.versionBadge.textContent = `v${version}`;

  els.versionBadge.addEventListener('click', () => {
    els.versionBadge.classList.add('checking');
    els.versionBadge.textContent = 'checking…';
    window.api.checkForUpdates({ manual: true });
  });
  els.updateDismiss.addEventListener('click', () => {
    els.updateBanner.classList.remove('show');
  });
  els.updateApply.addEventListener('click', () => {
    els.updateApply.disabled = true;
    els.updateApply.textContent = 'Downloading…';
    window.api.applyUpdate();
  });

  window.api.onUpdateStatus((s) => {
    switch (s.state) {
      case 'checking':
        els.versionBadge.classList.add('checking');
        els.versionBadge.textContent = 'checking…';
        break;
      case 'available':
        els.versionBadge.classList.remove('checking');
        els.versionBadge.classList.add('update');
        els.versionBadge.textContent = `v${version} → v${s.version}`;
        els.updateTitle.textContent = `Update available — v${s.version}`;
        els.updateSub.textContent = s.canSelfUpdate
          ? `You have v${s.current}. Download is ~${Math.round((s.size||0)/1048576)} MB.`
          : `You have v${s.current}. Click to open the download page.`;
        els.updateApply.textContent = s.canSelfUpdate ? 'Update & restart' : 'Open download';
        els.updateApply.disabled = false;
        els.updateProgress.classList.remove('show');
        els.updateBanner.classList.add('show');
        log('info', `Update available: v${s.version} (you have v${s.current}).`);
        break;
      case 'none':
        els.versionBadge.classList.remove('checking');
        els.versionBadge.textContent = `v${version} ✓`;
        setTimeout(() => { els.versionBadge.textContent = `v${version}`; }, 2500);
        log('info', `You're on the latest version (v${s.current}).`);
        break;
      case 'downloading':
        els.updateProgress.classList.add('show');
        els.updateProgressBar.style.width = `${s.percent || 0}%`;
        els.updateApply.textContent = `Downloading ${s.percent || 0}%`;
        break;
      case 'ready':
        els.updateApply.textContent = 'Restarting…';
        log('info', 'Update downloaded — restarting to apply.');
        break;
      case 'error':
        els.versionBadge.classList.remove('checking');
        els.versionBadge.textContent = `v${version}`;
        els.updateApply.disabled = false;
        els.updateApply.textContent = 'Retry';
        log('error', `Update check failed: ${s.message}`);
        break;
    }
  });
})();

initAccordion();
applySettingsToUI();
log('info', 'Booting…');

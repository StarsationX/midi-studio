// Renderer-side glue: wires DOM controls to the Python sidecar via the
// `window.api` bridge. Owns settings persistence, the visualizer's render
// loop, scrubber UX, log routing, accordion sidebar.

const $ = (id) => document.getElementById(id);
const els = {
  // sidebar, source
  midiPath: $('midi-path'),
  midiBrowse: $('midi-browse'),
  queueField: $('queue-field'),
  queueList: $('queue-list'),
  queueCount: $('queue-count'),
  queueClear: $('queue-clear'),
  queueAdd: $('queue-add'),
  queueUndo: $('queue-undo'),
  queueLoop: $('queue-loop'),
  recentField: $('recent-field'),
  recentSelect: $('recent-select'),
  recentClear: $('recent-clear'),
  targetSelect: $('target-select'),
  targetRefresh: $('target-refresh'),
  autoPickTarget: $('auto-pick-target'),
  mappingSelect: $('mapping-select'),
  mappingBrowse: $('mapping-browse'),
  // sidebar, playback
  tempo: $('tempo'),
  tempoLabel: $('tempo-label'),
  tempoBpm: $('tempo-bpm'),
  tempoBpmSrc: $('tempo-bpm-src'),
  tempoBpmReset: $('tempo-bpm-reset'),
  tempoBpmGuess: $('tempo-bpm-guess'),
  transpose: $('transpose'),
  transposeLabel: $('transpose-label'),
  transposeFit: $('transpose-fit'),
  transposeReset: $('transpose-reset'),
  rangeWarning: $('range-warning'),
  countdown: $('countdown'),
  stats: $('stats'),
  sustain: $('sustain'),
  noteColor: $('note-color'),
  noteColorReset: $('note-color-reset'),
  fallSpeed: $('fall-speed'),
  fallSpeedLabel: $('fall-speed-label'),
  // sidebar, hotkeys
  hkPlay: $('hotkey-play'),
  hkStop: $('hotkey-stop'),
  hkPause: $('hotkey-pause'),
  hkTempoUp: $('hotkey-tempo-up'),
  hkTempoDown: $('hotkey-tempo-down'),
  hkTempoSet: $('hotkey-tempo-set'),
  hkSeekFwd: $('hotkey-seek-fwd'),
  hkNext: $('hotkey-next'),
  hkPrev: $('hotkey-prev'),
  hkSeekBack: $('hotkey-seek-back'),
  tempoStep: $('tempo-step'),
  tempoPreset: $('tempo-preset'),
  seekStep: $('seek-step'),
  hkApply: $('hotkey-apply'),
  hkStatus: $('hotkey-status'),
  // header
  headerStatus: $('header-status'),
  statusText: $('status-text'),
  refocusTarget: $('refocus-target'),
  forgeActivity: $('forge-activity'),
  // transport, buttons
  play: $('play'),
  pause: $('pause'),
  stop: $('stop'),
  // transport, times
  timeElapsed: $('time-elapsed'),
  timeTotal: $('time-total'),
  // track info strip
  trackStrip: $('track-strip'),
  trackName: $('track-name'),
  trackMeta: $('track-meta'),
  rangeOverview: $('range-overview'),
  rangeCanvas: $('range-canvas'),
  rangeEmpty: $('range-empty'),
  rangeEnabled: $('range-enabled'),
  rangeStart: $('range-start'),
  rangeEnd: $('range-end'),
  rangeFull: $('range-full'),
  rangeSummary: $('range-summary'),
  rangeLoop: $('range-loop'),
  rampStart: $('ramp-start'),
  rampStep: $('ramp-step'),
  practiceRow: $('practice-row'),
  practiceSummary: $('practice-summary'),
  hand: $('hand'),
  handSplit: $('hand-split'),
  handSplitLabel: $('hand-split-label'),
  chordStagger: $('chord-stagger'),
  playReport: $('play-report'),
  exportSheet: $('export-sheet'),
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
  nextHotkey: '',
  prevHotkey: '',
  seekBackHotkey: '',
  transpose: 0,
  tempoStep: 0.1,
  tempoPreset: 1.0,
  seekStep: 5,
  targetHint: '',
  openSection: 'source',
  noteColor: '',            // '' = per-channel rainbow
  fallSpeed: 1,
  logCollapsed: true,
  mapCollapsed: false,      // song map hidden, roll takes the space
  recentFiles: [],          // most-recent-first list of MIDI paths
  autoPickTarget: true,     // auto-select the remembered target on launch
  playlist: [],
  playlistCurrent: '',
  queueLoop: false,
  hand: 'both',             // both | right | left, split by pitch at handSplit
  handSplit: 60,
  chordStaggerMs: 0,        // roll each chord by N ms per key, lowest first
  rangeLoop: false,         // replay the selection until stopped
  rampStart: 100,           // % of the set tempo the first pass runs at
  rampStep: 5,              // % added per pass until 100
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
// What the note spacing implies, when that disagrees with the file's own
// tempo event. Zero when they agree, or when nothing is loaded.
let bpmEstimate = 0;
let isPlaying = false;
let isPaused = false;
let isFocusLost = false;
let pendingRestartAt = null;   // seconds; set by a live tempo change
let pendingSeekAfterLoad = null; // seconds; pre-seek viz after next midi_loaded
let overviewEvents = [];
// The last midi_loaded, kept whole. The overlay window can be opened at any
// point, including halfway through a song, and the notes it needs were sent
// before it existed; this is what gets replayed to it.
let lastMidiLoaded = null;
// Practice ramp in flight: { target: tempo the user set, pct: current % }.
// Null when not ramping. The slider shows the ramped tempo while it runs and
// goes back to `target` when the loop stops.
let practice = null;
const viz = new Visualizer(els.vizCanvas);

// --------------------------------------------------------------------------
// Logging
// --------------------------------------------------------------------------
function log(level, message) {
  if (level === 'error' && els.logPanel && els.logPanel.classList.contains('is-collapsed')) {
    els.logPanel.classList.remove('is-collapsed');
    settings.logCollapsed = false; saveSettings();
  }
  if (level === 'error' && els.logPanel && els.logPanel.classList.contains('is-collapsed')) {
    els.logPanel.classList.remove('is-collapsed');
    settings.logCollapsed = false; saveSettings();
  }
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
  els.transpose.value = String(settings.transpose | 0);
  els.transposeLabel.textContent = (settings.transpose | 0) > 0 ? `+${settings.transpose | 0}` : String(settings.transpose | 0);
  els.transpose.value = String(settings.transpose | 0);
  els.transposeLabel.textContent = (settings.transpose | 0) > 0 ? `+${settings.transpose | 0}` : String(settings.transpose | 0);
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
  setHotkeyInput(els.hkNext, settings.nextHotkey || '');
  setHotkeyInput(els.hkPrev, settings.prevHotkey || '');
  setHotkeyInput(els.hkSeekBack, settings.seekBackHotkey || '');
  els.tempoStep.value = settings.tempoStep;
  els.tempoPreset.value = settings.tempoPreset;
  els.seekStep.value = settings.seekStep;
  els.autoPickTarget.checked = settings.autoPickTarget !== false;
  els.queueLoop.checked = !!settings.queueLoop;
  els.hand.value = ['both', 'right', 'left'].includes(settings.hand) ? settings.hand : 'both';
  els.handSplit.value = settings.handSplit | 0 || 60;
  showHandSplit();
  els.chordStagger.value = settings.chordStaggerMs | 0;
  els.rangeLoop.checked = !!settings.rangeLoop;
  els.rampStart.value = settings.rampStart | 0 || 100;
  els.rampStep.value = settings.rampStep | 0 || 5;
  showPractice();

  // Open the persisted section
  document.querySelectorAll('.section').forEach((sec) => {
    // 'hotkeys' was renamed to 'settings'; keep old saved state working.
    const open = settings.openSection === 'hotkeys' ? 'settings' : settings.openSection;
    sec.classList.toggle('is-open', sec.dataset.section === open);
  });

  // Log collapse state
  els.logPanel.classList.toggle('is-collapsed', !!settings.logCollapsed);

  // Recent files and the last playlist survive app restarts.
  renderRecents();
  const savedTracks = Array.isArray(settings.playlist)
    ? settings.playlist.filter((p) => typeof p === 'string' && /\.midi?$/i.test(p))
    : [];
  tracks = [...new Map(savedTracks.map((p) => [p.toLowerCase(), p])).values()];
  if (settings.midiPath && !tracks.some((p) => p.toLowerCase() === settings.midiPath.toLowerCase())) {
    tracks.unshift(settings.midiPath);
  }
  const currentPath = settings.playlistCurrent || settings.midiPath || '';
  curIdx = tracks.findIndex((p) => p.toLowerCase() === currentPath.toLowerCase());
  if (curIdx < 0 && tracks.length) curIdx = 0;
  if (curIdx >= 0) {
    lastMidiPath = tracks[curIdx];
    settings.midiPath = lastMidiPath;
    els.midiPath.value = lastMidiPath;
  }
  renderQueue();
  updateTrackStrip();
}

function addCustomMappingOption(p) {
  const existing = [...els.mappingSelect.options].find(o => o.value === '__custom__');
  if (existing) existing.remove();
  const opt = document.createElement('option');
  opt.value = '__custom__';
  opt.textContent = `custom: ${p.split(/[\\/]/).pop()}`;
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
      const previousTarget = selectedTarget();
      windows = evt.windows;
      populateWindows(previousTarget ? previousTarget.hwnd : null);
      break;

    case 'midi_loaded':
      lastMidiLoaded = evt;   // so a later-opened overlay can be handed it
      viz.load(evt.events, evt.note_to_key);
      overviewEvents = evt.events || [];
      totalDuration = evt.duration;
      totalNotes = evt.events.length;
      bpm = evt.bpm;
      bpmEstimate = evt.bpm_estimate || 0;
      showBpm();
      els.vizEmpty.classList.add('is-hidden');
      log('info', `Loaded "${lastMidiPath?.split(/[\\/]/).pop()}": `
        + `${evt.events.length} events, ${evt.duration.toFixed(1)}s, `
        + `~${evt.bpm.toFixed(1)} BPM`);
      if (typeof evt.transpose === 'number' && evt.transpose !== (settings.transpose | 0)) {
        settings.transpose = evt.transpose; showTranspose(); saveSettings();
        log('info', `Auto-transposed ${evt.transpose > 0 ? '+' : ''}${evt.transpose} semitones to fit the mapping.`);
      }
      els.rangeWarning.textContent = evt.unmapped && evt.unmapped.length
        ? `· ${evt.unmapped.length} notes out of range` : '';
      els.rangeWarning.classList.toggle('is-warn', !!(evt.unmapped && evt.unmapped.length));
      if (evt.unmapped && evt.unmapped.length) {
        log('warn',
          `Skipped ${evt.unmapped.length} notes outside the mapping range: `
          + `[${evt.unmapped.join(', ')}]`);
      }
      showMappingNote(evt);
      showReport(evt.report);
      updateTrackStrip();
      els.timeTotal.textContent = fmtClock(totalDuration);
      els.timeElapsed.textContent = fmtClock(0);
      els.scrubFill.style.width = '0%';
      els.scrubThumb.style.left = '0%';
      els.rangeEmpty.hidden = overviewEvents.length > 0;
      normalizePlaybackRange();
      drawRangeOverview();
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
      bpmEstimate = evt.bpm_estimate || 0;
      showBpm();
      viz.startClock(evt.duration, evt.start_elapsed || 0);
      repaintNow();   // swap the idle timer for the frame clock right away
      setStatus('playing', 'Playing');
      els.refocusTarget.hidden = true;
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
      repaintNow();   // one last paint, then the loop settles to the idle rate
      els.play.disabled = false;
      els.pause.disabled = true;
      els.stop.disabled = true;
      setPauseButton(false);
      viz.stopClock();
      // A natural end left the clock parked at the duration, so the next Play
      // seeked to the end and instantly "finished" again. Rewind instead.
      if (pendingRestartAt === null && !userStopped && !evt.crashed) viz.seek(0);
      if (evt.crashed) log('error', 'Player engine stopped unexpectedly. Playback reset.');
      setStatus('idle', 'Idle');
      els.refocusTarget.hidden = true;
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
      if (!userStopped && !evt.crashed && pendingRestartAt === null && typeof evt.sent === 'number') {
        const dropped = evt.total - evt.sent;
        log(dropped > 0 ? 'warn' : 'info',
          `Sent ${evt.sent} / ${evt.total} keys` + (dropped > 0 ? ` (${dropped} not sent)` : ''));
      }
      // A live tempo change stops the session, then resumes here at the
      // same musical position rescaled to the new tempo.
      if (pendingRestartAt !== null) {
        const at = pendingRestartAt;
        pendingRestartAt = null;
        loadMidi();                 // reload events/visualizer at new tempo
        sendPlay(at, 0);            // no countdown on a tempo restart
      } else if (!userStopped && !evt.crashed && els.rangeLoop.checked && playbackRange().enabled) {
        nextPracticePass();         // loop the selection, ramping if asked
      } else if (!userStopped && !evt.crashed) {
        advanceQueue();             // natural end -> next row in the playlist
      }
      if (userStopped || evt.crashed) endPractice();
      userStopped = false;
      renderQueue();                // drop the ▶ marker back to a row number
      break;

    case 'sheet_exported': {
      const p = evt.path;
      navigator.clipboard.writeText(evt.text || '').catch(() => {});
      log('info', `VP sheet saved: ${p} (${evt.notes} notes` + (evt.unmapped ? `, ${evt.unmapped} out of range skipped` : '') + `). Copied to clipboard.`);
      break;
    }

    case 'hotkey':
      if (evt.name === 'play') {
        if (isPlaying && isPaused) doResume();
        else doPlay();
      } else if (evt.name === 'stop') doStop();
      else if (evt.name === 'pause') doTogglePause();
      else if (evt.name === 'tempo_up') nudgeTempo(+(settings.tempoStep || 0.1));
      else if (evt.name === 'tempo_down') nudgeTempo(-(settings.tempoStep || 0.1));
      else if (evt.name === 'tempo_set') setTempo(settings.tempoPreset || 1.0);
      else if (evt.name === 'next_track') skipTrack(1);
      else if (evt.name === 'prev_track') skipTrack(-1);
      else if (evt.name === 'seek_fwd') seekRelative(+(settings.seekStep || 5));
      else if (evt.name === 'seek_back') seekRelative(-(settings.seekStep || 5));
      break;

    case 'error':
      log('error', evt.message);
      break;
  }
});

// ---- Perch toggle ---------------------------------------------------------
(function wirePerch() {
  const btn = document.getElementById('perch-btn');
  if (!btn || !window.api.toggleOverlay) { if (btn) btn.hidden = true; return; }
  const paint = (state) => btn.setAttribute('aria-pressed', String(!!(state && state.open)));
  btn.addEventListener('click', () => window.api.toggleOverlay().then(paint).catch(() => {}));
  // The overlay can also be opened by its global key or closed by its own X,
  // so the button follows the window rather than tracking its own idea of it.
  if (window.api.onOverlayState) window.api.onOverlayState(paint);
  if (window.api.overlayState) window.api.overlayState().then(paint).catch(() => {});
})();

// The overlay asking to be caught up. It missed midi_loaded (and, if it opened
// mid-song, playback_started too), so hand both back and let it resync its
// clock off the next ordinary progress packet.
if (window.api.onOverlayWantsState) {
  window.api.onOverlayWantsState(() => {
    if (lastMidiLoaded) window.api.replayToOverlay(lastMidiLoaded);
    if (isPlaying) {
      window.api.replayToOverlay({ event: 'playback_started', start_elapsed: viz.elapsed() });
    }
  });
}

const activeForgeJobs = new Set();
if (window.forge?.onStatus) {
  window.forge.onStatus((evt) => {
    if (!evt || !evt.event) return;
    if (evt.event === 'forge.progress' && evt.jobId) {
      activeForgeJobs.add(evt.jobId);
      els.forgeActivity.hidden = false;
      els.forgeActivity.title = evt.stage
        ? `Midi-Forge: ${evt.stage}. Playback remains available.`
        : 'Midi-Forge is running. Playback remains available.';
    } else if (evt.event === 'forge.done' && evt.jobId) {
      activeForgeJobs.delete(evt.jobId);
      els.forgeActivity.hidden = activeForgeJobs.size === 0;
      const midiPath = evt.ok && evt.result && evt.result.midiPath;
      if (midiPath) {
        const existed = tracks.some((p) => p.toLowerCase() === midiPath.toLowerCase());
        addToQueue([midiPath]);
        if (!existed) log('info', `Forge finished - added "${midiPath.split(/[\\/]/).pop()}" to the queue.`);
      }
    }
  });
}

function fmtMs(v) { return (v >= 0 ? '+' : '') + v.toFixed(2) + 'ms'; }

function onProgress(evt) {
  if (typeof evt.user_paused === 'boolean' && evt.user_paused !== isPaused) {
    isPaused = evt.user_paused;
    setPauseButton(isPaused);
  }
  isFocusLost = !!evt.focus_lost;
  els.refocusTarget.hidden = !isFocusLost;

  if (!isPlaying) {
    setStatus('idle', 'Idle');
  } else if (isFocusLost) {
    setStatus('blocked', 'Waiting for target');
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

// Icon-only Pause/Resume button, swap glyph + tint instead of label text.
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

// Full-song overview and playback range. The overview is a compact piano roll:
// time runs left-to-right and pitch runs bottom-to-top.
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
  seconds = Math.max(0, Number(seconds) || 0);
  const whole = Math.floor(seconds);
  const fraction = seconds - whole;
  const minutes = Math.floor(whole / 60);
  const secs = whole % 60;
  const tail = fraction >= 0.005 ? (Math.round(fraction * 100) / 100).toString().slice(1) : '';
  return `${minutes}:${String(secs).padStart(2, '0')}${tail}`;
}

function playbackRange() {
  if (!els.rangeEnabled.checked || totalDuration <= 0) return { enabled: false, start: 0, end: totalDuration };
  const rawStart = parseRangeTime(els.rangeStart.value);
  const rawEnd = parseRangeTime(els.rangeEnd.value);
  if (Number.isNaN(rawStart) || Number.isNaN(rawEnd)) return { enabled: true, valid: false, start: 0, end: totalDuration };
  const start = Math.max(0, Math.min(totalDuration, rawStart || 0));
  const end = Math.max(0, Math.min(totalDuration, rawEnd == null ? totalDuration : rawEnd));
  return { enabled: true, valid: end > start, start, end };
}

function normalizePlaybackRange() {
  const range = playbackRange();
  const valid = !range.enabled || range.valid !== false;
  els.rangeStart.disabled = !els.rangeEnabled.checked || totalDuration <= 0;
  els.rangeEnd.disabled = !els.rangeEnabled.checked || totalDuration <= 0;
  els.rangeFull.disabled = totalDuration <= 0 || !els.rangeEnabled.checked;
  els.rangeEnabled.disabled = totalDuration <= 0;
  els.rangeSummary.classList.toggle('is-error', !valid);
  els.rangeSummary.textContent = !valid ? 'Stop must be after start'
    : range.enabled ? `${formatRangeTime(range.start)} to ${formatRangeTime(range.end)} · ${formatRangeTime(range.end - range.start)}`
      : 'Full song';
  return valid;
}

function setPlaybackRange(start, end) {
  if (totalDuration <= 0) return;
  start = Math.max(0, Math.min(totalDuration, start));
  end = Math.max(start + 0.01, Math.min(totalDuration, end));
  els.rangeEnabled.checked = true;
  els.rangeStart.value = formatRangeTime(start);
  els.rangeEnd.value = formatRangeTime(end);
  normalizePlaybackRange();
  drawRangeOverview();
}

function resetPlaybackRange() {
  els.rangeEnabled.checked = false;
  els.rangeStart.value = '0:00';
  els.rangeEnd.value = '';
  normalizePlaybackRange();
  drawRangeOverview();
}

// Wheel-zoom the song overview so a playback range can be set to the beat.
const overviewZoom = window.TimelineZoom
  ? window.TimelineZoom(els.rangeOverview, () => totalDuration, () => drawRangeOverview())
  : { start: () => 0, span: () => totalDuration || 1, zoomed: () => false, follow() {},
      xFor: (t, w) => (t / (totalDuration || 1)) * w, timeAt: (x, w) => (x / w) * (totalDuration || 0) };

function drawRangeOverview() {
  const canvas = els.rangeCanvas;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.round(rect.width * dpr), height = Math.round(rect.height * dpr);
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = rect.width, h = rect.height;
  ctx.fillStyle = '#101115'; ctx.fillRect(0, 0, w, h);
  if (totalDuration <= 0) return;

  ctx.strokeStyle = '#25272d'; ctx.lineWidth = 1;
  const divisions = Math.max(4, Math.min(12, Math.floor(w / 100)));
  for (let i = 1; i < divisions; i++) {
    const x = (i / divisions) * w;
    ctx.beginPath(); ctx.moveTo(x + .5, 0); ctx.lineTo(x + .5, h); ctx.stroke();
  }
  const step = Math.max(1, Math.ceil(overviewEvents.length / 6000));
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#b8e62e';
  ctx.globalAlpha = .68;
  for (let i = 0; i < overviewEvents.length; i += step) {
    const event = overviewEvents[i];
    const x = overviewZoom.xFor(event[0], w);
    const y = h - 5 - ((event[3] - 21) / 87) * (h - 10);
    const noteW = Math.max(1, (Math.max(.03, event[2]) / overviewZoom.span()) * w);
    ctx.fillRect(x, y, Math.min(12, noteW), 1.5);
  }
  ctx.globalAlpha = 1;

  const range = playbackRange();
  if (range.enabled && range.valid !== false) {
    const sx = overviewZoom.xFor(range.start, w), ex = overviewZoom.xFor(range.end, w);
    ctx.fillStyle = 'rgba(0,0,0,.5)'; ctx.fillRect(0, 0, sx, h); ctx.fillRect(ex, 0, w - ex, h);
    ctx.fillStyle = 'rgba(184,230,46,.09)'; ctx.fillRect(sx, 0, Math.max(1, ex - sx), h);
    ctx.strokeStyle = '#b8e62e'; ctx.lineWidth = 2;
    for (const x of [sx, ex]) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); ctx.fillRect(x - 4, 0, 8, 9); ctx.fillRect(x - 4, h - 9, 8, 9); }
  }
  const playhead = Math.max(0, Math.min(totalDuration, viz.elapsed()));
  const px = overviewZoom.xFor(playhead, w);
  ctx.strokeStyle = '#fff'; ctx.globalAlpha = .75; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(px + .5, 0); ctx.lineTo(px + .5, h); ctx.stroke(); ctx.globalAlpha = 1;
}

let rangeDrag = null;
function overviewTime(clientX) {
  const rect = els.rangeOverview.getBoundingClientRect();
  return Math.max(0, Math.min(totalDuration, overviewZoom.timeAt(clientX - rect.left, rect.width)));
}
els.rangeOverview.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || totalDuration <= 0) return;
  const rect = els.rangeOverview.getBoundingClientRect();
  const range = playbackRange();
  const x = e.clientX - rect.left;
  const sx = range.enabled ? overviewZoom.xFor(range.start, rect.width) : -100;
  const ex = range.enabled ? overviewZoom.xFor(range.end, rect.width) : -100;
  rangeDrag = { mode: Math.abs(x - sx) < 10 ? 'start' : Math.abs(x - ex) < 10 ? 'end' : 'select', anchor: overviewTime(e.clientX), x: e.clientX, moved: false };
  els.rangeOverview.setPointerCapture(e.pointerId);
});
els.rangeOverview.addEventListener('pointermove', (e) => {
  if (!rangeDrag) return;
  const t = overviewTime(e.clientX);
  if (Math.abs(e.clientX - rangeDrag.x) > 3) rangeDrag.moved = true;
  const range = playbackRange();
  if (rangeDrag.mode === 'start') setPlaybackRange(Math.min(t, range.end - .01), range.end);
  else if (rangeDrag.mode === 'end') setPlaybackRange(range.start, Math.max(t, range.start + .01));
  else if (rangeDrag.moved) setPlaybackRange(Math.min(rangeDrag.anchor, t), Math.max(rangeDrag.anchor, t));
});
els.rangeOverview.addEventListener('pointerup', (e) => {
  if (!rangeDrag) return;
  if (!rangeDrag.moved && rangeDrag.mode === 'select') {
    const t = overviewTime(e.clientX);
    viz.seek(t); if (isPlaying) requestSeek(t);
  }
  rangeDrag = null;
  drawRangeOverview();
});
els.rangeOverview.addEventListener('pointercancel', () => { rangeDrag = null; });
els.rangeOverview.addEventListener('keydown', (e) => {
  if (totalDuration <= 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
  e.preventDefault();
  let next = viz.elapsed();
  if (e.key === 'ArrowLeft') next -= e.shiftKey ? 10 : 1;
  else if (e.key === 'ArrowRight') next += e.shiftKey ? 10 : 1;
  else if (e.key === 'Home') next = 0;
  else next = totalDuration;
  next = Math.max(0, Math.min(totalDuration, next));
  viz.seek(next); if (isPlaying) requestSeek(next);
  drawRangeOverview();
});
els.rangeEnabled.addEventListener('change', () => {
  if (els.rangeEnabled.checked && !els.rangeEnd.value) els.rangeEnd.value = formatRangeTime(totalDuration);
  normalizePlaybackRange(); drawRangeOverview();
});
[els.rangeStart, els.rangeEnd].forEach((input) => input.addEventListener('input', () => { normalizePlaybackRange(); drawRangeOverview(); }));
els.rangeFull.addEventListener('click', resetPlaybackRange);
new ResizeObserver(drawRangeOverview).observe(els.rangeOverview);

// --------------------------------------------------------------------------
// UI actions
// --------------------------------------------------------------------------
els.midiBrowse.addEventListener('click', async () => {
  const r = await window.api.pickMidi();
  const paths = (Array.isArray(r) ? r : [r]).filter(Boolean);
  if (!paths.length) return;
  setMidiFile(paths[0]);
  addToQueue(paths.slice(1));
});
els.queueAdd.addEventListener('click', async () => {
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
els.refocusTarget.addEventListener('click', () => {
  window.api.send({ cmd: 'refocus' });
});
els.queueLoop.addEventListener('change', () => {
  settings.queueLoop = els.queueLoop.checked;
  saveSettings();
});

let lastWindowRefresh = 0;
els.targetSelect.addEventListener('focus', () => {
  const now = Date.now();
  if (!isPlaying && now - lastWindowRefresh > 2000) {
    lastWindowRefresh = now;
    requestWindows();
  }
});

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

let pendingAutoTranspose = false;

function showTranspose() {
  const t = settings.transpose | 0;
  els.transposeLabel.textContent = t > 0 ? `+${t}` : String(t);
  els.transpose.value = String(t);
}

function applyTranspose(value, auto) {
  const t = Math.max(-24, Math.min(24, Math.round(Number(value) || 0)));
  settings.transpose = t;
  pendingAutoTranspose = !!auto;
  showTranspose();
  saveSettings();
  if (els.midiPath.value) { if (isPlaying) setTempo(parseFloat(els.tempo.value)); else loadMidi(); }
}

els.transpose.addEventListener('input', (e) => { settings.transpose = Math.round(Number(e.target.value) || 0); showTranspose(); });
els.transpose.addEventListener('change', (e) => applyTranspose(e.target.value, false));
els.transposeFit.addEventListener('click', () => applyTranspose(0, true));
els.transposeReset.addEventListener('click', () => applyTranspose(0, false));

els.tempo.addEventListener('input', () => {
  settings.tempo = parseFloat(els.tempo.value);
  els.tempoLabel.textContent = `${settings.tempo.toFixed(2)}×`;
  showBpm();
  saveSettings();
});
// The slider used to call loadMidi() directly, which re-scaled the visualizer
// while the engine kept playing the old timeline. setTempo does the restart.
els.tempo.addEventListener('change', () => {
  setTempo(parseFloat(els.tempo.value));
  // A range input answers arrow keys for as long as it holds focus, so a
  // slider clicked once quietly eats every later keypress meant for the game.
  els.tempo.blur();
});

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

// Options that change which notes exist or when they fire. They go with every
// load/play so the visualizer, the keys sent and the sheet agree.
function playOpts() {
  return {
    hand: settings.hand || 'both',
    hand_split: settings.handSplit | 0 || 60,
    chord_stagger_ms: settings.chordStaggerMs | 0,
  };
}
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function showHandSplit() {
  const n = settings.handSplit | 0 || 60;
  els.handSplitLabel.textContent = `${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 1}`;
  els.handSplit.disabled = (settings.hand || 'both') === 'both';
}
function reloadForOpts() {
  saveSettings();
  if (els.midiPath.value) { if (isPlaying) setTempo(parseFloat(els.tempo.value)); else loadMidi(); }
}
els.hand.addEventListener('change', () => { settings.hand = els.hand.value; showHandSplit(); reloadForOpts(); });
els.handSplit.addEventListener('change', () => {
  settings.handSplit = Math.max(24, Math.min(108, parseInt(els.handSplit.value, 10) || 60));
  els.handSplit.value = settings.handSplit;
  showHandSplit(); reloadForOpts();
});
els.chordStagger.addEventListener('change', () => {
  settings.chordStaggerMs = Math.max(0, Math.min(30, parseInt(els.chordStagger.value, 10) || 0));
  els.chordStagger.value = settings.chordStaggerMs;
  reloadForOpts();
});

// What the target is likely to drop, so the user hears about it before Play
// rather than after. Ghosting starts past ~6 keys on most keyboards.
function showReport(r) {
  if (!els.playReport) return;
  if (!r) { els.playReport.textContent = ''; els.playReport.classList.remove('is-warn'); return; }
  const parts = [];
  if (r.big_chords > 0) parts.push(`${r.big_chords} chord${r.big_chords === 1 ? '' : 's'} over ${r.ghost_limit} keys (widest ${r.max_chord})`);
  if (r.short_notes > 0) parts.push(`${r.short_notes} note${r.short_notes === 1 ? '' : 's'} under 30 ms`);
  const warn = parts.length > 0;
  els.playReport.classList.toggle('is-warn', warn);
  if (!warn) { els.playReport.textContent = `Widest chord: ${r.max_chord} keys. Nothing likely to drop.`; return; }
  const tip = r.big_chords > 0 && !(settings.chordStaggerMs | 0) ? ' Set Chord roll to 5–10 ms if notes go missing.' : '';
  els.playReport.textContent = parts.join(' · ') + '.' + tip;
}

// Practice loop: replay the selection, optionally starting slow and speeding
// up each pass until the tempo the user set.
function showPractice() {
  const on = els.rangeLoop.checked;
  els.practiceRow.classList.toggle('is-off', !on);
  els.rampStart.disabled = !on;
  els.rampStep.disabled = !on;
  if (!on) { els.practiceSummary.textContent = ''; return; }
  const start = settings.rampStart | 0 || 100;
  els.practiceSummary.textContent = practice
    ? `pass at ${practice.pct}%`
    : start < 100 ? `${start}% → 100%` : 'looping';
}
function applyRampTempo() {
  const t = Math.max(0.25, Math.min(3, practice.target * practice.pct / 100));
  els.tempo.value = t;
  settings.tempo = t;
  els.tempoLabel.textContent = `${t.toFixed(2)}×`;
  showBpm();
  showPractice();
}
function startPracticeIfAsked() {
  const start = settings.rampStart | 0 || 100;
  if (!els.rangeLoop.checked || !playbackRange().enabled || start >= 100 || practice) return false;
  practice = { target: parseFloat(els.tempo.value) || 1, pct: start };
  applyRampTempo();
  return true;
}
function nextPracticePass() {
  const range = playbackRange();
  if (practice) {
    const step = settings.rampStep | 0 || 5;
    if (practice.pct < 100) {
      practice.pct = Math.min(100, practice.pct + step);
      applyRampTempo();
      log('info', `Practice pass at ${practice.pct}% (${(settings.tempo).toFixed(2)}×)`);
      loadMidi();                    // rescale the visualizer to the new tempo
    }
  }
  sendPlay(range.start, 0);
}
function endPractice() {
  if (!practice) return;
  const t = practice.target;
  practice = null;
  els.tempo.value = t;
  settings.tempo = t;
  els.tempoLabel.textContent = `${t.toFixed(2)}×`;
  showBpm();
  saveSettings();
  showPractice();
  if (els.midiPath.value) loadMidi();
}
els.rangeLoop.addEventListener('change', () => { settings.rangeLoop = els.rangeLoop.checked; saveSettings(); showPractice(); });
els.rampStart.addEventListener('change', () => {
  settings.rampStart = Math.max(25, Math.min(100, parseInt(els.rampStart.value, 10) || 100));
  els.rampStart.value = settings.rampStart; saveSettings(); showPractice();
});
els.rampStep.addEventListener('change', () => {
  settings.rampStep = Math.max(1, Math.min(50, parseInt(els.rampStep.value, 10) || 5));
  els.rampStep.value = settings.rampStep; saveSettings();
});

els.exportSheet.addEventListener('click', () => {
  const p = els.midiPath.value;
  if (!p) { log('error', 'Load a MIDI first.'); return; }
  window.api.send({
    cmd: 'export_sheet', path: p, mapping: 'virtualpiano',
    transpose: settings.transpose | 0, ...playOpts(),
  });
});

function applyHotkeySettings() {
  const hk = (el) => (el.dataset.hk || '').trim();
  // Empty means unbound, including for these three. They used to spring back
  // to F6/F7/F8, so there was no way to free those keys for the game.
  settings.playHotkey = hk(els.hkPlay);
  settings.stopHotkey = hk(els.hkStop);
  settings.pauseHotkey = hk(els.hkPause);
  settings.tempoUpHotkey = hk(els.hkTempoUp);
  settings.tempoDownHotkey = hk(els.hkTempoDown);
  settings.tempoSetHotkey = hk(els.hkTempoSet);
  settings.seekFwdHotkey = hk(els.hkSeekFwd);
  settings.nextHotkey = hk(els.hkNext);
  settings.prevHotkey = hk(els.hkPrev);
  settings.seekBackHotkey = hk(els.hkSeekBack);
  saveSettings();
  sendHotkeys();
}
els.hkApply.addEventListener('click', applyHotkeySettings);

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
    if (!combo) return;          // modifier-only press, keep listening
    setHotkeyInput(input, combo);
    input.dataset.prev = combo;
    input.blur();
  });
}
const HK_INPUTS = [els.hkPlay, els.hkStop, els.hkPause,
  els.hkTempoUp, els.hkTempoDown, els.hkTempoSet,
  els.hkSeekFwd, els.hkSeekBack, els.hkNext, els.hkPrev];
HK_INPUTS.forEach(initHotkeyCapture);

// A visible way to unbind. Backspace-while-focused already did it, but nothing
// on screen said so, so in practice a key you no longer wanted stayed bound.
HK_INPUTS.forEach((input) => {
  if (!input || input.parentElement.classList.contains('hk-slot')) return;
  const slot = document.createElement('div');
  slot.className = 'hk-slot';
  input.parentElement.insertBefore(slot, input);
  slot.appendChild(input);
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'hk-clear';
  clear.title = 'Unbind';
  clear.setAttribute('aria-label', 'Unbind');
  clear.innerHTML = Icon.svg('close', 10);
  clear.addEventListener('click', () => {
    setHotkeyInput(input, '');
    input.dataset.prev = '';
    applyHotkeySettings();
  });
  slot.appendChild(clear);
  const paint = () => slot.classList.toggle('is-set', !!(input.dataset.hk || ''));
  paint();
  input.addEventListener('blur', paint);
  clear.addEventListener('click', paint);
});

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

// ---- tempo as BPM ------------------------------------------------------
// The slider is a multiplier, which only means something if you already know
// what the file's own tempo is. This is the same setting said as the number
// people actually think in. Neither control is the source of truth; the tempo
// scale is, and both are drawn from it.
function showBpm() {
  if (!els.tempoBpm) return;
  const scale = parseFloat(els.tempo.value) || 1;
  if (!bpm) {
    els.tempoBpm.value = '';
    els.tempoBpm.disabled = true;
    els.tempoBpmSrc.textContent = 'source —';
    return;
  }
  els.tempoBpm.disabled = false;
  // Do not fight the user mid-type: 17 on the way to 174 would be rewritten
  // and the caret would jump.
  if (document.activeElement !== els.tempoBpm) {
    els.tempoBpm.value = Math.round(bpm * scale);
  }
  els.tempoBpmSrc.textContent = `source ${Math.round(bpm)}`;
  // Every transcription this app makes is stamped 120 BPM by the library that
  // writes it, true or not, so "source" is not always trustworthy. Offer what
  // the note spacing suggests rather than overriding the file behind your back.
  const guess = Math.round(bpmEstimate || 0);
  const differs = guess > 0 && Math.abs(guess - Math.round(bpm)) >= 3;
  els.tempoBpmGuess.hidden = !differs;
  if (differs) {
    els.tempoBpmGuess.textContent = `Sounds like ${guess}`;
    els.tempoBpmGuess.title = `The file says ${Math.round(bpm)} BPM, but the gaps `
      + `between notes suggest ${guess}. Use this as the source tempo instead.`;
  }
}

function setBpm(target) {
  const want = Number(target);
  if (!bpm || !Number.isFinite(want) || want <= 0) { showBpm(); return; }
  const min = parseFloat(els.tempo.min), max = parseFloat(els.tempo.max);
  const scale = want / bpm;
  if (scale < min || scale > max) {
    // Say why, rather than silently clamping to a tempo nobody asked for.
    log('warn', `${Math.round(want)} BPM needs a ${scale.toFixed(2)}× tempo, `
      + `outside the ${min}–${max}× range. Clamped.`);
  }
  setTempo(scale);
  showBpm();
}

if (els.tempoBpmGuess) {
  // Taking the guess means treating it as the file's real tempo from here on,
  // so the multiplier stays put and only the reference number moves.
  els.tempoBpmGuess.addEventListener('click', () => {
    if (!bpmEstimate) return;
    log('info', `Source tempo set to ${Math.round(bpmEstimate)} BPM (was ${Math.round(bpm)}).`);
    bpm = bpmEstimate;
    bpmEstimate = 0;
    showBpm();
  });
}

if (els.tempoBpm) {
  els.tempoBpm.addEventListener('change', () => setBpm(els.tempoBpm.value));
  els.tempoBpm.addEventListener('keydown', (e) => { if (e.key === 'Enter') els.tempoBpm.blur(); });
  els.tempoBpm.addEventListener('blur', () => showBpm());
  els.tempoBpmReset.addEventListener('click', () => { setTempo(1); showBpm(); });
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
  showBpm();
  saveSettings();
  log('info', `Tempo → ${t.toFixed(2)}×`);
  if (isPlaying && !isPaused) {
    // Event times are baked at parse time, so restart the session at the
    // equivalent musical position under the new tempo scale.
    pendingRestartAt = viz.elapsed() * prev / t;
    window.api.send({ cmd: 'stop' });
  } else if (isPlaying && isPaused) {
    // Paused: never auto-resume. End the session and pre-seek the scrubber
    // to the equivalent spot, the next Play picks it up from there.
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
// Song map collapse. The roll is what people watch; the map is a tool they
// reach for. Hidden, its height goes to the roll.
const mapToggle = $('map-toggle'), rangeEditor = $('range-editor');
function applyMapCollapsed() {
  const c = !!settings.mapCollapsed;
  rangeEditor.classList.toggle('is-collapsed', c);
  mapToggle.setAttribute('aria-expanded', String(!c));
}
mapToggle.addEventListener('click', () => {
  settings.mapCollapsed = !settings.mapCollapsed;
  saveSettings();
  applyMapCollapsed();
  window.dispatchEvent(new Event('resize'));
});
applyMapCollapsed();

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
    next_track: settings.nextHotkey || '',
    prev_track: settings.prevHotkey || '',
    seek_back: settings.seekBackHotkey || '',
  });
  // Play/Pause/Stop can now be unbound, so they are no longer guaranteed to
  // have a label; printing "Play " with nothing after it reads as a glitch.
  const parts = [];
  const say = (name, combo) => { if (combo) parts.push(`${name} ${hkLabel(combo)}`); };
  say('Play', settings.playHotkey);
  say('Pause', settings.pauseHotkey);
  say('Stop', settings.stopHotkey);
  if (settings.tempoUpHotkey) parts.push(`T+ ${hkLabel(settings.tempoUpHotkey)}`);
  if (settings.tempoDownHotkey) parts.push(`T− ${hkLabel(settings.tempoDownHotkey)}`);
  if (settings.tempoSetHotkey) parts.push(`T= ${hkLabel(settings.tempoSetHotkey)}`);
  if (settings.seekFwdHotkey) parts.push(`→ ${hkLabel(settings.seekFwdHotkey)}`);
  if (settings.seekBackHotkey) parts.push(`← ${hkLabel(settings.seekBackHotkey)}`);
  els.hkStatus.textContent = parts.length
    ? parts.join('   ·   ')
    : 'No hotkeys bound. Use the buttons on screen, or set one above.';
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
    transpose: settings.transpose | 0,
    auto_transpose: !!pendingAutoTranspose,
    ...playOpts(),
  });
  pendingAutoTranspose = false;
  const t = parseFloat(els.tempo.value) || 1;
  if (Math.abs(t - 1) > 0.005) {
    log('info', `Loaded at ${t.toFixed(2)}× tempo (carried over). Reset sets it back to 1.00×.`);
  }
}

// Put a path in the box and hand it to the engine. Playlist bookkeeping lives
// in selectTrack() -- call that (or setMidiFile) rather than this directly.
function loadPath(p) {
  const changedTrack = p !== lastMidiPath;
  els.midiPath.value = p;
  settings.midiPath = p;
  saveSettings();
  if (changedTrack) resetPlaybackRange();
  loadMidi();
}

// Recent files, most-recent-first, de-duplicated, capped.
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
  els.recentSelect.innerHTML = '<option value="">Recent files</option>';
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
// is the current track, and any row can be clicked to jump to it.
let tracks = [], curIdx = -1, userStopped = false, autoPlayNext = false, queueUndo = null;

function persistPlaylist() {
  settings.playlist = tracks.slice(0, 200);
  settings.playlistCurrent = tracks[curIdx] || '';
  saveSettings();
}

function rememberPlaylist() {
  queueUndo = { tracks: tracks.slice(), curPath: tracks[curIdx] || null };
  els.queueUndo.hidden = false;
}

function renderQueue() {
  persistPlaylist();
  els.queueCount.textContent = tracks.length ? `(${tracks.length})` : '';
  els.queueList.innerHTML = '';
  if (!tracks.length) {
    const li = document.createElement('li');
    li.className = 'q-empty';
    li.textContent = 'Empty. Drop or browse .mid files to build a playlist.';
    els.queueList.appendChild(li);
    return;
  }
  tracks.forEach((path, i) => els.queueList.appendChild(queueRow(path, i)));
}

function queueRow(path, i) {
  const li = document.createElement('li');
  const isCurrent = i === curIdx;
  if (isCurrent) li.className = 'is-current';
  li.title = isCurrent ? path : path + '\nClick to load. Use the play button to start.';

  const num = document.createElement('span');
  num.className = 'q-num';
  num.textContent = isCurrent && isPlaying ? '\u25b6' : String(i + 1);

  const n = document.createElement('span');
  n.className = 'qn'; n.textContent = path.split(/[\\/]/).pop();

  const play = document.createElement('button');
  play.className = 'q-action q-play'; play.type = 'button'; play.title = 'Play this song'; play.innerHTML = Icon.svg('play', 10);
  play.addEventListener('click', (e) => { e.stopPropagation(); playTrack(i, true); });

  const up = document.createElement('button');
  up.className = 'q-action'; up.type = 'button'; up.title = 'Move up'; up.textContent = '↑'; up.disabled = i === 0;
  up.addEventListener('click', (e) => { e.stopPropagation(); moveTrack(i, i - 1); });
  const down = document.createElement('button');
  down.className = 'q-action'; down.type = 'button'; down.title = 'Move down'; down.textContent = '↓'; down.disabled = i === tracks.length - 1;
  down.addEventListener('click', (e) => { e.stopPropagation(); moveTrack(i, i + 1); });

  const x = document.createElement('button');
  x.className = 'q-action qx'; x.type = 'button'; x.title = 'Remove'; x.textContent = '\u2715';
  x.disabled = isCurrent && isPlaying;
  if (x.disabled) x.title = 'Stop playback before removing the current song';
  x.addEventListener('click', (e) => { e.stopPropagation(); removeTrack(i); });

  li.append(num, n, play, up, down, x);
  // Click a row to load it; the row's play button is what starts it.
  li.addEventListener('click', () => {
    if (i === curIdx) return;
    if (isPlaying) { userStopped = true; window.api.send({ cmd: 'stop' }); }
    selectTrack(i, false);
  });
  return li;
}

function moveTrack(from, to) {
  if (to < 0 || to >= tracks.length || from === to) return;
  rememberPlaylist();
  const currentPath = tracks[curIdx];
  const [item] = tracks.splice(from, 1);
  tracks.splice(to, 0, item);
  curIdx = currentPath ? tracks.indexOf(currentPath) : -1;
  renderQueue();
}

// Load a track. Plays it too when `andPlay`, once 'midi_loaded' comes back.
// Move through the playlist without touching the mouse, the whole point is
// not having to leave the game window.
function skipTrack(direction) {
  const list = settings.playlist || [];
  if (!list.length) return;
  const from = curIdx >= 0 ? curIdx : 0;
  playTrack((from + direction + list.length) % list.length, isPlaying);
}

function selectTrack(i, andPlay) {
  if (i < 0 || i >= tracks.length) return;
  curIdx = i;
  autoPlayNext = !!andPlay;
  loadPath(tracks[i]);
  renderQueue();
}

// Clicking a row: jump to it, and keep playing if we already were.
function playTrack(i, forcePlay = false) {
  if (i === curIdx && !isPlaying && totalDuration > 0) { doPlay(); return; }
  const keepGoing = isPlaying;
  if (isPlaying) { userStopped = true; window.api.send({ cmd: 'stop' }); }
  selectTrack(i, forcePlay || keepGoing);
}

function removeTrack(i) {
  rememberPlaylist();
  const removingCurrent = i === curIdx;
  tracks.splice(i, 1);
  if (removingCurrent) {
    if (tracks.length) {
      selectTrack(Math.min(i, tracks.length - 1), false);
      return;
    }
    curIdx = -1;
    lastMidiPath = null;
    totalDuration = 0;
    totalNotes = 0;
    overviewEvents = [];
    settings.midiPath = '';
    els.midiPath.value = '';
    els.vizEmpty.classList.remove('is-hidden');
    els.timeElapsed.textContent = fmtClock(0);
    els.timeTotal.textContent = fmtClock(0);
    resetPlaybackRange();
    updateTrackStrip();
  } else if (i < curIdx) curIdx--;
  renderQueue();
}

// Append files; load the first new one if nothing is loaded / playing.
function addToQueue(paths) {
  const known = new Set(tracks.map((p) => p.toLowerCase()));
  const ps = (paths || []).filter(p => p && /\.midi?$/i.test(p) && !known.has(p.toLowerCase()) && known.add(p.toLowerCase()));
  if (!ps.length) return;
  rememberPlaylist();
  const first = tracks.length;
  tracks.push(...ps);
  renderQueue();
  if (!isPlaying && curIdx < 0) selectTrack(first, false);
}

// Public entry for browse / recents / library / the Forge hand-off: put the file
// in the playlist (or find it there) and make it current.
// The 36-key layout has no black keys, so every sharp lands on the white key
// below it: mapped, so never "out of range", and wrong. A first-timer hears a
// sour song and blames the transcription. Say what happened and where the
// other layout is.
function showMappingNote(evt) {
  const el = document.getElementById('mapping-note');
  if (!el) return;
  const n = evt && evt.collapsed_sharps | 0;
  if (n > 0) {
    el.textContent = `${n} black-key notes will play as the white key below. `
      + `If your piano takes Shift for sharps, pick roblox61.`;
    el.classList.add('is-warn');
    log('warn', `${n} sharps/flats have no key in this layout and will play a semitone low. `
      + `Mapping → roblox61 if your game supports Shift.`);
  } else {
    el.textContent = (evt && evt.mapping_description) || '';
    el.classList.remove('is-warn');
  }
}

function setMidiFile(path, andPlay = false) {
  if (!path) return;
  let i = tracks.indexOf(path);
  if (i < 0) { tracks.push(path); i = tracks.length - 1; }
  // Loading is not playing. Starting the engine also focuses the game window,
  // so it only happens when the user asks: the Play button, a row's play
  // button, a hotkey, or the natural end of the previous track.
  if (isPlaying) { userStopped = true; window.api.send({ cmd: 'stop' }); }
  selectTrack(i, andPlay);
  if (!andPlay) log('info', 'Loaded ' + path.split(/[\/]/).pop() + ". Press Play when you're ready.");
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

els.queueClear.addEventListener('click', () => {
  if (!tracks.length) return;
  rememberPlaylist();
  const current = tracks[curIdx];
  tracks = current ? [current] : [];
  curIdx = current ? 0 : -1;
  renderQueue();
});
els.queueUndo.addEventListener('click', () => {
  if (!queueUndo) return;
  const now = { tracks: tracks.slice(), curPath: tracks[curIdx] || null };
  tracks = queueUndo.tracks.slice();
  curIdx = queueUndo.curPath ? tracks.indexOf(queueUndo.curPath) : -1;
  queueUndo = now;
  if (curIdx >= 0 && tracks[curIdx] !== lastMidiPath) selectTrack(curIdx, false);
  else renderQueue();
});

function selectedTarget() {
  const idx = parseInt(els.targetSelect.value, 10);
  return Number.isNaN(idx) ? null : windows[idx];
}

function sendPlay(startAt, countdown) {
  const path = els.midiPath.value;
  const target = selectedTarget();
  if (!path) { log('error', 'Pick a MIDI file first.'); return; }
  if (!target) { log('error', 'Pick a target window first (Refresh).'); return; }
  const range = playbackRange();
  if (range.enabled && range.valid === false) { log('error', 'Playback range: stop must be after start.'); return; }
  if (range.enabled && (startAt < range.start || startAt >= range.end)) startAt = range.start;
  window.api.send({
    cmd: 'play',
    midi_path: path,
    target_hwnd: target.hwnd,
    mapping: resolveMappingArg(),
    tempo: parseFloat(els.tempo.value),
    transpose: settings.transpose | 0,
    countdown: countdown,
    stats: !!els.stats.checked,
    sustain: !!els.sustain.checked,
    start_at: startAt,
    end_at: range.enabled ? range.end : null,
    ...playOpts(),
  });
}

function doPlay() {
  if (isPlaying) return;
  userStopped = false;
  // If the user pre-seeked via the scrubber before pressing Play, start
  // playback from that position instead of t=0.
  const range = playbackRange();
  let preSeek = viz.elapsed();
  if (range.enabled && range.valid !== false && (preSeek < range.start || preSeek >= range.end)) preSeek = range.start;
  if (startPracticeIfAsked()) {
    log('info', `Practice: ${practice.pct}% → 100%, +${settings.rampStep | 0 || 5}% per pass.`);
    loadMidi();                      // the engine parses again on play; this is for the visualizer
    preSeek = range.start;
  }
  sendPlay(preSeek > 0.25 ? preSeek : 0, parseInt(els.countdown.value, 10) || 0);
}

function doStop()  {
  // User stop wins over a pending tempo restart. Always send the stop,
  // even if the UI thinks nothing is playing, so a restart session that
  // was just dispatched gets killed instead of continuing.
  pendingRestartAt = null;
  pendingSeekAfterLoad = null;
  userStopped = true;               // suppresses queue advance in playback_done
  window.api.send({ cmd: 'stop' });
  endPractice();
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
function populateWindows(previousHwnd = null) {
  els.targetSelect.innerHTML = '';
  if (!windows.length) {
    const o = document.createElement('option');
    o.value = ''; o.textContent = 'No windows found';
    els.targetSelect.appendChild(o);
    return;
  }
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Choose a target window...';
  els.targetSelect.appendChild(placeholder);
  let preselect = -1;
  let bestScore = 0;
  windows.forEach((w, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    const proc = (w.process || '?').padEnd(28).slice(0, 28);
    o.textContent = `${proc} | ${w.title}`;
    els.targetSelect.appendChild(o);
    const haystack = `${w.process || ''} ${w.title || ''}`.toLowerCase();
    let score = 0;
    if (previousHwnd && Number(previousHwnd) === Number(w.hwnd)) score = 200;
    else if (settings.autoPickTarget !== false && settings.targetHint && haystack.includes(settings.targetHint.toLowerCase())) score = 100;
    else if (settings.autoPickTarget !== false && /robloxplayerbeta|virtual.?piano/.test(haystack)) score = 50;
    else if (settings.autoPickTarget !== false && /\broblox\b|\bpiano\b/.test(haystack)) score = 25;
    if (score > bestScore) { bestScore = score; preselect = i; }
  });
  if (preselect >= 0) els.targetSelect.value = String(preselect);
}

// --------------------------------------------------------------------------
// Scrubber. YouTube-style: hover preview, click-to-seek, drag-to-scrub
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
    log('warn', 'Drop ignored. Only .mid/.midi/.json files are supported.');
  }
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop',     (e) => e.preventDefault());

// --------------------------------------------------------------------------
// Render loop
// --------------------------------------------------------------------------
let lastOverviewFrame = 0;
let lastFrame = 0;

// How long to wait between repaints. This loop used to redraw as fast as the
// platform would allow (measured at ~500/sec, because backgroundThrottling is
// off so playback survives alt-tab, which also removes the vsync cap) and it
// did it even with no MIDI loaded and the tab hidden. Nothing here is needed
// when nothing is moving: the engine that plays notes is the Python side, this
// only draws. Idle still repaints a few times a second, so anything that
// changes without telling us self-heals instead of leaving a stale canvas.
function drawBudgetMs() {
  const root = document.documentElement;
  if (document.hidden) return Infinity;              // window minimised
  if (root.dataset.onscreen === '0') return Infinity; // another tab is showing
  const base = Number(root.dataset.drawms) || 16;
  if (!isPlaying) return 250;                        // idle: 4/sec is plenty
  // While notes are moving, this canvas IS the thing being watched, so it gets
  // at least 30fps whatever the allowance says. The perf budget and the "a game
  // is running" multiplier used to compound with an unfocused penalty on top,
  // landing at 5fps: the roll teleported from note to note instead of scrolling.
  // Playing into a game also means this window is normally NOT the focused one,
  // so unfocused is the usual case here, not a reason to go choppy.
  return Math.min(base, 33);
}
// Two id spaces, tracked separately: a rAF handle and a timeout handle can
// collide numerically, so clearTimeout(rafHandle) could cancel someone else's
// timer.
let rafId = 0, timerId = 0;
function cancelPending() {
  if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  if (timerId) { clearTimeout(timerId); timerId = 0; }
}
// Draw at the next opportunity. Also how playback starts the frame clock, so
// pressing Play does not wait out an idle timer first.
function repaintNow() {
  lastFrame = 0;
  cancelPending();
  rafId = requestAnimationFrame(frame);
}
window.addEventListener('midi-studio:onscreen', repaintNow);
window.addEventListener('focus', repaintNow);
document.addEventListener('visibilitychange', () => { if (!document.hidden) repaintNow(); });

function frame(now) {
  rafId = 0; timerId = 0;
  const budget = drawBudgetMs();
  // Nothing to draw for (hidden window, or another tab is showing): stop the
  // loop outright rather than waking 500 times a second to do nothing.
  // repaintNow() starts it again when this tab comes back.
  if (budget === Infinity) return;
  // While playing, ride the frame clock. While idle, a timer at the budget
  // interval instead: rAF here runs ~500/sec (no vsync cap, see above), and
  // waking the thread that often to decide not to draw is the whole cost on a
  // slow machine. Four wakeups a second is enough to keep the canvas honest.
  if (isPlaying) rafId = requestAnimationFrame(frame);
  else timerId = setTimeout(() => frame(performance.now()), budget);
  if (now - lastFrame < budget) return;
  lastFrame = now;
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

  if (now - lastOverviewFrame >= 80) {
    lastOverviewFrame = now;
    drawRangeOverview();
  }
}
rafId = requestAnimationFrame(frame);

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
        els.updateTitle.textContent = `Update available: v${s.version}`;
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
        log('info', 'Update downloaded. Restarting to apply.');
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

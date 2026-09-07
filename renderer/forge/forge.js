// forge.js — the Forge tab controller.
//
// Three columns (input rail / canvas / results), one Draw consumer per canvas,
// VList for the queue, the log and the results, Bus for every hand-off, and the
// engine itself driven through the unchanged window.forge IPC surface.
//
// Load-bearing rules this file must not break (CONTRACT §10, SYNTHESIS
// invariants 8, 9, 13, 27, 28):
//   * collectAdvanced() writes ALL 23 keys every time. Settings are deep-merged
//     in main, so an omitted key silently keeps its old on-disk value. '' means
//     "engine default" and the runner drops it before building the env.
//   * LEGACY_DEFAULTS are treated as unset on restore.
//   * The env verdict is painted from the localStorage cache SYNCHRONOUSLY,
//     because probing imports torch and takes tens of seconds.
//   * No bare rAF: everything paints through Draw.
//   * Peaks are bucketed in time-sliced chunks, never in one main-thread scan.
(() => {
  'use strict';

  const F = window.forge || {};
  const S = window.studio || {};
  const Bus = window.Bus;
  const T = (Bus && Bus.TYPES) || {};
  const Fmt = window.Fmt;
  const Tokens = window.Tokens;
  const Draw = window.Draw;
  const FRAME = 'forge';

  const $ = (id) => document.getElementById(id);
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const lower = (s) => String(s || '').toLowerCase();

  // ---- §9.6 coalesce / debounce -------------------------------------------
  function coalesce(fn) {
    let armed = false, args = null;
    return (...a) => {
      args = a;
      if (armed) return;
      armed = true;
      requestAnimationFrame(() => { armed = false; fn(...args); });
    };
  }
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

  // ---- teardown registry --------------------------------------------------
  const disposers = [];
  function on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    disposers.push(() => { try { target.removeEventListener(type, fn, opts); } catch (_) {} });
    return fn;
  }
  function every(ms, fn) {
    const id = setInterval(fn, ms);
    disposers.push(() => clearInterval(id));
    return id;
  }
  function keep(fn) { if (typeof fn === 'function') disposers.push(fn); return fn; }
  // A one-shot timer that takes its own disposer OUT of the registry when it
  // fires. `disposers` is only drained on teardown, so one clear-timeout closure
  // per stage completion, per result row and per hand-off flash grew an
  // unbounded array of dead closures for the whole life of the panel.
  function later(ms, fn) {
    let id = 0;
    const stop = () => { if (id) { clearTimeout(id); id = 0; } };
    id = setTimeout(() => {
      id = 0;
      const i = disposers.indexOf(stop);
      if (i >= 0) disposers.splice(i, 1);
      fn();
    }, ms);
    disposers.push(stop);
    return stop;
  }

  // =========================================================================
  // CONSTANTS
  // =========================================================================
  const AUDIO_EXT = /\.(mp3|wav|flac|m4a|ogg|opus|aac|wma|webm|mp4|aiff?|alac)$/i;
  const MIDI_EXT = /\.midi?$/i;

  const ADV_KEYS = ['USE_TTA', 'LOUDNESS_NORM', 'BIGSHIFTS', 'SEGMENT_HOP', 'VELOCITY_GAMMA',
    'MIN_NOTE_SEC', 'MIN_VELOCITY', 'PIANO_MIN_PITCH', 'PIANO_MAX_PITCH',
    'BP_ONSET_THRESHOLD', 'BP_FRAME_THRESHOLD', 'BP_MIN_NOTE_MS',
    'MAX_POLYPHONY', 'OCTAVE_FOLD', 'EXCLUDE_VOCALS', 'ONSET_DELTA', 'DRUM_MIN_GAP_MS',
    'MELODY_MIN_PITCH', 'MELODY_MAX_PITCH', 'MELODY_ONSET_THRESHOLD', 'MELODY_MIN_NOTE_MS',
    'MELODY_DENSITY', 'MELODY_FOLD'];
  const ADV_DEFAULTS = {
    USE_TTA: false, LOUDNESS_NORM: true, BIGSHIFTS: 1, SEGMENT_HOP: '',
    VELOCITY_GAMMA: 0.85, MIN_NOTE_SEC: 0.03, MIN_VELOCITY: 20,
    PIANO_MIN_PITCH: 21, PIANO_MAX_PITCH: 108, BP_ONSET_THRESHOLD: 0.5,
    BP_FRAME_THRESHOLD: 0.3, BP_MIN_NOTE_MS: 120, MAX_POLYPHONY: 0,
    OCTAVE_FOLD: true, EXCLUDE_VOCALS: false, ONSET_DELTA: 0.07,
    DRUM_MIN_GAP_MS: 50, MELODY_MIN_PITCH: 45, MELODY_MAX_PITCH: 100,
    MELODY_ONSET_THRESHOLD: 0.42, MELODY_MIN_NOTE_MS: 30,
    MELODY_DENSITY: 13, MELODY_FOLD: true,
  };
  // Values a past release persisted as if the user had chosen them. Treat them
  // exactly like an empty field (invariant 8).
  const LEGACY_DEFAULTS = { MIN_NOTE_SEC: '0.05', MELODY_MIN_NOTE_MS: '45' };

  const QUALITY = {
    balanced: { USE_TTA: false, BIGSHIFTS: 1, SEGMENT_HOP: '', MIN_NOTE_SEC: 0.03,
      MIN_VELOCITY: 20, MELODY_MIN_NOTE_MS: 30, MELODY_DENSITY: 13 },
    best: { USE_TTA: true, BIGSHIFTS: 3, SEGMENT_HOP: 4, MIN_NOTE_SEC: 0.02,
      MIN_VELOCITY: 12, MELODY_MIN_NOTE_MS: 22, MELODY_DENSITY: 22 },
  };
  const QUALITY_HINT = {
    balanced: 'One separation pass, default overlap.',
    best: 'Extra separation pass, double overlap, lower cutoffs. Three to five times slower.',
    custom: 'Your own Advanced Options values.',
  };

  const PIPELINES = ['piano', 'melody', 'general', 'drums', 'fast'];
  const PIPELINE_LABEL = { piano: 'Piano', melody: 'Melody', general: 'Full Song', drums: 'Drums', fast: 'Fast' };
  const PIPELINE_HINT = {
    melody: 'Prototype. Isolates the lead, removes octave doubles and caps notes per second so the result stays playable. Try Piano or Full Song if it disappoints.',
    piano: 'Separate the stems, then Transkun on the piano stem. The highest accuracy on a piano performance.',
    general: 'Separate, mix every pitched stem, then Transkun. Any genre, full mix.',
    fast: 'basic-pitch straight on the audio. Seconds instead of minutes, and rougher.',
    drums: 'Separate, then classify every hit onto the eight-pad kit: kick, snare, both hats, three toms, crash and ride.',
  };
  const STEMS_HINT = {
    separate: 'Split the mix into stems first. Slower, and much cleaner on a full song.',
    skip: 'The input is already an isolated stem, so separation is skipped.',
  };

  const STAGE_ORDER = ['load', 'separate', 'transcribe', 'midi', 'optimize', 'finalize', 'done'];
  // The pipeline's own vocabulary (forge-runner STAGES_2/3/4 + the keyword
  // fallback), mapped onto the seven-stage checklist.
  const STAGE_OF = {
    'queued': 'load', 'download': 'load', 'starting': 'load',
    'separate': 'separate', 'separating': 'separate', 'isolate lead': 'separate',
    'transcribe': 'transcribe', 'transcribing': 'transcribe', 'detect melody': 'transcribe',
    'build candidates': 'midi',
    'clean': 'optimize', 'cleaning': 'optimize',
    'prepare review': 'finalize',
    'done': 'done',
  };

  const ENV_CACHE_KEY = 'midi-forge.env.v1';
  const QUEUE_KEY = 'midi-forge.queue.v1';
  const PREVIEW_KEY = 'midi-forge.preview-prefs.v1';
  const RESULTS_KEY = 'midi-forge.results.v1';

  const BUCKETS = 4096;
  const PEAK_RATE = 11025;      // decodeAudioData resamples to the context rate

  // =========================================================================
  // STATE
  // =========================================================================
  let envReady = false, envGpu = '', envMissing = [];
  let busy = false, jobPaused = false, currentJob = null, pendingCancel = false;
  let inputPath = '', pipeline = 'melody', outputDir = '', currentProject = '';
  let activeState = 'ready', skipRequested = false, autoAdvancing = false;
  let cpuNoticeShown = false;
  let queue = [], runningQueue = false, queueUndo = null;
  let lastStage = '', jobStartedAt = 0, jobPercent = null, jobPctSeenAt = 0, jobName = '';
  let previewPrefs = { audioVolume: 80 };
  let waveToken = 0, waveDuration = 0, wavePeaks = null, waveDeferred = '', waveFailed = false;
  let sliceTimer = 0;
  let timeEnabled = false;
  let resultTab = 'results';
  let selected = null;
  let waveCollapsed = false, railCollapsed = false, inspCollapsed = false;
  let uiColumns = {};

  try { previewPrefs = Object.assign(previewPrefs, JSON.parse(localStorage.getItem(PREVIEW_KEY) || '{}')); } catch (_) {}

  // =========================================================================
  // LOG  (ring buffer + VList; every line also reaches the shell's drawer)
  // =========================================================================
  const LOG_CAP = 600;
  const logLines = [];
  let logList = null;
  const logCount = $('log-count');

  const paintLogCount = () => { const n = String(logLines.length); if (logCount.textContent !== n) logCount.textContent = n; };
  const refreshLog = coalesce(() => {
    if (!logList) return;
    const atEnd = logList.host.scrollTop + logList.host.clientHeight >= logList.host.scrollHeight - 24;
    logList.setItems(logLines.slice());
    if (atEnd) logList.host.scrollTop = logList.host.scrollHeight;
    paintLogCount();
  });

  function levelOf(text) {
    if (/^\s*(✖|error|failed|traceback)/i.test(text) || /\berror\b/i.test(text)) return 'error';
    if (/\bwarn/i.test(text)) return 'warn';
    if (/^\s*(✓|done|finished)/i.test(text)) return 'ok';
    return 'info';
  }

  // Locally generated lines go to the shell's log drawer too. The pipeline's own
  // forge.log stream already reaches the shell over IPC, so it must NOT be
  // forwarded a second time (CONTRACT §11.6: pick one channel per event).
  function logLine(text, opts) {
    const t = String(text == null ? '' : text).replace(/\s+$/, '');
    if (!t) return;
    const level = (opts && opts.level) || levelOf(t);
    logLines.push({ text: t, level });
    if (logLines.length > LOG_CAP) logLines.splice(0, logLines.length - LOG_CAP);
    refreshLog();
    if (!(opts && opts.localOnly) && Bus) {
      Bus.send(T.UI_STATUS, { frame: FRAME, text: t, severity: level === 'error' ? 'err' : level === 'ok' ? 'ok' : level === 'warn' ? 'warn' : 'info' });
    }
  }
  const logQuiet = (t) => logLine(t, { localOnly: true });

  // =========================================================================
  // TABS  (roving tabindex, arrow keys with wrap)
  // =========================================================================
  function tabGroup(strip, pairs, onChange) {
    const btns = pairs.map((p) => $(p[0]));
    const select = (idx, focus) => {
      pairs.forEach((p, i) => {
        const on = i === idx;
        btns[i].setAttribute('aria-selected', on ? 'true' : 'false');
        btns[i].tabIndex = on ? 0 : -1;
        const panel = p[1] ? $(p[1]) : null;
        if (panel && !pairs.some((q, j) => j !== i && q[1] === p[1])) panel.hidden = !on;
      });
      if (focus) btns[idx].focus();
      if (onChange) onChange(pairs[idx][0], idx);
    };
    on(strip, 'click', (e) => {
      const b = e.target.closest('button[role="tab"]');
      if (!b) return;
      const i = btns.indexOf(b);
      if (i >= 0) select(i, false);
    });
    on(strip, 'keydown', (e) => {
      const cur = btns.findIndex((b) => b.getAttribute('aria-selected') === 'true');
      if (cur < 0) return;
      let next = -1;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (cur + 1) % btns.length;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (cur + btns.length - 1) % btns.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = btns.length - 1;
      if (next < 0) return;
      e.preventDefault();
      select(next, true);
    });
    return { select };
  }

  // A VList measures its host; one that was filled while its panel was hidden has
  // nothing laid out, so every tab that reveals a list has to repaint it.
  const railTabs = tabGroup($('rail-tabs'),
    [['tab-input', 'tp-input'], ['tab-queue', 'tp-queue'], ['tab-settings', 'tp-adv']],
    (id) => { if (id === 'tab-queue' && queueList) queueList.paintNow(); });
  const progTabs = tabGroup($('prog-panel').querySelector('.tabstrip'),
    [['tab-progress', 'tp-progress'], ['tab-log', 'tp-log']],
    (id) => { if (id === 'tab-log' && logList) { refreshLog(); logList.paintNow(); } });
  const resTabs = tabGroup($('insp').querySelectorAll('.tabstrip')[0],
    [['tab-results', 'tp-results'], ['tab-history', 'tp-results']], (id) => {
      resultTab = id === 'tab-history' ? 'history' : 'results';
      renderResults();
    });

  // =========================================================================
  // COLUMN COLLAPSE
  // =========================================================================
  const persistColumns = debounce(() => {
    if (S.setUi) S.setUi({ forgeColumns: { rail: railCollapsed, insp: inspCollapsed, wave: waveCollapsed } });
  }, 400);

  function applyColumns() {
    $('rail').classList.toggle('is-collapsed', railCollapsed);
    $('insp').classList.toggle('is-collapsed', inspCollapsed);
    $('fg').dataset.rail = railCollapsed ? 'off' : 'on';
    $('fg').dataset.insp = inspCollapsed ? 'off' : 'on';
    $('rail-collapse').setAttribute('aria-expanded', railCollapsed ? 'false' : 'true');
    $('rail-collapse').setAttribute('aria-label', railCollapsed ? 'Expand the input column' : 'Collapse the input column');
    $('insp-collapse').setAttribute('aria-expanded', inspCollapsed ? 'false' : 'true');
    $('insp-collapse').setAttribute('aria-label', inspCollapsed ? 'Expand the results column' : 'Collapse the results column');
    $('wave-panel').classList.toggle('is-collapsed', waveCollapsed);
    $('wave-collapse').setAttribute('aria-expanded', waveCollapsed ? 'false' : 'true');
    $('wave-collapse').setAttribute('aria-label', waveCollapsed ? 'Expand the waveform' : 'Collapse the waveform');
    if (!inspCollapsed && resList) resList.paintNow();
    if (!railCollapsed && queueList && $('tp-queue').hidden === false) queueList.paintNow();
  }

  on($('rail-collapse'), 'click', () => { railCollapsed = !railCollapsed; applyColumns(); persistColumns(); });
  on($('insp-collapse'), 'click', () => { inspCollapsed = !inspCollapsed; applyColumns(); persistColumns(); });
  on($('wave-collapse'), 'click', () => {
    waveCollapsed = !waveCollapsed;
    applyColumns();
    persistColumns();
    // Expanding a collapsed preview is exactly when the skipped peaks are wanted.
    if (!waveCollapsed && waveDeferred) loadWaveform(waveDeferred, true);
    else if (!waveCollapsed) waveHandle.invalidate();
  });

  // =========================================================================
  // ADVANCED OPTIONS  (23 keys; switches carry booleans in aria-checked)
  // =========================================================================
  const advEl = (k) => $(k);
  const isSwitch = (el) => el && el.getAttribute('role') === 'switch';
  const readAdv = (el) => (isSwitch(el) ? el.getAttribute('aria-checked') === 'true' : el.value);
  function writeAdv(el, v) {
    if (!el) return;
    if (isSwitch(el)) el.setAttribute('aria-checked', v ? 'true' : 'false');
    else el.value = v == null ? '' : v;
  }

  // Every key, always: settings are deep-merged in main, so a key left out is a
  // key left as it was (invariant 8).
  function collectAdvanced() {
    const a = {};
    for (const k of ADV_KEYS) {
      const el = advEl(k);
      if (!el) continue;
      a[k] = readAdv(el);
    }
    return a;
  }
  function restoreAdvanced(saved) {
    for (const [k, v] of Object.entries(saved || {})) {
      const el = advEl(k);
      if (!el) continue;
      if (isSwitch(el)) { writeAdv(el, !!v); continue; }
      const stale = v == null || v === '' || String(v) === LEGACY_DEFAULTS[k];
      writeAdv(el, stale ? (k in ADV_DEFAULTS && ADV_DEFAULTS[k] !== '' ? ADV_DEFAULTS[k] : '') : v);
    }
  }

  // One trailing IPC write, but the patches MERGE: a debounce that keeps only
  // the last call would drop the pipeline change made 100ms before a timing one.
  let settingsPatch = null;
  const flushSettings = debounce(() => {
    const p = settingsPatch;
    settingsPatch = null;
    if (p && F.setSettings) F.setSettings(p);
  }, 300);
  function persistSettings(patch) {
    settingsPatch = Object.assign(settingsPatch || {}, patch || {});
    flushSettings();
  }
  const persistAdvanced = () => persistSettings({ advanced: collectAdvanced() });

  function detectQuality() {
    for (const [name, preset] of Object.entries(QUALITY)) {
      const same = Object.entries(preset).every(([k, v]) => {
        const el = advEl(k);
        if (!el) return true;
        return isSwitch(el) ? readAdv(el) === !!v : String(el.value) === String(v);
      });
      if (same) return name;
    }
    return 'custom';
  }
  function applyQuality(name) {
    const preset = QUALITY[name];
    if (!preset) return;
    for (const [k, v] of Object.entries(preset)) writeAdv(advEl(k), v);
  }
  // The brief: any manual edit inside Advanced Options flips Quality to Custom.
  // detectQuality() alone cannot express that — it only knows the seven fields a
  // preset writes, so editing, say, Ignore vocals would leave the card claiming
  // "Balanced" for a configuration the preset never produced.
  let qualityOverride = null;

  function syncQuality() {
    const q = $('quality');
    const name = qualityOverride || detectQuality();
    q.querySelector('option[value="custom"]').hidden = name !== 'custom';
    q.value = name;
    $('quality-hint').textContent = QUALITY_HINT[name] || '';
    q.closest('.fg-card').classList.toggle('is-custom', name === 'custom');
  }

  on($('quality'), 'change', () => {
    const name = $('quality').value;
    if (name === 'custom') { syncQuality(); return; }
    qualityOverride = null;
    applyQuality(name);
    syncQuality();
    persistAdvanced();
    logQuiet('Quality: ' + name + '. ' + QUALITY_HINT[name]);
  });

  // Any manual edit inside Advanced flips Quality to Custom.
  on($('adv'), 'change', () => { qualityOverride = 'custom'; syncQuality(); persistAdvanced(); });
  on($('adv'), 'click', (e) => {
    // The label is part of the control: a .switch-row is one hit target.
    const row = e.target.closest('.switch-row');
    const sw = e.target.closest('.switch') || (row && row.querySelector('.switch'));
    if (!sw || !$('adv').contains(sw)) return;
    writeAdv(sw, sw.getAttribute('aria-checked') !== 'true');
    qualityOverride = 'custom';
    syncQuality();
    persistAdvanced();
  });
  on($('adv'), 'keydown', (e) => {
    const sw = e.target.closest('.switch');
    if (!sw || (e.key !== ' ' && e.key !== 'Enter')) return;
    e.preventDefault();
    writeAdv(sw, sw.getAttribute('aria-checked') !== 'true');
    qualityOverride = 'custom';
    syncQuality();
    persistAdvanced();
  });

  function toggleSection(headId, bodyId) {
    on($(headId), 'click', () => {
      const body = $(bodyId);
      body.hidden = !body.hidden;
      $(headId).setAttribute('aria-expanded', String(!body.hidden));
    });
  }
  toggleSection('adv-toggle', 'adv');
  toggleSection('diag-toggle', 'diag');

  on($('adv-reset'), 'click', () => {
    for (const [k, v] of Object.entries(ADV_DEFAULTS)) writeAdv(advEl(k), v);
    qualityOverride = null;
    persistAdvanced();
    syncQuality();
    const b = $('adv-reset');
    b.textContent = 'Reset done';
    later(1200, () => { b.textContent = 'Reset tuning'; });
  });

  // =========================================================================
  // PIPELINE  (tiles + the Model card write the same value)
  // =========================================================================
  const tiles = () => Array.from($('pipeline').querySelectorAll('.tile'));

  function syncPipelineUI() {
    for (const t of tiles()) {
      const on_ = t.dataset.v === pipeline;
      t.setAttribute('aria-checked', on_ ? 'true' : 'false');
      t.tabIndex = on_ ? 0 : -1;
    }
    for (const g of document.querySelectorAll('.adv-group')) g.hidden = g.dataset.group !== pipeline;
    $('c-model').value = pipeline;
    $('c-model-h').textContent = PIPELINE_HINT[pipeline] || '';
    $('run-info-pipeline').textContent = pipeline;
    const dir = outputDir || defaultOutDir;
    $('run-info-out').textContent = dir ? dir.split(/[\\/]/).slice(-2).join('\\') : 'not set';
    $('run-info-out').title = dir || '';
  }

  function setPipeline(v, persist) {
    if (!PIPELINES.includes(v)) return;
    pipeline = v;
    syncPipelineUI();
    if (persist) persistSettings({ pipeline });
  }

  on($('pipeline'), 'click', (e) => {
    const b = e.target.closest('.tile');
    if (b) setPipeline(b.dataset.v, true);
  });
  on($('pipeline'), 'keydown', (e) => {
    const list = tiles();
    const cur = list.findIndex((t) => t.dataset.v === pipeline);
    let next = -1;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = (cur + 1) % list.length;
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = (cur + list.length - 1) % list.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = list.length - 1;
    else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); return; }
    if (next < 0) return;
    e.preventDefault();
    setPipeline(list[next].dataset.v, true);
    list[next].focus();
  });
  on($('c-model'), 'change', () => setPipeline($('c-model').value, true));

  // ---- Stems card (skipSeparation) ---------------------------------------
  const skipSeparation = () => $('c-stems').value === 'skip';
  function syncStems() {
    $('c-stems-h').textContent = STEMS_HINT[$('c-stems').value] || '';
  }
  on($('c-stems'), 'change', () => { syncStems(); persistSettings({ skipSeparation: skipSeparation() }); });

  // =========================================================================
  // OUTPUT FOLDER + FILENAME
  // =========================================================================
  let defaultOutDir = '';

  function setPathChip(chip, dirSpan, nameSpan, full, fallback) {
    const p = String(full || '');
    if (!p) {
      dirSpan.textContent = '';
      nameSpan.textContent = fallback || '—';
      chip.title = '';
      return;
    }
    const base = Fmt.basename(p) || p;
    const dir = p.slice(0, Math.max(0, p.length - base.length));
    dirSpan.textContent = dir;
    nameSpan.textContent = base;
    chip.title = p;
  }

  function syncOutput() {
    const dir = outputDir || defaultOutDir;
    setPathChip($('out-chip'), $('out-dir'), $('out-base'), dir, 'not set');
    $('clear-out').hidden = !outputDir;
    $('out-note').textContent = outputDir ? 'Your chosen folder.' : 'Program output folder.';
    syncPipelineUI();
  }

  on($('pick-out'), 'click', async () => {
    if (!F.pickOutDir) return;
    const d = await F.pickOutDir();
    if (!d) return;
    outputDir = d;
    if (F.setSettings) F.setSettings({ outputDir: d });
    syncOutput();
    logQuiet('Output folder: ' + d);
  });
  on($('clear-out'), 'click', () => {
    outputDir = '';
    if (F.setSettings) F.setSettings({ outputDir: '' });
    syncOutput();
  });
  on($('out-reveal'), 'click', (e) => {
    e.preventDefault();
    const dir = outputDir || defaultOutDir;
    if (dir && S.openPath) S.openPath(dir);
    else if (dir && F.openPath) F.openPath(dir);
  });
  on($('in-reveal'), 'click', (e) => {
    e.preventDefault();
    if (inputPath && Bus) Bus.send(T.FILE_REVEAL, { path: inputPath });
  });

  const sameAsInput = () => $('samename').getAttribute('aria-checked') === 'true';
  function syncSameName() {
    const same = sameAsInput();
    $('outname-field').hidden = same;
    $('samename-hint').textContent = same ? 'Turn off to name the file yourself.' : 'The engine will use the name below.';
    $('out-name').placeholder = inputPath ? Fmt.stem(inputPath) : 'same name as the song';
  }
  function toggleSameName() {
    $('samename').setAttribute('aria-checked', sameAsInput() ? 'false' : 'true');
    syncSameName();
    if (!sameAsInput()) $('out-name').focus();
  }
  on($('samename'), 'click', toggleSameName);
  on($('samename'), 'keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggleSameName(); } });

  // Windows-illegal characters would fail the write deep inside Python.
  const outputName = () => (sameAsInput() ? '' : $('out-name').value.trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '').slice(0, 120));

  // =========================================================================
  // INPUT + QUEUE
  // =========================================================================
  const saveQueue = debounce(() => {
    try {
      localStorage.setItem(QUEUE_KEY, JSON.stringify({
        current: activeState === 'done' ? '' : (inputPath || ''),
        waiting: queue.slice(0, 100),
      }));
    } catch (_) {}
  }, 500);

  let queueList = null;

  function queueItems() {
    const rows = [];
    if (inputPath) rows.push({ path: inputPath, active: true });
    for (const p of queue) rows.push({ path: p, active: false });
    return rows;
  }

  function renderQueue() {
    const rows = queueItems();
    const n = String(rows.length);
    if ($('queue-count').textContent !== n) $('queue-count').textContent = n;
    $('queue-empty').hidden = rows.length > 0;
    $('queue-list').hidden = rows.length === 0;
    if (queueList) { queueList.setItems(rows); if (!$('tp-queue').hidden) queueList.paintNow(); }
    saveQueue();
  }

  function rememberQueue() {
    queueUndo = { inputPath, activeState, queue: queue.slice() };
    $('queue-undo').hidden = false;
  }

  function addInputs(paths, mode) {
    mode = mode || 'smart';
    const raw = (paths || []).filter(Boolean).map(String);
    if (!raw.length) return;
    rememberQueue();
    if (mode === 'replace' && !busy) {
      const chosen = raw.shift();
      queue = queue.filter((p) => lower(p) !== lower(chosen));
      setInput(chosen);
    }
    const seen = new Set([inputPath, ...queue].filter(Boolean).map(lower));
    const ps = raw.filter((p) => !seen.has(lower(p)) && seen.add(lower(p)));
    if (mode === 'smart' && !busy && !inputPath && ps.length) setInput(ps.shift());
    queue.push(...ps);
    if (ps.length) railTabs.select(1, false);
    renderQueue();
    updateStart();
  }

  function removeActive() {
    if (busy || !inputPath) return;
    rememberQueue();
    setInput(queue.length ? queue.shift() : '');
    renderQueue();
    updateStart();
  }

  function skipCurrent() {
    if (!busy) { removeActive(); return; }
    skipRequested = true;
    runningQueue = queue.length > 0;
    if (currentJob) F.cancel(currentJob);
    else pendingCancel = true;
    logLine('Skipping current song…', { level: 'warn' });
    renderQueue();
  }

  function promote(i) {
    if (busy || i < 0 || i >= queue.length) return;
    rememberQueue();
    const picked = queue.splice(i, 1)[0];
    if (inputPath) queue.unshift(inputPath);
    setInput(picked);
    renderQueue();
    updateStart();
  }
  function move(i, delta) {
    const j = i + delta;
    if (i < 0 || j < 0 || i >= queue.length || j >= queue.length) return;
    rememberQueue();
    const t = queue[i]; queue[i] = queue[j]; queue[j] = t;
    renderQueue();
    if (queueList) queueList.setCursor(j + (inputPath ? 1 : 0), { scroll: true });
  }
  function removeAt(i) {
    if (i < 0 || i >= queue.length) return;
    rememberQueue();
    queue.splice(i, 1);
    renderQueue();
    updateStart();
  }

  function queueRowHeight() { return Tokens ? Tokens.num('h-row-lg', 40) : 40; }

  queueList = window.VList($('queue-list'), {
    rowHeight: queueRowHeight(),
    ariaLabel: 'Forge queue',
    selectable: true,
    key: (it) => lower(it.path),
    createRow() {
      const n = document.createElement('div');
      n.className = 'lrow is-lg';
      n.innerHTML =
        '<span class="lrow-index"></span>' +
        '<span class="lrow-main"><span class="lrow-name u-truncate"></span><span class="lrow-sub u-truncate"></span></span>' +
        '<span class="lrow-meta"></span>' +
        '<span class="lrow-actions">' +
        '<button class="btn btn-icon is-sm is-bare" data-action="up" aria-label="Move up"></button>' +
        '<button class="btn btn-icon is-sm is-bare" data-action="down" aria-label="Move down"></button>' +
        '<button class="btn btn-icon is-sm is-bare" data-action="remove" aria-label="Remove from the queue"></button>' +
        '</span>';
      const acts = n.lastElementChild;
      acts.children[0].innerHTML = window.Icon.svg('up', 11);
      acts.children[1].innerHTML = window.Icon.svg('down', 11);
      acts.children[2].innerHTML = window.Icon.svg('close', 11);
      return n;
    },
    renderRow(node, it, index) {
      const idx = node.children[0], main = node.children[1], meta = node.children[2], acts = node.children[3];
      idx.textContent = it.active ? '▶' : String(index + (inputPath ? 0 : 1));
      main.children[0].textContent = Fmt.basename(it.path);
      main.children[1].textContent = Fmt.dirname(it.path);
      node.title = it.path;
      node.setAttribute('aria-label', Fmt.basename(it.path) + (it.active ? ', current' : ', queued'));
      node.classList.toggle('is-current', !!it.active);
      node.classList.toggle('is-playing', !!it.active && busy);
      meta.textContent = it.active ? (busy ? (jobPaused ? 'paused' : 'running') : activeState) : 'queued';
      const qi = index - (inputPath ? 1 : 0);
      if (it.active) {
        acts.children[0].hidden = true;
        acts.children[1].hidden = true;
        acts.children[2].hidden = false;
        acts.children[2].dataset.action = busy ? 'skip' : 'remove-active';
        acts.children[2].setAttribute('aria-label', busy ? 'Skip this song' : 'Remove the current song');
        acts.children[2].innerHTML = window.Icon.svg(busy ? 'next' : 'close', 11);
      } else {
        acts.children[0].hidden = false;
        acts.children[1].hidden = false;
        acts.children[2].hidden = false;
        acts.children[0].disabled = qi <= 0;
        acts.children[1].disabled = qi >= queue.length - 1;
        acts.children[2].dataset.action = 'remove';
        acts.children[2].setAttribute('aria-label', 'Remove from the queue');
        acts.children[2].innerHTML = window.Icon.svg('close', 11);
      }
    },
    onAction(action, it, index) {
      const qi = index - (inputPath ? 1 : 0);
      if (action === 'up') move(qi, -1);
      else if (action === 'down') move(qi, 1);
      else if (action === 'remove') removeAt(qi);
      else if (action === 'remove-active') removeActive();
      else if (action === 'skip') skipCurrent();
    },
    onActivate(it, index) {
      const qi = index - (inputPath ? 1 : 0);
      if (!it.active) promote(qi);
    },
    onContextMenu(it, index, ev) {
      ev.preventDefault();
      const qi = index - (inputPath ? 1 : 0);
      window.Menu.open([
        { group: Fmt.basename(it.path) },
        !it.active && { label: 'Make this the current song', icon: 'up', disabled: busy, run: () => promote(qi) },
        !it.active && { label: 'Move up', icon: 'up', disabled: qi <= 0, run: () => move(qi, -1) },
        !it.active && { label: 'Move down', icon: 'down', disabled: qi >= queue.length - 1, run: () => move(qi, 1) },
        it.active && busy && { label: 'Skip this song', icon: 'next', run: skipCurrent },
        { sep: true },
        { label: 'Show in folder', icon: 'folder', run: () => Bus && Bus.send(T.FILE_REVEAL, { path: it.path }) },
        { label: it.active ? 'Remove the current song' : 'Remove from the queue', icon: 'close', danger: true,
          disabled: it.active && busy, run: () => (it.active ? removeActive() : removeAt(qi)) },
      ], { x: ev.clientX, y: ev.clientY, ariaLabel: Fmt.basename(it.path), returnFocusTo: queueList.host });
    },
  });
  keep(() => queueList.destroy());

  // Alt+Arrow reorders. Captured so VList's own key handling does not fight it.
  on($('queue-list'), 'keydown', (e) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    e.stopPropagation();
    const i = queueList.cursor();
    if (i < 0) return;
    move(i - (inputPath ? 1 : 0), e.key === 'ArrowUp' ? -1 : 1);
  }, true);

  on($('queue-clear'), 'click', () => {
    if (!queue.length) return;
    rememberQueue();
    queue = [];
    renderQueue();
    updateStart();
    logQuiet('Cleared the waiting queue. Undo puts it back.');
  });
  on($('queue-undo'), 'click', () => {
    if (!queueUndo || busy) return;
    const now = { inputPath, activeState, queue: queue.slice() };
    const prev = queueUndo;
    queueUndo = now;                      // Undo doubles as Redo
    queue = prev.queue.slice();
    if (prev.inputPath !== inputPath) setInput(prev.inputPath);
    activeState = prev.activeState || 'ready';
    renderQueue();
    updateStart();
  });
  const toggleAuto = () => {
    const el = $('queue-auto');
    el.setAttribute('aria-checked', el.getAttribute('aria-checked') === 'true' ? 'false' : 'true');
  };
  on($('queue-auto'), 'click', toggleAuto);
  on($('queue-auto'), 'keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggleAuto(); } });
  on($('queue-auto-lbl'), 'click', toggleAuto);
  const autoContinue = () => $('queue-auto').getAttribute('aria-checked') === 'true';

  const browse = async (mode) => {
    if (!F.pickInput) return;
    const r = await F.pickInput();
    addInputs(Array.isArray(r) ? r : [r], mode);
  };
  on($('dropzone'), 'click', () => browse('replace'));
  on($('queue-add'), 'click', () => browse('queue'));
  on($('queue-empty-add'), 'click', () => browse('queue'));

  function restoreQueue() {
    try {
      const saved = JSON.parse(localStorage.getItem(QUEUE_KEY) || '{}');
      const current = typeof saved.current === 'string' && AUDIO_EXT.test(saved.current) ? saved.current : '';
      const waiting = Array.isArray(saved.waiting) ? saved.waiting.filter((p) => typeof p === 'string' && AUDIO_EXT.test(p)) : [];
      const seen = new Set();
      const unique = [current, ...waiting].filter((p) => {
        if (!p) return false;
        const k = lower(p);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      if (!unique.length) return;
      const count = unique.length;
      setInput(unique.shift());
      queue = unique;
      activeState = 'ready';
      logQuiet(`Restored ${count} song${count === 1 ? '' : 's'} from your last session.`);
    } catch (_) {}
  }

  // ---- drop --------------------------------------------------------------
  let dragDepth = 0;
  const veil = $('drop-veil');
  function showVeil(on_) {
    veil.hidden = !on_;
    document.documentElement.dataset.drop = on_ ? 'on' : '';
    $('dropzone').classList.toggle('is-over', !!on_);
  }
  on(window, 'dragenter', (e) => { e.preventDefault(); dragDepth++; showVeil(true); });
  on(window, 'dragover', (e) => { e.preventDefault(); });
  on(window, 'dragleave', (e) => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; showVeil(false); } });
  on(window, 'drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    showVeil(false);
    acceptDrop(e.dataTransfer && e.dataTransfer.files);
  });

  function acceptDrop(files) {
    const audio = [], midis = [];
    for (const f of files || []) {
      const p = F.getDroppedFilePath ? F.getDroppedFilePath(f) : '';
      if (p && MIDI_EXT.test(p)) midis.push(p);
      else if (p && (AUDIO_EXT.test(p) || !/\.[a-z0-9]+$/i.test(p))) audio.push(p);
      else logQuiet('Ignored (not audio or MIDI): ' + (p || (f && f.name) || 'unknown'));
    }
    // A dropped MIDI is never forged — it goes where it can be heard.
    if (midis.length && Bus) Bus.send(T.NAV_OPEN_SELFMIDI, { midiPath: midis[0], play: false });
    addInputs(audio);
  }

  // ---- URL fetch ---------------------------------------------------------
  function doFetch() {
    const url = $('url').value.trim();
    if (!url || busy || !F.yt) return;
    clearError();
    logLine('Fetching ' + url);
    beginJob('Download', 'download', Fmt.basename(url) || url);
    F.yt({ url, outDir: outputDir }).then((id) => {
      currentJob = id;
      if (pendingCancel) F.cancel(id);
      else if (Bus) Bus.send(T.FORGE_STATUS, { event: 'forge.job', jobId: id, name: jobName, kind: 'download' });
    }).catch((err) => failJob(String((err && err.message) || err)));
  }
  on($('fetch'), 'click', doFetch);
  on($('url'), 'keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doFetch(); } });

  // =========================================================================
  // SONG HEADER + INPUT SWITCH
  // =========================================================================
  function syncSong() {
    if (!inputPath) {
      $('song-title').textContent = 'No input loaded';
      $('song-meta').textContent = 'Drop an audio file, paste a link, or browse.';
      $('song-fmt').hidden = true;
      $('in-chip').hidden = true;
      return;
    }
    $('song-title').textContent = Fmt.stem(inputPath);
    $('song-title').title = inputPath;
    $('song-fmt').hidden = false;
    $('song-fmt').textContent = (Fmt.ext(inputPath) || '').replace('.', '').toUpperCase() || 'AUDIO';
    setPathChip($('in-chip'), $('in-dir'), $('in-name'), inputPath, '');
    $('in-chip').hidden = false;
    paintSongMeta();
  }

  const audioMeta = { seconds: 0, rate: 0, channels: 0, bytes: 0 };
  function paintSongMeta() {
    if (!inputPath) return;
    const bits = [];
    const dur = audioMeta.seconds || waveDuration;
    bits.push(dur ? Fmt.clock(dur) : '--:--');
    if (audioMeta.rate) bits.push((audioMeta.rate / 1000).toFixed(1).replace(/\.0$/, '') + ' kHz');
    if (audioMeta.channels) bits.push(audioMeta.channels === 1 ? 'mono' : audioMeta.channels === 2 ? 'stereo' : audioMeta.channels + ' ch');
    if (audioMeta.bytes) bits.push(Fmt.bytes(audioMeta.bytes));
    $('song-meta').textContent = bits.join('  ·  ');
  }

  function setInput(p) {
    stopPreview();
    activeState = 'ready';
    inputPath = String(p || '');
    audioMeta.seconds = audioMeta.rate = audioMeta.channels = audioMeta.bytes = 0;
    const a = $('preview-audio');
    if (inputPath && F.fileUrl) { a.src = F.fileUrl(inputPath); }
    else { a.removeAttribute('src'); try { a.load(); } catch (_) {} }
    syncSong();
    syncSameName();
    loadWaveform(inputPath, false);
    syncTimingControls();
    updateStart();
    renderQueue();
  }

  // =========================================================================
  // WAVEFORM  (static layer + playhead overlay, peaks bucketed in slices)
  // =========================================================================
  const waveHost = $('wave-shell');
  const waveCanvas = $('waveform');
  const audio = $('preview-audio');
  const waveLayer = new Draw.LayerCache();
  keep(() => waveLayer.dispose());

  const zoom = window.TimelineZoom(waveHost, () => waveDuration, () => waveHandle.invalidate());

  function rangeNow() {
    const t = collectTiming();
    if (!t.enabled || Number.isNaN(t.start) || Number.isNaN(t.end)) return { enabled: false, start: 0, end: waveDuration || 0 };
    const start = clamp(t.start || 0, 0, waveDuration || Number.MAX_SAFE_INTEGER);
    const end = t.end == null ? (waveDuration || start) : clamp(t.end, 0, waveDuration || t.end);
    return { enabled: true, start, end: Math.max(start, end) };
  }

  function waveEmptyText() {
    if (!inputPath) return 'No audio loaded';
    if (waveDeferred) return 'Peaks skipped while the batch runs';
    if (waveFailed) return 'No waveform for this file';
    return 'Reading peaks…';
  }

  function paintPeaks(ctx, geo) {
    const w = geo.w, h = geo.h, mid = h / 2;
    ctx.fillStyle = Tokens.get('bg-2', '#0f1013');
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = Tokens.get('line', '#2b2e36');
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, Math.round(mid) + 0.5);
    ctx.lineTo(w, Math.round(mid) + 0.5);
    ctx.stroke();

    // time grid
    const cols = waveDuration > 0 ? clamp(Math.floor(w / 118), 4, 12) : 6;
    const t0 = zoom.start(), sp = zoom.span();
    ctx.strokeStyle = Tokens.get('line-soft', '#3a3d4566');
    ctx.fillStyle = Tokens.get('text-3', '#868a92');
    ctx.font = '12px ' + Tokens.get('font-mono', 'monospace');
    ctx.textBaseline = 'top';
    for (let i = 0; i <= cols; i++) {
      const x = Math.round((i / cols) * w) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
      if (waveDuration > 0 && i < cols) ctx.fillText(Fmt.clock(t0 + (i / cols) * sp), x + 5, 4);
    }

    if (!wavePeaks || !waveDuration) {
      ctx.fillStyle = Tokens.get('text-3', '#868a92');
      ctx.font = '12px ' + Tokens.get('font-body', 'sans-serif');
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(waveEmptyText(), w / 2, mid);
      ctx.textAlign = 'left';
      return;
    }
    // Aggregate min/max across EVERY bucket a pixel covers. Sampling one bucket
    // per pixel silently dropped real peaks the moment the view zoomed out.
    const total = wavePeaks.length / 2;
    const amp = h * 0.42;
    ctx.strokeStyle = Tokens.get('text-2', '#9b9ea6');
    ctx.beginPath();
    for (let x = 0; x < w; x++) {
      const ta = t0 + (x / w) * sp;
      const tb = t0 + ((x + 1) / w) * sp;
      let b0 = Math.floor((ta / waveDuration) * total);
      let b1 = Math.ceil((tb / waveDuration) * total);
      b0 = clamp(b0, 0, total - 1);
      b1 = clamp(Math.max(b1, b0 + 1), 1, total);
      let mn = 1, mx = -1;
      for (let b = b0; b < b1; b++) {
        const lo = wavePeaks[b * 2], hi = wavePeaks[b * 2 + 1];
        if (lo < mn) mn = lo;
        if (hi > mx) mx = hi;
      }
      if (mx < mn) { mn = 0; mx = 0; }
      const px = x + 0.5;
      ctx.moveTo(px, mid + mn * amp);
      ctx.lineTo(px, mid + mx * amp + 0.6);
    }
    ctx.stroke();
  }

  function paintOverlay(ctx, w, h) {
    const r = rangeNow();
    if (waveDuration > 0 && r.enabled) {
      const sx = clamp(zoom.xFor(r.start, w), -4, w + 4);
      const ex = clamp(zoom.xFor(r.end, w), -4, w + 4);
      ctx.fillStyle = 'rgba(0,0,0,.42)';
      if (sx > 0) ctx.fillRect(0, 0, sx, h);
      if (ex < w) ctx.fillRect(ex, 0, w - ex, h);
      ctx.fillStyle = Tokens.rgba('accent', 0.10);
      ctx.fillRect(sx, 0, Math.max(1, ex - sx), h);
      const accent = Tokens.get('accent', '#b8e62e');
      ctx.strokeStyle = accent;
      ctx.fillStyle = accent;
      ctx.lineWidth = 2;
      for (const x of [sx, ex]) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
        ctx.fillRect(x - 3, 0, 6, 11);
        ctx.fillRect(x - 3, h - 11, 6, 11);
      }
    }
    const at = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    if (waveDuration > 0) {
      const px = Math.round(zoom.xFor(clamp(at, 0, waveDuration), w)) + 0.5;
      ctx.strokeStyle = Tokens.get('text', '#e8e9ea');
      ctx.globalAlpha = 0.75;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, h);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  let lastAria = -1;
  const waveHandle = Draw.register({
    key: 'forge:wave',
    el: waveHost,
    draw() {
      if (waveCollapsed) return;
      const geo = Draw.fitCanvas(waveCanvas, waveHost.clientWidth, waveHost.clientHeight);
      if (geo.resized) waveLayer.invalidate();
      const version = [peaksVersion, zoom.start().toFixed(3), zoom.span().toFixed(3), Tokens.themeKey()].join('|');
      waveLayer.paint(geo.w, geo.h, version, (ctx, g) => paintPeaks(ctx, g));
      waveLayer.blit(geo.ctx, 0, 0);
      paintOverlay(geo.ctx, geo.w, geo.h);
      paintReadout();
      const pct = waveDuration ? Math.round(clamp(audio.currentTime / waveDuration, 0, 1) * 100) : 0;
      if (pct !== lastAria) {
        lastAria = pct;
        waveCanvas.setAttribute('aria-valuenow', String(pct));
        waveCanvas.setAttribute('aria-valuetext', Fmt.clock(audio.currentTime || 0));
      }
      // While the preview is running the playhead has to keep moving; asking for
      // the next frame from inside the draw is how Draw wants that expressed.
      if (!audio.paused && !audio.ended) { zoom.follow(audio.currentTime || 0); waveHandle.invalidate(); }
    },
  });
  keep(() => waveHandle.dispose());
  let peaksVersion = 'empty';

  function paintReadout() {
    const now = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    const total = waveDuration || (Number.isFinite(audio.duration) ? audio.duration : 0);
    const r = rangeNow();
    const sel = r.enabled && r.end > r.start ? '  ·  ' + Fmt.clock(r.start) + '–' + Fmt.clock(r.end) : '';
    const txt = Fmt.clockPad(now, { ms: true }) + ' / ' + Fmt.clockPad(total, { ms: true }) + sel;
    const el = $('time-readout');
    if (el.textContent !== txt) el.textContent = txt;
  }

  // ---- peak extraction ---------------------------------------------------
  function bucketSliced(data, out, token) {
    return new Promise((resolve, reject) => {
      const n = data.length, B = out.length / 2;
      const stride = n / B;
      let b = 0;
      const step = () => {
        sliceTimer = 0;
        if (token !== waveToken) { reject(new Error('stale')); return; }
        const t0 = performance.now();
        while (b < B) {
          const a = Math.floor(b * stride);
          const e = Math.min(n, Math.floor((b + 1) * stride));
          let mn = 1, mx = -1;
          for (let i = a; i < e; i++) { const v = data[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
          if (e <= a) { mn = 0; mx = 0; }
          out[b * 2] = mn;
          out[b * 2 + 1] = mx;
          b++;
          // Budget the slice, not the bucket count: one bucket of a 30-minute
          // file is already tens of thousands of samples.
          if ((b & 31) === 0 && performance.now() - t0 > 4) break;
        }
        if (b >= B) { resolve(); return; }
        sliceTimer = setTimeout(step, 0);
      };
      step();
    });
  }
  disposers.push(() => { if (sliceTimer) clearTimeout(sliceTimer); });

  // The decode context resamples to PEAK_RATE, so the buffer it hands back can
  // never report the file's real rate or channel count. Both come from the
  // container header instead — bytes we have already fetched, so it costs one
  // pass over the first few hundred of them and no second decode.
  const MP3_RATES = [[11025, 12000, 8000], [0, 0, 0], [22050, 24000, 16000], [44100, 48000, 32000]];
  function sniffAudioMeta(bytes) {
    const d = new DataView(bytes);
    const n = d.byteLength;
    const tag = (o, s) => { for (let i = 0; i < s.length; i++) if (d.getUint8(o + i) !== s.charCodeAt(i)) return false; return true; };
    try {
      if (n > 44 && tag(0, 'RIFF') && tag(8, 'WAVE')) {
        let o = 12;
        while (o + 8 < n) {
          const size = d.getUint32(o + 4, true);
          if (tag(o, 'fmt ')) return { rate: d.getUint32(o + 12, true), channels: d.getUint16(o + 10, true) };
          o += 8 + size + (size & 1);
        }
      }
      if (n > 42 && tag(0, 'fLaC')) {
        // STREAMINFO: 20-bit sample rate then 3-bit (channels - 1), 36 bytes in.
        const a = d.getUint8(18), b = d.getUint8(19), c = d.getUint8(20);
        return { rate: (a << 12) | (b << 4) | (c >> 4), channels: ((c >> 1) & 0x07) + 1 };
      }
      if (n > 64 && tag(0, 'OggS')) {
        const limit = Math.min(n - 16, 65536);
        for (let o = 0; o < limit; o++) {
          if (d.getUint8(o) === 0x01 && tag(o + 1, 'vorbis')) {
            return { rate: d.getUint32(o + 12, true), channels: d.getUint8(o + 11) };
          }
          if (tag(o, 'OpusHead')) return { rate: d.getUint32(o + 12, true) || 48000, channels: d.getUint8(o + 9) };
        }
      }
      if (n > 64 && (tag(4, 'ftyp') || tag(4, 'moov'))) {
        const limit = Math.min(n - 32, 1 << 20);
        for (let o = 0; o < limit; o++) {
          if (!tag(o, 'mp4a')) continue;
          // AudioSampleEntry: channelcount at box+24, then samplesize,
          // pre_defined and reserved before the 16.16 samplerate at box+32.
          // `o` is box+4, so the rate's integer half is o+28 -- o+26 was
          // `reserved`, which is always 0.
          return { rate: d.getUint16(o + 28, false), channels: d.getUint16(o + 20, false) };
        }
      }
      // MP3: skip an ID3v2 tag, then read the first frame header.
      let o = 0;
      if (n > 10 && tag(0, 'ID3')) {
        const sz = ((d.getUint8(6) & 0x7f) << 21) | ((d.getUint8(7) & 0x7f) << 14)
          | ((d.getUint8(8) & 0x7f) << 7) | (d.getUint8(9) & 0x7f);
        o = 10 + sz;
      }
      const limit = Math.min(n - 4, o + 65536);
      for (; o < limit; o++) {
        if (d.getUint8(o) !== 0xff || (d.getUint8(o + 1) & 0xe0) !== 0xe0) continue;
        const ver = (d.getUint8(o + 1) >> 3) & 0x03;
        const ri = (d.getUint8(o + 2) >> 2) & 0x03;
        if (ri === 3 || !MP3_RATES[ver] || !MP3_RATES[ver][ri]) continue;
        return { rate: MP3_RATES[ver][ri], channels: ((d.getUint8(o + 3) >> 6) & 0x03) === 3 ? 1 : 2 };
      }
    } catch (_) { /* an unreadable header is not an error, just an em dash */ }
    return { rate: 0, channels: 0 };
  }

  async function decodeAt(bytes) {
    const OC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (OC) {
      // decodeAudioData resamples to the context rate and runs off the main
      // thread, so a 30-minute file arrives as ~20M samples instead of ~80M and
      // no AudioContext is left open afterwards.
      const oc = new OC(1, 1, PEAK_RATE);
      return oc.decodeAudioData(bytes);
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('no audio decoder');
    const ac = new AC();
    try { return await ac.decodeAudioData(bytes); }
    finally { try { ac.close(); } catch (_) {} }
  }

  async function loadWaveform(p, force) {
    const token = ++waveToken;
    if (sliceTimer) { clearTimeout(sliceTimer); sliceTimer = 0; }
    wavePeaks = null;
    waveDuration = 0;
    waveFailed = false;
    peaksVersion = 'empty:' + token;
    waveDeferred = '';
    $('wave-loading').hidden = true;
    $('wave-deferred').hidden = true;
    waveHandle.invalidate();
    if (!p || !F.fileUrl) return;
    // Whole-file decode is the single most expensive thing this tab does. A
    // batch auto-advance or a collapsed preview does not need it.
    if (!force && (autoAdvancing || waveCollapsed)) {
      waveDeferred = p;
      peaksVersion = 'deferred:' + token;
      $('wave-deferred').hidden = false;
      waveHandle.invalidate();
      return;
    }
    $('wave-loading').hidden = false;
    $('wave-loading-txt').textContent = 'Reading peaks…';
    try {
      const res = await fetch(F.fileUrl(p));
      const bytes = await res.arrayBuffer();
      if (token !== waveToken) return;
      audioMeta.bytes = bytes.byteLength;
      const sniffed = sniffAudioMeta(bytes);
      const buf = await decodeAt(bytes);
      if (token !== waveToken) return;
      audioMeta.seconds = buf.duration || 0;
      audioMeta.rate = sniffed.rate;
      audioMeta.channels = sniffed.channels;
      const out = new Float32Array(BUCKETS * 2);
      await bucketSliced(buf.getChannelData(0), out, token);
      if (token !== waveToken) return;
      waveDuration = buf.duration || 0;
      wavePeaks = out;
      peaksVersion = p + '#' + token;
      paintSongMeta();
    } catch (err) {
      if (token !== waveToken) return;
      waveFailed = true;
      peaksVersion = 'failed:' + token;
      logQuiet('Waveform unavailable for this file; the time fields and the preview still work.');
    } finally {
      if (token === waveToken) {
        $('wave-loading').hidden = true;
        waveHandle.invalidate();
        syncTimingControls();
      }
    }
  }
  on($('wave-load'), 'click', () => { if (waveDeferred) loadWaveform(waveDeferred, true); });

  // ---- zoom buttons: drive the shared TimelineZoom, never a second window --
  function zoomBy(dir) {
    const r = Draw.measure(waveHost);
    waveHost.dispatchEvent(new WheelEvent('wheel', {
      deltaY: dir * 420, clientX: r.left + r.w / 2, clientY: r.top + r.h / 2, bubbles: false, cancelable: true,
    }));
  }
  on($('zoom-in'), 'click', () => zoomBy(-1));
  on($('zoom-out'), 'click', () => zoomBy(1));
  on($('zoom-reset'), 'click', () => zoom.reset());

  // =========================================================================
  // TIME RANGE
  // =========================================================================
  function parseTimeValue(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) return null;
    const v = Fmt.parseClock(s);
    return v == null ? NaN : v;
  }
  function collectTiming() {
    if (!timeEnabled) return { enabled: false, start: '', end: '' };
    return { enabled: true, start: parseTimeValue($('time-start').value), end: parseTimeValue($('time-end').value) };
  }
  function validateTiming(shout) {
    const t = collectTiming();
    let ok = true;
    let msg = 'Whole song. Drag across the waveform to pick a range.';
    if (t.enabled) {
      if (Number.isNaN(t.start) || Number.isNaN(t.end)) { ok = false; msg = 'Enter times as seconds, m:ss, or h:mm:ss.'; }
      else if (t.start != null && t.end != null && t.end <= t.start) { ok = false; msg = 'End must be after Start.'; }
      else msg = 'Forging ' + Fmt.clock(t.start || 0) + ' to ' + (t.end == null ? 'the end' : Fmt.clock(t.end)) + '.';
    }
    const hint = $('time-hint');
    if (hint.textContent !== msg) hint.textContent = msg;
    hint.classList.toggle('is-error', !ok);
    $('time-start').classList.toggle('is-invalid', !ok);
    $('time-end').classList.toggle('is-invalid', !ok);
    // The footer hint sits next to the fields and reports validity; the card
    // explains the choice. Printing the same sentence twice reads as a bug.
    $('c-range-h').textContent = t.enabled ? msg : 'Transcribe the entire file.';
    if (shout && !ok) logLine('Time range error: ' + msg, { level: 'warn' });
    return ok;
  }
  function syncTimingControls() {
    $('time-start').disabled = !timeEnabled;
    $('time-end').disabled = !timeEnabled;
    $('time-reset').disabled = !timeEnabled;
    $('time-from-playhead').disabled = !inputPath;
    $('time-to-playhead').disabled = !inputPath;
    $('c-range').value = timeEnabled ? 'custom' : 'all';
    validateTiming(false);
  }
  const persistTiming = debounce(() => {
    persistSettings({ timing: { enabled: timeEnabled, start: $('time-start').value.trim(), end: $('time-end').value.trim() } });
  }, 400);

  function onTimingChanged() {
    syncTimingControls();
    updateStart();
    waveHandle.invalidate();
    persistTiming();
  }
  // The DRAG is rAF-coalesced (dragMove); this must therefore be immediate, or
  // every range edit would land two frames late.
  function setRange(start, end) {
    timeEnabled = true;
    $('time-start').value = Fmt.clock(start, { ms: start % 1 !== 0 });
    $('time-end').value = Fmt.clock(end, { ms: end % 1 !== 0 });
    onTimingChanged();
  }

  on($('time-start'), 'input', onTimingChanged);
  on($('time-end'), 'input', onTimingChanged);
  on($('c-range'), 'change', () => {
    timeEnabled = $('c-range').value === 'custom';
    if (timeEnabled && !$('time-start').value) $('time-start').value = '0:00';
    onTimingChanged();
  });
  on($('time-reset'), 'click', () => {
    timeEnabled = false;
    $('time-start').value = '0:00';
    $('time-end').value = '';
    onTimingChanged();
  });
  on($('time-from-playhead'), 'click', () => {
    const now = clamp(audio.currentTime || 0, 0, waveDuration || Number.MAX_SAFE_INTEGER);
    const r = rangeNow();
    setRange(now, Math.max(now + 0.01, r.enabled ? r.end : (waveDuration || now + 30)));
  });
  on($('time-to-playhead'), 'click', () => {
    const now = clamp(audio.currentTime || 0, 0, waveDuration || Number.MAX_SAFE_INTEGER);
    const r = rangeNow();
    setRange(Math.min(r.enabled ? r.start : 0, Math.max(0, now - 0.01)), now);
  });

  // ---- pointer: proportional edge handles, 3px deadzone, unmoved = seek ----
  let drag = null;
  function timeFromEvent(e, rect) {
    const x = clamp(e.clientX - rect.left, 0, rect.w);
    return clamp(zoom.timeAt(x, rect.w), 0, waveDuration || 0);
  }
  on(waveCanvas, 'pointerdown', (e) => {
    if (!waveDuration || busy) return;
    const rect = Draw.measure(waveCanvas);
    const r = rangeNow();
    const sx = zoom.xFor(r.start, rect.w);
    const ex = zoom.xFor(r.end, rect.w);
    const x = e.clientX - rect.left;
    // Invariant 20's proportional rule: `width > 14 && |x - edge| <= min(8,
    // width*0.3)`. The edge zone exists ONLY above 14px -- a fixed 8px zone on a
    // narrow range (a 3s selection in a 5min song is ~10px) made the whole range
    // plus 8px either side resolve to 'start', and an unmoved click in that mode
    // neither seeks nor starts a new selection.
    const width = Math.abs(ex - sx);
    const grab = width > 14 ? Math.min(8, width * 0.3) : 0;
    const nearStart = r.enabled && Math.abs(x - sx) <= grab;
    const nearEnd = r.enabled && Math.abs(x - ex) <= grab;
    drag = { mode: nearStart ? 'start' : nearEnd ? 'end' : 'select', anchor: timeFromEvent(e, rect), rect, x0: e.clientX, moved: false };
    try { waveCanvas.setPointerCapture(e.pointerId); } catch (_) {}
    waveHandle.setLive(true);
    document.body.classList.add('is-resizing');
  });
  const dragMove = coalesce((sec) => {
    if (!drag) return;
    const r = rangeNow();
    if (drag.mode === 'start') setRange(clamp(sec, 0, Math.max(0, r.end - 0.01)), r.end);
    else if (drag.mode === 'end') setRange(r.start, clamp(sec, Math.min(waveDuration, r.start + 0.01), waveDuration));
    else setRange(Math.min(drag.anchor, sec), Math.max(drag.anchor, sec));
  });
  on(waveCanvas, 'pointermove', (e) => {
    if (!drag || !waveDuration) return;
    if (Math.abs(e.clientX - drag.x0) > 3) drag.moved = true;
    if (drag.mode === 'select' && !drag.moved) return;
    dragMove(timeFromEvent(e, drag.rect));
  });
  function endDrag(e) {
    if (!drag) return;
    if (!drag.moved && drag.mode === 'select' && waveDuration) {
      try { audio.currentTime = timeFromEvent(e, drag.rect); } catch (_) {}
      waveHandle.invalidate();
    }
    drag = null;
    document.body.classList.remove('is-resizing');
    waveHandle.setLive(!audio.paused);
    persistTiming.flush();
  }
  on(waveCanvas, 'pointerup', endDrag);
  on(waveCanvas, 'pointercancel', () => { drag = null; document.body.classList.remove('is-resizing'); waveHandle.setLive(!audio.paused); });

  on(waveCanvas, 'keydown', (e) => {
    if (e.key === ' ') { e.preventDefault(); togglePreview(); return; }
    if (!waveDuration || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    let next = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    if (e.key === 'ArrowLeft') next -= e.shiftKey ? 10 : 1;
    else if (e.key === 'ArrowRight') next += e.shiftKey ? 10 : 1;
    else if (e.key === 'Home') next = 0;
    else next = waveDuration;
    try { audio.currentTime = clamp(next, 0, waveDuration); } catch (_) {}
    waveHandle.invalidate();
  });

  // =========================================================================
  // LOCAL AUDIO PREVIEW  (a local preview, never a transport owner — §7)
  // =========================================================================
  let previewStopAt = null;
  const savePreviewPrefs = debounce(() => {
    try { localStorage.setItem(PREVIEW_KEY, JSON.stringify(previewPrefs)); } catch (_) {}
  }, 300);

  function applyVolume(v) {
    previewPrefs.audioVolume = clamp(Number(v) || 0, 0, 100);
    $('preview-volume').value = String(previewPrefs.audioVolume);
    $('preview-volume').style.setProperty('--p', String(previewPrefs.audioVolume / 100));
    $('preview-volume-value').textContent = previewPrefs.audioVolume + '%';
    audio.volume = previewPrefs.audioVolume / 100;
  }
  on($('preview-volume'), 'input', (e) => applyVolume(e.target.value));
  on($('preview-volume'), 'change', (e) => { applyVolume(e.target.value); savePreviewPrefs(); });

  function stopPreview() {
    previewStopAt = null;
    try { audio.pause(); } catch (_) {}
    waveHandle.setLive(false);
    syncPreviewButtons();
  }
  function syncPreviewButtons() {
    const playing = !audio.paused && !audio.ended;
    const b = $('preview');
    b.setAttribute('aria-label', playing ? 'Pause preview' : 'Play preview');
    b.innerHTML = window.Icon.svg(playing ? 'pause' : 'play', 12);
    b.classList.toggle('is-active', playing);
    b.disabled = !inputPath || busy;
    $('preview-stop').disabled = !inputPath;
  }
  async function togglePreview() {
    if (!inputPath || busy) return;
    if (!audio.paused && !audio.ended) { stopPreview(); return; }
    if (!audio.getAttribute('src') && F.fileUrl) audio.src = F.fileUrl(inputPath);
    if (!validateTiming(true)) return;
    const t = collectTiming();
    previewStopAt = t.enabled && t.end != null ? t.end : null;
    try {
      if (t.enabled) audio.currentTime = t.start || 0;
      await audio.play();
      waveHandle.setLive(true);
      waveHandle.invalidate();
    } catch (_) {
      logQuiet('The preview could not play this file.');
    }
    syncPreviewButtons();
  }
  on($('preview'), 'click', togglePreview);
  on($('preview-stop'), 'click', () => { stopPreview(); try { audio.currentTime = 0; } catch (_) {} waveHandle.invalidate(); });
  on(audio, 'timeupdate', () => {
    if (previewStopAt != null && audio.currentTime >= previewStopAt) stopPreview();
    waveHandle.invalidate();
  });
  on(audio, 'play', () => { waveHandle.setLive(true); syncPreviewButtons(); });
  on(audio, 'pause', () => { waveHandle.setLive(false); syncPreviewButtons(); waveHandle.invalidate(); });
  on(audio, 'ended', () => { waveHandle.setLive(false); syncPreviewButtons(); });
  on(audio, 'loadedmetadata', () => {
    if (!waveDuration && Number.isFinite(audio.duration)) waveDuration = audio.duration;
    if (!audioMeta.seconds && Number.isFinite(audio.duration)) audioMeta.seconds = audio.duration;
    paintSongMeta();
    waveHandle.invalidate();
  });

  // The global transport winning means our local preview must go quiet.
  if (window.Transport) {
    keep(window.Transport.onChange((snap) => {
      if (!snap) return;
      if ((snap.status === 'playing' || snap.status === 'counting') && !audio.paused) stopPreview();
    }));
  }

  // =========================================================================
  // PROGRESS  (seven stages, real timings, never invented progress)
  // =========================================================================
  const stageEl = {};
  for (const li of $('stages').children) stageEl[li.dataset.stage] = li;
  let stageState = {}, stageStart = {}, stageMs = {}, currentStage = '';

  function resetStages() {
    stageState = {}; stageStart = {}; stageMs = {}; currentStage = '';
    for (const key of STAGE_ORDER) {
      const li = stageEl[key];
      li.dataset.state = 'wait';
      li.classList.remove('is-fresh');
      li.removeAttribute('aria-current');
      li.querySelector('.stg-meta').textContent = 'Waiting';
      const fill = li.querySelector('.bar-fill');
      fill.classList.remove('indet');
      fill.style.setProperty('--p', '0');
      li.querySelector('.stg-bar').setAttribute('aria-valuenow', '0');
    }
  }

  function markDone(key, at) {
    if (stageState[key] === 'done') return;
    stageState[key] = 'done';
    const li = stageEl[key];
    if (stageStart[key]) stageMs[key] = at - stageStart[key];
    li.dataset.state = 'done';
    li.removeAttribute('aria-current');
    li.classList.add('is-fresh');
    const ms = stageMs[key];
    li.querySelector('.stg-meta').textContent = ms ? 'Done (' + Math.max(1, Math.round(ms / 1000)) + 's)' : 'Done';
    const fill = li.querySelector('.bar-fill');
    fill.classList.remove('indet');
    fill.style.setProperty('--p', '1');
    li.querySelector('.stg-bar').setAttribute('aria-valuenow', '100');
    later(400, () => li.classList.remove('is-fresh'));
  }

  function setStage(key) {
    if (!STAGE_ORDER.includes(key) || currentStage === key) return;
    const now = Date.now();
    const target = STAGE_ORDER.indexOf(key);
    for (let i = 0; i < target; i++) {
      const k = STAGE_ORDER[i];
      if (stageState[k] !== 'done') { if (!stageStart[k]) stageStart[k] = now; markDone(k, now); }
    }
    currentStage = key;
    stageStart[key] = stageStart[key] || now;
    stageState[key] = 'active';
    const li = stageEl[key];
    li.dataset.state = 'active';
    li.setAttribute('aria-current', 'step');
  }

  function paintActiveStage() {
    if (!currentStage) return;
    const li = stageEl[currentStage];
    const bar = li.querySelector('.stg-bar');
    const fill = li.querySelector('.bar-fill');
    const stalled = jobPercent != null && Date.now() - jobPctSeenAt > 4000;
    if (jobPercent == null || stalled) {
      // Never invent a number the backend has not reported. Subtle indeterminate
      // activity is honest; a creeping bar is not.
      if (!fill.classList.contains('indet')) fill.classList.add('indet');
      li.querySelector('.stg-meta').textContent = jobPaused ? 'Paused' : 'Working';
      bar.removeAttribute('aria-valuenow');
      bar.setAttribute('aria-valuetext', jobPaused ? 'Paused' : 'Working, amount unknown');
      return;
    }
    fill.classList.remove('indet');
    bar.removeAttribute('aria-valuetext');
    fill.style.setProperty('--p', String(clamp(jobPercent, 0, 100) / 100));
    bar.setAttribute('aria-valuenow', String(Math.round(jobPercent)));
    const eta = etaSeconds();
    li.querySelector('.stg-meta').textContent = Math.round(jobPercent) + '%' + (eta ? ' · ' + Fmt.duration(eta) : '');
  }

  function etaSeconds() {
    if (jobPercent == null || jobPercent < 5 || !jobStartedAt) return 0;
    const elapsed = (Date.now() - jobStartedAt) / 1000;
    if (elapsed < 8) return 0;
    return Math.round(elapsed * (100 - jobPercent) / jobPercent);
  }

  let lastPctText = '';
  function paintClock() {
    const elapsed = jobStartedAt ? Math.floor((Date.now() - jobStartedAt) / 1000) : 0;
    $('job-elapsed').textContent = jobStartedAt ? Fmt.clockPad(elapsed) : '--:--';
    const eta = etaSeconds();
    $('job-eta').textContent = eta ? Fmt.duration(eta) : (busy ? '—' : '--:--');
    const txt = jobPercent == null ? '' : Math.round(jobPercent) + '%';
    if (txt !== lastPctText) { lastPctText = txt; $('job-pct').textContent = txt; }
    paintActiveStage();
  }
  let clockTimer = 0;
  function startClock() {
    if (clockTimer) return;
    clockTimer = setInterval(() => { if (busy) paintClock(); else stopClock(); }, 1000);
  }
  function stopClock() { if (clockTimer) { clearInterval(clockTimer); clockTimer = 0; } }
  disposers.push(stopClock);

  function setJobPill(kind, word) {
    const pill = $('job-pill');
    pill.className = 'pill' + (kind ? ' is-' + kind : '');
    $('job-dot').className = 'dot' + (kind === 'ok' ? ' ok' : kind === 'err' ? ' err' : kind === 'warn' ? ' warn' : '');
    $('job-dot').classList.toggle('is-paused', word === 'Paused');
    $('job-state').textContent = word;
  }

  function beginJob(stageWord, kind, name) {
    resetStages();
    clearError();
    busy = true;
    jobPaused = false;
    currentJob = null;
    pendingCancel = false;
    activeState = 'running';
    skipRequested = false;
    jobStartedAt = Date.now();
    jobPercent = null;
    jobPctSeenAt = Date.now();
    jobName = name || Fmt.basename(inputPath);
    lastStage = stageWord;
    setStage('load');
    setJobPill('warn', kind === 'download' ? 'Downloading' : 'Working');
    $('job-name').textContent = jobName;
    $('prog-foot').textContent = 'The pipeline reports each stage as it reaches it.';
    progTabs.select(0, false);
    syncBusy();
    startClock();
    paintClock();
  }

  function syncBusy() {
    $('pause').hidden = !busy;
    $('cancel').hidden = !busy;
    $('fetch').disabled = busy;
    $('pause').textContent = jobPaused ? 'Resume' : 'Pause';
    syncPreviewButtons();
    updateStart();
    renderQueue();
  }

  function endJob() {
    busy = false;
    jobPaused = false;
    currentJob = null;
    pendingCancel = false;
    $('cancel').textContent = 'Cancel';
    stopClock();
    syncBusy();
    paintClock();
  }

  function showError(msg) {
    $('errcard').hidden = false;
    $('err-msg').textContent = msg;
    if (currentStage) {
      stageEl[currentStage].dataset.state = 'fail';
      stageEl[currentStage].querySelector('.stg-meta').textContent = 'Failed';
      stageEl[currentStage].querySelector('.bar-fill').classList.remove('indet');
    }
    setJobPill('err', 'Failed');
  }
  function clearError() { $('errcard').hidden = true; $('err-msg').textContent = ''; }
  function failJob(msg) { endJob(); showError(msg); logLine('Could not start the job: ' + msg, { level: 'error' }); }
  on($('err-dismiss'), 'click', clearError);

  on($('pause'), 'click', async () => {
    if (!F.pause || !busy) return;
    const want = !jobPaused;
    $('pause').disabled = true;
    let r = null;
    try { r = await F.pause(want); } catch (_) {}
    $('pause').disabled = false;
    if (r && r.ok) {
      jobPaused = !!r.paused;
      applyPaused();
      logLine(jobPaused ? 'Paused. The GPU is free until you resume.' : 'Resumed.');
    } else logLine((r && r.error) || 'Could not pause the job.', { level: 'warn' });
  });
  function applyPaused() {
    $('pause').textContent = jobPaused ? 'Resume' : 'Pause';
    setJobPill(jobPaused ? 'warn' : 'warn', jobPaused ? 'Paused' : 'Working');
    if (currentStage) stageEl[currentStage].querySelector('.stg-meta').textContent = jobPaused ? 'Paused' : (lastStage || 'Working');
    renderQueue();
  }
  on($('cancel'), 'click', () => {
    // Cancelling the visible job abandons the whole batch; a half-run queue that
    // keeps going after Cancel is never what anyone means. It stays recoverable.
    if (queue.length) { rememberQueue(); queue = []; logLine('Queue cleared. Undo puts the list back.', { level: 'warn' }); }
    runningQueue = false;
    skipRequested = false;
    renderQueue();
    if (currentJob) F.cancel(currentJob);
    else pendingCancel = true;
    $('cancel').textContent = 'Cancelling…';
  });

  // =========================================================================
  // START
  // =========================================================================
  function updateStart() {
    const ok = !!(envReady && inputPath && !busy && validateTiming(false));
    $('start').disabled = !ok;
    $('start').title = ok ? '' : !envReady ? 'The Forge engine is not set up yet.'
      : !inputPath ? 'Load an audio file first.' : busy ? 'A job is already running.' : 'Fix the time range first.';
  }

  function startJob() {
    if (!inputPath || busy) return;
    if (!validateTiming(true)) return;
    const advanced = collectAdvanced();
    const timingRaw = { enabled: timeEnabled, start: $('time-start').value.trim(), end: $('time-end').value.trim() };
    if (F.setSettings) F.setSettings({ pipeline, skipSeparation: skipSeparation(), advanced, timing: timingRaw });
    const more = queue.length ? ' (' + queue.length + ' more queued)' : '';
    beginJob('Queued', 'run', Fmt.basename(inputPath));
    logLine('Start ' + Fmt.basename(inputPath) + ' (' + pipeline + (skipSeparation() ? ', skip-sep' : '') + ')' + more);
    F.run({ inputPath, pipeline, skipSeparation: skipSeparation(), advanced, timing: collectTiming(), outputName: outputName() })
      .then((id) => {
        currentJob = id;
        if (pendingCancel) F.cancel(id);
        else if (Bus) Bus.send(T.FORGE_STATUS, { event: 'forge.job', jobId: id, name: jobName, kind: pipeline });
      })
      .catch((err) => failJob(String((err && err.message) || err)));
    // A name belongs to one song, not to the queue.
    $('out-name').value = '';
    $('samename').setAttribute('aria-checked', 'true');
    syncSameName();
  }
  on($('start'), 'click', () => { runningQueue = queue.length > 0; startJob(); });

  // =========================================================================
  // RESULTS + HISTORY
  // =========================================================================
  const BADGE = { primary: 'Primary', clean: 'Clean', alternate: 'Alternate', drums: 'Drums' };
  let sessionResults = [], history = [], resList = null;

  function loadHistory() {
    try {
      const raw = JSON.parse(localStorage.getItem(RESULTS_KEY) || '[]');
      history = Array.isArray(raw) ? raw.filter((r) => r && typeof r.path === 'string') : [];
    } catch (_) { history = []; }
  }
  // Only the row's own facts are persisted. `freshUntil` is a 500ms entrance
  // flag, and the onset array lives in metaCache alone: a Float32Array
  // stringifies as {"0":..,"1":..}, which added ~30KB of numeric-keyed JSON per
  // parsed row, walked the blob into the 5MB quota (the write is a silent
  // try/catch) and came back as a lengthless object that read as "no data".
  const HISTORY_KEEP = ['path', 'project', 'pipeline', 'badge', 'at', 'notes', 'seconds'];
  let historyWriteFailed = false;
  const saveHistory = debounce(() => {
    const rows = history.slice(0, 200).map((r) => {
      const out = {};
      for (const k of HISTORY_KEEP) if (r[k] !== undefined) out[k] = r[k];
      return out;
    });
    try {
      localStorage.setItem(RESULTS_KEY, JSON.stringify(rows));
      historyWriteFailed = false;
    } catch (err) {
      // 200 whitelisted rows are a few tens of KB, so this should be
      // unreachable -- but a silent catch is how the old unbounded blob hid a
      // dead quota, so say it once instead of never.
      if (!historyWriteFailed) {
        historyWriteFailed = true;
        logQuiet('Could not save the results history: ' + ((err && err.message) || err));
      }
    }
  }, 400);

  function badgeFor(kind, name, pipe) {
    if (pipe === 'drums') return 'drums';
    if (kind === 'clean') return 'clean';
    if (kind && kind !== 'primary') return 'alternate';
    if (/_(balanced|detailed|alt\d*)$/i.test(Fmt.stem(name))) return 'alternate';
    if (/_clean$/i.test(Fmt.stem(name))) return 'clean';
    return 'primary';
  }

  function addResults(result, pipe) {
    const made = Date.now();
    const rows = [];
    const seen = new Set();
    const push = (path, kind) => {
      if (!path || seen.has(lower(path))) return;
      seen.add(lower(path));
      rows.push({
        path, project: result.projectPath || '', pipeline: pipe,
        badge: badgeFor(kind, path, pipe), at: made,
        notes: (result.candidateCounts && kind && result.candidateCounts[kind] != null) ? Number(result.candidateCounts[kind]) : null,
        seconds: null, freshUntil: made + 500,
      });
    };
    const cands = result.candidates && typeof result.candidates === 'object' ? result.candidates : null;
    if (cands) for (const [k, v] of Object.entries(cands)) push(v, k);
    push(result.midiPath, 'primary');
    if (!rows.length) return null;
    sessionResults = rows.concat(sessionResults);
    history = rows.map((r) => Object.assign({}, r)).concat(history.filter((h) => !seen.has(lower(h.path))));
    saveHistory();
    renderResults();
    select(rows[0]);
    later(520, () => { if (resList) resList.refresh(); });
    return rows[0];
  }

  function sortedResults() {
    const src = (resultTab === 'history' ? history : sessionResults).slice();
    const mode = $('res-sort').value;
    const byName = (a, b) => Fmt.basename(a.path).localeCompare(Fmt.basename(b.path), undefined, { numeric: true, sensitivity: 'base' });
    // Sort once per order change, never inside renderRow. An unparsed column
    // sorts the rows it has and appends the rest in the previous order.
    if (mode === 'name') src.sort(byName);
    else if (mode === 'old') src.sort((a, b) => a.at - b.at);
    else if (mode === 'notes') src.sort((a, b) => (b.notes == null ? -1 : b.notes) - (a.notes == null ? -1 : a.notes));
    else if (mode === 'dur') src.sort((a, b) => (b.seconds == null ? -1 : b.seconds) - (a.seconds == null ? -1 : a.seconds));
    else src.sort((a, b) => b.at - a.at);
    return src;
  }

  function renderResults() {
    const rows = sortedResults();
    $('res-count').textContent = String(sessionResults.length);
    $('res-empty').hidden = rows.length > 0;
    $('res-list').hidden = rows.length === 0;
    if (resList) { resList.setItems(rows); resList.paintNow(); }
    if (rows.length && !selected) select(rows[0]);
    if (!rows.length) select(null);
  }

  resList = window.VList($('res-list'), {
    rowHeight: Tokens ? Tokens.num('h-row-lg', 40) : 40,
    ariaLabel: 'Forge results',
    key: (it) => lower(it.path),
    createRow() {
      const n = document.createElement('div');
      n.className = 'lrow is-lg';
      n.innerHTML =
        '<span class="lrow-main"><span class="lrow-name u-truncate"></span><span class="lrow-sub u-truncate"></span></span>' +
        '<span class="lrow-meta"><span class="tag fg-badge"></span><span class="mono small"></span></span>';
      return n;
    },
    renderRow(node, it) {
      const main = node.children[0], meta = node.children[1];
      main.children[0].textContent = Fmt.basename(it.path);
      const notes = it.notes == null ? '—' : Fmt.count(it.notes, 'note');
      const dur = it.seconds == null ? '—' : Fmt.clock(it.seconds);
      main.children[1].textContent = notes + ' · ' + dur;
      meta.children[0].textContent = BADGE[it.badge] || 'Primary';
      meta.children[0].classList.toggle('is-accent', it.badge === 'primary' || it.badge === 'clean');
      meta.children[1].textContent = Fmt.when(it.at);
      meta.children[1].title = Fmt.stamp(it.at);
      node.title = it.path;
      node.setAttribute('aria-label', Fmt.basename(it.path) + ', ' + (BADGE[it.badge] || 'Primary') + ', ' + notes);
      node.classList.toggle('is-fresh', !!it.freshUntil && Date.now() < it.freshUntil);
      ensureMeta(it);
    },
    // ONE source of truth for "what is selected". Every path that changes the
    // list's selection -- a click, an arrow key, Ctrl+A, the list's own Escape
    // (which stops propagation, so a document handler never sees it) -- lands
    // here and drives select(), so the rows and the Selected Result panel with
    // its four live hand-off buttons cannot disagree. select() re-selects
    // silently, so this does not loop.
    onSelectionChange(keys, rows) { select(rows && rows.length ? rows[rows.length - 1] : null); },
    onActivate(it) { if (Bus) Bus.send(T.NAV_OPEN_EDITOR, { projectPath: it.project || '', midiPath: it.path }); },
    onContextMenu(it, index, ev) {
      ev.preventDefault();
      window.Menu.open([
        { group: Fmt.basename(it.path) },
        { label: 'Open in Editor', icon: 'send', run: () => Bus.send(T.NAV_OPEN_EDITOR, { projectPath: it.project || '', midiPath: it.path }) },
        { label: 'Send to Player', icon: 'play', run: () => Bus.send(T.NAV_OPEN_PLAYER, { midiPath: it.path }) },
        { label: 'Listen (Self MIDI)', icon: 'keyboard', run: () => Bus.send(T.NAV_OPEN_SELFMIDI, { midiPath: it.path, projectPath: it.project || '' }) },
        { sep: true },
        { label: 'Show in folder', icon: 'folder', run: () => Bus.send(T.FILE_REVEAL, { path: it.path }) },
        { label: 'Forget this result', icon: 'close', danger: true, run: () => forget(it) },
      ], { x: ev.clientX, y: ev.clientY, ariaLabel: Fmt.basename(it.path), returnFocusTo: resList.host });
    },
  });
  keep(() => resList.destroy());
  on($('res-sort'), 'change', renderResults);

  function forget(it) {
    sessionResults = sessionResults.filter((r) => lower(r.path) !== lower(it.path));
    history = history.filter((r) => lower(r.path) !== lower(it.path));
    saveHistory();
    if (selected && lower(selected.path) === lower(it.path)) selected = null;
    renderResults();
  }

  function select(it) {
    selected = it || null;
    const panel = $('sel-panel');
    if (!selected) { panel.hidden = true; densLayer.invalidate(); densHandle.invalidate(); return; }
    panel.hidden = false;
    panel.classList.remove('is-in');
    // Force one reflow-free restart of the entrance: the class is re-added on
    // the next frame, which is the documented pattern for an enter transition.
    requestAnimationFrame(() => panel.classList.add('is-in'));
    $('sel-badge').textContent = BADGE[selected.badge] || 'Primary';
    $('sel-name').textContent = Fmt.basename(selected.path);
    $('sel-name').title = selected.path;
    $('sel-when').textContent = Fmt.when(selected.at);
    $('sel-when').title = Fmt.stamp(selected.at);
    paintSelStats();
    if (resList) resList.selectKeys([lower(selected.path)], true);
    ensureMeta(selected, true);
    densLayer.invalidate();
    densHandle.invalidate();
  }
  function paintSelStats() {
    if (!selected) return;
    $('sel-notes').textContent = selected.notes == null ? '—' : String(selected.notes);
    $('sel-dur').textContent = selected.seconds == null ? '—' : Fmt.clock(selected.seconds);
  }

  // ---- hand-off actions --------------------------------------------------
  const act = (fn) => () => { if (selected && Bus) fn(selected); };
  on($('act-editor'), 'click', act((r) => Bus.send(T.NAV_OPEN_EDITOR, { projectPath: r.project || '', midiPath: r.path })));
  on($('act-player'), 'click', act((r) => { Bus.send(T.NAV_OPEN_PLAYER, { midiPath: r.path }); logQuiet('Sent ' + Fmt.basename(r.path) + ' to the Player.'); }));
  on($('act-listen'), 'click', act((r) => Bus.send(T.NAV_OPEN_SELFMIDI, { midiPath: r.path, projectPath: r.project || '' })));
  on($('act-folder'), 'click', act((r) => Bus.send(T.FILE_REVEAL, { path: r.path })));

  // =========================================================================
  // MIDI METADATA  (note count, length, onset histogram) — lazily, cached
  // =========================================================================
  const metaCache = new Map();
  const metaPending = new Set();
  const MAX_MIDI_BYTES = 8 * 1024 * 1024;

  function ensureMeta(it, urgent) {
    if (!it || !F.fileUrl) return;
    const key = lower(it.path);
    const hit = metaCache.get(key);
    if (hit) { applyMeta(it, hit); return; }
    if (metaPending.has(key)) return;
    if (!urgent && metaPending.size >= 3) return;      // a handful per frame, never the whole list
    metaPending.add(key);
    fetch(F.fileUrl(it.path))
      .then((r) => r.arrayBuffer())
      .then((buf) => {
        if (buf.byteLength > MAX_MIDI_BYTES) throw new Error('too large');
        const m = readMidi(buf);
        metaCache.set(key, m);
        applyMeta(it, m);
      })
      .catch(() => { metaCache.set(key, { notes: null, seconds: null, onsets: [] }); })
      .then(() => { metaPending.delete(key); });
  }
  // The onset array is read back from metaCache, never stored on the row: the
  // rows ARE the history entries and history is what gets stringified.
  function onsetsFor(it) {
    if (!it) return null;
    const m = metaCache.get(lower(it.path));
    return (m && m.onsets && m.onsets.length) ? m.onsets : null;
  }
  function applyMeta(it, m) {
    let changed = false;
    if (it.notes == null && m.notes != null) { it.notes = m.notes; changed = true; }
    if (it.seconds == null && m.seconds != null) { it.seconds = m.seconds; changed = true; }
    for (const arr of [sessionResults, history]) {
      for (const r of arr) if (lower(r.path) === lower(it.path)) { r.notes = it.notes; r.seconds = it.seconds; }
    }
    if (changed) {
      saveHistory();
      if (resList) resList.refresh();
      if (selected && lower(selected.path) === lower(it.path)) { paintSelStats(); densLayer.invalidate(); densHandle.invalidate(); }
    } else if (selected && lower(selected.path) === lower(it.path)) {
      densLayer.invalidate();
      densHandle.invalidate();
    }
  }

  // A minimal Standard MIDI File reader: note-on count, end time, onset list.
  // No dependency, no new IPC channel — the file is read through the fileUrl the
  // preload already exposes.
  function readMidi(buffer) {
    const d = new DataView(buffer);
    const empty = { notes: null, seconds: null, onsets: [] };
    if (d.byteLength < 14) return empty;
    if (d.getUint32(0) !== 0x4d546864) return empty;      // 'MThd'
    const division = d.getInt16(12);
    const ntrks = d.getUint16(10);
    let p = 8 + d.getUint32(4);
    const tempos = [];                                    // {tick, usPerQuarter}
    const onsetTicks = [];
    let notes = 0, maxTick = 0;

    for (let track = 0; track < ntrks && p + 8 <= d.byteLength; track++) {
      if (d.getUint32(p) !== 0x4d54726b) break;              // 'MTrk', or give up
      const len = d.getUint32(p + 4);
      let q = p + 8;
      const end = Math.min(d.byteLength, q + len);
      let tick = 0, running = 0;
      while (q < end) {
        let shift = 0, delta = 0, byte;
        do { byte = d.getUint8(q++); delta = (delta << 7) | (byte & 0x7f); shift++; } while ((byte & 0x80) && q < end && shift < 5);
        tick += delta;
        if (q >= end) break;
        let status = d.getUint8(q);
        if (status & 0x80) { q++; running = status; } else status = running;
        const type = status & 0xf0;
        if (status === 0xff) {
          const meta = d.getUint8(q++);
          let l = 0, b;
          do { b = d.getUint8(q++); l = (l << 7) | (b & 0x7f); } while (b & 0x80 && q < end);
          if (meta === 0x51 && l >= 3) tempos.push({ tick, us: (d.getUint8(q) << 16) | (d.getUint8(q + 1) << 8) | d.getUint8(q + 2) });
          q += l;
          if (meta === 0x2f) { if (tick > maxTick) maxTick = tick; break; }
        } else if (status === 0xf0 || status === 0xf7) {
          let l = 0, b;
          do { b = d.getUint8(q++); l = (l << 7) | (b & 0x7f); } while (b & 0x80 && q < end);
          q += l;
        } else if (type === 0xc0 || type === 0xd0) {
          q += 1;
        } else {
          const vel = q + 1 < end ? d.getUint8(q + 1) : 0;
          if (type === 0x90 && vel > 0) { notes++; onsetTicks.push(tick); }
          q += 2;
        }
        if (tick > maxTick) maxTick = tick;
      }
      p = p + 8 + len;
    }

    const toSeconds = (() => {
      if (division <= 0) {                                 // SMPTE: frames per second
        const fps = -(division >> 8) || 25;
        const tpf = (division & 0xff) || 1;
        const per = 1 / (fps * tpf);
        return (t) => t * per;
      }
      const tpq = division;
      tempos.sort((a, b) => a.tick - b.tick);
      if (!tempos.length || tempos[0].tick > 0) tempos.unshift({ tick: 0, us: 500000 });
      const marks = [];
      let acc = 0;
      for (let i = 0; i < tempos.length; i++) {
        marks.push({ tick: tempos[i].tick, sec: acc, per: tempos[i].us / 1e6 / tpq });
        if (i + 1 < tempos.length) acc += (tempos[i + 1].tick - tempos[i].tick) * (tempos[i].us / 1e6 / tpq);
      }
      return (t) => {
        let m = marks[0];
        for (let i = 1; i < marks.length; i++) { if (marks[i].tick <= t) m = marks[i]; else break; }
        return m.sec + (t - m.tick) * m.per;
      };
    })();

    const onsets = new Float32Array(onsetTicks.length);
    for (let i = 0; i < onsetTicks.length; i++) onsets[i] = toSeconds(onsetTicks[i]);
    return { notes, seconds: toSeconds(maxTick), onsets };
  }

  // ---- note-density strip ------------------------------------------------
  const densLayer = new Draw.LayerCache();
  keep(() => densLayer.dispose());
  const densHandle = Draw.register({
    key: 'forge:density',
    el: $('dens-host'),
    idleMs: 500,
    draw() {
      const host = $('dens-host');
      if (host.clientWidth < 4) return;
      const geo = Draw.fitCanvas($('dens'), host.clientWidth, host.clientHeight);
      if (geo.resized) densLayer.invalidate();
      const ons = onsetsFor(selected);
      const key = selected ? lower(selected.path) + '|' + (ons ? ons.length : 0) : 'none';
      densLayer.paint(geo.w, geo.h, key + '|' + Tokens.themeKey(), (ctx, g) => paintDensity(ctx, g));
      densLayer.blit(geo.ctx, 0, 0);
    },
  });
  keep(() => densHandle.dispose());

  function paintDensity(ctx, g) {
    ctx.fillStyle = Tokens.get('bg-2', '#0f1013');
    ctx.fillRect(0, 0, g.w, g.h);
    const onsets = onsetsFor(selected);
    const span = selected && selected.seconds ? selected.seconds : 0;
    if (!onsets || !onsets.length || !span) {
      ctx.fillStyle = Tokens.get('text-3', '#868a92');
      ctx.font = '12px ' + Tokens.get('font-mono', 'monospace');
      ctx.textBaseline = 'middle';
      ctx.fillText('no data', 8, g.h / 2);
      return;
    }
    const cols = Math.max(8, Math.floor(g.w / 3));
    const hist = new Uint32Array(cols);
    for (let i = 0; i < onsets.length; i++) {
      const c = clamp(Math.floor((onsets[i] / span) * cols), 0, cols - 1);
      hist[c]++;
    }
    let peak = 1;
    for (let i = 0; i < cols; i++) if (hist[i] > peak) peak = hist[i];
    const bw = g.w / cols;
    ctx.fillStyle = Tokens.get('accent', '#b8e62e');
    for (let i = 0; i < cols; i++) {
      if (!hist[i]) continue;
      const h = Math.max(1, (hist[i] / peak) * (g.h - 4));
      ctx.fillRect(i * bw, g.h - h - 2, Math.max(1, bw - 1), h);
    }
    ctx.strokeStyle = Tokens.get('line', '#2b2e36');
    ctx.beginPath();
    ctx.moveTo(0, g.h - 1.5);
    ctx.lineTo(g.w, g.h - 1.5);
    ctx.stroke();
  }

  // =========================================================================
  // ENGINE VERDICT + SETUP MODAL
  // =========================================================================
  function setEnv(kind, text) {
    const chip = $('env-chip');
    chip.className = 'pill fg-env' + (kind ? ' is-' + kind : '');
    $('env-dot').className = 'dot' + (kind === 'ok' ? ' ok' : kind === 'err' ? ' err' : kind === 'warn' ? ' warn' : '');
    $('env-text').textContent = text;
    chip.title = text + (envMissing.length ? '\nMissing: ' + envMissing.join(', ') : '') + '\nClick to open first-time setup.';
  }

  async function refreshStorage() {
    if (!S.forgeInfo) return;
    let info = null;
    try { info = await S.forgeInfo(); } catch (_) { return; }
    if (!info) return;
    setPathChip($('setup-dirchip'), $('setup-dir'), $('setup-dirname'), info.forgeEnvDir, 'not set');
    const free = info.forgeFreeGb;
    $('setup-free').textContent = free == null ? '' : free + ' GB free';
    $('setup-free').classList.toggle('is-low', free != null && free < 15);
  }

  async function refreshEnv() {
    // Paint what the probe said last time FIRST. Probing imports torch and takes
    // tens of seconds; a blank chip for half a minute reads as broken.
    let cached = null;
    try { cached = JSON.parse(localStorage.getItem(ENV_CACHE_KEY) || 'null'); } catch (_) {}
    if (cached && cached.forgeReady) {
      envReady = true;
      envGpu = cached.gpu || '';
      setEnv('ok', envGpu ? 'Ready · ' + envGpu : 'Ready · CPU');
      updateStart();
    } else {
      setEnv('warn', 'Checking engine…');
    }
    refreshStorage();
    let s = null;
    try { s = await F.check(); } catch (_) { s = { forgeReady: false }; }
    envReady = !!(s && s.forgeReady);
    envGpu = (s && s.gpu) || '';
    envMissing = (s && s.missing) || [];
    try { localStorage.setItem(ENV_CACHE_KEY, JSON.stringify({ forgeReady: envReady, gpu: envGpu })); } catch (_) {}
    if (envReady) {
      setEnv('ok', envGpu ? 'Ready · ' + envGpu : 'Ready · CPU (slow)');
      if (!envGpu && !cpuNoticeShown) {
        cpuNoticeShown = true;
        logLine('No GPU detected. Piano and Full Song take 20 to 40 minutes per song here. Fast finishes in a couple of minutes at lower quality.', { level: 'warn' });
      }
      closeSetup();
    } else {
      setEnv('err', 'Not set up' + (envMissing.length ? ' · missing ' + envMissing.join(', ') : ''));
    }
    // The GPU is only ever known here, and the probe is expensive: share it so
    // the shell can cache the verdict for the next cold start.
    if (Bus) Bus.send(T.FORGE_STATUS, { event: 'forge.env', forgeReady: envReady, gpu: envGpu, missing: envMissing });
    updateStart();
  }
  on($('env-recheck'), 'click', refreshEnv);

  // ---- modal -------------------------------------------------------------
  let setupReturn = null;
  function openSetup() {
    const scrim = $('setup-scrim');
    if (!scrim.hidden) return;
    setupReturn = document.activeElement;
    scrim.hidden = false;
    requestAnimationFrame(() => scrim.classList.add('is-open'));
    refreshStorage();
    const focusable = $('setup').querySelector('button:not([hidden]):not(:disabled)');
    if (focusable) focusable.focus();
  }
  function closeSetup() {
    const scrim = $('setup-scrim');
    if (scrim.hidden) return;
    scrim.classList.remove('is-open');
    later(140, () => { scrim.hidden = true; });
    if (setupReturn && setupReturn.focus) { try { setupReturn.focus(); } catch (_) {} }
    setupReturn = null;
  }
  on($('env-chip'), 'click', openSetup);
  on($('setup-open'), 'click', openSetup);
  on($('setup-x'), 'click', closeSetup);
  on($('setup-scrim'), 'pointerdown', (e) => { if (e.target === $('setup-scrim')) closeSetup(); });
  on($('setup'), 'keydown', (e) => {
    if (e.key !== 'Tab') return;
    const items = Array.from($('setup').querySelectorAll('button, [href], input, select, textarea'))
      .filter((el) => !el.disabled && !el.hidden && el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  on(document, 'keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('setup-scrim').hidden) { e.preventDefault(); closeSetup(); return; }
    // Not silent: onSelectionChange is what clears `selected` and hides the
    // Selected Result panel, so the two halves of the column stay in step.
    if (selected && resList) { e.preventDefault(); resList.clearSelection(); }
  });

  if (S.getVersion) S.getVersion().then((v) => { $('setup-version').textContent = 'v' + v; }).catch(() => {});

  on($('setup-change'), 'click', async () => {
    if (!S.changeForgeFolder) return;
    const b = $('setup-change');
    const label = b.textContent;
    b.disabled = true;
    b.textContent = 'Moving…';
    try {
      const r = await S.changeForgeFolder();
      if (r && r.ok) { logLine('Forge storage: ' + r.forgeEnvDir); refreshEnv(); refreshStorage(); }
      else if (r && !r.canceled) logLine((r && r.error) || 'Could not change the Forge folder.', { level: 'error' });
    } finally { b.disabled = false; b.textContent = label; }
  });
  on($('setup-log'), 'click', async () => {
    if (!S.openSetupLog) return;
    const r = await S.openSetupLog();
    if (r && !r.ok) logLine(r.error || 'No setup log yet. It appears once setup starts.', { level: 'warn' });
  });
  on($('setup-copy'), 'click', () => copyLog('the setup log'));
  on($('diag-log'), 'click', () => { if (S.openSetupLog) S.openSetupLog(); });
  on($('diag-copy'), 'click', () => copyLog('this tab’s log'));
  on($('log-copy'), 'click', () => copyLog('the log'));
  on($('log-clear'), 'click', () => { logLines.length = 0; refreshLog(); });

  async function copyLog(what) {
    const text = logLines.map((l) => l.text).join('\n');
    try {
      await navigator.clipboard.writeText(text || '(' + what + ' is empty)');
      logQuiet('Copied ' + what + ' to the clipboard.');
    } catch (_) {
      logQuiet('Could not copy. Use "Open setup log" instead.');
    }
  }

  // ---- provisioning ------------------------------------------------------
  let setupStarted = 0, setupTimer = 0, setupSilence = 0, setupHeard = false;
  function startSetupTimer() {
    setupStarted = Date.now();
    clearInterval(setupTimer);
    setupTimer = setInterval(() => {
      const s = Math.floor((Date.now() - setupStarted) / 1000);
      $('setup-elapsed').textContent = Fmt.clockPad(s) + ' elapsed';
    }, 1000);
    disposers.push(() => clearInterval(setupTimer));
  }
  function stopSetupTimer() {
    clearInterval(setupTimer); setupTimer = 0;
    clearTimeout(setupSilence); setupSilence = 0;
    $('setup-elapsed').textContent = '';
  }
  function noteSetupOutput() { setupHeard = true; clearTimeout(setupSilence); setupSilence = 0; }

  on($('setup-start'), 'click', async () => {
    try {
      if (S.forgeInfo) {
        try {
          const info = await S.forgeInfo();
          const needGb = (info && info.forgeNeedGb) || 15;
          if (info && info.forgeFreeGb != null && info.forgeFreeGb < needGb) {
            logLine('Only ' + info.forgeFreeGb + ' GB free on ' + info.forgeEnvDir + ' — setup needs about ' + needGb + ' GB.', { level: 'warn' });
            if (!window.confirm('That drive has ' + info.forgeFreeGb + ' GB free and setup needs about ' + needGb
              + ' GB. Use "Change folder…" to install the engine on another drive. Start anyway?')) return;
          }
        } catch (_) { /* advisory only */ }
      }
      $('setup-start').disabled = true;
      $('setup-cancel').hidden = false;
      $('setup-prog').hidden = false;
      $('setup-step').textContent = 'Starting…';
      $('setup-msg').textContent = '';
      startSetupTimer();
      setupHeard = false;
      // Nothing coming back at all must look like a failure, not like progress.
      clearTimeout(setupSilence);
      setupSilence = setTimeout(() => {
        if (setupHeard) return;
        $('setup-step').textContent = 'Setup did not start';
        $('setup-msg').textContent = 'No response from the setup process. Open the setup log, or use "Change folder…" and pick a folder inside your user profile.';
        $('setup-start').disabled = false;
        $('setup-cancel').hidden = true;
        stopSetupTimer();
      }, 12000);
      await F.provision();
    } catch (error) {
      // A thrown handler used to leave the panel on its placeholder with no error
      // anywhere, which is indistinguishable from a hang.
      stopSetupTimer();
      $('setup-step').textContent = 'Setup could not start';
      $('setup-msg').textContent = String((error && error.message) || error);
      $('setup-start').disabled = false;
      $('setup-cancel').hidden = true;
      logLine('Setup could not start: ' + String((error && error.message) || error), { level: 'error' });
    }
  });
  on($('setup-cancel'), 'click', () => {
    if (!window.confirm('Cancel Forge setup? It resumes where it stopped when you start it again.')) return;
    $('setup-cancel').textContent = 'Cancelling…';
    if (F.cancelProvision) F.cancelProvision();
  });

  // =========================================================================
  // STATUS STREAM  (IPC only — forge.log / forge.progress are not mirrored)
  // =========================================================================
  if (F.onStatus) keep(F.onStatus((s) => {
    if (!s || typeof s !== 'object') return;
    if (typeof s.event === 'string' && s.event.indexOf('forge.provision') === 0) noteSetupOutput();
    switch (s.event) {
      case 'forge.provision.progress': {
        $('setup-prog').hidden = false;
        $('setup-step').textContent = s.step || 'Working…';
        const indet = s.percent == null || s.percent < 0;
        const fill = $('setup-bar');
        fill.classList.toggle('indet', indet);
        fill.style.setProperty('--p', indet ? '0' : String(clamp(s.percent, 0, 100) / 100));
        $('setup-pct').textContent = indet ? '' : s.percent + '%';
        if (indet) $('setup-barwrap').removeAttribute('aria-valuenow');
        else $('setup-barwrap').setAttribute('aria-valuenow', String(Math.round(s.percent)));
        $('setup-msg').textContent = s.message || '';
        break;
      }
      case 'forge.provision.log':
        logLine(s.line, { localOnly: true });
        break;
      case 'forge.provision.done':
        stopSetupTimer();
        $('setup-msg').textContent = 'Done.';
        $('setup-cancel').hidden = true;
        $('setup-cancel').textContent = 'Cancel';
        $('setup-start').disabled = false;
        $('setup-start').textContent = 'Set up Forge';
        refreshEnv();
        break;
      case 'forge.provision.error': {
        stopSetupTimer();
        const cancelled = /cancel/i.test(s.message || '');
        $('setup-msg').textContent = (cancelled ? '' : 'Failed: ') + (s.message || 'Setup failed.');
        $('setup-cancel').hidden = true;
        $('setup-cancel').textContent = 'Cancel';
        $('setup-start').disabled = false;
        $('setup-start').textContent = cancelled ? 'Set up Forge' : 'Retry setup';
        break;
      }
      case 'forge.progress': {
        if (s.stage) lastStage = s.stage;
        const mapped = STAGE_OF[lower(s.stage)];
        if (mapped) setStage(mapped);
        const pct = Number(s.percent);
        if (Number.isFinite(pct) && pct >= 0) {
          const next = Math.max(jobPercent == null ? 0 : jobPercent, pct);   // monotonic
          if (next !== jobPercent) { jobPercent = next; jobPctSeenAt = Date.now(); }
        } else if (jobPercent == null) {
          jobPctSeenAt = Date.now();
        }
        if (!jobPaused && currentStage) stageEl[currentStage].querySelector('.stg-name').title = s.stage || '';
        paintClock();
        break;
      }
      case 'forge.log':
        // Already on its way to the shell's drawer over IPC — do not resend.
        logLine(s.line, { localOnly: true, level: s.level === 'error' ? 'error' : undefined });
        break;
      case 'forge.paused':
        jobPaused = !!s.paused;
        applyPaused();
        paintClock();
        break;
      case 'forge.done':
        onDone(s);
        break;
      default:
        break;
    }
  }));

  function onDone(s) {
    const wasSkipped = skipRequested;
    skipRequested = false;
    endJob();
    if (wasSkipped) {
      logLine('Skipped.', { level: 'warn' });
      setJobPill('warn', 'Skipped');
    } else if (s.ok) {
      const result = s.result || {};
      if (result.downloadedPath) {
        setStage('done');
        markDone('done', Date.now());
        setJobPill('ok', 'Downloaded');
        addInputs([result.downloadedPath], 'replace');
        logLine('Downloaded ' + Fmt.basename(result.downloadedPath), { level: 'ok' });
        if (Bus) Bus.send(T.UI_TOAST, { severity: 'ok', title: 'Downloaded', message: Fmt.basename(result.downloadedPath), key: 'forge-dl' });
        $('url').value = '';
      } else if (result.midiPath) {
        jobPercent = 100;
        jobPctSeenAt = Date.now();
        setStage('done');
        markDone('done', Date.now());
        activeState = 'done';
        currentProject = result.projectPath || '';
        setJobPill('ok', 'Complete');
        $('prog-foot').textContent = 'Finished in ' + Fmt.duration(Math.max(1, Math.round((Date.now() - jobStartedAt) / 1000))) + '.';
        addResults(result, pipeline);
        logLine('Done: ' + result.midiPath, { level: 'ok' });
      }
    } else {
      activeState = /cancel/i.test(s.error || '') ? 'cancelled' : 'failed';
      showError(s.error || 'The job failed.');
      // The shell already toasts a failed forge.done from its own IPC listener.
      logLine((s.error || 'failed'), { localOnly: true, level: 'error' });
    }
    // One failure must not strand the rest of the batch.
    if ((runningQueue || wasSkipped) && queue.length && autoContinue()) {
      autoAdvancing = true;
      setInput(queue.shift());
      autoAdvancing = false;
      startJob();
    } else {
      runningQueue = false;
      if (wasSkipped) setInput('');
      renderQueue();
    }
  }

  // =========================================================================
  // COMMANDS  (§11.5 — the shell drives forge.setup and forge.recheck by id)
  // =========================================================================
  if (window.Commands) {
    window.Commands.setScope(FRAME);
    keep(window.Commands.registerAll([
      { id: 'forge.setup', label: 'Forge: first-time setup', keywords: ['install', 'provision', 'engine', 'download'], group: 'Forge', run: () => { railTabs.select(2, false); openSetup(); } },
      { id: 'forge.recheck', label: 'Forge: re-check the engine', keywords: ['probe', 'gpu', 'torch'], group: 'Forge', run: refreshEnv },
      { id: 'forge.start', label: 'Forge: start transcribing', keywords: ['run', 'go', 'convert'], group: 'Forge', enabled: () => !!(envReady && inputPath && !busy), run: () => { runningQueue = queue.length > 0; startJob(); } },
      { id: 'forge.cancel', label: 'Forge: cancel the job', group: 'Forge', danger: true, enabled: () => busy, run: () => $('cancel').click() },
      { id: 'forge.pause', label: 'Forge: pause or resume the job', group: 'Forge', enabled: () => busy, run: () => $('pause').click() },
      { id: 'forge.skip', label: 'Forge: skip this song', group: 'Forge', enabled: () => busy, run: skipCurrent },
      { id: 'forge.browse', label: 'Forge: choose an audio file', keywords: ['open', 'input'], group: 'Forge', run: () => browse('replace') },
      { id: 'forge.addQueue', label: 'Forge: add files to the queue', group: 'Forge', run: () => browse('queue') },
      { id: 'forge.clearQueue', label: 'Forge: clear the waiting queue', group: 'Forge', enabled: () => queue.length > 0, run: () => $('queue-clear').click() },
      { id: 'forge.undoQueue', label: 'Forge: undo the last queue change', group: 'Forge', enabled: () => !!queueUndo && !busy, run: () => $('queue-undo').click() },
      { id: 'forge.outputFolder', label: 'Forge: change the output folder', group: 'Forge', run: () => $('pick-out').click() },
      { id: 'forge.preview', label: 'Forge: play or pause the audio preview', group: 'Forge', enabled: () => !!inputPath, run: togglePreview },
      { id: 'forge.fitZoom', label: 'Forge: fit the whole song in the waveform', group: 'Forge', run: () => zoom.reset() },
      { id: 'forge.advanced', label: 'Forge: show Advanced Options', group: 'Forge', run: () => { railTabs.select(2, false); if ($('adv').hidden) $('adv-toggle').click(); $('adv-toggle').focus(); } },
      { id: 'forge.log', label: 'Forge: show the pipeline log', group: 'Forge', run: () => progTabs.select(1, false) },
      { id: 'forge.copyLog', label: 'Forge: copy the pipeline log', group: 'Forge', run: () => copyLog('the log') },
      { id: 'forge.openResult', label: 'Forge: open the last result in the Editor', group: 'Forge', enabled: () => !!selected, run: () => $('act-editor').click() },
      { id: 'forge.sendPlayer', label: 'Forge: send the last result to the Player', group: 'Forge', enabled: () => !!selected, run: () => $('act-player').click() },
      { id: 'forge.listen', label: 'Forge: listen to the last result in Self MIDI', group: 'Forge', enabled: () => !!selected, run: () => $('act-listen').click() },
      { id: 'forge.revealResult', label: 'Forge: show the last result in its folder', group: 'Forge', enabled: () => !!selected, run: () => $('act-folder').click() },
    ]));
  }

  // =========================================================================
  // BUS WIRING
  // =========================================================================
  if (Bus) {
    keep(Bus.on(T.NAV_OPEN_FORGE, (p) => {
      if (!p) return;
      const paths = [];
      if (Array.isArray(p.inputPaths)) paths.push(...p.inputPaths);
      if (p.inputPath) paths.unshift(p.inputPath);
      if (paths.length) addInputs(paths, 'replace');
      if (p.url) { $('url').value = String(p.url); railTabs.select(0, false); $('url').focus(); }
    }));
    // The source panel flashes the row a file came from. Ours are result rows.
    keep(Bus.on(T.FILE_OPEN, (p) => {
      if (!p || p.from !== FRAME || !p.path) return;
      const row = (resultTab === 'history' ? history : sessionResults).find((r) => lower(r.path) === lower(p.path));
      if (!row) return;
      row.freshUntil = Date.now() + 500;
      if (resList) resList.refresh();
      later(520, () => { if (resList) resList.refresh(); });
    }));
    const reRow = () => {
      const h = queueRowHeight();
      if (queueList) queueList.rowHeight(h);
      if (resList) resList.rowHeight(h);
      waveLayer.invalidate();
      waveHandle.invalidate();
    };
    on(window, 'midi-studio:density', reRow);
    keep(Bus.on(T.UI_DENSITY, reRow));
    on(window, 'midi-studio:onscreen', () => { waveHandle.invalidate(); densHandle.invalidate(); });
  }

  // =========================================================================
  // TEARDOWN
  // =========================================================================
  function teardown() {
    persistTiming.flush();
    persistColumns.flush();
    flushSettings.flush();
    saveQueue.flush();
    saveHistory.flush();
    savePreviewPrefs.flush();
    waveToken++;
    try { audio.pause(); } catch (_) {}
    for (const d of disposers.splice(0)) { try { d(); } catch (_) {} }
  }
  window.addEventListener('pagehide', teardown);
  window.addEventListener('beforeunload', teardown);

  // =========================================================================
  // BOOT
  // =========================================================================
  logList = window.VList($('log'), {
    rowHeight: 18,
    ariaLabel: 'Pipeline log',
    selectable: 'multi',
    key: (it, i) => i,
    createRow() {
      const n = document.createElement('div');
      n.className = 'lrow';
      return n;
    },
    renderRow(node, it) {
      node.textContent = it.text;
      // Keep vlist-row: it is what supplies position:absolute + pointer-events
      // inside the pointer-events:none sizer. Dropping it let .lrow's own
      // position:relative lay every row out in flow AS WELL as translating it.
      node.className = 'vlist-row lrow is-' + it.level;
    },
  });
  keep(() => logList.destroy());

  applyVolume(previewPrefs.audioVolume);
  syncStems();
  syncSameName();
  syncQuality();
  syncPipelineUI();
  syncTimingControls();
  syncPreviewButtons();
  resetStages();
  setJobPill('', 'Idle');
  loadHistory();
  renderResults();
  applyColumns();

  if (F.getOutputDir) {
    F.getOutputDir().then((d) => { defaultOutDir = d || ''; syncOutput(); }).catch(() => {});
  }

  if (F.getSettings) {
    F.getSettings().then((s) => {
      if (!s) return;
      if (s.pipeline) setPipeline(s.pipeline, false);
      $('c-stems').value = s.skipSeparation ? 'skip' : 'separate';
      syncStems();
      if (s.timing) {
        timeEnabled = !!s.timing.enabled;
        $('time-start').value = s.timing.start || '';
        $('time-end').value = s.timing.end || '';
      }
      if (s.outputDir) outputDir = s.outputDir;
      restoreAdvanced(s.advanced);
      qualityOverride = null;       // what is on disk is not a "manual edit"
      syncQuality();
      syncPipelineUI();
      syncTimingControls();
      syncOutput();
      updateStart();
    }).catch(() => {});
  }

  if (S.getUi) {
    S.getUi().then((u) => {
      uiColumns = (u && u.forgeColumns) || {};
      railCollapsed = !!uiColumns.rail;
      inspCollapsed = !!uiColumns.insp;
      waveCollapsed = !!uiColumns.wave;
      applyColumns();
      waveHandle.invalidate();
    }).catch(() => {});
  }

  // Size changes go through a ResizeObserver, never a raw window resize handler.
  // resize.js also dispatches a synthetic window resize on every divider commit,
  // which the observer already covers; the extra listener below is only for the
  // browsers that have no ResizeObserver.
  const invalidateCanvases = coalesce(() => {
    waveLayer.invalidate(); waveHandle.invalidate();
    densLayer.invalidate(); densHandle.invalidate();
  });
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(invalidateCanvases);
    ro.observe(waveHost);
    ro.observe($('dens-host'));
    keep(() => ro.disconnect());
  } else {
    on(window, 'resize', invalidateCanvases);
  }
  if (Tokens) keep(Tokens.onChange(invalidateCanvases));

  restoreQueue();
  renderQueue();
  syncOutput();
  updateStart();
  window.Icon.apply(document);
  syncPreviewButtons();
  waveHandle.invalidate();
  densHandle.invalidate();

  // 6. The handshake. Everything above is wired, so a queued hand-off can be
  // delivered the moment this lands.
  if (Bus) Bus.send(T.FRAME_READY, { frame: FRAME, title: 'Forge' });

  // The env probe costs tens of seconds of Python; it must not delay first paint
  // or the handshake.
  later(250, refreshEnv);

  // Legacy hand-off entry point, harmless once frame:ready has been sent.
  window.setForgeInput = (p) => { if (p) addInputs([p], 'replace'); };
  window.refreshForgeEnvironment = refreshEnv;
})();

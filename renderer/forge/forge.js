// forge.js — Midi Forge tab controller. Drives window.forge.
(() => {
  const F = window.forge;
  const Review = window.review;
  // self-apply saved theme on load (shell also pushes it live on change)
  if (window.studio && studio.getUi) studio.getUi().then((u) => { if (u && u.theme) document.documentElement.dataset.theme = u.theme; }).catch(() => {});
  const $ = (id) => document.getElementById(id);
  const ADV_KEYS = ['USE_TTA', 'LOUDNESS_NORM', 'BIGSHIFTS', 'SEGMENT_HOP', 'VELOCITY_GAMMA',
    'MIN_NOTE_SEC', 'MIN_VELOCITY', 'PIANO_MIN_PITCH', 'PIANO_MAX_PITCH',
    'BP_ONSET_THRESHOLD', 'BP_FRAME_THRESHOLD', 'BP_MIN_NOTE_MS',
    'MAX_POLYPHONY', 'OCTAVE_FOLD', 'EXCLUDE_VOCALS', 'ONSET_DELTA', 'DRUM_MIN_GAP_MS',
    'MELODY_MIN_PITCH', 'MELODY_MAX_PITCH', 'MELODY_ONSET_THRESHOLD', 'MELODY_MIN_NOTE_MS',
    'MELODY_DENSITY', 'MELODY_FOLD'];
  const ADV_DEFAULTS = {
    USE_TTA: false, LOUDNESS_NORM: true, BIGSHIFTS: 1, SEGMENT_HOP: '',
    VELOCITY_GAMMA: 0.85, MIN_NOTE_SEC: 0.05, MIN_VELOCITY: 20,
    PIANO_MIN_PITCH: 21, PIANO_MAX_PITCH: 108, BP_ONSET_THRESHOLD: 0.5,
    BP_FRAME_THRESHOLD: 0.3, BP_MIN_NOTE_MS: 120, MAX_POLYPHONY: 0,
    OCTAVE_FOLD: true, EXCLUDE_VOCALS: false, ONSET_DELTA: 0.07,
    DRUM_MIN_GAP_MS: 50, MELODY_MIN_PITCH: 45, MELODY_MAX_PITCH: 100,
    MELODY_ONSET_THRESHOLD: 0.42, MELODY_MIN_NOTE_MS: 45,
    MELODY_DENSITY: 13, MELODY_FOLD: true,
  };

  const PIPELINE_HINT = {
    melody: '⚠ Prototype — tuned for dense, fast electronic music (artcore/Camellia-style layering). Tracks the lead line across layers, removes octave doubles, and caps how many notes a second it hands you. Use Piano or General if the output disappoints.',
    piano: 'Separate + Transkun on the piano stem — best for piano performances.',
    general: 'Separate, mix every pitched stem, then Transkun — best for full songs (any genre).',
    fast: 'basic-pitch straight on the audio — quick and rough, lower quality.',
    drums: 'Separate, then classify each drum hit (kick/snare/hats/cymbals) — for Roblox drum kits.',
  };

  // Show only the tuning group relevant to the selected pipeline.
  function syncPipelineUI() {
    document.querySelectorAll('.adv-group').forEach((g) => { g.hidden = (g.dataset.group !== pipeline); });
    const h = document.getElementById('pipeline-hint');
    if (h && PIPELINE_HINT[pipeline]) h.textContent = PIPELINE_HINT[pipeline];
    const ri = $('run-info-pipeline'); if (ri) ri.textContent = pipeline;
    const ro = $('run-info-out');
    if (ro) ro.textContent = ($('out-dir').textContent || '').split(/[\\/]/).slice(-2).join('\\') || '—';
  }
  const AUDIO_EXT = /\.(mp3|wav|flac|m4a|ogg|opus|aac|wma)$/i;
  const MIDI_EXT = /\.midi?$/i;

  let envReady = false, busy = false, inputPath = '', pipeline = 'melody', cpuNoticeShown = false;
  let currentJob = null, pendingCancel = false, outputDir = '', currentProject = '';
  let activeState = 'ready', skipRequested = false;
  let previewTimer = null;
  let wavePeaks = [], waveDuration = 0, waveToken = 0, waveDrag = null, audioCtx = null;
  const PREVIEW_PREFS_KEY = 'midi-forge.preview-prefs.v1';
  let previewPrefs = { audioVolume: 80 };
  try { previewPrefs = { ...previewPrefs, ...JSON.parse(localStorage.getItem(PREVIEW_PREFS_KEY) || '{}') }; } catch (_) {}

  // ---- queue ----------------------------------------------------------------
  // Extra inputs to convert after the current one, run strictly one at a time
  // (each job already saturates the GPU, so parallelism would only thrash).
  let queue = [], runningQueue = false, queueUndo = null;
  const QUEUE_STORAGE_KEY = 'midi-forge.queue.v1';

  function saveQueue() {
    try {
      localStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify({
        current: activeState === 'done' ? '' : (inputPath || ''),
        waiting: queue.slice(0, 100),
      }));
    } catch (_) {}
  }

  function restoreQueue() {
    try {
      const saved = JSON.parse(localStorage.getItem(QUEUE_STORAGE_KEY) || '{}');
      const current = typeof saved.current === 'string' && AUDIO_EXT.test(saved.current)
        ? saved.current : '';
      const waiting = Array.isArray(saved.waiting)
        ? saved.waiting.filter((p) => typeof p === 'string' && AUDIO_EXT.test(p))
        : [];
      const seen = new Set();
      const unique = [current, ...waiting].filter((p) => {
        if (!p) return false;
        const key = p.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (unique.length) {
        const restoredCount = unique.length;
        setInput(unique.shift());
        queue = unique;
        activeState = 'ready';
        logLine(`Restored ${restoredCount} song${restoredCount === 1 ? '' : 's'} from your last session.`);
      }
    } catch (_) {}
  }

  function rememberQueue() {
    queueUndo = { inputPath, activeState, queue: queue.slice() };
    $('queue-undo').hidden = false;
  }

  function openQueue() {
    $('queue-wrap').classList.remove('is-collapsed');
    $('queue-toggle').setAttribute('aria-expanded', 'true');
  }

  function renderQueue() {
    const list = $('queue-list');
    const waiting = queue.length;
    $('queue-count').textContent = String(waiting + (inputPath ? 1 : 0));
    $('queue-toggle').classList.toggle('has-items', waiting > 0);
    $('queue-toggle').title = waiting ? `${waiting} song${waiting === 1 ? '' : 's'} waiting` : 'Nothing queued';
    list.innerHTML = '';
    if (inputPath) list.appendChild(queueItem(inputPath, -1));
    queue.forEach((p, i) => list.appendChild(queueItem(p, i)));
    if (!inputPath && !queue.length) {
      const li = document.createElement('li');
      li.className = 'qi-empty';
      li.textContent = 'Empty — drop or browse several files to batch them.';
      list.appendChild(li);
    }
    saveQueue();
  }
  function queueItem(path, i) {
    const li = document.createElement('li');
    const active = i < 0;
    li.className = active ? `is-running is-${activeState}` : '';
    const name = document.createElement('span');
    name.className = 'qi-name'; name.textContent = path.split(/[\\/]/).pop(); name.title = path;
    const state = document.createElement('span');
    state.className = 'qi-state'; state.textContent = active ? (busy ? 'running' : activeState) : 'queued';
    li.append(name, state);
    if (active) {
      const action = document.createElement('button');
      action.className = busy ? 'qi-skip' : 'qi-x';
      action.type = 'button';
      action.title = busy ? 'Skip this song and continue the queue' : 'Remove current song';
      action.textContent = busy ? '⏭' : '✕';
      action.addEventListener('click', () => busy ? skipCurrent() : removeActive());
      li.appendChild(action);
    } else {
      const up = document.createElement('button');
      up.className = 'qi-move'; up.type = 'button'; up.title = 'Move up'; up.textContent = '↑'; up.disabled = i === 0;
      up.addEventListener('click', () => { if (i < 1) return; rememberQueue(); [queue[i - 1], queue[i]] = [queue[i], queue[i - 1]]; renderQueue(); });
      const down = document.createElement('button');
      down.className = 'qi-move'; down.type = 'button'; down.title = 'Move down'; down.textContent = '↓'; down.disabled = i === queue.length - 1;
      down.addEventListener('click', () => { if (i >= queue.length - 1) return; rememberQueue(); [queue[i], queue[i + 1]] = [queue[i + 1], queue[i]]; renderQueue(); });
      name.classList.add('is-clickable');
      name.title = busy ? path : `${path}\n(click to make this the current song)`;
      name.addEventListener('click', () => {
        if (busy) return;
        rememberQueue();
        const picked = queue.splice(i, 1)[0];
        if (inputPath) queue.unshift(inputPath);
        setInput(picked); renderQueue(); updateStart();
      });
      const x = document.createElement('button');
      x.className = 'qi-x'; x.type = 'button'; x.title = 'Remove from queue'; x.textContent = '✕';
      x.addEventListener('click', () => { rememberQueue(); queue.splice(i, 1); renderQueue(); updateStart(); });
      li.append(up, down, x);
    }
    return li;
  }
  function addInputs(paths, mode = 'smart') {
    const raw = (paths || []).filter(Boolean);
    if (!raw.length) return;
    rememberQueue();
    if (mode === 'replace' && !busy) {
      const chosen = raw.shift();
      queue = queue.filter((p) => p.toLowerCase() !== chosen.toLowerCase());
      setInput(chosen);
    }
    const seen = new Set([inputPath, ...queue].filter(Boolean).map((p) => p.toLowerCase()));
    const ps = raw.filter((p) => !seen.has(p.toLowerCase()) && seen.add(p.toLowerCase()));
    if (mode === 'smart' && !busy && !inputPath && ps.length) setInput(ps.shift());
    queue.push(...ps);
    if (ps.length) openQueue();      // show what was just added, so a mistake is visible
    renderQueue(); updateStart();
  }
  $('queue-toggle').addEventListener('click', () => {
    const wrap = $('queue-wrap');
    const collapsed = wrap.classList.toggle('is-collapsed');
    $('queue-toggle').setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  });
  $('queue-clear').addEventListener('click', () => { if (!queue.length) return; rememberQueue(); queue = []; renderQueue(); updateStart(); });
  $('queue-undo').addEventListener('click', () => {
    if (!queueUndo || busy) return;
    const now = { inputPath, activeState, queue: queue.slice() };
    const previous = queueUndo;
    queueUndo = now;
    queue = previous.queue.slice();
    if (previous.inputPath !== inputPath) setInput(previous.inputPath);
    activeState = previous.activeState || 'ready';
    renderQueue(); updateStart();
  });

  function removeActive() {
    if (busy || !inputPath) return;
    rememberQueue();
    if (queue.length) setInput(queue.shift());
    else setInput('');
    renderQueue(); updateStart();
  }

  function skipCurrent() {
    if (!busy) { removeActive(); return; }
    skipRequested = true;
    runningQueue = queue.length > 0;
    if (currentJob) F.cancel(currentJob);
    else pendingCancel = true;
    logLine('Skipping current song…');
    renderQueue();
  }

  const logLine = (t) => { const el = $('log'); el.textContent += t + '\n'; el.scrollTop = el.scrollHeight; };

  // ---- waveform editor ------------------------------------------------------
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  function formatClock(sec) {
    sec = Math.max(0, Number(sec) || 0);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    const ms = Math.floor((sec - Math.floor(sec)) * 1000);
    return `${h ? `${String(h).padStart(2, '0')}:` : ''}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
  }
  function savePreviewPrefs() {
    try { localStorage.setItem(PREVIEW_PREFS_KEY, JSON.stringify(previewPrefs)); } catch (_) {}
  }
  function buildPeaks(buffer, buckets) {
    const data = buffer.getChannelData(0);
    const peaks = [];
    const stride = Math.max(1, Math.floor(data.length / buckets));
    for (let i = 0; i < buckets; i++) {
      const a = i * stride, b = Math.min(data.length, a + stride);
      let min = 1, max = -1;
      for (let j = a; j < b; j++) {
        const v = data[j];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      peaks.push([min, max]);
    }
    return peaks;
  }
  function waveRange() {
    const t = collectTiming();
    if (!t.enabled || Number.isNaN(t.start) || Number.isNaN(t.end)) {
      return { enabled: false, start: 0, end: waveDuration || 0 };
    }
    const start = clamp(t.start || 0, 0, waveDuration || Number.MAX_SAFE_INTEGER);
    const end = t.end == null ? (waveDuration || start) : clamp(t.end, 0, waveDuration || t.end);
    return { enabled: true, start, end: Math.max(start, end) };
  }
  function updateTimeReadout() {
    const a = $('preview-audio');
    const now = Number.isFinite(a.currentTime) ? a.currentTime : 0;
    const total = waveDuration || (Number.isFinite(a.duration) ? a.duration : 0);
    const range = waveRange();
    const sel = range.enabled && range.end > range.start ? ` | ${formatClock(range.start)}-${formatClock(range.end)}` : '';
    $('time-readout').textContent = `${formatClock(now)} / ${formatClock(total)}${sel}`;
  }
  function setupWaveCanvas() {
    const canvas = $('waveform');
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.floor(rect.width * dpr));
    const h = Math.max(1, Math.floor(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { canvas, ctx, w: rect.width, h: rect.height };
  }
  // Wheel-zoom the waveform: picking a 4-second range inside a 5-minute song
  // with the whole song squeezed into 900px is guesswork otherwise.
  const waveZoom = window.TimelineZoom
    ? window.TimelineZoom($('wave-shell'), () => waveDuration, () => drawWaveform())
    : { start: () => 0, span: () => waveDuration || 1, zoomed: () => false,
        xFor: (t, w) => (t / (waveDuration || 1)) * w, timeAt: (x, w) => (x / w) * (waveDuration || 0), follow() {} };

  function drawWaveform() {
    const { ctx, w, h } = setupWaveCanvas();
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = css('--bg-2') || '#0f1013';
    ctx.fillRect(0, 0, w, h);

    const mid = h / 2;
    ctx.strokeStyle = css('--line') || '#2b2e36';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, mid + 0.5);
    ctx.lineTo(w, mid + 0.5);
    ctx.stroke();

    const gridCount = waveDuration > 0 ? Math.min(12, Math.max(4, Math.floor(w / 110))) : 6;
    ctx.strokeStyle = css('--line-soft') || '#3a3d4566';
    ctx.fillStyle = css('--text-3') || '#62656d';
    ctx.font = '10px "JetBrains Mono", monospace';
    for (let i = 0; i <= gridCount; i++) {
      const x = (i / gridCount) * w;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, h);
      ctx.stroke();
      if (waveDuration > 0 && i < gridCount) ctx.fillText(formatClock(waveZoom.start() + (i / gridCount) * waveZoom.span()).replace(/\.000$/, ''), x + 6, 14);
    }

    if (wavePeaks.length) {
      ctx.strokeStyle = css('--text-2') || '#9b9ea6';
      ctx.lineWidth = 1;
      ctx.beginPath();
      const from = waveDuration ? waveZoom.start() / waveDuration : 0;
      const width = waveDuration ? waveZoom.span() / waveDuration : 1;
      for (let x = 0; x < w; x++) {
        const p = wavePeaks[Math.min(wavePeaks.length - 1, Math.floor((from + (x / w) * width) * wavePeaks.length))];
        const y1 = mid + p[0] * (h * 0.42);
        const y2 = mid + p[1] * (h * 0.42);
        ctx.moveTo(x + 0.5, y1);
        ctx.lineTo(x + 0.5, y2);
      }
      ctx.stroke();
    }

    const range = waveRange();
    if (waveDuration > 0 && range.enabled) {
      const sx = waveZoom.xFor(range.start, w);
      const ex = waveZoom.xFor(range.end, w);
      ctx.fillStyle = 'rgba(0, 0, 0, .34)';
      ctx.fillRect(0, 0, sx, h);
      ctx.fillRect(ex, 0, w - ex, h);
      ctx.fillStyle = css('--accent-soft') || '#252a1a';
      ctx.globalAlpha = 0.55;
      ctx.fillRect(sx, 0, Math.max(1, ex - sx), h);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = css('--accent') || '#b8e62e';
      ctx.lineWidth = 2;
      for (const x of [sx, ex]) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
        ctx.fillStyle = css('--accent') || '#b8e62e';
        ctx.fillRect(x - 4, 0, 8, 12);
        ctx.fillRect(x - 4, h - 12, 8, 12);
      }
    }

    const a = $('preview-audio');
    if (waveDuration > 0 && Number.isFinite(a.currentTime)) {
      const px = waveZoom.xFor(clamp(a.currentTime, 0, waveDuration), w);
      $('waveform').setAttribute('aria-valuenow', String(Math.round(clamp(a.currentTime / waveDuration, 0, 1) * 100)));
      ctx.strokeStyle = '#ffffff';
      ctx.globalAlpha = 0.65;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px + 0.5, 0);
      ctx.lineTo(px + 0.5, h);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    updateTimeReadout();
  }
  async function loadWaveform(p) {
    const token = ++waveToken;
    wavePeaks = [];
    waveDuration = 0;
    $('wave-loading').hidden = false;
    drawWaveform();
    if (!p || !F.fileUrl) { $('wave-loading').hidden = true; return; }
    try {
      const res = await fetch(F.fileUrl(p));
      const bytes = await res.arrayBuffer();
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const audio = await audioCtx.decodeAudioData(bytes);
      if (token !== waveToken) return;
      waveDuration = audio.duration || 0;
      wavePeaks = buildPeaks(audio, 4096);
    } catch (e) {
      if (token === waveToken) logLine('Waveform unavailable for this file; time fields and preview still work.');
    } finally {
      if (token === waveToken) {
        $('wave-loading').hidden = true;
        drawWaveform();
      }
    }
  }
  function setTimingRange(start, end) {
    $('time-enabled').checked = true;
    $('time-start').value = formatTime(start);
    $('time-end').value = formatTime(end);
    validateTiming(false);
    updateStart();
    drawWaveform();
  }
  function syncTimingControls() {
    const enabled = $('time-enabled').checked;
    $('time-start').disabled = !enabled;
    $('time-end').disabled = !enabled;
    $('time-from-playhead').disabled = !inputPath;
    $('time-to-playhead').disabled = !inputPath;
    $('time-reset').disabled = !enabled;
  }
  function waveSecondsFromEvent(e) {
    const rect = $('waveform').getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    return clamp(waveZoom.timeAt(x, rect.width), 0, waveDuration || 0);
  }

  // ---- enable/disable state ----
  function parseTimeValue(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    const parts = s.split(':').map((p) => p.trim());
    if (parts.length > 3 || parts.some((p) => p === '' || Number.isNaN(Number(p)))) return NaN;
    let sec = 0;
    for (const p of parts) sec = sec * 60 + Number(p);
    return sec >= 0 ? sec : NaN;
  }
  function formatTime(sec) {
    if (sec == null || Number.isNaN(sec)) return '';
    const whole = Math.floor(sec), frac = sec - whole;
    const m = Math.floor(whole / 60), s = whole % 60;
    const tail = frac > 0 ? (Math.round(frac * 1000) / 1000).toString().slice(1) : '';
    return `${m}:${String(s).padStart(2, '0')}${tail}`;
  }
  function collectTiming() {
    if (!$('time-enabled').checked) return { enabled: false, start: '', end: '' };
    return {
      enabled: true,
      start: parseTimeValue($('time-start').value),
      end: parseTimeValue($('time-end').value),
    };
  }
  function validateTiming(show) {
    const t = collectTiming();
    let ok = true, msg = 'Use seconds or mm:ss. Leave Stop blank to forge through the end.';
    if (t.enabled) {
      if (Number.isNaN(t.start) || Number.isNaN(t.end)) { ok = false; msg = 'Enter times as seconds, mm:ss, or hh:mm:ss.'; }
      else if (t.start != null && t.end != null && t.end <= t.start) { ok = false; msg = 'Stop must be after Start.'; }
      else msg = `Forge range: ${formatTime(t.start || 0)} to ${t.end == null ? 'end' : formatTime(t.end)}.`;
    }
    $('time-hint').textContent = msg;
    $('time-hint').classList.toggle('is-error', !ok);
    if (show && !ok) logLine('Time range error: ' + msg);
    return ok;
  }
  function updateStart() { $('start').disabled = !(envReady && inputPath && !busy && validateTiming(false)); }
  function setBusy(b) {
    busy = b;
    $('fetch').disabled = b; $('preview').disabled = b;
    $('cancel').hidden = !b; $('pause').hidden = !b; if (!b) { $('pause').textContent = 'Pause'; jobPaused = false; }
    updateStart();
  }
  function stopPreview() {
    if (previewTimer) { clearInterval(previewTimer); previewTimer = null; }
    try { $('preview-audio').pause(); } catch (_) {}
  }
  function setInput(p) {
    stopPreview();
    activeState = 'ready';
    inputPath = p; $('input-path').value = p;
    if (p && F.fileUrl) $('preview-audio').src = F.fileUrl(p);
    else { $('preview-audio').removeAttribute('src'); $('preview-audio').load(); }
    loadWaveform(p);
    syncTimingControls();
    updateStart(); renderQueue();
  }

  // ---- env status (probed only on load / re-check / provision-done) ----
  function setEnv(state, text) { $('env-dot').className = 'dot ' + (state || ''); $('env-text').textContent = text; }
  // Where setup will install, shown in the setup panel with the free space on
  // that drive — picking the drive is the one decision setup can't recover from.
  async function refreshStorage() {
    if (!window.studio || !studio.forgeInfo) return;
    let info; try { info = await studio.forgeInfo(); } catch { return; }
    if (!info) return;
    $('setup-dir').textContent = info.forgeEnvDir || '—';
    $('setup-dir').title = info.forgeEnvDir || '';
    const free = info.forgeFreeGb;
    $('setup-free').textContent = free == null ? '' : `${free} GB free`;
    $('setup-free').classList.toggle('is-low', free != null && free < 15);
  }

  async function refreshEnv() {
    setEnv('warn', 'Checking Midi Forge…');
    refreshStorage();
    let s; try { s = await F.check(); } catch { s = { forgeReady: false }; }
    envReady = !!s.forgeReady;
    if (envReady) {
      setEnv('ok', s.gpu ? `Ready · GPU: ${s.gpu}` : 'Ready (CPU mode — slow)');
      // A CPU-only machine spends 20-40 minutes on a Piano/General run. Say so
      // once, and point at the pipeline that finishes in a couple of minutes.
      if (!s.gpu && !cpuNoticeShown) {
        cpuNoticeShown = true;
        logLine('No GPU detected — Piano/General take 20-40 min per song here. "Fast" finishes in a couple of minutes at lower quality.');
      }
      $('setup').hidden = true; $('work').style.opacity = '1'; $('work').style.pointerEvents = '';
    } else {
      const why = (s.missing && s.missing.length) ? ` (missing: ${s.missing.join(', ')})` : '';
      setEnv('err', 'Not set up' + why);
      $('setup').hidden = false;
    }
    // MIDI preview is lightweight and must remain usable before Forge setup.
    $('work').style.opacity = '1'; $('work').style.pointerEvents = '';
    updateStart();
  }
  $('env-recheck').addEventListener('click', refreshEnv);
  $('setup-change').addEventListener('click', async () => {
    if (!window.studio || !studio.changeForgeFolder) return;
    const btn = $('setup-change'); btn.disabled = true; const label = btn.textContent; btn.textContent = 'Moving…';
    try {
      const r = await studio.changeForgeFolder();
      if (r && r.ok) { logLine(`Forge storage: ${r.forgeEnvDir}`); refreshEnv(); }
      else if (r && !r.canceled) logLine(r.error || 'Could not change the Forge folder.');
    } finally { btn.disabled = false; btn.textContent = label; }
  });

  // ---- setup / provisioning ----
  $('setup-start').addEventListener('click', async () => {
    // 15 GB is what provision_forge.py hard-gates on; finding that out four
    // gigabytes into the download is not a plan.
    if (window.studio && studio.forgeInfo) {
      try {
        const info = await studio.forgeInfo();
        if (info && info.forgeFreeGb != null && info.forgeFreeGb < 15) {
          logLine(`Only ${info.forgeFreeGb} GB free on ${info.forgeEnvDir} — setup needs about 15 GB.`);
          if (!window.confirm(`That drive has ${info.forgeFreeGb} GB free and setup needs about 15 GB.\n\n`
            + 'Use "Change folder…" to install the engine on another drive.\n\nStart anyway?')) return;
        }
      } catch (_) { /* the check is advisory */ }
    }
    $('setup-start').disabled = true; $('setup-cancel').hidden = false; $('setup-prog').hidden = false;
    startSetupTimer();
    F.provision();
  });
  $('setup-cancel').addEventListener('click', () => {
    if (!window.confirm('Cancel Midi Forge setup? Setup resumes where it stopped when you start it again.')) return;
    $('setup-cancel').textContent = 'Cancelling…'; F.cancelProvision();
  });

  // ---- input: browse + drop (no env re-probe on change) ----
  $('browse').addEventListener('click', async () => { const r = await F.pickInput(); addInputs(Array.isArray(r) ? r : [r], 'replace'); });
  $('queue-add').addEventListener('click', async () => { const r = await F.pickInput(); addInputs(Array.isArray(r) ? r : [r], 'queue'); });

  function acceptDrop(files) {
    const ok = [], midis = [];
    for (const f of files || []) {
      const p = F.getDroppedFilePath(f);
      if (p && MIDI_EXT.test(p)) midis.push(p);
      else if (p && (AUDIO_EXT.test(p) || !/\.[a-z0-9]+$/i.test(p))) ok.push(p);
      else logLine('Ignored (not audio or MIDI): ' + (p || f.name));
    }
    if (midis.length) parent.postMessage({ type: 'studio:open-audition', midiPath: midis[0], projectPath: '', play: false }, '*');
    addInputs(ok);
  }
  const ov = $('drop-overlay');
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; ov.classList.add('show'); });
  window.addEventListener('dragover', (e) => { e.preventDefault(); });
  window.addEventListener('dragleave', (e) => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; ov.classList.remove('show'); } });
  window.addEventListener('drop', (e) => { e.preventDefault(); dragDepth = 0; ov.classList.remove('show'); acceptDrop(e.dataTransfer && e.dataTransfer.files); });

  // ---- URL fetch ----
  function doFetch() {
    const url = $('url').value.trim(); if (!url || busy) return;
    hideResults(); logLine('▶ Fetching ' + url);
    $('job-prog').hidden = false; $('job-stage').textContent = 'Download'; $('job-bar').className = 'bar-fill indet'; $('job-pct').textContent = '';
    setBusy(true); currentJob = null; pendingCancel = false;
    activeState = 'running'; skipRequested = false;
    F.yt({ url, outDir: outputDir }).then((id) => { currentJob = id; if (pendingCancel) F.cancel(id); });
  }
  $('fetch').addEventListener('click', doFetch);
  $('url').addEventListener('keydown', (e) => { if (e.key === 'Enter') doFetch(); });

  // ---- output folder ----
  // Show the effective program output folder when the user hasn't overridden it.
  // Windows-illegal characters would fail the write deep inside Python.
  const outputName = () => $('out-name').value.trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '').slice(0, 120);

  function showDefaultOut() { if (F.getOutputDir) F.getOutputDir().then((d) => { if (!outputDir && d) $('out-dir').textContent = d; syncPipelineUI(); }).catch(() => {}); }
  $('pick-out').addEventListener('click', async () => { const d = await F.pickOutDir(); if (d) { outputDir = d; $('out-dir').textContent = d; $('clear-out').hidden = false; F.setSettings({ outputDir: d }); syncPipelineUI(); } });
  $('clear-out').addEventListener('click', () => { outputDir = ''; $('clear-out').hidden = true; F.setSettings({ outputDir: '' }); showDefaultOut(); });

  // ---- pipeline + advanced ----
  $('pipeline').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; pipeline = b.dataset.v; document.querySelectorAll('#pipeline button').forEach((x) => x.classList.toggle('is-active', x === b)); syncPipelineUI(); });
  $('adv-toggle').addEventListener('click', () => {
    const a = $('adv'); a.hidden = !a.hidden;
    $('adv-toggle').textContent = a.hidden ? 'Advanced ▾' : 'Advanced ▴';
    $('adv-toggle').setAttribute('aria-expanded', String(!a.hidden));
  });
  $('adv-reset').addEventListener('click', () => {
    for (const [key, value] of Object.entries(ADV_DEFAULTS)) {
      const el = $(key);
      if (el.type === 'checkbox') el.checked = value;
      else el.value = value;
    }
    F.setSettings({ advanced: collectAdvanced() });
    const button = $('adv-reset');
    button.textContent = 'Reset done';
    setTimeout(() => { button.textContent = 'Reset tuning'; }, 1200);
  });
  function onTimingChanged() { syncTimingControls(); updateStart(); drawWaveform(); }
  ['time-enabled', 'time-start', 'time-end'].forEach((id) => $(id).addEventListener('input', onTimingChanged));
  $('time-enabled').addEventListener('change', onTimingChanged);
  $('time-from-playhead').addEventListener('click', () => {
    const now = clamp($('preview-audio').currentTime || 0, 0, waveDuration || Number.MAX_SAFE_INTEGER);
    const range = waveRange();
    setTimingRange(now, Math.max(now + 0.01, range.enabled ? range.end : (waveDuration || now + 30)));
    syncTimingControls();
  });
  $('time-to-playhead').addEventListener('click', () => {
    const now = clamp($('preview-audio').currentTime || 0, 0, waveDuration || Number.MAX_SAFE_INTEGER);
    const range = waveRange();
    setTimingRange(Math.min(range.enabled ? range.start : 0, Math.max(0, now - 0.01)), now);
    syncTimingControls();
  });
  $('time-reset').addEventListener('click', () => {
    $('time-enabled').checked = false;
    $('time-start').value = '0:00';
    $('time-end').value = '';
    onTimingChanged();
  });
  $('preview-volume').value = String(clamp(Number(previewPrefs.audioVolume) || 0, 0, 100));
  $('preview-volume-value').textContent = `${$('preview-volume').value}%`;
  $('preview-audio').volume = Number($('preview-volume').value) / 100;
  $('preview-volume').addEventListener('input', (event) => {
    previewPrefs.audioVolume = Number(event.target.value);
    $('preview-volume-value').textContent = `${event.target.value}%`;
    $('preview-audio').volume = previewPrefs.audioVolume / 100;
    savePreviewPrefs();
  });
  $('preview').addEventListener('click', async () => {
    if (!inputPath || !validateTiming(true)) return;
    const a = $('preview-audio');
    if (!a.src && F.fileUrl) a.src = F.fileUrl(inputPath);
    const t = collectTiming();
    const start = t.enabled ? (t.start || 0) : 0;
    const end = t.enabled ? t.end : null;
    stopPreview();
    try {
      a.currentTime = start;
      await a.play();
      if (end != null) previewTimer = setInterval(() => { if (a.currentTime >= end) stopPreview(); }, 80);
    } catch (_) {
      logLine('Preview could not play this file.');
    }
  });
  $('preview-stop').addEventListener('click', stopPreview);
  $('preview-audio').addEventListener('loadedmetadata', () => {
    const d = $('preview-audio').duration;
    if (!waveDuration && Number.isFinite(d)) waveDuration = d;
    drawWaveform();
  });
  $('preview-audio').addEventListener('timeupdate', drawWaveform);
  $('preview-audio').addEventListener('pause', drawWaveform);
  $('waveform').addEventListener('pointerdown', (e) => {
    if (!waveDuration || busy) return;
    const canvas = $('waveform');
    const rect = canvas.getBoundingClientRect();
    const sec = waveSecondsFromEvent(e);
    const range = waveRange();
    const sx = waveZoom.xFor(range.start, rect.width);
    const ex = waveZoom.xFor(range.end, rect.width);
    const x = e.clientX - rect.left;
    const nearStart = range.enabled && Math.abs(x - sx) <= 10;
    const nearEnd = range.enabled && Math.abs(x - ex) <= 10;
    waveDrag = { mode: nearStart ? 'start' : nearEnd ? 'end' : 'select', anchor: sec, moved: false, x };
    canvas.setPointerCapture(e.pointerId);
  });
  $('waveform').addEventListener('pointermove', (e) => {
    if (!waveDrag || !waveDuration) return;
    const sec = waveSecondsFromEvent(e);
    if (Math.abs(e.clientX - waveDrag.x) > 3) waveDrag.moved = true;
    const range = waveRange();
    if (waveDrag.mode === 'start') setTimingRange(clamp(sec, 0, Math.max(0, range.end - 0.01)), range.end);
    else if (waveDrag.mode === 'end') setTimingRange(range.start, clamp(sec, Math.min(waveDuration, range.start + 0.01), waveDuration));
    else if (waveDrag.moved) setTimingRange(Math.min(waveDrag.anchor, sec), Math.max(waveDrag.anchor, sec));
  });
  $('waveform').addEventListener('pointerup', (e) => {
    if (!waveDrag || !waveDuration) return;
    const sec = waveSecondsFromEvent(e);
    if (!waveDrag.moved && waveDrag.mode === 'select') {
      $('preview-audio').currentTime = sec;
      drawWaveform();
    }
    waveDrag = null;
  });
  $('waveform').addEventListener('pointercancel', () => { waveDrag = null; });
  $('waveform').addEventListener('keydown', (e) => {
    if (!waveDuration || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const audio = $('preview-audio');
    let next = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    if (e.key === 'ArrowLeft') next -= e.shiftKey ? 10 : 1;
    else if (e.key === 'ArrowRight') next += e.shiftKey ? 10 : 1;
    else if (e.key === 'Home') next = 0;
    else next = waveDuration;
    audio.currentTime = clamp(next, 0, waveDuration);
    drawWaveform();
  });
  window.addEventListener('resize', drawWaveform);

  function collectAdvanced() {
    const a = {};
    for (const k of ADV_KEYS) { const el = $(k); if (!el) continue; if (el.type === 'checkbox') a[k] = el.checked; else if (el.value !== '') a[k] = el.value; }
    return a;
  }

  F.getSettings().then((s) => {
    if (!s) return;
    if (s.pipeline) { pipeline = s.pipeline; document.querySelectorAll('#pipeline button').forEach((x) => x.classList.toggle('is-active', x.dataset.v === pipeline)); }
    if (s.skipSeparation) $('skipsep').checked = true;
    if (s.timing) {
      $('time-enabled').checked = !!s.timing.enabled;
      $('time-start').value = s.timing.start || '';
      $('time-end').value = s.timing.end || '';
      validateTiming(false);
    }
    if (s.outputDir) { outputDir = s.outputDir; $('out-dir').textContent = s.outputDir; $('clear-out').hidden = false; }
    else showDefaultOut();
    if (s.advanced) for (const [k, v] of Object.entries(s.advanced)) { const el = $(k); if (!el) continue; if (el.type === 'checkbox') el.checked = !!v; else el.value = v; }
    syncPipelineUI();
  }).catch(() => {});
  syncPipelineUI();

  // ---- run / cancel ----
  function hideResults() {
    $('output').hidden = true; $('output-summary').hidden = true; $('output').classList.remove('has-result');
    $('errcard').hidden = true; $('output-review').hidden = true;
    currentProject = '';
  }
  function startJob() {
    if (!inputPath || busy) return;
    if (!validateTiming(true)) return;
    const advanced = collectAdvanced();
    const timingRaw = { enabled: $('time-enabled').checked, start: $('time-start').value.trim(), end: $('time-end').value.trim() };
    const timing = collectTiming();
    F.setSettings({ pipeline, skipSeparation: $('skipsep').checked, advanced, timing: timingRaw });
    hideResults(); $('job-prog').hidden = false; $('job-stage').textContent = 'Queued'; $('job-bar').className = 'bar-fill indet'; $('job-pct').textContent = '';
    setBusy(true); currentJob = null; pendingCancel = false;
    const n = queue.length ? ` — ${queue.length} more queued` : '';
    logLine('▶ Start ' + inputPath.split(/[\/]/).pop() + ' (' + pipeline + ($('skipsep').checked ? ', skip-sep' : '') + ')' + n);
    renderQueue();
    F.run({ inputPath, pipeline, skipSeparation: $('skipsep').checked, advanced, timing, outputName: outputName() })
      .then((id) => { currentJob = id; if (pendingCancel) F.cancel(id); });
    $('out-name').value = '';   // a name belongs to one song, not to the queue
  }
  $('start').addEventListener('click', () => { runningQueue = queue.length > 0; startJob(); });
  let jobPaused = false;
  $('pause').addEventListener('click', async () => {
    if (!F.pause) return;
    const want = !jobPaused;
    $('pause').disabled = true;
    const r = await F.pause(want);
    $('pause').disabled = false;
    if (r && r.ok) {
      jobPaused = r.paused;
      $('pause').textContent = jobPaused ? 'Resume' : 'Pause';
      $('job-stage').textContent = jobPaused ? 'Paused' : $('job-stage').textContent;
      logLine(jobPaused ? '⏸ Paused — the GPU is free until you resume.' : '▶ Resumed.');
    } else logLine((r && r.error) || 'Could not pause the job.');
  });
  $('cancel').addEventListener('click', () => {
    // Cancelling the visible job abandons the whole batch — a half-run queue
    // that keeps going after you hit Cancel is never what anyone means.
    if (queue.length) { rememberQueue(); queue = []; logLine('Queue cleared — press Undo to get the list back.'); }
    runningQueue = false; renderQueue();
    skipRequested = false;
    if (currentJob) F.cancel(currentJob); else pendingCancel = true;
    $('cancel').textContent = 'Cancelling…';
  });

  // ---- output actions ----
  $('output-open').addEventListener('click', async () => { const p = $('output-path').textContent; if (p) { const r = await F.showItem(p); if (r && !r.ok) showError('File not found — it may have moved.'); } });
  $('output-listen').addEventListener('click', () => {
    const midiPath = $('output-path').textContent;
    if (midiPath) parent.postMessage({ type: 'studio:open-audition', midiPath, projectPath: currentProject, play: undefined }, '*');
  });
  $('output-review').addEventListener('click', () => {
    if (!currentProject) return;
    // Only the melody pipeline writes a project file; the others still have a
    // .mid the Editor can open directly.
    parent.postMessage({ type: 'studio:open-review',
      projectPath: currentProject || ($('output-path').textContent || '').trim() }, '*');
  });
  function sendOutputToPlayer() {
    const p = $('output-path').textContent; if (!p) return;
    try {
      parent.document.querySelector('.tab[data-tab="player"]').click();
      const w = (parent.document.getElementById('frame-player') || {}).contentWindow;
      if (w && typeof w.setMidiFile === 'function') { w.setMidiFile(p); logLine('→ Loaded into Midi Player'); }
      else if (w && w.api) { w.api.send({ cmd: 'load_midi', path: p, mapping: 'roblox88', tempo: 1.0 }); logLine('→ Sent to Midi Player'); }
      else logLine('Open the Midi Player tab, then pick it from Recent.');
    } catch (_) { logLine('Couldn\'t hand off — open Midi Player and pick it from Recent.'); }
  }
  $('output-toplayer').addEventListener('click', sendOutputToPlayer);
  $('log-clear').addEventListener('click', () => { $('log').textContent = ''; });
  $('err-dismiss').addEventListener('click', () => { $('errcard').hidden = true; });

  function showError(msg) { $('job-prog').hidden = true; $('errcard').hidden = false; $('err-msg').textContent = msg; }

  // ---- status stream ----
  F.onStatus((s) => {
    if (!s || !s.event) return;
    switch (s.event) {
      case 'forge.provision.progress': {
        $('setup-prog').hidden = false; $('setup-step').textContent = s.step || 'Working…';
        const indet = (s.percent == null || s.percent < 0);
        $('setup-bar').className = 'bar-fill' + (indet ? ' indet' : ''); $('setup-bar').style.width = indet ? '' : (s.percent + '%');
        $('setup-pct').textContent = indet ? '' : (s.percent + '%'); $('setup-msg').textContent = s.message || ''; break;
      }
      case 'forge.provision.log': logLine(s.line); break;
      case 'forge.provision.done': $('setup-msg').textContent = 'Done!'; $('setup-cancel').hidden = true; $('setup-cancel').textContent = 'Cancel'; $('setup-start').disabled = false; $('setup-start').textContent = 'Set up Midi Forge'; refreshEnv(); break;
      case 'forge.provision.error': {
        $('setup-msg').textContent = '✖ ' + (s.message || 'Setup failed.');
        $('setup-cancel').hidden = true; $('setup-cancel').textContent = 'Cancel';
        $('setup-start').disabled = false; $('setup-start').textContent = /cancel/i.test(s.message || '') ? 'Set up Midi Forge' : 'Retry setup';
        // Offer the full log so it can be shared (the panel above is ephemeral).
        if (!/cancel/i.test(s.message || '') && window.studio && window.studio.openSetupLog) {
          let b = $('setup-log-btn');
          if (!b) { b = document.createElement('button'); b.id = 'setup-log-btn'; b.className = 'btn btn-ghost'; b.style.marginTop = '8px'; b.textContent = '📄 Open setup log'; b.addEventListener('click', () => window.studio.openSetupLog()); $('setup-msg').insertAdjacentElement('afterend', b); }
          b.hidden = false;
        }
        break;
      }

      case 'forge.progress': {
        $('job-stage').textContent = s.stage || '';
        const indet = (s.percent == null || s.percent < 0);
        $('job-bar').className = 'bar-fill' + (indet ? ' indet' : ''); $('job-bar').style.width = indet ? '' : (s.percent + '%');
        $('job-pct').textContent = indet ? '' : (s.percent + '%'); break;
      }
      case 'forge.log': logLine(s.line); break;
      case 'forge.done': {
        const wasSkipped = skipRequested;
        skipRequested = false;
        setBusy(false); $('cancel').textContent = 'Cancel'; currentJob = null; pendingCancel = false; $('job-prog').hidden = true;
        if (wasSkipped) {
          logLine('Skipped.');
        } else if (s.ok) {
          const out = (s.result && (s.result.midiPath || s.result.downloadedPath)) || '';
          if (s.result && s.result.downloadedPath) { addInputs([out], 'replace'); logLine('✓ Downloaded: ' + out); }
          else {
            activeState = 'done'; $('output').hidden = false; $('output-summary').hidden = false; $('output').classList.add('has-result'); $('output-path').textContent = out;
            currentProject = (s.result && s.result.projectPath) || '';
            $('output-review').hidden = false;   // any result can be opened in the Editor
            logLine('✓ Done: ' + out);
          }
        } else {
          activeState = /cancel/i.test(s.error || '') ? 'cancelled' : 'failed';
          showError(s.error || 'Job failed.'); logLine('✖ ' + (s.error || 'failed'));
        }
        // Keep draining the batch: one failure shouldn't strand the rest.
        if ((runningQueue || wasSkipped) && queue.length && $('queue-auto').checked) { setInput(queue.shift()); startJob(); }
        else { runningQueue = false; if (wasSkipped) setInput(''); renderQueue(); }
        break;
      }
    }
  });

  restoreQueue();
  renderQueue();
  syncTimingControls();
  drawWaveform();
  window.refreshForgeEnvironment = refreshEnv;
  refreshEnv();
})();

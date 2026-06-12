// forge.js — Midi-Forge tab controller. Drives window.forge.
(() => {
  const F = window.forge;
  const $ = (id) => document.getElementById(id);
  const ADV_KEYS = ['USE_TTA', 'LOUDNESS_NORM', 'BIGSHIFTS', 'SEGMENT_HOP', 'VELOCITY_GAMMA',
    'MIN_NOTE_SEC', 'MIN_VELOCITY', 'PIANO_MIN_PITCH', 'PIANO_MAX_PITCH',
    'BP_ONSET_THRESHOLD', 'BP_FRAME_THRESHOLD', 'BP_MIN_NOTE_MS',
    'MAX_POLYPHONY', 'OCTAVE_FOLD', 'EXCLUDE_VOCALS', 'ONSET_DELTA', 'DRUM_MIN_GAP_MS'];

  const PIPELINE_HINT = {
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

  let envReady = false, busy = false, inputPath = '', pipeline = 'piano';
  let currentJob = null, pendingCancel = false, outputDir = '';

  const logLine = (t) => { const el = $('log'); el.textContent += t + '\n'; el.scrollTop = el.scrollHeight; };

  // ---- enable/disable state ----
  function updateStart() { $('start').disabled = !(envReady && inputPath && !busy); }
  function setBusy(b) {
    busy = b;
    $('fetch').disabled = b; $('browse').disabled = b;
    $('cancel').hidden = !b; updateStart();
  }
  function setInput(p) { inputPath = p; $('input-path').value = p; updateStart(); }

  // ---- env status (probed only on load / re-check / provision-done) ----
  function setEnv(state, text) { $('env-dot').className = 'dot ' + (state || ''); $('env-text').textContent = text; }
  async function refreshEnv() {
    setEnv('warn', 'Checking Midi-Forge…');
    let s; try { s = await F.check(); } catch { s = { forgeReady: false }; }
    envReady = !!s.forgeReady;
    if (envReady) {
      setEnv('ok', s.gpu ? `Ready · GPU: ${s.gpu}` : 'Ready (CPU mode — slow)');
      $('setup').hidden = true; $('work').style.opacity = '1'; $('work').style.pointerEvents = '';
    } else {
      const why = (s.missing && s.missing.length) ? ` (missing: ${s.missing.join(', ')})` : '';
      setEnv('err', 'Not set up' + why);
      $('setup').hidden = false; $('work').style.opacity = '.5'; $('work').style.pointerEvents = 'none';
    }
    updateStart();
  }
  $('env-recheck').addEventListener('click', refreshEnv);

  // ---- setup / provisioning ----
  $('setup-start').addEventListener('click', () => { $('setup-start').disabled = true; $('setup-cancel').hidden = false; $('setup-prog').hidden = false; F.provision(); });
  $('setup-cancel').addEventListener('click', () => {
    if (!window.confirm('Cancel Midi-Forge setup? The partial download is discarded; you can restart it later.')) return;
    $('setup-cancel').textContent = 'Cancelling…'; F.cancelProvision();
  });

  // ---- input: browse + drop (no env re-probe on change) ----
  $('browse').addEventListener('click', async () => { const p = await F.pickInput(); if (p) setInput(p); });

  function acceptDrop(file) {
    if (!file) return;
    const p = F.getDroppedFilePath(file);
    if (p && (AUDIO_EXT.test(p) || !/\.[a-z0-9]+$/i.test(p))) setInput(p);
    else logLine('Ignored (not an audio file): ' + (p || file.name));
  }
  const ov = $('drop-overlay');
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); if (busy) return; dragDepth++; ov.classList.add('show'); });
  window.addEventListener('dragover', (e) => { e.preventDefault(); });
  window.addEventListener('dragleave', (e) => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; ov.classList.remove('show'); } });
  window.addEventListener('drop', (e) => { e.preventDefault(); dragDepth = 0; ov.classList.remove('show'); if (busy) return; acceptDrop(e.dataTransfer && e.dataTransfer.files[0]); });

  // ---- URL fetch ----
  function doFetch() {
    const url = $('url').value.trim(); if (!url || busy) return;
    hideResults(); logLine('▶ Fetching ' + url);
    $('job-prog').hidden = false; $('job-stage').textContent = 'Download'; $('job-bar').className = 'bar-fill indet'; $('job-pct').textContent = '';
    setBusy(true); currentJob = null; pendingCancel = false;
    F.yt({ url, outDir: outputDir }).then((id) => { currentJob = id; if (pendingCancel) F.cancel(id); });
  }
  $('fetch').addEventListener('click', doFetch);
  $('url').addEventListener('keydown', (e) => { if (e.key === 'Enter') doFetch(); });

  // ---- output folder ----
  // Show the effective program output folder when the user hasn't overridden it.
  function showDefaultOut() { if (F.getOutputDir) F.getOutputDir().then((d) => { if (!outputDir && d) $('out-dir').textContent = d; syncPipelineUI(); }).catch(() => {}); }
  $('pick-out').addEventListener('click', async () => { const d = await F.pickOutDir(); if (d) { outputDir = d; $('out-dir').textContent = d; $('clear-out').hidden = false; F.setSettings({ outputDir: d }); syncPipelineUI(); } });
  $('clear-out').addEventListener('click', () => { outputDir = ''; $('clear-out').hidden = true; F.setSettings({ outputDir: '' }); showDefaultOut(); });

  // ---- pipeline + advanced ----
  $('pipeline').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; pipeline = b.dataset.v; document.querySelectorAll('#pipeline button').forEach((x) => x.classList.toggle('is-active', x === b)); syncPipelineUI(); });
  $('adv-toggle').addEventListener('click', () => { const a = $('adv'); a.hidden = !a.hidden; $('adv-toggle').textContent = a.hidden ? 'Advanced ▾' : 'Advanced ▴'; });

  function collectAdvanced() {
    const a = {};
    for (const k of ADV_KEYS) { const el = $(k); if (!el) continue; if (el.type === 'checkbox') a[k] = el.checked; else if (el.value !== '') a[k] = el.value; }
    return a;
  }

  F.getSettings().then((s) => {
    if (!s) return;
    if (s.pipeline) { pipeline = s.pipeline; document.querySelectorAll('#pipeline button').forEach((x) => x.classList.toggle('is-active', x.dataset.v === pipeline)); }
    if (s.skipSeparation) $('skipsep').checked = true;
    if (s.outputDir) { outputDir = s.outputDir; $('out-dir').textContent = s.outputDir; $('clear-out').hidden = false; }
    else showDefaultOut();
    if (s.advanced) for (const [k, v] of Object.entries(s.advanced)) { const el = $(k); if (!el) continue; if (el.type === 'checkbox') el.checked = !!v; else el.value = v; }
    syncPipelineUI();
  }).catch(() => {});
  syncPipelineUI();

  // ---- run / cancel ----
  function hideResults() { $('output').hidden = true; $('errcard').hidden = true; }
  $('start').addEventListener('click', () => {
    if (!inputPath || busy) return;
    const advanced = collectAdvanced();
    F.setSettings({ pipeline, skipSeparation: $('skipsep').checked, advanced });
    hideResults(); $('job-prog').hidden = false; $('job-stage').textContent = 'Queued'; $('job-bar').className = 'bar-fill indet'; $('job-pct').textContent = '';
    setBusy(true); currentJob = null; pendingCancel = false;
    logLine('▶ Start (' + pipeline + ($('skipsep').checked ? ', skip-sep' : '') + ')');
    F.run({ inputPath, pipeline, skipSeparation: $('skipsep').checked, advanced }).then((id) => { currentJob = id; if (pendingCancel) F.cancel(id); });
  });
  $('cancel').addEventListener('click', () => { if (currentJob) F.cancel(currentJob); else pendingCancel = true; $('cancel').textContent = 'Cancelling…'; });

  // ---- output actions ----
  $('output-open').addEventListener('click', async () => { const p = $('output-path').textContent; if (p) { const r = await F.showItem(p); if (r && !r.ok) showError('File not found — it may have moved.'); } });
  $('output-toplayer').addEventListener('click', () => {
    const p = $('output-path').textContent; if (!p) return;
    try {
      parent.document.querySelector('.tab[data-tab="player"]').click();
      const w = (parent.document.getElementById('frame-player') || {}).contentWindow;
      if (w && typeof w.setMidiFile === 'function') { w.setMidiFile(p); logLine('→ Loaded into Midi-Player'); }
      else if (w && w.api) { w.api.send({ cmd: 'load_midi', path: p, mapping: 'roblox88', tempo: 1.0 }); logLine('→ Sent to Midi-Player'); }
      else logLine('Open the Midi-Player tab, then pick it from Recent.');
    } catch (_) { logLine('Couldn\'t hand off — open Midi-Player and pick it from Recent.'); }
  });
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
      case 'forge.provision.done': $('setup-msg').textContent = 'Done!'; $('setup-cancel').hidden = true; $('setup-cancel').textContent = 'Cancel'; $('setup-start').disabled = false; $('setup-start').textContent = 'Set up Midi-Forge'; refreshEnv(); break;
      case 'forge.provision.error': {
        $('setup-msg').textContent = '✖ ' + (s.message || 'Setup failed.');
        $('setup-cancel').hidden = true; $('setup-cancel').textContent = 'Cancel';
        $('setup-start').disabled = false; $('setup-start').textContent = /cancel/i.test(s.message || '') ? 'Set up Midi-Forge' : 'Retry setup';
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
      case 'forge.done':
        setBusy(false); $('cancel').textContent = 'Cancel'; currentJob = null; pendingCancel = false; $('job-prog').hidden = true;
        if (s.ok) {
          const out = (s.result && (s.result.midiPath || s.result.downloadedPath)) || '';
          if (s.result && s.result.downloadedPath) { setInput(out); logLine('✓ Downloaded: ' + out); }
          else { $('output').hidden = false; $('output-path').textContent = out; logLine('✓ Done: ' + out); }
        } else { showError(s.error || 'Job failed.'); logLine('✖ ' + (s.error || 'failed')); }
        break;
    }
  });

  refreshEnv();
})();

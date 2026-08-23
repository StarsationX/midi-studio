// shell.js — tab switching + version badge + update banner + lightweight toasts.
(() => {
  const studio = window.studio || window.api;

  // ---- tabs (with persistence + keyboard) ----
  const tabs = document.getElementById('tabs');
  const frames = [...document.querySelectorAll('.tabframe')];
  function ensureFrame(name) {
    const frame = frames.find((f) => f.dataset.tab === name);
    if (frame && !frame.getAttribute('src') && frame.dataset.src) frame.setAttribute('src', frame.dataset.src);
    return frame;
  }

  // ---- theme + custom accent (applied to shell html + both iframe docs) ----
  let curTheme = '', curVars = null;
  const ACCENT_KEYS = ['--accent', '--accent-2', '--accent-deep', '--accent-ink', '--accent-soft', '--accent-line', '--ok'];
  function deriveAccent(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec((hex || '').trim()); if (!m) return null;
    const n = parseInt(m[1], 16), r = n >> 16 & 255, g = n >> 8 & 255, b = n & 255;
    const h2 = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
    const blend = (tr, tg, tb, p) => '#' + h2(r + (tr - r) * p) + h2(g + (tg - g) * p) + h2(b + (tb - b) * p);
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    return { '--accent': '#' + m[1], '--accent-2': blend(255, 255, 255, 0.18), '--accent-deep': blend(0, 0, 0, 0.28),
      '--accent-ink': lum > 0.6 ? '#0c0d10' : '#f4f6ff', '--accent-soft': blend(20, 21, 25, 0.86),
      '--accent-line': blend(20, 21, 25, 0.62), '--ok': '#' + m[1] };
  }
  const skin = (el) => { try {
    el.dataset.theme = curTheme;
    if (curVars) for (const k of ACCENT_KEYS) el.style.setProperty(k, curVars[k]);
    else for (const k of ACCENT_KEYS) el.style.removeProperty(k);
  } catch {} };
  const applySkin = () => { skin(document.documentElement); frames.forEach((f) => skin(f.contentDocument && f.contentDocument.documentElement)); };
  function applyTheme(t) { curTheme = t || ''; applySkin(); }
  function applyAccent(hex) { curVars = hex ? deriveAccent(hex) : null; applySkin(); }
  frames.forEach((f) => f.addEventListener('load', () => { skin(f.contentDocument && f.contentDocument.documentElement); applyPerf(); }));

  // Resource limit: pushed onto every frame's <html> so the animation loops can
  // read it without another IPC round trip. The user's preference and "a game is
  // running" are kept apart — folding them into one flag latched the limit on
  // permanently the first time Roblox was seen.
  // '' = full speed, 'balanced' = half rate, 'easy' = smallest footprint. A
  // running game can raise the level but never lowers the user's choice.
  let userPerf = 'full', gameActive = '', gamingRule = 'limit';
  function effectivePerf() {
    const order = ['full', 'balanced', 'easy'];
    let level = userPerf;
    if (gameActive && gamingRule !== 'nothing') {
      level = order[Math.max(order.indexOf(level), order.indexOf('easy'))];
    }
    return level;
  }
  function applyPerf() {
    const level = effectivePerf();
    const value = level === 'full' ? '' : level;
    document.documentElement.dataset.perf = value;
    frames.forEach((f) => {
      const el = f.contentDocument && f.contentDocument.documentElement;
      if (el) el.dataset.perf = value;
    });
  }
  function activate(name, persist = true) {
    if (!frames.some((f) => f.dataset.tab === name)) return;
    ensureFrame(name);
    document.querySelectorAll('.tab').forEach((t) => {
      const on = t.dataset.tab === name;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    frames.forEach((f) => f.classList.toggle('is-active', f.dataset.tab === name));
    const titles = { forge: 'MIDI Studio — Midi Forge', player: 'MIDI Studio — Midi Player',
      review: 'MIDI Studio — Midi Editor', audition: 'MIDI Studio — Self Midi' };
    document.title = titles[name] || 'MIDI Studio';
    if (persist && studio && studio.setUi) studio.setUi({ lastTab: name });
  }
  tabs.addEventListener('click', (e) => { const b = e.target.closest('.tab'); if (b) activate(b.dataset.tab); });
  // Ctrl+1..Ctrl+4 switch tabs, in the order they appear.
  window.addEventListener('keydown', (e) => {
    if (!e.ctrlKey) return;
    if (e.key === '1') { activate('forge'); e.preventDefault(); }
    if (e.key === '2') { activate('player'); e.preventDefault(); }
    if (e.key === '3') { activate('review'); e.preventDefault(); }
    if (e.key === '4') { activate('audition'); e.preventDefault(); }
  });
  function openAudition(payload) {
    const frame = document.getElementById('frame-audition');
    const deliver = () => {
      const target = frame && frame.contentWindow;
      if (target && typeof target.loadAudition === 'function') {
        target.loadAudition(payload.midiPath || '', payload.projectPath || '', { play: payload.play });
      }
    };
    if (frame && frame.contentWindow && typeof frame.contentWindow.loadAudition === 'function') deliver();
    else if (frame) frame.addEventListener('load', deliver, { once: true });
    activate('audition');
  }
  function openReview(payload) {
    const frame = document.getElementById('frame-review');
    const deliver = () => {
      const target = frame && frame.contentWindow;
      if (target && typeof target.openReviewProject === 'function') target.openReviewProject(payload.projectPath || payload.midiPath || '');
    };
    if (frame && frame.contentWindow && typeof frame.contentWindow.openReviewProject === 'function') deliver();
    else if (frame) frame.addEventListener('load', deliver, { once: true });
    activate('review');
  }
  // The Player frame is loaded on demand now, so a hand-off has to wait for it
  // instead of reaching into a contentWindow that has nothing in it yet.
  function openPlayer(payload) {
    const frame = document.getElementById('frame-player');
    const deliver = () => {
      const target = frame && frame.contentWindow;
      if (target && typeof target.setMidiFile === 'function') target.setMidiFile(payload.midiPath || '');
      else if (target && target.api) target.api.send({ cmd: 'load_midi', path: payload.midiPath || '', mapping: 'roblox88', tempo: 1.0 });
    };
    if (frame && frame.contentWindow && typeof frame.contentWindow.setMidiFile === 'function') deliver();
    else if (frame) frame.addEventListener('load', () => setTimeout(deliver, 120), { once: true });
    activate('player');
  }

  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'studio:open-player') openPlayer(event.data);
    if (event.data && event.data.type === 'studio:open-audition') openAudition(event.data);
    if (event.data && event.data.type === 'studio:open-review') openReview(event.data);
  });
  // Ctrl+1..4 arrive from the main process (see before-input-event) because the
  // tab iframe swallows key events aimed at the shell.
  if (studio && studio.onShortcut) studio.onShortcut((p) => { if (p && p.tab) activate(p.tab); });

  // A running game forces the limited draw rate regardless of the setting.
  if (studio && studio.onGameActive) studio.onGameActive((p) => {
    const was = gameActive;
    gameActive = (p && p.game) || '';
    applyPerf();
    if (gameActive && !was) toast(`${gameActive.replace(/\.exe$/i, '')} detected — going easy on the GPU`, 'ok');
    if (!gameActive && was) toast('Game closed — full speed again', 'ok');
  });

  // Restore last tab.
  if (studio && studio.getUi) studio.getUi().then((ui) => { if (ui) { if (ui.lastTab) activate(ui.lastTab, false); applyTheme(ui.theme); if (ui.accent) applyAccent(ui.accent); } }).catch(() => {});
  if (studio && studio.getPerformance) studio.getPerformance().then((p) => {
    if (!p) return;
    // perfMode was the old on/off switch; honour it as "easy" on first run.
    userPerf = p.level || 'full';
    gamingRule = p.whenGaming || 'limit';
    applyPerf();
  }).catch(() => {});

  // ---- version badge ----
  const badge = document.getElementById('version-badge');
  if (studio && studio.getVersion) studio.getVersion().then((v) => { badge.textContent = 'v' + v; }).catch(() => {});
  badge.addEventListener('click', () => studio && studio.checkForUpdates && studio.checkForUpdates({ manual: true }));

  // ---- toasts ----
  let toastWrap = null;
  function toast(msg, kind) {
    if (!toastWrap) { toastWrap = document.createElement('div'); toastWrap.className = 'toasts'; document.body.appendChild(toastWrap); }
    const t = document.createElement('div'); t.className = 'toast' + (kind ? ' toast--' + kind : ''); t.setAttribute('role', 'status'); t.textContent = msg;
    toastWrap.appendChild(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 260); }, 3600);
  }

  // ---- update banner ----
  const el = document.getElementById('update-banner');
  const $ = (id) => document.getElementById(id);
  const show = () => { el.hidden = false; };
  let staged = false; // an update is downloaded/available and ready to apply
  $('ub-dismiss').addEventListener('click', () => { el.hidden = true; });
  $('ub-apply').addEventListener('click', () => {
    if (!staged) { studio.checkForUpdates({ manual: true }); return; } // error/retry with nothing staged -> re-check
    const b = $('ub-apply'); b.disabled = true; b.textContent = 'Working…'; studio.applyUpdate();
  });

  if (studio && studio.onUpdateStatus) studio.onUpdateStatus((s) => {
    if (!s || !s.state) return;
    switch (s.state) {
      case 'available': {
        staged = true;
        $('ub-title').textContent = `Update available — v${s.version}`;
        const note = (s.notes || '').split(/\r?\n/).find((l) => l.trim()) || 'A new version is ready.';
        $('ub-sub').textContent = `From v${s.current}${s.size ? ` · ${(s.size / 1048576).toFixed(0)} MB` : ''} · ${note.replace(/^#+\s*/, '')}`;
        $('ub-prog').hidden = true;
        const a = $('ub-apply'); a.disabled = false; a.textContent = s.canSelfUpdate ? 'Update & restart' : 'Open download page'; a.style.display = '';
        show(); break;
      }
      case 'checking': staged = false; $('ub-title').textContent = 'Checking for updates…'; $('ub-sub').textContent = ''; $('ub-apply').style.display = 'none'; $('ub-prog').hidden = true; show(); break;
      case 'downloading': $('ub-title').textContent = `Downloading update… ${s.percent || 0}%`; $('ub-prog').hidden = false; $('ub-prog-fill').style.width = `${s.percent || 0}%`; $('ub-apply').disabled = true; show(); break;
      case 'verifying': $('ub-title').textContent = 'Verifying download…'; break;
      case 'ready': $('ub-title').textContent = 'Restarting to apply update…'; $('ub-sub').textContent = ''; break;
      case 'manual': $('ub-title').textContent = 'Finish the update in your browser'; $('ub-sub').textContent = 'The download page has opened.'; $('ub-apply').style.display = 'none'; show(); break;
      case 'updated': el.hidden = true; toast(`Updated to v${s.version}`, 'ok'); break;
      case 'none': el.hidden = true; toast(`You're on the latest version (v${s.current})`, 'ok'); break;
      case 'error':
        staged = false; $('ub-title').textContent = 'Update failed'; $('ub-sub').textContent = s.message || 'Try again later.'; $('ub-prog').hidden = true;
        { const a = $('ub-apply'); a.disabled = false; a.textContent = 'Retry'; a.style.display = ''; } show(); break;
    }
  });

  // ---- fatal engine errors are visible even from the Forge tab ----
  if (studio && studio.onEngineError) studio.onEngineError((msg) => {
    if (typeof msg === 'string' && /missing|couldn't launch|not running|crashed/i.test(msg)) toast('Player engine: ' + msg.slice(0, 120), 'err');
  });

  // ---- settings / about modal ----
  const modal = document.getElementById('settings-modal');
  function showForgeInfo(info) {
    if (!info) return;
    $('s-version').textContent = 'v' + info.version;
    $('s-forge').textContent = info.forgeReady ? 'Ready' : 'Not set up';
    $('s-forgedir').textContent = info.forgeEnvDir || '—';
    $('s-forgedir').title = info.forgeEnvDir || '';
    $('s-resetforge').hidden = !info.forgeCustom;
  }
  function refreshForgeInfo() {
    return studio.forgeInfo ? studio.forgeInfo().then(showForgeInfo).catch(() => {}) : Promise.resolve();
  }
  function openSettings() {
    modal.hidden = false;
    document.body.classList.add('modal-open');
    refreshForgeInfo();
    if (studio.getPerformance) studio.getPerformance().then((p) => {
      if (!p) return;
      $('s-perf-level').value = p.level || 'full';
      $('s-perf-gaming').value = p.whenGaming || 'limit';
      $('s-perf-threads').value = String(p.threads || 4);
      $('s-perf-batch').value = String(p.batch || 2);
    }).catch(() => {});
    if (studio.getUi) studio.getUi().then((ui) => { $('s-autoupdate').checked = !ui || ui.autoCheckUpdates !== false; $('s-theme').value = (ui && ui.theme) || 'lime'; $('s-accent').value = (ui && ui.accent) || (getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#b8e62e'); }).catch(() => {});
  }
  function closeSettings() { modal.hidden = true; document.body.classList.remove('modal-open'); }
  document.getElementById('settings-btn').addEventListener('click', openSettings);
  document.getElementById('settings-close').addEventListener('click', closeSettings);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeSettings(); });
  $('s-autoupdate').addEventListener('change', (e) => studio.setUi && studio.setUi({ autoCheckUpdates: e.target.checked }));
  $('s-theme').addEventListener('change', (e) => { applyAccent(''); applyTheme(e.target.value); studio.setUi && studio.setUi({ theme: e.target.value, accent: '' });
    $('s-accent').value = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#b8e62e'; });
  $('s-accent').addEventListener('input', (e) => { applyAccent(e.target.value); studio.setUi && studio.setUi({ accent: e.target.value }); });
  $('s-perf-level').addEventListener('change', (e) => {
    userPerf = e.target.value; applyPerf();
    studio.setPerformance && studio.setPerformance({ level: userPerf });
  });
  $('s-perf-gaming').addEventListener('change', (e) => {
    gamingRule = e.target.value; applyPerf();
    studio.setPerformance && studio.setPerformance({ whenGaming: gamingRule });
  });
  ['s-perf-threads', 's-perf-batch'].forEach((id) => {
    $(id).addEventListener('change', (e) => {
      const key = id === 's-perf-threads' ? 'threads' : 'batch';
      const max = key === 'threads' ? 32 : 8;
      const value = Math.max(1, Math.min(max, Math.round(Number(e.target.value) || 1)));
      e.target.value = String(value);
      studio.setPerformance && studio.setPerformance({ [key]: value });
    });
  });
  $('s-openforge').addEventListener('click', () => studio.openForgeFolder && studio.openForgeFolder());
  async function relocateForge(method, button) {
    if (!studio[method]) return;
    const buttons = [$('s-changeforge'), $('s-resetforge')];
    buttons.forEach((item) => { item.disabled = true; });
    const oldText = button.textContent; button.textContent = 'Moving…';
    try {
      const result = await studio[method]();
      if (result && result.ok) {
        showForgeInfo(result);
        toast(result.moved ? 'Forge storage moved' : 'Forge storage location updated', 'ok');
        const frame = document.getElementById('frame-forge');
        if (frame && frame.contentWindow && typeof frame.contentWindow.refreshForgeEnvironment === 'function') frame.contentWindow.refreshForgeEnvironment();
      } else if (result && !result.canceled) toast(result.error || 'Could not change Forge storage', 'err');
    } catch (error) { toast(error.message || 'Could not change Forge storage', 'err'); }
    finally { button.textContent = oldText; buttons.forEach((item) => { item.disabled = false; }); }
  }
  $('s-changeforge').addEventListener('click', () => relocateForge('changeForgeFolder', $('s-changeforge')));
  $('s-resetforge').addEventListener('click', () => relocateForge('resetForgeFolder', $('s-resetforge')));
  $('s-recheck').addEventListener('click', () => { studio.checkForUpdates({ manual: true }); closeSettings(); });
  $('s-setuplog').addEventListener('click', async () => {
    const r = studio.openSetupLog ? await studio.openSetupLog() : null;
    if (r && !r.ok) toast(r.error || 'No setup log yet', 'err');
  });
  $('s-repo').addEventListener('click', (e) => { e.preventDefault(); studio.openExternal && studio.openExternal('https://github.com/StarsationX/midi-studio'); });
  $('s-clean').addEventListener('click', () => {
    if (!window.confirm('Clean reinstall? This deletes MIDI Studio\'s managed Forge environment so it re-downloads next time. (It never touches a separate Midi-Forge install.)')) return;
    studio.cleanReinstall().then((r) => {
      toast(r && r.ok ? 'Forge storage cleared' : ((r && r.error) || 'Nothing to clean'), r && r.ok ? 'ok' : 'err');
      const frame = document.getElementById('frame-forge');
      if (frame && frame.contentWindow && typeof frame.contentWindow.refreshForgeEnvironment === 'function') frame.contentWindow.refreshForgeEnvironment();
      refreshForgeInfo();
    });
  });

  // ---- keyboard / a11y ----
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { if (!modal.hidden) closeSettings(); else if (!el.hidden) el.hidden = true; }
    if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && document.activeElement && document.activeElement.classList.contains('tab')) {
      const order = ['forge', 'player', 'review', 'audition'];
      const cur = order.indexOf(document.querySelector('.tab.is-active').dataset.tab);
      const next = order[(cur + (e.key === 'ArrowRight' ? 1 : order.length - 1)) % order.length];
      activate(next); document.querySelector(`.tab[data-tab="${next}"]`).focus(); e.preventDefault();
    }
  });
})();

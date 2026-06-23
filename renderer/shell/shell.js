// shell.js — tab switching + version badge + update banner + lightweight toasts.
(() => {
  const studio = window.studio || window.api;

  // ---- tabs (with persistence + keyboard) ----
  const tabs = document.getElementById('tabs');
  const frames = [...document.querySelectorAll('.tabframe')];

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
  frames.forEach((f) => f.addEventListener('load', () => skin(f.contentDocument && f.contentDocument.documentElement)));
  function activate(name, persist = true) {
    if (!frames.some((f) => f.dataset.tab === name)) return;
    document.querySelectorAll('.tab').forEach((t) => {
      const on = t.dataset.tab === name;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    frames.forEach((f) => f.classList.toggle('is-active', f.dataset.tab === name));
    document.title = name === 'forge' ? 'MIDI Studio — Forge' : 'MIDI Studio — Player';
    if (persist && studio && studio.setUi) studio.setUi({ lastTab: name });
  }
  tabs.addEventListener('click', (e) => { const b = e.target.closest('.tab'); if (b) activate(b.dataset.tab); });
  // Ctrl+1 / Ctrl+2 switch tabs.
  window.addEventListener('keydown', (e) => {
    if (!e.ctrlKey) return;
    if (e.key === '1') { activate('forge'); e.preventDefault(); }
    if (e.key === '2') { activate('player'); e.preventDefault(); }
  });
  // Restore last tab.
  if (studio && studio.getUi) studio.getUi().then((ui) => { if (ui) { if (ui.lastTab) activate(ui.lastTab, false); applyTheme(ui.theme); if (ui.accent) applyAccent(ui.accent); } }).catch(() => {});

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
  function openSettings() {
    modal.hidden = false;
    document.body.classList.add('modal-open');
    if (studio.forgeInfo) studio.forgeInfo().then((i) => {
      if (!i) return;
      $('s-version').textContent = 'v' + i.version;
      $('s-forge').textContent = i.forgeReady ? 'Ready' : 'Not set up';
      $('s-forgedir').textContent = i.forgeEnvDir || '—';
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
  $('s-openforge').addEventListener('click', () => studio.openForgeFolder && studio.openForgeFolder());
  $('s-recheck').addEventListener('click', () => { studio.checkForUpdates({ manual: true }); closeSettings(); });
  $('s-repo').addEventListener('click', (e) => { e.preventDefault(); studio.openExternal && studio.openExternal('https://github.com/StarsationX/midi-studio'); });
  $('s-clean').addEventListener('click', () => {
    if (!window.confirm('Clean reinstall? This deletes MIDI Studio\'s managed Forge environment so it re-downloads next time. (It never touches a separate Midi-Forge install.)')) return;
    studio.cleanReinstall().then((r) => { toast(r && r.ok ? 'Forge env cleared — reopen the Forge tab to reinstall' : 'Nothing to clean', r && r.ok ? 'ok' : undefined); closeSettings(); });
  });

  // ---- keyboard / a11y ----
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { if (!modal.hidden) closeSettings(); else if (!el.hidden) el.hidden = true; }
    if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && document.activeElement && document.activeElement.classList.contains('tab')) {
      const order = ['forge', 'player'];
      const cur = order.indexOf(document.querySelector('.tab.is-active').dataset.tab);
      const next = order[(cur + (e.key === 'ArrowRight' ? 1 : order.length - 1)) % order.length];
      activate(next); document.querySelector(`.tab[data-tab="${next}"]`).focus(); e.preventDefault();
    }
  });
})();

// midi-library.js — adds a "Songs folder" picker to the player's Source panel.
// Lists every .mid in the chosen folder (defaults to the Forge output folder) so
// you can pick one to load + play. Loaded after app.js in the same frame; reuses
// the player's global setMidiFile() — app.js itself is untouched.
(() => {
  const studio = window.studio;
  if (!studio || typeof setMidiFile !== 'function' || !studio.listMidis) return;

  const body = document.querySelector('.section[data-section="source"] .section-body');
  if (!body) return;

  const field = document.createElement('div');
  field.className = 'field';
  field.innerHTML =
    '<label>Transcribed songs <span class="muted small" id="lib-count"></span></label>' +
    '<input id="lib-search" type="text" placeholder="Search songs…" autocomplete="off" ' +
      'style="width:100%;margin-bottom:6px;display:none" />' +
    '<div class="file-row">' +
      '<select id="lib-select"><option value="">— choose a folder —</option></select>' +
      '<button id="lib-refresh" class="btn btn-icon" title="Rescan folder">↻</button>' +
      '<button id="lib-browse" class="btn btn-icon" title="Choose a folder of MIDIs">📁</button>' +
    '</div>';
  // Place it at the very top of the Source panel so it's the first control.
  body.insertBefore(field, body.firstChild);

  const sel = field.querySelector('#lib-select');
  const browse = field.querySelector('#lib-browse');
  const refreshBtn = field.querySelector('#lib-refresh');
  const search = field.querySelector('#lib-search');
  const count = field.querySelector('#lib-count');
  const LAST_KEY = 'midi-studio.lib.last';
  let dir = '';
  let allFiles = [];   // full list for this folder (unfiltered)

  function render() {
    const q = search.value.trim().toLowerCase();
    const list = q ? allFiles.filter((p) => p.split(/[\\/]/).pop().toLowerCase().includes(q)) : allFiles;
    const last = localStorage.getItem(LAST_KEY) || '';
    sel.innerHTML = '';
    const head = document.createElement('option');
    head.value = '';
    head.textContent = !allFiles.length ? '— no MIDIs here —'
      : list.length ? `— ${list.length}${q ? ' match' + (list.length > 1 ? 'es' : '') : ' MIDI' + (list.length > 1 ? 's' : '')} —`
      : '— no matches —';
    sel.appendChild(head);
    for (const p of list) {
      const o = document.createElement('option');
      o.value = p; o.textContent = p.split(/[\\/]/).pop(); o.title = p;
      if (p === last) o.selected = true;       // re-select the last-played song
      sel.appendChild(o);
    }
    search.style.display = allFiles.length > 6 ? '' : 'none';  // only when worth it
  }

  async function refresh() {
    if (!dir) { allFiles = []; sel.innerHTML = '<option value="">— choose a folder —</option>'; count.textContent = ''; return; }
    try { allFiles = await studio.listMidis(dir); } catch (_) { allFiles = []; }
    render();
    count.textContent = dir.split(/[\\/]/).filter(Boolean).pop();
    count.title = dir;
  }

  search.addEventListener('input', render);
  sel.addEventListener('change', () => { if (sel.value) { localStorage.setItem(LAST_KEY, sel.value); setMidiFile(sel.value); } });
  refreshBtn.addEventListener('click', refresh);
  browse.addEventListener('click', async () => {
    const d = await studio.pickFolder();
    if (d) { dir = d; try { await studio.setLibraryDir(d); } catch (_) {} refresh(); }
  });

  // Resolve the default folder (manual pick > last transcription's folder > Forge
  // output folder). Re-resolved when a transcription finishes, so by default the
  // list follows wherever the newest transcribed MIDI came out.
  function syncDir() { studio.getLibraryDir().then((d) => { dir = d || ''; refresh(); }).catch(() => {}); }
  syncDir();
  if (studio.onLibraryChanged) studio.onLibraryChanged(syncDir);

  // A discoverable shortcut to the persistent AppData mappings folder. Drop
  // custom mapping .json files there and they survive every relaunch/update.
  if (studio.openMappingsDir) {
    const mb = document.getElementById('mapping-browse');
    if (mb && !document.getElementById('mapping-folder')) {
      const fb = document.createElement('button');
      fb.id = 'mapping-folder';
      fb.className = mb.className;
      fb.title = 'Open mappings folder (custom mappings kept here persist)';
      fb.textContent = '📁';
      fb.addEventListener('click', () => { try { studio.openMappingsDir(); } catch (_) {} });
      mb.insertAdjacentElement('afterend', fb);
    }
  }
})();

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
    '<div class="file-row">' +
      '<select id="lib-select"><option value="">— choose a folder —</option></select>' +
      '<button id="lib-browse" class="btn btn-icon" title="Choose a folder of MIDIs">📁</button>' +
    '</div>';
  // Place it at the very top of the Source panel so it's the first control.
  body.insertBefore(field, body.firstChild);

  const sel = field.querySelector('#lib-select');
  const browse = field.querySelector('#lib-browse');
  const count = field.querySelector('#lib-count');
  let dir = '';

  async function refresh() {
    if (!dir) { sel.innerHTML = '<option value="">— choose a folder —</option>'; count.textContent = ''; return; }
    let list = [];
    try { list = await studio.listMidis(dir); } catch (_) {}
    sel.innerHTML = '';
    const head = document.createElement('option');
    head.value = '';
    head.textContent = list.length ? `— ${list.length} MIDI${list.length > 1 ? 's' : ''} —` : '— no MIDIs here —';
    sel.appendChild(head);
    for (const p of list) {
      const o = document.createElement('option');
      o.value = p; o.textContent = p.split(/[\\/]/).pop(); o.title = p;
      sel.appendChild(o);
    }
    count.textContent = dir ? dir.split(/[\\/]/).filter(Boolean).pop() : '';
    count.title = dir;
  }

  sel.addEventListener('change', () => { if (sel.value) setMidiFile(sel.value); });
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
})();

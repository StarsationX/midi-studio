// library.js: the Library tab.
//
// The dedicated file view. It is the PRIMARY consumer of the one library index
// (electron/library.js): it does not re-implement the scan, the melody-candidate
// fold, the skip set or the caps, and it does not own a second favourites store
// -- favourites are ui.libraryFavorites in settings, the same set Listen
// reads and writes.
//
// The four columns a directory listing cannot answer (Length, Notes, Source,
// Tags) come from three different places on purpose:
//   Length / Notes  parsed from the file, ONCE, in the main process, keyed by
//                   path+mtime+size, and only for rows that have actually been
//                   on screen (see wantMeta / onRender). Never in a render path,
//                   never for the whole library up front, and an em dash -- not
//                   a zero -- until it is known.
//   Source          derived in main from the .midstudio.json sidecar Forge
//                   writes plus which root the file sits under.
//   Tags            user data, in the same index file as the parsed metadata.
//
// Playback: the Library is NOT one of the three transport owners. A row preview
// plays the LOCAL source audio of a transcription through its own <audio>
// element, claims nothing, and stops the moment the real transport owner starts.
'use strict';

(function () {
  const FRAME = 'library';
  const T = window.Bus ? window.Bus.TYPES : {};
  const Bus = window.Bus;
  const Fmt = window.Fmt;
  const lib = window.library || {};
  const studio = window.studio || {};

  const $ = (id) => document.getElementById(id);
  const low = (v) => String(v || '').toLowerCase();
  const cleanups = [];
  const on = (el, type, fn, opts) => {
    if (!el) return;
    el.addEventListener(type, fn, opts);
    cleanups.push(() => el.removeEventListener(type, fn, opts));
  };
  const later = (fn, ms) => { const t = setTimeout(fn, ms); cleanups.push(() => clearTimeout(t)); return t; };
  // ipcRenderer.invoke REJECTS whenever its main-process handler throws, and an
  // unhandled rejection is a silent failure. Every call in this file gets an
  // onRejected arm; this is the one for the calls whose failure is not worth
  // saying anything about.
  const quiet = (promise) => { if (promise && promise.then) promise.then(null, () => {}); return promise; };

  // One rAF per burst, last value wins. For painting. (CONTRACT 9.6)
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
    cleanups.push(() => w.cancel());
    return w;
  }

  // =========================================================================
  // STATE
  // =========================================================================
  const RECENT_MS = 7 * 24 * 3600 * 1000;
  const SRC_LABEL = { generated: 'Generated', imported: 'Imported', library: 'Library' };
  const SRC_ORDER = { generated: 0, imported: 1, library: 2 };
  const USE_LABEL = {
    player: 'Played in Player', selfmidi: 'Listened in Listen', editor: 'Opened in Editor',
    forge: 'Used in Forge', preview: 'Previewed here', reveal: 'Revealed in Explorer'
  };
  const BUILTIN = 2;          // dirs[0] and dirs[1] are built in (CONTRACT 11.12)

  const state = {
    files: [],            // every file, newest first, mutated in place
    byPath: new Map(),    // lower path -> file
    rows: [],             // what the active view shows, in display order
    dirs: [], extra: [],
    truncated: false,
    storage: null,
    loading: true,
    scanId: 0,
    view: 'all',
    folder: '',
    query: '', terms: [],
    fType: '', fSource: '', fTag: '',
    sortKey: 'date', sortDir: -1,
    mode: 'list',
    sel: [],              // selected paths, in selection order
    selSet: new Set(),    // lower paths
    focusPath: '',        // what the inspector is showing
    favs: [], favSet: new Set(),
    ghosts: new Map(),    // lower path -> placeholder for a favourite with no live file
    counts: {},
    tab: 'details',
    art: null,            // {path, roll, duration, ...}
    indexing: false, pendingSelect: '',
    sideOn: true, inspOn: true, autoCols: null
  };

  // =========================================================================
  // FAVOURITES -- ONE store, shared with Listen (CONTRACT 11.12)
  // Settings REPLACES arrays (invariant 38), so the whole array always goes out.
  // =========================================================================
  const writeFavs = debounce(() => {
    if (studio.setUi) {
      const wrote = studio.setUi({ libraryFavorites: state.favs.slice() });
      if (wrote && wrote.then) {
        wrote.then(null, () => toast('warn', 'Favourites could not be saved',
          'The change is showing here but did not reach settings.'));
      }
    }
    if (Bus) Bus.send(T.LIBRARY_CHANGED, { reason: 'favorites' });
  }, 250);

  function loadFavs() {
    if (!studio.getUi) return Promise.resolve();
    return studio.getUi().then((ui) => {
      const list = (ui && Array.isArray(ui.libraryFavorites)) ? ui.libraryFavorites : [];
      state.favs = list.map(String).filter(Boolean);
      state.favSet = new Set(state.favs.map(low));
    }, () => {});
  }

  function isFav(p) { return state.favSet.has(low(p)); }

  function setFav(paths, want) {
    const list = Array.isArray(paths) ? paths : [paths];
    for (const p of list) {
      const key = low(p);
      const has = state.favSet.has(key);
      if (want === has) continue;
      if (want) { state.favSet.add(key); state.favs.push(String(p)); }
      else {
        state.favSet.delete(key);
        state.favs = state.favs.filter((f) => low(f) !== key);
      }
      const file = state.byPath.get(key);
      if (file) { file.fav = want; rebuildHay(file); }
    }
    writeFavs();
    recount();                    // rebuilds the placeholders from state.favs
    // Un-favouriting a missing file removes the only thing that was keeping its
    // placeholder alive, so it must leave the selection with it.
    if (want === false) {
      for (const p of list) {
        if (fileFor(p)) continue;
        removeSel(p);
        if (low(p) === low(state.focusPath)) focusFile('');
      }
    }
    apply();
    renderInspector();
  }

  // The one lookup: a live file, or the placeholder standing in for a favourite
  // whose file has gone (CONTRACT 11.12 -- such a favourite is KEPT and MARKED,
  // never silently dropped, so a removable drive coming back keeps the list).
  function fileFor(p) {
    const key = low(p);
    return state.byPath.get(key) || state.ghosts.get(key) || null;
  }

  // =========================================================================
  // SCAN
  // =========================================================================
  function makeFile(raw) {
    const file = {
      path: String(raw.path || ''), name: String(raw.name || ''), dir: String(raw.dir || ''),
      size: Number(raw.size) || 0, modified: Number(raw.modified) || 0,
      source: raw.source || 'library',
      ext: /\.midi$/i.test(String(raw.path)) ? 'midi' : 'mid',
      notes: null, dur: null, bpm: null, bad: false, missing: false,
      hasAudio: !!raw.hasAudio,
      tags: [], fav: false, plays: 0, lastPlayed: 0, events: [], lastUse: 0,
      nameLow: low(raw.name), dirLow: low(raw.dir), hay: ''
    };
    file.fav = isFav(file.path);
    return file;
  }

  // A favourite with no live file. Same shape as a real one so every filter,
  // comparator and renderer treats it as a row; `missing` is what turns the
  // actions off and the marker on.
  function ghostFor(p) {
    const base = Fmt.basename(p);
    const name = base.replace(/\.midi?$/i, '');
    const dir = Fmt.dirname(p);
    const g = {
      path: String(p), name: name, dir: dir,
      size: 0, modified: 0, source: 'library',
      ext: /\.midi$/i.test(String(p)) ? 'midi' : 'mid',
      notes: null, dur: null, bpm: null, bad: false, missing: true, hasAudio: false,
      tags: [], fav: true, plays: 0, lastPlayed: 0, events: [], lastUse: 0,
      nameLow: low(name), dirLow: low(dir), hay: ''
    };
    rebuildHay(g);
    return g;
  }

  // Rebuilt from state.favs, reusing the previous object for a path that is
  // still missing so the selection and the inspector keep their identity.
  function rebuildGhosts() {
    const next = new Map();
    for (const p of state.favs) {
      const key = low(p);
      if (!key || state.byPath.has(key) || next.has(key)) continue;
      const g = state.ghosts.get(key) || ghostFor(p);
      adoptGhostState(g);
      next.set(key, g);
    }
    state.ghosts = next;
  }

  function rebuildHay(file) {
    file.hay = file.nameLow + ' ' + file.dirLow + ' ' + low(file.tags.join(' ')) + ' '
      + file.source + (file.fav ? ' favorite' : '') + (file.missing ? ' missing' : '');
  }

  // Tags and usage are USER data and are never pruned by a scan, so a favourite
  // whose file has gone still has both -- the placeholder gets them too.
  function adoptGhostState(file) {
    const key = low(file.path);
    const t = state.tagsMap && state.tagsMap[key];
    file.tags = Array.isArray(t) ? t.slice() : [];
    const u = state.usageMap && state.usageMap[key];
    file.plays = u ? (Number(u.c) || 0) : 0;
    file.lastPlayed = u ? (Number(u.l) || 0) : 0;
    file.events = u && Array.isArray(u.e) ? u.e.slice() : [];
    file.lastUse = file.events.length ? (Number(file.events[0].t) || 0) : 0;
    rebuildHay(file);
  }

  function adoptUserState(tags, usage) {
    state.tagsMap = tags || null;
    state.usageMap = usage || null;
    for (const file of state.files) {
      const key = low(file.path);
      const t = tags && tags[key];
      file.tags = Array.isArray(t) ? t.slice() : [];
      const u = usage && usage[key];
      file.plays = u ? (Number(u.c) || 0) : 0;
      file.lastPlayed = u ? (Number(u.l) || 0) : 0;
      file.events = u && Array.isArray(u.e) ? u.e.slice() : [];
      file.lastUse = file.events.length ? (Number(file.events[0].t) || 0) : 0;
      rebuildHay(file);
    }
  }

  let scanToken = 0;
  function refresh(reason) {
    if (!lib.scan) return Promise.resolve();
    const token = ++scanToken;
    state.loading = true;
    partial = [];
    setScanning(true, reason);
    return lib.scan().then((r) => {
      if (token !== scanToken) return;
      state.scanId = r.scanId || 0;
      state.dirs = (r.dirs || []).map(String);
      state.extra = (r.extra || []).map(String);
      state.truncated = !!r.truncated;
      state.storage = r.storage || null;
      state.indexing = !!r.indexing;
      state.files = (r.files || []).map(makeFile);
      state.byPath = new Map(state.files.map((f) => [low(f.path), f]));
      adoptUserState(r.tags, r.usage);
      state.loading = false;
      setScanning(false);
      renderFolders();
      renderStorage();
      recount();
      apply();
      renderInspector();
      if (state.pendingSelect) { const p = state.pendingSelect; state.pendingSelect = ''; select(p, true); }
    }, (error) => {
      if (token !== scanToken) return;
      state.loading = false;
      setScanning(false);
      toast('err', 'The library could not be scanned', String((error && error.message) || error));
      apply();
    });
  }

  // Partial batches, so the table paints as the walk fills it instead of after.
  let partial = [];
  const drainPartial = coalesce(() => {
    if (!state.loading || !partial.length) return;
    const add = partial;
    partial = [];
    for (const raw of add) {
      const key = low(raw.path);
      if (state.byPath.has(key)) continue;
      const file = makeFile(raw);
      state.byPath.set(key, file);
      state.files.push(file);
      rebuildHay(file);
    }
    state.files.sort((a, b) => b.modified - a.modified);
    recount();
    apply();
  });

  function setScanning(busy, reason) {
    const pill = $('scan-pill');
    if (pill) {
      pill.hidden = !busy;
      $('scan-pill-txt').textContent = reason === 'index' ? 'Indexing' : 'Scanning';
      pill.querySelector('.dot').className = busy ? 'dot is-live' : 'dot';
    }
    $('skel').hidden = !busy || state.files.length > 0;
  }

  // =========================================================================
  // LAZY METADATA -- only rows that have been on screen, a handful at a time
  // =========================================================================
  const wanted = new Map();     // lower path -> file
  const askMeta = debounce(() => {
    if (!lib.meta || !wanted.size) return;
    const batch = [];
    for (const file of wanted.values()) {
      batch.push({ path: file.path, modified: file.modified, size: file.size });
      if (batch.length >= 32) break;
    }
    for (const req of batch) wanted.delete(low(req.path));
    lib.meta({ paths: batch }).then((r) => {
      const meta = (r && r.meta) || {};
      let touched = 0;
      for (const p of Object.keys(meta)) {
        const file = state.byPath.get(low(p));
        if (!file) continue;
        const m = meta[p];
        if (m.bad) { file.bad = true; file.notes = null; file.dur = null; }
        else { file.notes = Number(m.notes) || 0; file.dur = Number(m.duration) || 0; file.bpm = m.bpm; }
        touched++;
      }
      if (touched) {
        paintRows();
        renderFoot();
        if (state.focusPath) renderInspector();
      }
      if (wanted.size) askMeta();
    }, () => {});
  }, 45);

  function wantMeta(first, last) {
    for (let i = first; i < last && i < state.rows.length; i++) {
      const file = state.rows[i];
      if (!file || file.missing || file.bad || file.notes !== null) continue;
      wanted.set(low(file.path), file);
    }
    if (wanted.size) askMeta();
  }

  // =========================================================================
  // FILTER + SORT.  Sorted ONCE per order change, never in renderRow.
  // =========================================================================
  const CMP = {
    name: (a, b) => (a.nameLow < b.nameLow ? -1 : a.nameLow > b.nameLow ? 1 : 0),
    date: (a, b) => a.modified - b.modified,
    length: (a, b) => a.dur - b.dur,
    notes: (a, b) => a.notes - b.notes,
    source: (a, b) => (SRC_ORDER[a.source] - SRC_ORDER[b.source])
      || (a.nameLow < b.nameLow ? -1 : a.nameLow > b.nameLow ? 1 : 0),
    tags: (a, b) => {
      const at = low(a.tags[0] || ''), bt = low(b.tags[0] || '');
      if (at === bt) return a.nameLow < b.nameLow ? -1 : 1;
      if (!at) return 1;
      if (!bt) return -1;
      return at < bt ? -1 : 1;
    }
  };
  const LAZY = { length: 'dur', notes: 'notes' };

  function inView(file) {
    switch (state.view) {
      case 'generated': return file.source === 'generated';
      case 'imported': return file.source === 'imported';
      case 'favorites': return file.fav;
      case 'recent': {
        const cut = Date.now() - RECENT_MS;
        return file.modified >= cut || file.lastUse >= cut;
      }
      case 'folder': {
        const d = state.folder;
        if (!d) return false;
        return file.dirLow === d || file.dirLow.startsWith(d + '\\') || file.dirLow.startsWith(d + '/');
      }
      default: return true;
    }
  }

  function passes(file) {
    if (!inView(file)) return false;
    if (state.fType && file.ext !== state.fType) return false;
    if (state.fSource && file.source !== state.fSource) return false;
    if (state.fTag === ' none') { if (file.tags.length) return false; }
    else if (state.fTag && !file.tags.some((t) => low(t) === state.fTag)) return false;
    for (const term of state.terms) if (file.hay.indexOf(term) < 0) return false;
    return true;
  }

  function apply() {
    // The previous display order is what an unparsed row falls back to, so it is
    // captured before the new sort (CONTRACT 11.12 rule 5).
    const prev = new Map();
    for (let i = 0; i < state.rows.length; i++) prev.set(low(state.rows[i].path), i);
    const rank = (f) => { const i = prev.get(low(f.path)); return i === undefined ? 1e9 : i; };

    // Favorites is the one view whose membership is the STORE, not the scan, so
    // a favourite with no live file is listed from its placeholder instead of
    // vanishing (CONTRACT 11.12).
    const pool = state.view === 'favorites' && state.ghosts.size
      ? state.files.concat([...state.ghosts.values()])
      : state.files;
    const rows = pool.filter(passes);
    const cmp = CMP[state.sortKey] || CMP.date;
    const lazy = LAZY[state.sortKey];
    if (lazy) {
      // Sorting an unparsed column sorts what it has and appends the rest: it
      // must never block and must never trigger a full-library parse.
      const known = [], unknown = [];
      for (const f of rows) (f[lazy] === null || f.bad ? unknown : known).push(f);
      known.sort((a, b) => cmp(a, b) * state.sortDir);
      unknown.sort((a, b) => rank(a) - rank(b));
      state.rows = known.concat(unknown);
    } else {
      rows.sort((a, b) => cmp(a, b) * state.sortDir || rank(a) - rank(b));
      state.rows = rows;
    }

    if (state.mode === 'grid') { rebuildShelves(); rowList.setItems([]); }
    else { rowList.setItems(state.rows); cardList.setItems([]); }
    syncSelectionInto();
    renderFoot();
    renderEmpty();
    renderSub();
    wantMeta.apply(null, activeRange());
  }

  function activeRange() {
    if (state.mode === 'grid') {
      const r = cardList.range();
      return [r[0] * shelfCols, Math.min(state.rows.length, r[1] * shelfCols)];
    }
    return rowList.range();
  }

  const paintRows = coalesce(() => {
    if (state.mode === 'grid') cardList.refresh(); else rowList.refresh();
  });

  // =========================================================================
  // LIST VIEW
  // =========================================================================
  const EM = '—';
  function lenOf(f) { return f.bad ? EM : (f.dur === null ? EM : Fmt.clock(f.dur)); }
  function notesOf(f) { return f.bad ? EM : (f.notes === null ? EM : String(f.notes)); }

  const rowList = window.VList($('rows'), {
    rowHeight: window.Tokens ? window.Tokens.num('h-lrow', 36) : 36,
    selectable: 'multi',
    ariaLabel: 'MIDI files',
    // Defensive on purpose: VList's refreshState() runs synchronously from
    // selectKeys(), before its own rAF has re-based the row pool, so a list that
    // just got shorter hands this function a hole.
    key: (it, i) => (it && it.path) || 'row:' + i,
    createRow() {
      const n = document.createElement('div');
      n.className = 'lrow is-grid';
      n.innerHTML =
        '<span class="lcell is-check"><button class="checkbox" type="button" role="checkbox"'
        + ' aria-checked="false" data-action="check" tabindex="-1" aria-label="Select this file"></button></span>'
        + '<span class="lcell lcell-name"><span class="lib-nm"></span>'
        + '<span class="tag is-accent lib-favtag" hidden>FAV</span>'
        + '<span class="tag is-err lib-misstag" hidden>MISSING</span></span>'
        + '<span class="lcell is-num"></span>'
        + '<span class="lcell is-num"></span>'
        + '<span class="lcell"><span class="lib-src"></span></span>'
        + '<span class="lcell is-dim"></span>'
        + '<span class="lcell lcell-tags"></span>'
        + '<span class="lcell is-act lrow-actions"><button class="btn btn-icon is-sm is-bare"'
        + ' type="button" data-action="menu" tabindex="-1" aria-label="More actions for this file">'
        + '<i data-icon="dots" data-icon-size="13"></i></button></span>';
      n.draggable = true;
      if (window.Icon) window.Icon.apply(n);
      return n;
    },
    renderRow(node, file, index, st) {
      const c = node.children;
      const gone = !!file.missing;
      node.classList.toggle('is-missing', gone);
      c[0].firstChild.setAttribute('aria-checked', st.selected ? 'true' : 'false');
      c[1].firstChild.textContent = file.name;
      c[1].children[1].hidden = !file.fav;
      c[1].children[2].hidden = !gone;
      c[2].textContent = lenOf(file);
      c[3].textContent = notesOf(file);
      const src = c[4].firstChild;
      src.textContent = gone ? EM : (SRC_LABEL[file.source] || 'Library');
      src.className = 'lib-src' + (!gone && file.source === 'generated' ? ' is-generated' : '');
      c[5].textContent = gone ? EM : Fmt.when(file.modified);
      c[5].title = gone ? '' : Fmt.stamp(file.modified);
      const tags = c[6];
      const want = file.tags.length;
      while (tags.children.length > want) tags.removeChild(tags.lastChild);
      while (tags.children.length < want) {
        const t = document.createElement('span');
        t.className = 'tag';
        tags.appendChild(t);
      }
      for (let i = 0; i < want; i++) tags.children[i].textContent = file.tags[i];
      node.setAttribute('aria-label', gone
        ? file.name + ', missing: this favourite is no longer on disk'
        : file.name + ', ' + (SRC_LABEL[file.source] || 'Library') + ', added ' + Fmt.when(file.modified));
      node.title = gone ? file.path + ' (not found)' : file.path;
    },
    onSelectionChange(keys) { if (state.mode === 'list') adoptSelection(keys); },
    onCursor(file) { if (file) focusFile(file.path); },
    onClick(file) { focusFile(file.path); },
    // Double-click / Enter on a row IS the explicit ask to play (CONTRACT 11.2),
    // which is the one place this tab decides `play` for the router.
    onActivate(file) { sendTo('player', [file.path], true); },
    onAction(action, file, index, ev) {
      if (action === 'check') { rowList.selectIndex(index, 'toggle'); return; }
      const btn = ev.target && ev.target.closest ? ev.target.closest('[data-action]') : null;
      if (action === 'menu') openRowMenu(file, { anchor: btn || rowList.host });
    },
    onContextMenu(file, index, ev) { ev.preventDefault(); openRowMenu(file, { x: ev.clientX, y: ev.clientY }); },
    onRender(first, last) { if (state.mode === 'list') wantMeta(first, last); }
  });

  // =========================================================================
  // GRID VIEW -- one virtualised row per shelf of cards, so a few thousand
  // files cost the same handful of nodes the table does.
  // =========================================================================
  // JS owns these numbers and writes --card-h into the layout, because VList
  // positions every shelf from rowHeight alone: if CSS and rowHeight disagree
  // the shelves silently drift by a growing offset (CONTRACT 2.7).
  // The shelf height is ONE number, derived from the two things that make it:
  // the card height JS writes into --card-h and the shelf's own padding-top
  // (var(--s2) in library.css). VList positions every shelf from rowHeight
  // alone, so if the two disagree the shelves drift by a growing offset
  // (CONTRACT 2.7) -- which is why measureShelf recomputes it and calls
  // cardList.rowHeight() instead of trusting a constant.
  const CARD_MIN = 168, CARD_GAP = 8, SHELF_PAD = 24, CARD_H = 132;
  const shelfPad = () => (window.Tokens ? window.Tokens.num('s2', 8) : 8);
  let shelfCols = 4, shelfH = CARD_H + shelfPad(), shelves = [];

  const cardsHost = $('cards');
  cardsHost.setAttribute('role', 'listbox');
  cardsHost.setAttribute('aria-multiselectable', 'true');
  cardsHost.setAttribute('aria-label', 'MIDI files');

  function measureShelf() {
    const h = CARD_H + shelfPad();
    let moved = false;
    if (h !== shelfH) { shelfH = h; cardList.rowHeight(h); moved = true; }
    // A width of 0 means the host is display:none (#cardwrap is hidden while the
    // table is up), which is "unknown", NOT a number to commit: a fallback here
    // is what froze the shelf at 3 enormous cards until the window was resized.
    const w = cardsHost.clientWidth;
    if (w > 0) {
      const cols = Math.max(1, Math.min(10,
        Math.floor((w - SHELF_PAD + CARD_GAP) / (CARD_MIN + CARD_GAP))));
      if (cols !== shelfCols) {
        shelfCols = cols;
        cardsHost.style.setProperty('--cards', String(cols));
        moved = true;
      }
    }
    return moved;
  }

  function rebuildShelves() {
    shelves = [];
    for (let i = 0; i < state.rows.length; i += shelfCols) {
      shelves.push({ id: 'shelf' + i, at: i, files: state.rows.slice(i, i + shelfCols) });
    }
    cardList.setItems(shelves, { keepSelection: false });
  }

  const cardList = window.VList(cardsHost, {
    rowHeight: shelfH,
    selectable: false,
    key: (it, i) => (it && it.id) || 'shelf:' + i,
    createRow() {
      const n = document.createElement('div');
      n.className = 'lib-shelf';
      n.setAttribute('role', 'presentation');
      return n;
    },
    renderRow(node, shelf) {
      while (node.children.length > shelf.files.length) node.removeChild(node.lastChild);
      while (node.children.length < shelf.files.length) {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'lib-card';
        card.setAttribute('role', 'option');
        // The listbox host is the single tab stop; the options are reached with
        // the arrow keys (CONTRACT 2.5), never by Tab walking every card.
        card.tabIndex = -1;
        card.innerHTML = '<span class="lib-card-art"><span class="lib-card-bars"></span></span>'
          + '<span class="lib-card-name"></span><span class="lib-card-meta"></span>'
          + '<span class="lib-card-foot"><span class="tag lib-card-src"></span>'
          + '<span class="tag is-accent lib-favtag" hidden>FAV</span></span>';
        node.appendChild(card);
      }
      for (let i = 0; i < shelf.files.length; i++) {
        const file = shelf.files[i];
        const card = node.children[i];
        const idx = shelf.at + i;
        const gone = !!file.missing;
        card.dataset.path = file.path;
        card.dataset.at = String(idx);
        const sel = state.selSet.has(low(file.path));
        card.setAttribute('aria-selected', sel ? 'true' : 'false');
        card.classList.toggle('is-cursor', idx === gridCursor);
        card.classList.toggle('is-missing', gone);
        card.children[1].textContent = file.name;
        card.children[2].textContent = gone ? 'not on disk'
          : (file.dur === null ? EM : Fmt.clock(file.dur))
            + ' · ' + (file.notes === null ? EM : file.notes + ' notes');
        card.children[3].firstChild.textContent = gone ? 'Missing' : (SRC_LABEL[file.source] || 'Library');
        card.children[3].firstChild.className = 'tag lib-card-src' + (gone ? ' is-err' : '');
        card.children[3].children[1].hidden = !file.fav;
        card.title = gone ? file.path + ' (not found)' : file.path;
        card.setAttribute('aria-label', gone
          ? file.name + ', missing: this favourite is no longer on disk'
          : file.name + ', ' + (SRC_LABEL[file.source] || 'Library'));
        paintCardBars(card.children[0].firstChild, file);
      }
    },
    onClick(shelf, index, ev) {
      const card = ev.target && ev.target.closest ? ev.target.closest('.lib-card') : null;
      if (!card) return;
      const at = Number(card.dataset.at);
      if (!Number.isFinite(at)) return;
      pickGrid(at, ev.shiftKey ? 'range' : (ev.ctrlKey || ev.metaKey) ? 'toggle' : 'set');
    },
    // Same as the table: activating a card is the explicit ask to play.
    onActivate(shelf, index, ev) {
      const card = ev.target && ev.target.closest ? ev.target.closest('.lib-card') : null;
      if (!card) return;
      sendTo('player', [card.dataset.path], true);
    },
    onContextMenu(shelf, index, ev) {
      const card = ev.target && ev.target.closest ? ev.target.closest('.lib-card') : null;
      if (!card) return;
      ev.preventDefault();
      const at = Number(card.dataset.at);
      if (!state.selSet.has(low(card.dataset.path))) pickGrid(at, 'set');
      openRowMenu(state.rows[at], { x: ev.clientX, y: ev.clientY });
    },
    onRender(first, last) {
      if (state.mode !== 'grid') return;
      wantMeta(first * shelfCols, Math.min(state.rows.length, last * shelfCols));
    }
  });

  // #cardwrap is `hidden` while the table is up, so the FIRST honest width the
  // card host ever has arrives after apply() un-hides it -- and nothing else
  // re-measures on a plain click of the Grid button (VList's own observer only
  // repaints). One observer on the host covers the mode switch, the divider
  // drag, the column toggles and the window resize with one rule.
  if (window.ResizeObserver) {
    const remeasure = coalesce(() => {
      if (state.mode !== 'grid') return;
      if (measureShelf()) rebuildShelves();
    });
    const ro = new ResizeObserver(() => remeasure());
    ro.observe(cardsHost);
    cleanups.push(() => ro.disconnect());
  }

  // A card cannot afford its own canvas, so its art is eight bars scaled from
  // whatever the index already knows -- and a plain plate until it knows any.
  function paintCardBars(host, file) {
    const want = 8;
    while (host.children.length < want) host.appendChild(document.createElement('i'));
    const seedBase = file.notes === null ? 0 : file.notes;
    for (let i = 0; i < want; i++) {
      const bar = host.children[i];
      if (!seedBase) { bar.style.height = '2px'; continue; }
      // A stable pseudo-random shape per file: it is an ornament, not data, so
      // it must at least never flicker between renders.
      const seed = (file.nameLow.charCodeAt(i % file.nameLow.length || 0) || 65) + i * 7 + seedBase;
      const h = 18 + ((seed * 2654435761) % 82);
      bar.style.height = Math.max(8, Math.min(100, h)) + '%';
    }
  }

  let gridCursor = -1;
  let gridAnchor = -1;

  function pickGrid(at, mode) {
    if (at < 0 || at >= state.rows.length) return;
    const file = state.rows[at];
    if (mode === 'toggle') {
      if (state.selSet.has(low(file.path))) removeSel(file.path); else addSel(file.path);
      gridAnchor = at;
    } else if (mode === 'range') {
      const from = gridAnchor < 0 ? at : gridAnchor;
      const a = Math.min(from, at), b = Math.max(from, at);
      state.sel = []; state.selSet = new Set();
      for (let i = a; i <= b; i++) addSel(state.rows[i].path);
    } else {
      state.sel = []; state.selSet = new Set();
      addSel(file.path);
      gridAnchor = at;
    }
    gridCursor = at;
    focusFile(file.path);
    afterSelection();
  }

  function scrollGridTo(at) {
    if (at < 0) return;
    cardList.scrollToIndex(Math.floor(at / shelfCols), 'nearest');
  }

  // The grid host is a VList too, and its own keydown moves a SHELF cursor,
  // which is not what an arrow key means here. Capture on the wrapper runs
  // before the host's listener, so the keys this view owns never reach it.
  on($('cardwrap'), 'keydown', (ev) => {
    if (state.mode !== 'grid' || !state.rows.length) return;
    const k = ev.key;
    let next = gridCursor;
    if (k === 'ArrowRight') next = Math.min(state.rows.length - 1, (gridCursor < 0 ? -1 : gridCursor) + 1);
    else if (k === 'ArrowLeft') next = Math.max(0, (gridCursor < 0 ? 0 : gridCursor) - 1);
    else if (k === 'ArrowDown') next = Math.min(state.rows.length - 1, (gridCursor < 0 ? -shelfCols : gridCursor) + shelfCols);
    else if (k === 'ArrowUp') next = Math.max(0, (gridCursor < 0 ? 0 : gridCursor) - shelfCols);
    else if (k === 'Home') next = 0;
    else if (k === 'End') next = state.rows.length - 1;
    else if (k === 'PageDown') next = Math.min(state.rows.length - 1, (gridCursor < 0 ? 0 : gridCursor) + shelfCols * 3);
    else if (k === 'PageUp') next = Math.max(0, (gridCursor < 0 ? 0 : gridCursor) - shelfCols * 3);
    else if (k === 'Enter') {
      if (gridCursor >= 0) sendTo('player', [state.rows[gridCursor].path], true);
    } else if (k === ' ' || k === 'Spacebar') {
      if (gridCursor >= 0) pickGrid(gridCursor, 'toggle');
    } else if (k === 'Escape') {
      clearSelection();
    } else if ((k === 'a' || k === 'A') && (ev.ctrlKey || ev.metaKey)) {
      selectAllVisible();
    } else return;
    ev.preventDefault();
    ev.stopPropagation();
    if (next !== gridCursor && next >= 0) {
      // Ctrl+arrow moves the cursor without disturbing the selection, exactly as
      // VList's own listbox keyboard does in the table view.
      if (ev.ctrlKey || ev.metaKey) { gridCursor = next; cardList.refresh(); }
      else pickGrid(next, ev.shiftKey ? 'range' : 'set');
      scrollGridTo(next);
    }
  }, true);

  // =========================================================================
  // SELECTION
  // =========================================================================
  function addSel(p) {
    const key = low(p);
    if (state.selSet.has(key)) return;
    state.selSet.add(key);
    state.sel.push(String(p));
  }
  function removeSel(p) {
    const key = low(p);
    if (!state.selSet.delete(key)) return;
    state.sel = state.sel.filter((x) => low(x) !== key);
  }

  function adoptSelection(keys) {
    state.sel = (keys || []).map(String);
    state.selSet = new Set(state.sel.map(low));
    if (state.sel.length) focusFile(state.sel[state.sel.length - 1]);
    else focusFile('');
    afterSelection();
  }

  function afterSelection() {
    renderSelBar();
    renderInspector();
    if (state.mode === 'grid') cardList.refresh();
    syncCheckAll();
    publishSoon();
  }

  function syncSelectionInto() {
    if (state.mode === 'list') rowList.selectKeys(state.sel, true);
    syncCheckAll();
    renderSelBar();
  }

  function selectAllVisible() {
    state.sel = []; state.selSet = new Set();
    for (const f of state.rows) addSel(f.path);
    if (state.mode === 'list') rowList.selectKeys(state.sel, true);
    afterSelection();
  }

  function clearSelection() {
    state.sel = []; state.selSet = new Set();
    if (state.mode === 'list') rowList.clearSelection(true);
    focusFile('');
    afterSelection();
  }

  function syncCheckAll() {
    const box = $('check-all');
    if (!box) return;
    const total = state.rows.length;
    let n = 0;
    for (const f of state.rows) if (state.selSet.has(low(f.path))) n++;
    box.setAttribute('aria-checked', !n ? 'false' : n === total ? 'true' : 'mixed');
    box.disabled = !total;
  }

  function selectedFiles() {
    const out = [];
    for (const p of state.sel) { const f = fileFor(p); if (f) out.push(f); }
    return out;
  }

  function focusFile(p) {
    const next = String(p || '');
    if (low(next) === low(state.focusPath)) return;
    state.focusPath = next;
    state.art = null;
    artHandle.invalidate();
    const file = next ? fileFor(next) : null;
    // A missing file has nothing to read, so asking for its roll would only be a
    // failed main-process read per selection.
    if (next && !(file && file.missing)) loadArtSoon(next);
    else loadArtSoon.cancel();
    renderInspector();
  }

  // =========================================================================
  // THE ART: a real piano-roll thumbnail of the selected file
  // =========================================================================
  let artToken = 0;
  function loadArt(p, after) {
    if (!lib.meta) return;
    const token = ++artToken;
    lib.meta({ paths: [], roll: p }).then((r) => {
      if (token !== artToken || low(state.focusPath) !== low(p)) return;
      state.art = (r && r.roll) || null;
      const file = state.byPath.get(low(p));
      if (file && state.art && Number.isFinite(state.art.notes)) {
        file.notes = state.art.notes;
        file.dur = state.art.duration;
        file.bpm = state.art.bpm;
        paintRows();
      }
      artHandle.invalidate();
      renderInspector();
      if (after) after();
    }, () => {});
  }

  // DEBOUNCED, because every roll is a full file read plus a parse of the whole
  // note array in the main process. VList's ArrowDown calls setCursor per row, so
  // holding it across a hundred rows used to issue a hundred concurrent invokes
  // on the process that has to service all other IPC and window input; artToken
  // discarded the stale ANSWERS but never prevented the WORK. Trailing edge, last
  // path wins: only the row the user settles on is ever parsed.
  const loadArtSoon = debounce((p) => loadArt(p), 150);

  const artHost = $('art-host');
  const artCanvas = $('art');
  const artHandle = window.Draw.register({
    key: 'library:art',
    el: artHost,
    draw() {
      const w = artHost.clientWidth, h = artHost.clientHeight;
      if (!w || !h) return;
      const fit = window.Draw.fitCanvas(artCanvas, w, h);
      const ctx = fit.ctx;
      const Tk = window.Tokens;
      ctx.clearRect(0, 0, fit.w, fit.h);
      const art = state.art;
      const many = state.sel.length > 1;
      if (many || !art || !art.roll || !art.roll.length) return;

      // graphite bed + octave rules
      const lines = Tk.get('line', '#2b2e36');
      let lo = 127, hi = 0;
      for (const n of art.roll) { if (n[2] < lo) lo = n[2]; if (n[2] > hi) hi = n[2]; }
      if (hi - lo < 12) { const mid = (hi + lo) / 2; lo = Math.max(0, mid - 6); hi = Math.min(127, mid + 6); }
      const pad = 4;
      const span = Math.max(0.001, art.duration || 1);
      const pitchH = (fit.h - pad * 2) / (hi - lo + 1);
      ctx.fillStyle = Tk.get('bg-2', '#0f1013');
      ctx.fillRect(0, 0, fit.w, fit.h);
      ctx.strokeStyle = lines;
      ctx.lineWidth = 1;
      for (let pitch = Math.ceil(lo / 12) * 12; pitch <= hi; pitch += 12) {
        const y = Math.round(pad + (hi - pitch) * pitchH) + 0.5;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(fit.w, y); ctx.stroke();
      }

      const dim = Tk.get('accent-deep', '#8fb320');
      const hot = Tk.get('accent', '#b8e62e');
      const at = previewTime();
      for (const n of art.roll) {
        const x = pad + (n[0] / span) * (fit.w - pad * 2);
        const wpx = Math.max(1.5, (n[1] / span) * (fit.w - pad * 2));
        const y = pad + (hi - n[2]) * pitchH;
        const sounding = at !== null && at >= n[0] && at < n[0] + n[1];
        ctx.fillStyle = sounding ? hot : dim;
        ctx.fillRect(Math.round(x), Math.round(y), Math.max(1.5, wpx), Math.max(1.5, pitchH - 1));
      }
      if (at !== null) {
        const x = Math.round(pad + (at / span) * (fit.w - pad * 2)) + 0.5;
        ctx.strokeStyle = hot;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, fit.h); ctx.stroke();
      }
    }
  });
  cleanups.push(() => artHandle.dispose());
  if (window.Tokens) cleanups.push(window.Tokens.onChange(() => artHandle.invalidate()));

  // =========================================================================
  // LOCAL PREVIEW
  // Not the global transport: the Library is not one of the three owners, so it
  // claims nothing, publishes no caps and reports no state -- and it stops the
  // moment a real owner starts (CONTRACT 7).
  // =========================================================================
  const audio = $('preview');
  let previewPath = '';

  function previewTime() {
    // The playhead and the accent "currently sounding" notes describe the file the
    // plate is DRAWING. Previewing file A and then clicking row B used to sweep
    // A's clock across B's roll and light up B's notes, putting the one functional
    // accent on data it does not describe.
    if (!previewPath || !state.art || low(state.art.path) !== low(previewPath)) return null;
    if (audio.paused || !Number.isFinite(audio.currentTime)) return null;
    return audio.currentTime;
  }

  // What the ROLL knows: the exact audio path out of the .midstudio.json sidecar.
  // Only available once that file's roll has been read.
  function previewAudioFor(p) {
    if (!state.art || low(state.art.path) !== low(p)) return '';
    return state.art.previewAudio || state.art.sourceAudio || '';
  }

  function rollKnown(p) { return !!(state.art && low(state.art.path) === low(p)); }

  // What the INDEX knows: whether a sidecar exists at all (library:scan derives
  // hasAudio from the sidecar set it already collected). Right-clicking a row
  // selects it and starts an async roll read, and the menu is built on the very
  // next line -- so a test that needs the roll greys Preview out on every row the
  // user has not already been sitting on. This one needs nothing but the scan.
  function canPreview(p) {
    if (!p) return false;
    if (rollKnown(p)) return !!previewAudioFor(p);
    const f = fileFor(p);
    return !!(f && f.hasAudio && !f.missing);
  }

  function noPreviewToast() {
    toast('warn', 'Nothing to preview',
      'This file has no source recording. Listen plays the notes instead.');
  }

  function startPreview(p) {
    const target = String(p || '');
    if (!target || !lib.fileUrl) return;
    if (rollKnown(target)) { beginPreview(target); return; }
    if (!canPreview(target)) { noPreviewToast(); return; }
    // The sidecar says there is audio but its roll has not arrived yet: read it
    // now rather than refusing an action the file can perform.
    loadArtSoon.cancel();
    loadArt(target, () => beginPreview(target));
  }

  function beginPreview(p) {
    const src = previewAudioFor(p);
    if (!src) { noPreviewToast(); return; }
    if (!lib.fileUrl) return;
    stopPreview();
    previewPath = String(p);
    audio.src = lib.fileUrl(src);
    audio.currentTime = 0;
    const played = audio.play();
    if (played && played.catch) played.catch(() => {
      previewPath = '';
      toast('err', 'Preview failed', 'The source audio could not be opened.');
      renderActions();
    });
    artHandle.setLive(true);
    record(p, 'preview');
    renderActions();
  }

  function stopPreview() {
    if (!previewPath) return;
    previewPath = '';
    try { audio.pause(); audio.removeAttribute('src'); audio.load(); } catch (_) {}
    artHandle.setLive(false);
    artHandle.invalidate();
    renderActions();
  }

  on(audio, 'timeupdate', () => artHandle.invalidate());
  on(audio, 'ended', () => stopPreview());
  on(audio, 'error', () => { if (previewPath) { previewPath = ''; artHandle.setLive(false); renderActions(); } });
  cleanups.push(stopPreview);

  if (window.Transport) {
    cleanups.push(window.Transport.onChange((s) => {
      if (!s) return;
      if (s.status === 'playing' || s.status === 'counting') stopPreview();
      noteTransport(s);
    }));
  }

  // =========================================================================
  // USAGE.  The inspector is only worth having if it is truthful, so every use
  // this panel can actually observe is recorded: what it sends itself, what the
  // transport reports playing, and what Forge says it produced.
  // =========================================================================
  const seen = new Map();
  function record(p, kind) {
    if (!p || !lib.usage) return;
    const key = low(p) + '|' + kind;
    const now = Date.now();
    if (now - (seen.get(key) || 0) < 4000) return;
    seen.set(key, now);
    lib.usage({ path: String(p), kind, at: now }).then((r) => {
      const u = r && r.usage;
      const file = fileFor(p);
      if (!file || !u) return;
      file.plays = Number(u.c) || 0;
      file.lastPlayed = Number(u.l) || 0;
      file.events = Array.isArray(u.e) ? u.e.slice() : [];
      file.lastUse = file.events.length ? (Number(file.events[0].t) || 0) : 0;
      if (low(p) === low(state.focusPath)) renderInspector();
    }, () => {});
  }

  // A play that started in another tab still belongs in this file's history.
  // transport:state is relayed to every frame, and its label is the filename the
  // owner is showing, which is enough to attribute it without guessing.
  let lastOwnerKey = '';
  function noteTransport(s) {
    if (!s || (s.status !== 'playing' && s.status !== 'counting')) { lastOwnerKey = ''; return; }
    const owner = s.owner === 'audition' ? 'selfmidi' : s.owner;
    if (!owner || !USE_LABEL[owner]) return;
    const label = low(Fmt.basename(String(s.label || '')));
    if (!label) return;
    const key = owner + '|' + label;
    if (key === lastOwnerKey) return;
    lastOwnerKey = key;
    const stem = label.replace(/\.midi?$/, '');
    for (const file of state.files) {
      if (file.nameLow === stem || low(Fmt.basename(file.path)) === label) { record(file.path, owner); return; }
    }
  }

  // =========================================================================
  // HAND-OFF
  // =========================================================================
  // `play` is TRI-STATE and the ROUTER fills it in (CONTRACT 11.2): shell.js only
  // substitutes the user's Settings > Playback > "Sending a file to the Player"
  // choice when `play` is undefined, and that choice defaults to load-without-
  // playing (invariant 17: loading a track is not playing it). So every button,
  // menu item and palette command leaves it undefined and lets the router decide;
  // the ONLY caller that passes true is a row/card activation, which is itself the
  // explicit ask.
  function sendTo(where, paths, play) {
    let list = (paths || []).filter(Boolean);
    if (!list.length || !Bus) return;
    const gone = list.filter((f) => state.ghosts.has(low(f)));
    if (gone.length) {
      list = list.filter((f) => !state.ghosts.has(low(f)));
      if (!list.length) {
        toast('warn', 'That file is missing',
          Fmt.basename(gone[0]) + ' is no longer on disk, so there is nothing to send.');
        return;
      }
    }
    const first = list[0];
    const payload = { midiPath: first };
    if (play !== undefined) payload.play = !!play;
    if (where === 'player') { Bus.send(T.NAV_OPEN_PLAYER, payload); record(first, 'player'); }
    else if (where === 'selfmidi') { Bus.send(T.NAV_OPEN_SELFMIDI, payload); record(first, 'selfmidi'); }
    else if (where === 'editor') {
      const art = state.art && low(state.art.path) === low(first) ? state.art : null;
      delete payload.play;
      if (art && art.projectPath) payload.projectPath = art.projectPath;
      Bus.send(T.NAV_OPEN_EDITOR, payload);
      record(first, 'editor');
    }
    if (list.length > 1) {
      toast('info', 'One file at a time', (list.length - 1) + ' more were left here.');
    }
  }

  function reveal(p) {
    if (!p) return;
    if (Bus) Bus.send(T.FILE_REVEAL, { path: p });
    else if (lib.reveal) lib.reveal(p);
    record(p, 'reveal');
  }

  function toast(severity, title, message) {
    if (Bus) Bus.send(T.UI_TOAST, { severity, title, message: message || '' });
  }

  // =========================================================================
  // CONFIRMATION -- the app's one dialog surface (CONTRACT 2.14), not
  // window.confirm. A native Chromium dialog inside an iframe is a different
  // design language, is neither theme- nor density-aware, and blocks the frame's
  // event loop instead of joining this panel's Escape/focus chain. Toggled with
  // el.hidden, because .dlg-scrim is display:flex (invariant 29).
  // =========================================================================
  const dlg = {
    scrim: $('confirm-scrim'), title: $('confirm-title'), msg: $('confirm-msg'),
    yes: $('confirm-yes'), no: $('confirm-no'), resolve: null, restore: null
  };
  let dlgTimer = 0, dlgGen = 0;

  function setDlgOpen(want) {
    clearTimeout(dlgTimer);
    dlgTimer = 0;
    dlgGen++;
    const gen = dlgGen;
    if (want) {
      dlg.scrim.hidden = false;
      // One frame at the closed transform, so the enter transition actually runs.
      requestAnimationFrame(() => { if (gen === dlgGen) dlg.scrim.classList.add('is-open'); });
      return;
    }
    dlg.scrim.classList.remove('is-open');
    dlgTimer = setTimeout(() => { dlgTimer = 0; dlg.scrim.hidden = true; }, 180);
  }

  function closeConfirm(answer) {
    if (!dlg.resolve) return;
    const done = dlg.resolve;
    const back = dlg.restore;
    dlg.resolve = null;
    dlg.restore = null;
    setDlgOpen(false);
    if (back && back.focus && back.isConnected) { try { back.focus(); } catch (_) {} }
    done(answer);
  }

  function confirmDanger(opts) {
    closeConfirm(false);              // never two questions at once
    dlg.title.textContent = opts.title;
    dlg.msg.textContent = opts.message;
    dlg.yes.textContent = opts.confirm;
    dlg.restore = document.activeElement;
    setDlgOpen(true);
    dlg.yes.focus();
    return new Promise((resolve) => { dlg.resolve = resolve; });
  }

  on(dlg.yes, 'click', () => closeConfirm(true));
  on(dlg.no, 'click', () => closeConfirm(false));
  on(dlg.scrim, 'pointerdown', (ev) => { if (ev.target === dlg.scrim) closeConfirm(false); });
  // The focus trap plus Escape precedence. Escape is stopped here so it closes
  // the dialog without also clearing the search or the selection behind it.
  on(dlg.scrim, 'keydown', (ev) => {
    if (ev.key === 'Escape') { ev.stopPropagation(); ev.preventDefault(); closeConfirm(false); return; }
    if (ev.key !== 'Tab') return;
    ev.preventDefault();
    const stops = [dlg.no, dlg.yes];
    const at = stops.indexOf(document.activeElement);
    const next = ev.shiftKey
      ? (at <= 0 ? stops.length - 1 : at - 1)
      : (at < 0 || at >= stops.length - 1 ? 0 : at + 1);
    stops[next].focus();
  });
  // Answer first, THEN kill the close timer: the other order lets the exit timer
  // this schedules outlive the teardown that was meant to clear it.
  cleanups.push(() => closeConfirm(false));
  cleanups.push(() => { clearTimeout(dlgTimer); dlgTimer = 0; });

  // =========================================================================
  // ROW MENU
  // =========================================================================
  function openRowMenu(file, at) {
    if (!file || !window.Menu) return;
    const many = state.selSet.has(low(file.path)) && state.sel.length > 1;
    const targets = many ? state.sel.slice() : [file.path];
    const fav = many ? targets.every((p) => isFav(p)) : file.fav;
    const opts0 = { ariaLabel: file.name,
      returnFocusTo: state.mode === 'grid' ? cardsHost : rowList.host };
    if (at && at.anchor) opts0.anchor = at.anchor; else { opts0.x = at.x; opts0.y = at.y; }
    // A missing favourite can only be un-favourited or copied: everything else
    // needs a file that is not there.
    if (!many && file.missing) {
      window.Menu.open([
        { group: file.name },
        { group: 'Missing — not on disk' },
        { label: 'Remove from Favorites', run: () => setFav([file.path], false) },
        { label: 'Copy path', run: () => copyPaths([file.path]) }
      ], opts0);
      return;
    }
    const items = [
      { group: many ? targets.length + ' files' : file.name },
      !many && { label: 'Preview', icon: 'play', disabled: !canPreview(file.path),
        run: () => startPreview(file.path) },
      { label: 'Send to Player', key: 'Enter', icon: 'send', run: () => sendTo('player', targets) },
      { label: 'Listen', run: () => sendTo('selfmidi', targets) },
      { label: 'Open in Editor', run: () => sendTo('editor', targets) },
      { sep: true },
      { label: 'Favorite', checked: fav, run: () => setFav(targets, !fav) },
      { label: 'Add a tag…', run: () => { showInspector(); setTab('details'); openTagAdd(); } },
      { sep: true },
      !many && { label: 'Reveal in Explorer', icon: 'folder', run: () => reveal(file.path) },
      { label: many ? 'Copy paths' : 'Copy path', run: () => copyPaths(targets) },
      { sep: true },
      { label: many ? 'Delete ' + targets.length + ' files…' : 'Delete…', danger: true,
        run: () => remove(targets) }
    ];
    if (many) opts0.ariaLabel = targets.length + ' files';
    window.Menu.open(items, opts0);
  }

  function copyPaths(paths) {
    const text = (paths || []).join('\r\n');
    if (!text) return;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(
          () => toast('ok', paths.length > 1 ? paths.length + ' paths copied' : 'Path copied'),
          () => toast('warn', 'Could not copy', 'The clipboard refused the write.'));
      }
    } catch (_) { toast('warn', 'Could not copy', 'The clipboard refused the write.'); }
  }

  function remove(paths) {
    const list = (paths || []).filter(Boolean).filter((f) => !state.ghosts.has(low(f)));
    if (!list.length || !lib.remove) return;
    const what = list.length === 1 ? Fmt.basename(list[0]) : list.length + ' MIDI files';
    confirmDanger({
      title: list.length === 1 ? 'Delete this file?' : 'Delete ' + list.length + ' files?',
      message: 'Move ' + what + ' to the Recycle Bin? '
        + (list.length === 1 ? 'It can be restored' : 'They can be restored') + ' from there.',
      confirm: list.length === 1 ? 'Move to Recycle Bin' : 'Move ' + list.length + ' to Recycle Bin'
    }).then((yes) => { if (yes) doRemove(list); });
  }

  function doRemove(list) {
    lib.remove({ paths: list }).then((r) => {
      const done = (r && r.trashed) || [];
      const failed = (r && r.failed) || [];
      if (done.length) {
        for (const p of done) { state.byPath.delete(low(p)); state.selSet.delete(low(p)); }
        state.sel = state.sel.filter((p) => !done.some((d) => low(d) === low(p)));
        state.files = state.files.filter((f) => state.byPath.has(low(f.path)));
        if (done.some((d) => low(d) === low(state.focusPath))) focusFile('');
        recount(); apply(); afterSelection();
        toast('ok', done.length === 1 ? 'Moved to the Recycle Bin' : done.length + ' files moved to the Recycle Bin',
          done.length === 1 ? Fmt.basename(done[0]) : '');
      }
      if (failed.length) toast('err', 'Some files stayed', failed.map((f) => Fmt.basename(f.path)).join(', '));
    }, (error) => toast('err', 'Delete failed', String((error && error.message) || error)));
  }

  // =========================================================================
  // SIDEBAR
  // =========================================================================
  function recount() {
    rebuildGhosts();
    const c = { all: 0, generated: 0, imported: 0, favorites: 0, recent: 0 };
    const cut = Date.now() - RECENT_MS;
    const folders = new Map();
    for (const dir of state.dirs) folders.set(low(dir), 0);
    for (const file of state.files) {
      c.all++;
      if (file.source === 'generated') c.generated++;
      if (file.source === 'imported') c.imported++;
      if (file.fav) c.favorites++;
      if (file.modified >= cut || file.lastUse >= cut) c.recent++;
      for (const dir of folders.keys()) {
        if (file.dirLow === dir || file.dirLow.startsWith(dir + '\\') || file.dirLow.startsWith(dir + '/')) {
          folders.set(dir, folders.get(dir) + 1);
        }
      }
    }
    // A favourite whose file is gone is still a favourite: it is counted, or the
    // count contradicts the view it labels.
    c.favorites += state.ghosts.size;
    state.counts = c;
    state.folderCounts = folders;
    for (const el of document.querySelectorAll('#views [data-count]')) {
      el.textContent = (c[el.dataset.count] || 0).toLocaleString();
    }
    const fc = $('folder-count');
    const shown = folderRows().length;
    if (fc) fc.textContent = shown ? String(shown) : '';
    renderFolderCounts();
    refreshTagFilter();
  }

  // dirs[0] is the Forge output folder and dirs[1] is ~/Documents/MIDI Studio,
  // and by default those are the SAME path -- so the list is deduplicated for
  // display while the built-in test stays exactly what CONTRACT 11.12 says it
  // is: an index below 2 in the array main returned.
  function folderRows() {
    const out = [];
    const seen = new Set();
    state.dirs.forEach((dir, i) => {
      const key = low(dir);
      if (!dir || seen.has(key)) return;
      seen.add(key);
      out.push({ dir: dir, builtin: i < BUILTIN });
    });
    return out;
  }

  function renderFolders() {
    const host = $('folders');
    if (!host) return;
    host.textContent = '';
    folderRows().forEach((entry) => {
      const dir = entry.dir;
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'lrow';
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', 'false');
      row.dataset.dir = dir;
      row.title = dir;
      const base = Fmt.basename(dir) || dir;
      // One line, the way the reference reads a folder list: the whole path is
      // on row.title above and on the "open in Explorer" button beside it.
      row.innerHTML = '<span class="lrow-icon"><i data-icon="folder" data-icon-size="13"></i></span>'
        + '<span class="lrow-main"><span class="lrow-name"></span></span>'
        + '<span class="lrow-meta" data-fcount>0</span>'
        + '<span class="lrow-actions"></span>';
      row.children[1].children[0].textContent = base;
      const actions = row.children[3];
      if (entry.builtin) {
        // library:removeFolder only filters the USER list, so a remove button
        // on either built-in would do nothing at all (CONTRACT 11.12).
        const tag = document.createElement('span');
        tag.className = 'tag is-bare lrow-tag';
        tag.textContent = 'built in';
        actions.appendChild(tag);
      } else {
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'btn btn-icon is-sm is-bare';
        rm.setAttribute('aria-label', 'Stop scanning ' + base);
        rm.tabIndex = -1;
        rm.innerHTML = '<i data-icon="close" data-icon-size="11"></i>';
        rm.addEventListener('click', (ev) => {
          ev.stopPropagation();
          if (!lib.removeFolder) return;
          lib.removeFolder(dir).then(() => {
            if (low(state.folder) === low(dir)) setView('all', '');
          }, (error) => toast('err', 'The folder could not be removed',
            String((error && error.message) || error)));
        });
        actions.appendChild(rm);
      }
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'btn btn-icon is-sm is-bare';
      open.setAttribute('aria-label', 'Open ' + base + ' in Explorer');
      open.tabIndex = -1;
      open.innerHTML = '<i data-icon="folder" data-icon-size="11"></i>';
      open.addEventListener('click', (ev) => { ev.stopPropagation(); if (lib.openPath) quiet(lib.openPath(dir)); });
      actions.appendChild(open);
      host.appendChild(row);
    });
    if (window.Icon) window.Icon.apply(host);
    renderFolderCounts();
    syncViewRows();
  }

  function renderFolderCounts() {
    const counts = state.folderCounts || new Map();
    for (const row of document.querySelectorAll('#folders .lrow')) {
      const cell = row.querySelector('[data-fcount]');
      if (cell) cell.textContent = (counts.get(low(row.dataset.dir)) || 0).toLocaleString();
    }
  }

  // Roving tabindex (CONTRACT 2.5): a listbox is ONE tab stop and its options are
  // reached with the arrow keys. Leaving every option focusable made Tab walk
  // every view and every folder one at a time, and a listbox whose options are
  // individually tabbable is an ARIA violation.
  function rove(rows, isOn) {
    let found = false;
    for (const row of rows) {
      const on2 = isOn(row);
      row.setAttribute('aria-selected', on2 ? 'true' : 'false');
      row.tabIndex = on2 ? 0 : -1;
      if (on2) found = true;
    }
    // Nothing selected in this list (the other one owns the view): the first row
    // keeps the tab stop, or the list cannot be reached from the keyboard at all.
    if (!found && rows.length) rows[0].tabIndex = 0;
  }

  function syncViewRows() {
    rove([...document.querySelectorAll('#views .lrow')], (row) => state.view === row.dataset.view);
    rove([...document.querySelectorAll('#folders .lrow')],
      (row) => state.view === 'folder' && low(row.dataset.dir) === low(state.folder));
  }

  function setView(view, folder) {
    state.view = view;
    state.folder = low(folder || '');
    syncViewRows();
    apply();
    publishSoon();
  }

  function renderStorage() {
    const s = state.storage;
    const drive = $('store-drive'), text = $('store-text'), sub = $('store-sub');
    const meter = $('store-meter'), fill = $('store-fill'), box = $('store');
    const lowPill = $('store-low');
    if (!s || !Number.isFinite(s.totalBytes) || !s.totalBytes) {
      drive.textContent = 'Storage' + (s && s.root ? ' (' + s.root.replace(/\\$/, '') + ')' : '');
      text.textContent = 'unknown';
      sub.textContent = 'The drive would not report its size.';
      fill.style.setProperty('--p', '0');
      meter.setAttribute('aria-valuenow', '0');
      meter.setAttribute('aria-valuetext', 'unknown');
      box.classList.remove('is-low');
      lowPill.hidden = true;
      return;
    }
    const used = s.usedBytes, total = s.totalBytes;
    const p = Math.max(0, Math.min(1, used / total));
    // Low space is a WORD (the pill) and an aria-valuetext, not a colour on its
    // own: rule 11, and a forced-colours mode gets no colour at all.
    const tight = s.freeBytes < 5 * 1024 * 1024 * 1024;
    drive.textContent = 'Storage (' + ((s.root || '').replace(/\\$/, '') || 'drive') + ')';
    text.textContent = Fmt.gb(used) + ' of ' + Fmt.gb(total) + ' used';
    sub.textContent = (tight ? 'Low: only ' : '') + Fmt.bytes(s.freeBytes)
      + ' free for new transcriptions.';
    fill.style.setProperty('--p', String(Math.round(p * 1000) / 1000));
    meter.setAttribute('aria-valuenow', String(Math.round(p * 100)));
    meter.setAttribute('aria-valuetext', text.textContent + (tight ? ', low space' : ''));
    box.classList.toggle('is-low', tight);
    lowPill.hidden = !tight;
  }

  // arrow-key roving for the two sidebar listboxes
  function rovingList(host, activate) {
    on(host, 'click', (ev) => {
      const row = ev.target.closest ? ev.target.closest('.lrow') : null;
      if (row && host.contains(row)) activate(row);
    });
    on(host, 'keydown', (ev) => {
      const rows = [...host.querySelectorAll('.lrow')];
      if (!rows.length) return;
      let at = rows.findIndex((r) => r.getAttribute('aria-selected') === 'true');
      if (ev.key === 'ArrowDown') at = (at + 1 + rows.length) % rows.length;
      else if (ev.key === 'ArrowUp') at = (at - 1 + rows.length) % rows.length;
      else if (ev.key === 'Home') at = 0;
      else if (ev.key === 'End') at = rows.length - 1;
      else if (ev.key === 'Enter' || ev.key === ' ') { if (at >= 0) activate(rows[at]); ev.preventDefault(); return; }
      else return;
      ev.preventDefault();
      activate(rows[at]);
      rows[at].focus();
      rows[at].scrollIntoView({ block: 'nearest' });
    });
  }
  rovingList($('views'), (row) => setView(row.dataset.view, ''));
  rovingList($('folders'), (row) => setView('folder', row.dataset.dir));

  // =========================================================================
  // INSPECTOR
  // =========================================================================
  function setTab(which) {
    state.tab = which;
    $('tab-details').setAttribute('aria-selected', which === 'details' ? 'true' : 'false');
    $('tab-history').setAttribute('aria-selected', which === 'history' ? 'true' : 'false');
    $('pane-details').hidden = which !== 'details';
    $('pane-history').hidden = which !== 'history';
    if (which === 'details') artHandle.invalidate();
  }

  function usageRow(ev) {
    const row = document.createElement('div');
    row.className = 'lrow';
    row.innerHTML = '<span class="lrow-main"><span class="lrow-name"></span></span><span class="lrow-meta"></span>';
    row.children[0].firstChild.textContent = USE_LABEL[ev.k] || ev.k;
    row.children[1].textContent = Fmt.when(ev.t);
    row.children[1].title = Fmt.stamp(ev.t);
    return row;
  }

  function renderInspector() {
    const many = state.sel.length > 1;
    const file = fileFor(state.focusPath);
    const name = $('i-name'), line = $('i-line'), gen = $('i-gen');

    if (many) {
      let bytes = 0, notes = 0, dur = 0, known = 0;
      for (const f of selectedFiles()) {
        bytes += f.size;
        if (f.notes !== null) { notes += f.notes; dur += f.dur; known++; }
      }
      name.textContent = state.sel.length + ' files selected';
      name.title = '';
      line.textContent = Fmt.bytes(bytes) + (known ? ' · ' + notes.toLocaleString() + ' notes · ' + Fmt.duration(dur) : '');
      gen.textContent = known < state.sel.length ? (state.sel.length - known) + ' not indexed yet' : '';
    } else if (!file) {
      name.textContent = 'Nothing selected';
      name.title = '';
      line.textContent = 'Pick a file to see what is in it.';
      gen.textContent = '';
    } else if (file.missing) {
      name.textContent = Fmt.basename(file.path);
      name.title = file.path;
      line.textContent = 'Not found on disk';
      gen.textContent = 'This favourite is kept until you remove it. Reconnect the drive or folder '
        + 'it lives on and rescan.';
    } else {
      name.textContent = Fmt.basename(file.path);
      name.title = file.path;
      line.textContent = notesOf(file) + (file.notes === null ? ' notes' : ' notes') + ' · ' + lenOf(file)
        + (file.bpm ? ' · ' + Fmt.bpm(file.bpm) + ' BPM' : '');
      const art = state.art && low(state.art.path) === low(file.path) ? state.art : null;
      const when = art && art.createdAt ? new Date(art.createdAt).getTime() : 0;
      gen.textContent = file.source === 'generated'
        ? 'Generated ' + Fmt.when(when || file.modified) + (art && art.pipeline ? ' · ' + art.pipeline + ' pipeline' : '')
        : file.source === 'imported' ? 'Imported from a folder you added' : 'Found in your library';
    }

    const tag = $('art-tag');
    if (file && !many) {
      tag.hidden = false;
      tag.className = 'tag lib-art-tag' + (file.missing ? ' is-err' : '');
      tag.textContent = file.missing ? 'Missing' : (SRC_LABEL[file.source] || 'Library');
    } else tag.hidden = true;

    // The plate's label is set here, not in the draw: the draw is parked while
    // the inspector is off screen and would leave a stale word behind.
    const art2 = state.art && file && low(state.art.path) === low(file.path) ? state.art : null;
    const blank = many || !art2 || !art2.roll || !art2.roll.length;
    const empty = $('art-empty');
    empty.hidden = !blank;
    if (blank) {
      empty.textContent = many ? state.sel.length + ' files selected'
        : !file ? 'Nothing selected'
          : file.missing ? 'File not found'
            : art2 ? 'No notes to draw' : 'Reading the file…';
    }

    renderTags(file, many);
    renderProps(file, many);
    renderUsage(file);
    renderActions();
    artHandle.invalidate();
  }

  function renderTags(file, many) {
    const host = $('i-tags');
    host.textContent = '';
    const tags = many ? [] : (file ? file.tags : []);
    $('tag-count').textContent = String(tags.length);
    for (const t of tags) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.innerHTML = '<span class="chip-text"></span><button class="chip-x" type="button"></button>';
      chip.children[0].textContent = t;
      chip.children[1].setAttribute('aria-label', 'Remove the tag ' + t);
      chip.children[1].innerHTML = '<i data-icon="close" data-icon-size="10"></i>';
      chip.children[1].addEventListener('click', () => applyTags(file.path, file.tags.filter((x) => x !== t)));
      host.appendChild(chip);
    }
    if (window.Icon) window.Icon.apply(host);
    const input = $('tag-input');
    input.disabled = !file && !many;
    input.placeholder = many ? 'Tag all ' + state.sel.length : 'Add a tag';
    $('tag-add').disabled = input.disabled;
    $('tag-more').disabled = input.disabled;
    $('tag-hint').textContent = many
      ? 'Adding a tag here applies it to every selected file.'
      : 'Tags are yours: they are saved with the library index, not in the file.';
    if (input.disabled) closeTagAdd();
  }

  function renderProps(file, many) {
    const set = (id, v) => { $(id).textContent = v; };
    const chip = $('p-path');
    const reveal = chip.querySelector('.pathchip-reveal');
    const gone = !!(file && file.missing && !many);
    // .pathchip.is-missing is the shared marker for a path that is not there.
    chip.classList.toggle('is-missing', gone);
    if (reveal) reveal.disabled = gone || !file || many;
    if (!file || many) {
      for (const id of ['p-type', 'p-source', 'p-size', 'p-date', 'p-last', 'p-plays']) set(id, EM);
      chip.children[0].textContent = '';
      chip.children[1].textContent = many ? state.sel.length + ' files' : EM;
      chip.title = '';
      return;
    }
    set('p-type', '.' + file.ext);
    set('p-source', gone ? 'Missing' : (SRC_LABEL[file.source] || 'Library'));
    set('p-size', gone ? EM : Fmt.bytes(file.size));
    set('p-date', gone ? EM : Fmt.when(file.modified));
    $('p-date').title = gone ? '' : Fmt.stamp(file.modified);
    set('p-last', file.lastPlayed ? Fmt.when(file.lastPlayed) : 'never');
    $('p-last').title = file.lastPlayed ? Fmt.stamp(file.lastPlayed) : '';
    set('p-plays', String(file.plays));
    const base = Fmt.basename(file.path);
    chip.children[0].textContent = file.path.slice(0, file.path.length - base.length);
    chip.children[1].textContent = base;
    chip.title = gone ? file.path + ' (not found)' : file.path;
  }

  function renderUsage(file) {
    const host = $('i-usage'), empty = $('usage-empty');
    const hist = $('i-history'), hEmpty = $('hist-empty');
    host.textContent = '';
    hist.textContent = '';
    const events = file ? file.events : [];
    $('hist-count').textContent = String(events.length);
    empty.hidden = events.length > 0;
    hEmpty.hidden = events.length > 0;
    for (const ev of events.slice(0, 3)) host.appendChild(usageRow(ev));
    for (const ev of events) hist.appendChild(usageRow(ev));
    $('see-all').hidden = !events.length;
  }

  function renderActions() {
    const many = state.sel.length > 1;
    const file = fileFor(state.focusPath);
    const has = !!file;
    // A missing favourite: every action that needs the file is off, and only
    // un-favouriting is left (CONTRACT 11.12). With a multi-selection the buttons
    // act on the whole selection, which sendTo/remove already filter.
    const gone = !!(file && file.missing) && !many;
    const playing = !!previewPath;
    const prev = $('a-preview');
    $('a-preview-t').textContent = playing ? 'Stop preview' : 'Preview';
    if (window.Icon) $('a-preview-i').innerHTML = window.Icon.svg(playing ? 'stop' : 'play', 15);
    prev.disabled = !has || many || gone || (!playing && !canPreview(state.focusPath));
    $('a-editor').disabled = !has || gone;
    $('a-player').disabled = !has || gone;
    $('a-listen').disabled = !has || gone;
    $('a-reveal').disabled = !has || many || gone;
    $('a-delete').disabled = (!has && !many) || gone;
    const fav = $('a-fav');
    const on2 = many ? selectedFiles().every((f) => f.fav) : (file ? file.fav : false);
    fav.disabled = !has && !many;
    fav.setAttribute('aria-pressed', on2 ? 'true' : 'false');
    fav.textContent = on2 ? 'Favorited' : 'Favorite';
    const note = $('a-note');
    if (gone) {
      note.hidden = false;
      note.textContent = 'This file is no longer on disk. It stays in Favorites until you remove it, '
        + 'and everything else here needs the file.';
    } else if (has && !many && !canPreview(state.focusPath)) {
      note.hidden = false;
      note.textContent = 'No source recording for this file, so Preview has nothing to play. Listen plays the notes.';
    } else note.hidden = true;
  }

  function applyTags(path, tags) {
    if (!path || !lib.setTags) return;
    lib.setTags({ path, tags }).then((r) => {
      const file = fileFor(path);
      if (!file) return;
      file.tags = (r && r.tags) || [];
      rebuildHay(file);
      refreshTagFilter();
      paintRows();
      renderInspector();
      apply();
    }, () => {});
  }

  // The chips row carries one "+"; the field itself is the disclosure behind
  // it, so the inspector stays as quiet as the reference until you ask.
  function openTagAdd() {
    if ($('tag-input').disabled) return;
    $('tagadd').hidden = false;
    $('tag-hint').hidden = false;
    $('tag-more').setAttribute('aria-expanded', 'true');
    $('tag-input').focus();
  }
  function closeTagAdd() {
    $('tagadd').hidden = true;
    $('tag-hint').hidden = true;
    $('tag-more').setAttribute('aria-expanded', 'false');
  }

  function addTagFromInput() {
    const input = $('tag-input');
    const value = input.value.trim();
    if (!value) return;
    const focused = fileFor(state.focusPath);
    const targets = state.sel.length > 1 ? selectedFiles() : (focused ? [focused] : []);
    if (!targets.length) return;
    input.value = '';
    let pending = targets.length;
    for (const file of targets) {
      if (file.tags.some((t) => low(t) === low(value))) { pending--; continue; }
      lib.setTags({ path: file.path, tags: file.tags.concat([value]) }).then((r) => {
        file.tags = (r && r.tags) || file.tags;
        rebuildHay(file);
        if (--pending <= 0) { refreshTagFilter(); paintRows(); renderInspector(); apply(); }
      }, () => { pending--; });
    }
    if (pending <= 0) { refreshTagFilter(); paintRows(); renderInspector(); apply(); }
  }

  function refreshTagFilter() {
    const select = $('f-tag');
    if (!select) return;
    const seenTags = new Map();
    for (const file of state.files) for (const t of file.tags) {
      const k = low(t);
      if (!seenTags.has(k)) seenTags.set(k, t);
    }
    const keys = [...seenTags.keys()].sort();
    const want = keys.join('|');
    if (select.dataset.built === want) return;
    select.dataset.built = want;
    const current = state.fTag;
    select.textContent = '';
    const opt = (value, label) => {
      const o = document.createElement('option');
      o.value = value; o.textContent = label;
      select.appendChild(o);
    };
    opt('', 'All tags');
    opt(' none', 'Untagged');
    for (const k of keys) opt(k, seenTags.get(k));
    select.value = keys.indexOf(current) >= 0 || current === '' || current === ' none' ? current : '';
    state.fTag = select.value;
  }

  // =========================================================================
  // HEADER / FOOTER TEXT
  // =========================================================================
  function renderSub() {
    const total = state.files.length;
    const shown = state.rows.length;
    const parts = [];
    parts.push(shown === total ? Fmt.count(total, 'file') : shown.toLocaleString() + ' of ' + total.toLocaleString() + ' files');
    parts.push(Fmt.count(folderRows().length, 'folder'));
    if (state.truncated) parts.push('capped at ' + (4000).toLocaleString());
    parts.push('Organize, search, preview and manage your collection.');
    $('lib-sub').textContent = state.loading && !total ? 'Scanning…' : parts.join(' · ');
  }

  function renderFoot() {
    let known = 0;
    // A missing file can never be parsed, so counting it as pending would leave
    // "Index all" armed forever with nothing to do.
    for (const f of state.rows) if (f.notes !== null || f.missing) known++;
    $('foot-count').textContent = state.rows.length.toLocaleString() + ' shown';
    $('foot-indexed').textContent = state.rows.length
      ? known.toLocaleString() + ' indexed' + (known < state.rows.length ? ' · ' + (state.rows.length - known).toLocaleString() + ' pending' : '')
      : '—';
    $('trunc').hidden = !state.truncated;
    $('index-all').disabled = state.indexing || known >= state.rows.length;
    $('index-all').textContent = state.indexing ? 'Indexing…' : 'Index all';
  }

  function renderEmpty() {
    const box = $('empty');
    const filtered = !!(state.terms.length || state.fType || state.fSource || state.fTag || state.view !== 'all');
    const show = !state.loading && !state.rows.length;
    box.hidden = !show;
    $('grid').hidden = show || state.mode !== 'list';
    $('cardwrap').hidden = show || state.mode !== 'grid';
    if (!show) return;
    if (state.files.length && filtered) {
      $('empty-title').textContent = 'Nothing matches';
      $('empty-msg').textContent = 'No file in this view matches the search and filters.';
      $('empty-clear').hidden = false;
      $('empty-add').hidden = true;
    } else {
      $('empty-title').textContent = 'No MIDI files yet';
      $('empty-msg').textContent = 'Forge a song, or add a folder you already keep MIDI files in.';
      $('empty-clear').hidden = true;
      $('empty-add').hidden = false;
    }
  }

  function renderSelBar() {
    const bar = $('selbar');
    const n = state.sel.length;
    bar.hidden = n < 2;
    if (n >= 2) $('sel-count').textContent = n + ' selected';
  }

  // =========================================================================
  // TOOLBAR
  // =========================================================================
  const runSearch = debounce(() => {
    state.terms = state.query.split(/\s+/).filter(Boolean);
    apply();
  }, 120);

  on($('q'), 'input', () => {
    state.query = low($('q').value);
    $('searchwrap').classList.toggle('has-value', !!$('q').value);
    runSearch();
  });
  on($('q'), 'keydown', (ev) => {
    if (ev.key === 'Escape' && $('q').value) { ev.stopPropagation(); clearSearch(); }
    else if (ev.key === 'Enter') { ev.preventDefault(); (state.mode === 'grid' ? cardsHost : rowList.host).focus(); }
  });
  function clearSearch() {
    $('q').value = '';
    state.query = '';
    state.terms = [];
    $('searchwrap').classList.remove('has-value');
    runSearch.cancel();
    apply();
  }
  on($('q-clear'), 'click', () => { clearSearch(); $('q').focus(); });

  on($('f-type'), 'change', () => { state.fType = $('f-type').value; apply(); });
  on($('f-source'), 'change', () => { state.fSource = $('f-source').value; apply(); });
  on($('f-tag'), 'change', () => { state.fTag = $('f-tag').value; apply(); });
  on($('sort'), 'change', () => {
    const [k, d] = $('sort').value.split(':');
    setSort(k, Number(d) || 1, false);
  });

  function setSort(key, dir, fromHead) {
    if (!CMP[key]) return;
    state.sortKey = key;
    state.sortDir = dir < 0 ? -1 : 1;
    for (const th of document.querySelectorAll('#grid .lgrid-th[data-col]')) {
      const isIt = th.dataset.col === key;
      const word = state.sortDir < 0 ? 'descending' : 'ascending';
      if (isIt) th.setAttribute('aria-sort', word); else th.removeAttribute('aria-sort');
      const btn = th.querySelector('.th-sort');
      if (btn) {
        const label = btn.textContent.trim();
        btn.setAttribute('aria-label', 'Sort by ' + label.toLowerCase() + (isIt ? ', ' + word : ''));
      }
    }
    const want = key + ':' + state.sortDir;
    if ($('sort').value !== want) {
      const has = [...$('sort').options].some((o) => o.value === want);
      $('sort').value = has ? want : '';
    }
    if (fromHead !== 'quiet') apply();
    publishSoon();
  }

  on($('grid').querySelector('.lgrid-head'), 'click', (ev) => {
    const th = ev.target.closest ? ev.target.closest('.lgrid-th[data-col]') : null;
    if (!th) return;
    const key = th.dataset.col;
    const dir = state.sortKey === key ? -state.sortDir : (key === 'date' || key === 'length' || key === 'notes' ? -1 : 1);
    setSort(key, dir, true);
  });

  on($('check-all'), 'click', () => {
    const box = $('check-all');
    if (box.getAttribute('aria-checked') === 'true') clearSelection(); else selectAllVisible();
  });

  on($('viewmode'), 'click', (ev) => {
    const btn = ev.target.closest ? ev.target.closest('button[data-mode]') : null;
    if (btn) setMode(btn.dataset.mode);
  });
  on($('viewmode'), 'keydown', (ev) => {
    if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
    ev.preventDefault();
    setMode(state.mode === 'list' ? 'grid' : 'list');
    $('viewmode').querySelector('[aria-checked="true"]').focus();
  });

  function setMode(mode) {
    if (mode !== 'list' && mode !== 'grid') return;
    state.mode = mode;
    for (const b of $('viewmode').querySelectorAll('button[data-mode]')) {
      b.setAttribute('aria-checked', b.dataset.mode === mode ? 'true' : 'false');
      b.tabIndex = b.dataset.mode === mode ? 0 : -1;
    }
    // apply() is what un-hides #cardwrap, so the measurement has to come after
    // it: measuring a display:none host reads 0 and commits nothing.
    apply();
    if (mode === 'grid' && measureShelf()) rebuildShelves();
    publishSoon();
  }

  on($('rescan'), 'click', () => refresh('manual'));
  on($('add-folder'), 'click', addFolder);
  on($('empty-add'), 'click', addFolder);
  on($('empty-clear'), 'click', () => {
    state.fType = state.fSource = state.fTag = '';
    $('f-type').value = ''; $('f-source').value = ''; $('f-tag').value = '';
    clearSearch();
    setView('all', '');
  });

  function addFolder() {
    if (!lib.addFolder) return;
    lib.addFolder().then((r) => {
      if (r && r.ok) toast('ok', 'Folder added', r.dir);
    }, () => {});
  }

  // ---- the background full index -------------------------------------------
  const reportBusy = debounce((percent, label, busy) => {
    if (Bus) Bus.send(T.FRAME_BUSY, { frame: FRAME, busy, label, percent });
  }, 100);

  on($('index-all'), 'click', () => {
    if (!lib.index) return;
    if (state.indexing) { quiet(lib.index({ cancel: true })); return; }
    state.indexing = true;
    renderFoot();
    setScanning(true, 'index');
    lib.index({}).then((r) => {
      if (!r || r.total === 0) { state.indexing = false; setScanning(false); renderFoot(); }
    }, () => { state.indexing = false; setScanning(false); renderFoot(); });
  });

  if (lib.onProgress) {
    cleanups.push(lib.onProgress((msg) => {
      if (!msg) return;
      if (msg.kind === 'scan') {
        if (Array.isArray(msg.files) && msg.files.length) { partial = partial.concat(msg.files); drainPartial(); }
        return;
      }
      if (msg.kind !== 'index') return;
      const total = Number(msg.total) || 0;
      const done = Number(msg.indexed) || 0;
      if (msg.done) {
        state.indexing = false;
        setScanning(false);
        reportBusy.cancel();
        if (Bus) Bus.send(T.FRAME_BUSY, { frame: FRAME, busy: false, label: 'Indexed ' + done.toLocaleString() + ' files' });
        wanted.clear();
        for (const f of state.rows) if (f.notes === null && !f.bad) wanted.set(low(f.path), f);
        askMeta();
        renderFoot();
        return;
      }
      state.indexing = true;
      reportBusy(total ? Math.round((done / total) * 100) : 0,
        'Indexing ' + total.toLocaleString() + ' MIDI files', true);
    }));
  }

  // ---- column toggles ------------------------------------------------------
  function showSide(want) {
    state.sideOn = !!want;
    $('side').hidden = !want;
    gripSide.classList.toggle('is-off', !want);
    $('t-side').setAttribute('aria-pressed', want ? 'true' : 'false');
  }
  function showInspector(want) {
    const on2 = want === undefined ? true : !!want;
    state.inspOn = on2;
    $('insp').hidden = !on2;
    gripInsp.classList.toggle('is-off', !on2);
    $('t-insp').setAttribute('aria-pressed', on2 ? 'true' : 'false');
    if (on2) artHandle.invalidate();
  }
  const grips = document.querySelectorAll('.lib > .grip-h');
  const gripSide = grips[0], gripInsp = grips[1];
  on($('t-side'), 'click', () => { showSide(!state.sideOn); afterLayout(); });
  on($('t-insp'), 'click', () => { showInspector(!state.inspOn); afterLayout(); });

  // Auto-collapse only when the breakpoint actually changes, so a deliberate
  // toggle is never undone by a stray resize event.
  function fitColumns() {
    const w = window.innerWidth;
    const want = { side: w >= 980, insp: w >= 1180 };
    const key = (want.side ? 's' : '') + (want.insp ? 'i' : '');
    if (state.autoCols === key) return false;
    state.autoCols = key;
    showSide(want.side);
    showInspector(want.insp);
    return true;
  }

  function afterLayout() {
    if (state.mode === 'grid' && measureShelf()) rebuildShelves();
    rowList.invalidate();
    cardList.invalidate();
    artHandle.invalidate();
  }
  const onResize = coalesce(() => { fitColumns(); afterLayout(); });
  on(window, 'resize', onResize);

  // =========================================================================
  // DRAG AND DROP
  // =========================================================================
  const body = $('body'), dropCard = $('dropcard');
  let dragDepth = 0;
  let dropTimer = 0;
  cleanups.push(() => clearTimeout(dropTimer));
  function showDrop(on2) {
    body.classList.toggle('is-over', on2);
    clearTimeout(dropTimer);
    dropTimer = 0;
    if (on2) { dropCard.hidden = false; requestAnimationFrame(() => dropCard.classList.add('is-open')); return; }
    dropCard.classList.remove('is-open');
    dropTimer = setTimeout(() => { dropTimer = 0; dropCard.hidden = true; }, 200);
  }
  on(window, 'dragenter', (ev) => {
    if (!ev.dataTransfer || [...ev.dataTransfer.types].indexOf('Files') < 0) return;
    ev.preventDefault();
    dragDepth++;
    showDrop(true);
  });
  on(window, 'dragover', (ev) => {
    if (!ev.dataTransfer || [...ev.dataTransfer.types].indexOf('Files') < 0) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'copy';
  });
  on(window, 'dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) showDrop(false); });
  on(window, 'drop', (ev) => {
    if (!ev.dataTransfer) return;
    ev.preventDefault();
    dragDepth = 0;
    showDrop(false);
    const api = window.api || {};
    const paths = [];
    for (const f of ev.dataTransfer.files || []) {
      const p = api.getDroppedFilePath ? api.getDroppedFilePath(f) : (f.path || '');
      if (p) paths.push(p);
    }
    if (!paths.length) return;
    // One router owns this: the shell decides where a dropped file belongs.
    if (Bus) Bus.send(T.FILE_DROPPED, { paths, kind: 'mid', frame: FRAME });
  });

  // Dragging rows out: the paths as text, which is what another app or a text
  // field can actually take. A native OS file drag needs webContents.startDrag
  // in the main process, which this tab does not add.
  on(rowList.host, 'dragstart', (ev) => {
    const row = ev.target.closest ? ev.target.closest('.lrow') : null;
    if (!row) return;
    const at = Number(row.dataset.index);
    const file = state.rows[at];
    if (!file) return;
    const paths = state.selSet.has(low(file.path)) && state.sel.length > 1 ? state.sel.slice() : [file.path];
    ev.dataTransfer.setData('text/plain', paths.join('\r\n'));
    ev.dataTransfer.effectAllowed = 'copy';
    dragPaths = paths;
  });
  let dragPaths = null;
  on(rowList.host, 'dragend', () => { dragPaths = null; clearFolderHover(); });

  // ...and dropping them on Favorites, the one internal target that means
  // something without moving a file on disk.
  function clearFolderHover() {
    for (const el of document.querySelectorAll('#views .lrow.is-over')) el.classList.remove('is-over');
  }
  on($('views'), 'dragover', (ev) => {
    if (!dragPaths) return;
    const row = ev.target.closest ? ev.target.closest('.lrow') : null;
    if (!row || row.dataset.view !== 'favorites') return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'copy';
    clearFolderHover();
    row.classList.add('is-over');
  });
  on($('views'), 'dragleave', clearFolderHover);
  on($('views'), 'drop', (ev) => {
    const row = ev.target.closest ? ev.target.closest('.lrow') : null;
    if (!dragPaths || !row || row.dataset.view !== 'favorites') return;
    ev.preventDefault();
    setFav(dragPaths.slice(), true);
    clearFolderHover();
    dragPaths = null;
  });

  // =========================================================================
  // INSPECTOR CONTROLS
  // =========================================================================
  on($('tab-details'), 'click', () => setTab('details'));
  on($('tab-history'), 'click', () => setTab('history'));
  on(document.querySelector('.lib-insp-tabs'), 'keydown', (ev) => {
    if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
    ev.preventDefault();
    setTab(state.tab === 'details' ? 'history' : 'details');
    $(state.tab === 'details' ? 'tab-details' : 'tab-history').focus();
  });
  on($('see-all'), 'click', () => { setTab('history'); $('tab-history').focus(); });

  for (const head of document.querySelectorAll('.insp-sec-head')) {
    on(head, 'click', () => {
      const open = head.getAttribute('aria-expanded') !== 'true';
      head.setAttribute('aria-expanded', open ? 'true' : 'false');
      const body2 = document.getElementById(head.getAttribute('aria-controls'));
      if (body2) body2.hidden = !open;
    });
  }

  on($('tag-more'), 'click', () => {
    if ($('tagadd').hidden) openTagAdd(); else closeTagAdd();
  });
  on($('tag-add'), 'click', addTagFromInput);
  on($('tag-input'), 'keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); addTagFromInput(); }
    else if (ev.key === 'Escape') { ev.stopPropagation(); $('tag-input').value = ''; closeTagAdd(); $('tag-more').focus(); }
  });
  on($('p-path').querySelector('.pathchip-reveal'), 'click', () => reveal(state.focusPath));

  on($('a-preview'), 'click', () => { if (previewPath) stopPreview(); else startPreview(state.focusPath); });
  on($('a-editor'), 'click', () => sendTo('editor', [state.focusPath]));
  on($('a-player'), 'click', () => sendTo('player', [state.focusPath]));
  on($('a-listen'), 'click', () => sendTo('selfmidi', [state.focusPath]));
  on($('a-reveal'), 'click', () => reveal(state.focusPath));
  on($('a-fav'), 'click', () => {
    const many = state.sel.length > 1;
    const targets = many ? state.sel.slice() : [state.focusPath];
    const on2 = many ? selectedFiles().every((f) => f.fav) : isFav(state.focusPath);
    setFav(targets, !on2);
  });
  on($('a-delete'), 'click', () => remove(state.sel.length > 1 ? state.sel.slice() : [state.focusPath]));

  on($('sel-player'), 'click', () => sendTo('player', state.sel.slice()));
  on($('sel-fav'), 'click', () => setFav(state.sel.slice(), !selectedFiles().every((f) => f.fav)));
  on($('sel-tag'), 'click', () => { showInspector(true); setTab('details'); openTagAdd(); });
  on($('sel-delete'), 'click', () => remove(state.sel.slice()));
  on($('sel-clear'), 'click', () => clearSelection());

  // Escape inside this panel: our own menu (Menu already captures it), then the
  // search, then the selection. It never reaches the shell from inside a frame.
  on(document, 'keydown', (ev) => {
    if (ev.key === 'Escape') {
      if (window.Menu && window.Menu.isOpen()) return;
      if (dlg.resolve) { closeConfirm(false); return; }
      if ($('q').value) { clearSearch(); return; }
      if (state.sel.length) clearSelection();
      return;
    }
    if ((ev.key === 'f' || ev.key === 'F') && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      $('q').focus();
      $('q').select();
    }
  });

  // =========================================================================
  // BUS
  // =========================================================================
  if (Bus) {
    cleanups.push(Bus.on(T.NAV_OPEN_LIBRARY, (p) => {
      if (!p) return;
      if (typeof p.query === 'string') {
        $('q').value = p.query;
        state.query = low(p.query);
        state.terms = state.query.split(/\s+/).filter(Boolean);
        $('searchwrap').classList.toggle('has-value', !!p.query);
        apply();
      }
      if (p.selectPath) select(p.selectPath, true);
    }));

    cleanups.push(Bus.on(T.LIBRARY_CHANGED, (p) => {
      const reason = p && p.reason;
      if (reason === 'favorites') { loadFavs().then(() => { syncFavFlags(); recount(); apply(); renderInspector(); }); return; }
      if (reason === 'tags') return;
      refresh('changed');
    }));

    // The source panel gets to flash the row a file came from.
    cleanups.push(Bus.on(T.FILE_OPEN, (p) => {
      if (!p || p.from !== FRAME || !p.path) return;
      select(p.path, false);
    }));

    // Forge finishing is the one usage event this panel cannot originate.
    cleanups.push(Bus.on(T.FORGE_STATUS, (p) => {
      if (!p || p.event !== 'forge.done') return;
      const mp = (p.result && p.result.midiPath) || p.midiPath;
      if (mp) later(() => record(mp, 'forge'), 1200);
    }));

    cleanups.push(Bus.on(T.NAV_ACTIVATED, (p) => {
      if (!p || p.tab !== FRAME) return;
      afterLayout();
    }));

  }

  function syncFavFlags() {
    for (const file of state.files) {
      const want = state.favSet.has(low(file.path));
      if (want !== file.fav) { file.fav = want; rebuildHay(file); }
    }
  }

  function select(p, scroll) {
    const key = low(p);
    const file = state.byPath.get(key);
    if (!file) {
      // A hand-off can land before, during or after the first paint, so one that
      // arrives mid-scan waits for the scan rather than being dropped.
      if (state.loading) { state.pendingSelect = String(p); return; }
      toast('info', Fmt.basename(p) + ' is not in a scanned folder',
        'Add its folder from the browser column to keep it listed here.');
      return;
    }
    state.pendingSelect = '';
    // A file can be hidden by the current view: showing it is more useful than
    // silently doing nothing.
    if (!passes(file)) {
      state.view = 'all';
      state.folder = '';
      syncViewRows();
      apply();
    }
    state.sel = [file.path];
    state.selSet = new Set([key]);
    if (state.mode === 'list') {
      rowList.selectKeys(state.sel, true);
      const at = rowList.indexOfKey(file.path);
      if (at >= 0 && scroll !== false) rowList.scrollToIndex(at, 'center');
      if (at >= 0) rowList.setCursor(at, { scroll: false });
    } else {
      const at = state.rows.indexOf(file);
      gridCursor = at;
      if (at >= 0 && scroll !== false) scrollGridTo(at);
      cardList.refresh();
    }
    focusFile(file.path);
    afterSelection();
  }

  function onDensity() {
    if (!window.Tokens) return;
    window.Tokens.refresh();
    rowList.rowHeight(window.Tokens.num('h-lrow', 36));
    if (state.mode === 'grid' && measureShelf()) rebuildShelves();
    artHandle.invalidate();
  }
  on(window, 'midi-studio:density', onDensity);
  on(window, 'midi-studio:onscreen', () => {
    if (document.documentElement.getAttribute('data-onscreen') === '0') stopPreview();
    else afterLayout();
  });

  // =========================================================================
  // COMMANDS  (§11.5: publish, or it is not in Ctrl+K)
  // =========================================================================
  const Commands = window.Commands;
  const publishSoon = debounce(() => { if (Commands) Commands.publish(); }, 120);

  if (Commands) {
    Commands.setScope(FRAME);
    const one = () => !!state.focusPath;
    const some = () => state.sel.length > 0;
    cleanups.push(Commands.registerAll([
      { id: 'library.search', label: 'Search the library', keywords: ['find', 'filter'], group: 'Library',
        keys: 'Ctrl+F', run: () => { $('q').focus(); $('q').select(); } },
      { id: 'library.rescan', label: 'Rescan every library folder', keywords: ['refresh', 'reload'],
        group: 'Library', run: () => refresh('manual') },
      { id: 'library.addFolder', label: 'Add a library folder', keywords: ['import', 'watch'],
        group: 'Library', run: addFolder },
      { id: 'library.indexAll', label: 'Index length and notes for every file',
        keywords: ['parse', 'metadata'], group: 'Library',
        enabled: () => !state.indexing, run: () => $('index-all').click() },
      { id: 'library.toggleView', label: 'Switch between list and grid', keywords: ['cards', 'layout'],
        group: 'Library', run: () => setMode(state.mode === 'list' ? 'grid' : 'list') },
      { id: 'library.selectAll', label: 'Select every visible file', keys: 'Ctrl+A', group: 'Library',
        enabled: () => state.rows.length > 0, run: selectAllVisible },
      { id: 'library.clearFilters', label: 'Clear the search and filters', group: 'Library',
        run: () => $('empty-clear').click() },
      { id: 'library.preview', label: 'Preview the selected file', group: 'Library',
        enabled: () => one() && canPreview(state.focusPath),
        run: () => startPreview(state.focusPath) },
      { id: 'library.sendPlayer', label: 'Send the selection to the Player', icon: 'send', group: 'Library',
        enabled: some, run: () => sendTo('player', state.sel.slice()) },
      { id: 'library.openEditor', label: 'Open the selection in the Editor', group: 'Library',
        enabled: some, run: () => sendTo('editor', state.sel.slice()) },
      { id: 'library.listen', label: 'Listen to the selection in Listen', group: 'Library',
        enabled: some, run: () => sendTo('selfmidi', state.sel.slice()) },
      { id: 'library.favorite', label: 'Favourite the selection', group: 'Library',
        enabled: some, run: () => setFav(state.sel.slice(), !selectedFiles().every((f) => f.fav)) },
      { id: 'library.reveal', label: 'Reveal the selected file in Explorer', icon: 'folder',
        group: 'Library', enabled: one, run: () => reveal(state.focusPath) },
      { id: 'library.copyPath', label: 'Copy the selected paths', group: 'Library',
        enabled: some, run: () => copyPaths(state.sel.slice()) },
      { id: 'library.delete', label: 'Delete the selection', group: 'Library', danger: true,
        enabled: some, run: () => remove(state.sel.slice()) }
    ]));
  }

  // =========================================================================
  // TEARDOWN
  // =========================================================================
  function teardown() {
    writeFavs.flush();
    reportBusy.cancel();
    stopPreview();
    for (const fn of cleanups.splice(0)) { try { fn(); } catch (_) {} }
    try { rowList.destroy(); } catch (_) {}
    try { cardList.destroy(); } catch (_) {}
  }
  window.addEventListener('pagehide', teardown, { once: true });
  window.addEventListener('beforeunload', () => writeFavs.flush());

  // =========================================================================
  // BOOT
  // =========================================================================
  document.querySelector('.lib').style.setProperty('--card-h', CARD_H + 'px');
  setMode('list');
  setSort('date', -1, 'quiet');
  syncViewRows();
  fitColumns();
  measureShelf();
  renderInspector();
  renderSub();
  renderFoot();

  loadFavs().then(() => refresh('boot'));

  // frame:ready is the handshake: it drains whatever hand-off is queued for us.
  if (Bus) Bus.send(T.FRAME_READY, { frame: FRAME, title: 'Library' });
})();

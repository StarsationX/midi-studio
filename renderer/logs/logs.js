// logs.js: the Logs tab.
//
// This page is a VIEW, never the owner. The shell owns the ring buffer, because
// the shell is the thing that receives forge:status, engine:error, the
// provisioning stream and ui:status from every frame, and it has to keep
// collecting whether or not this tab has ever been opened -- tab frames load
// lazily, so a viewer that owned the buffer would start every session empty and
// would lose everything the moment it was reloaded.
//
// So the traffic is:
//   log:sync    shell -> here, once, on our frame:ready. The whole buffer.
//   log:append  shell -> here, BATCHED. One rAF's worth of lines per message,
//               never one message per line: a transcription emits hundreds of
//               lines per stage and that fan-out is exactly what the rewrite
//               has been removing.
//   log:clear   here -> shell. Clear is a request; the shell answers with a
//               fresh (empty) log:sync, so the two can never disagree.
//
// The level vocabulary is the shell's, unchanged: info | ok | warn | error.
// (Note that is the LOG spelling, not the bus's four-word severity list where
// 'error' is spelt 'err' -- see CONTRACT 6.1.)
'use strict';

(function () {
  const FRAME = 'logs';
  const Bus = window.Bus;
  const T = Bus ? Bus.TYPES : {};
  const Tokens = window.Tokens;

  const $ = (id) => document.getElementById(id);
  const cleanups = [];
  const on = (el, type, fn, opts) => {
    if (!el) return;
    el.addEventListener(type, fn, opts);
    cleanups.push(() => el.removeEventListener(type, fn, opts));
  };

  // Trailing edge, last value wins. cancel() drops the pending call. There is no
  // coalesce() here on purpose: every paint on this page goes through the Draw
  // scheduler, which is already rAF-coalesced AND parks off-screen.
  function debounce(fn, ms) {
    let t = 0, last = null;
    const w = (...a) => {
      last = a;
      clearTimeout(t);
      t = setTimeout(() => { t = 0; const p = last; last = null; fn(...p); }, ms);
    };
    w.cancel = () => { clearTimeout(t); t = 0; last = null; };
    return w;
  }

  // ==========================================================================
  // STATE
  // ==========================================================================
  let cap = 600;                       // the shell tells us; this is its default
  const lines = [];                    // the mirror, same order, same cap
  let view = [];                       // the current filter's slice
  const filter = { src: 'all', level: 'all', q: '' };
  let follow = true;
  let synced = false;

  // The source filter is five buckets, not one bucket per writer: the shell
  // tags a line with whoever produced it, which includes every frame key. Forge
  // and first-time setup are their own streams; the Player covers Self MIDI too
  // (one engine); everything else is the shell talking about itself.
  const SRC_BUCKET = {
    forge: 'forge',
    setup: 'setup',
    player: 'player', audition: 'player'
  };
  const bucketOf = (src) => SRC_BUCKET[src] || 'shell';

  function matches(l) {
    if (filter.src !== 'all' && bucketOf(l.src) !== filter.src) return false;
    if (filter.level !== 'all' && l.level !== filter.level) return false;
    if (filter.q && l.text.toLowerCase().indexOf(filter.q) < 0
                 && l.src.toLowerCase().indexOf(filter.q) < 0) return false;
    return true;
  }
  const filtering = () => filter.src !== 'all' || filter.level !== 'all' || !!filter.q;

  function rebuild() {
    view = filtering() ? lines.filter(matches) : lines.slice();
  }

  // ==========================================================================
  // THE LIST
  // Virtualised: the buffer is thousands of lines over a long session and
  // per-line DOM for the whole of it is the thing VList exists to prevent.
  // ==========================================================================
  const listHost = $('list');
  const LEVEL_WORD = { info: 'INFO', ok: 'OK', warn: 'WARN', error: 'ERR' };

  const list = window.VList(listHost, {
    rowHeight: Tokens ? Tokens.num('h-logrow', 22) : 22,
    overscan: 10,
    selectable: false,
    ariaLabel: 'Activity log',
    key: (it) => it.id,
    createRow() {
      const n = document.createElement('div');
      n.className = 'lrow is-grid';
      n.innerHTML = '<span class="lcell lg-t"></span><span class="lcell lg-src"></span>'
                  + '<span class="lcell lg-lvl"></span><span class="lcell lg-msg selectable"></span>';
      return n;
    },
    renderRow(n, it) {
      // classList, NEVER className: VList adds .vlist-row (position:absolute) to
      // every node it pools, and assigning className here deletes it -- the rows
      // drop into normal flow and stack on top of their own translateY.
      n.classList.remove('is-ok', 'is-warn', 'is-error');
      if (it.level && it.level !== 'info') n.classList.add('is-' + it.level);
      n.children[0].textContent = it.clock;
      n.children[1].textContent = it.src;
      n.children[2].textContent = LEVEL_WORD[it.level] || 'INFO';
      n.children[3].textContent = it.text;
      n.setAttribute('aria-label', it.clock + ' ' + it.src + ' ' + (LEVEL_WORD[it.level] || 'INFO') + ': ' + it.text);
      n.title = it.text;
    }
  });

  // Every repaint goes through the one scheduler, so a Forge run that logs for
  // twenty minutes while this tab is in the background paints nothing at all
  // (data-onscreen="0" parks the consumer), and coming back on screen repaints
  // it once. A hand-rolled rAF would do neither.
  const draw = window.Draw.register({
    key: 'logs:list',
    // The PANEL, not the list: the empty state hides the list, and a consumer
    // observed on a hidden element parks -- which would mean the one draw that
    // has to un-hide it never runs.
    el: $('lg'),
    draw() {
      const empty = $('empty');
      const grid = $('grid');
      const none = view.length === 0;
      grid.hidden = none;
      empty.hidden = !none;
      if (none) {
        const filtered = filtering() && lines.length > 0;
        $('empty-title').textContent = filtered ? 'No line matches' : 'Nothing logged yet';
        $('empty-msg').textContent = filtered
          ? 'Nothing in the ' + lines.length + ' lines held matches these filters.'
          : 'Forge output, first-time setup, player errors and shell events all land here.';
        $('empty-actions').hidden = !filtered;
        renderCounts();
        return;
      }
      list.setItems(view);
      if (follow) list.scrollToIndex(view.length - 1, 'nearest');
      renderCounts();
    }
  });
  cleanups.push(() => draw.dispose());
  const repaint = () => draw.invalidate();

  function renderCounts() {
    const total = lines.length;
    const shown = view.length;
    $('counts').textContent = shown === total
      ? total + (total === 1 ? ' line' : ' lines')
      : shown + ' of ' + total + ' lines';
    $('cap').textContent = synced
      ? (total >= cap ? 'Buffer full: the oldest of ' + cap + ' lines is dropped as new ones arrive.'
                      : 'Holding the last ' + cap + ' lines.')
      : '';
  }

  // Follow disengages the moment the user scrolls away from the tail and
  // re-engages when they come back to it.
  on(listHost, 'scroll', () => {
    const atEnd = listHost.scrollTop + listHost.clientHeight >= listHost.scrollHeight - 4;
    if (atEnd === follow) return;
    setFollow(atEnd, { scroll: false });
  });
  function setFollow(on_, opts) {
    follow = !!on_;
    $('follow').setAttribute('aria-pressed', follow ? 'true' : 'false');
    if (follow && (!opts || opts.scroll !== false)) repaint();
  }

  // ==========================================================================
  // FILTERS
  // ==========================================================================
  function apply() { rebuild(); repaint(); }

  const applyQuery = debounce((v) => {
    filter.q = String(v || '').trim().toLowerCase();
    apply();
  }, 110);
  cleanups.push(() => applyQuery.cancel());

  on($('q'), 'input', (e) => {
    $('searchwrap').classList.toggle('has-value', !!e.target.value);
    applyQuery(e.target.value);
  });
  on($('q-clear'), 'click', () => {
    $('q').value = '';
    $('searchwrap').classList.remove('has-value');
    applyQuery.cancel();
    filter.q = '';
    apply();
    $('q').focus();
  });
  on($('f-level'), 'change', (e) => { filter.level = e.target.value || 'all'; apply(); });

  // The segmented group: roving tabindex + arrow keys with wrap is the
  // implementer's job (CONTRACT 2.5); the CSS is already ready for it.
  const srcHost = $('f-src');
  const srcBtns = Array.prototype.slice.call(srcHost.querySelectorAll('button[role=radio]'));
  function setSrc(value, opts) {
    filter.src = value;
    for (const b of srcBtns) {
      const isOn = b.dataset.src === value;
      b.setAttribute('aria-checked', isOn ? 'true' : 'false');
      b.tabIndex = isOn ? 0 : -1;
      if (isOn && opts && opts.focus) b.focus();
    }
    apply();
  }
  on(srcHost, 'click', (e) => {
    const b = e.target.closest('button[role=radio]');
    if (b) setSrc(b.dataset.src);
  });
  on(srcHost, 'keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') return;
    const i = srcBtns.findIndex((b) => b.dataset.src === filter.src);
    const n = srcBtns.length;
    let next;
    if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    else next = ((i < 0 ? 0 : i) + (e.key === 'ArrowRight' ? 1 : n - 1)) % n;
    setSrc(srcBtns[next].dataset.src, { focus: true });
    e.preventDefault();
  });

  function clearFilters() {
    $('q').value = '';
    $('searchwrap').classList.remove('has-value');
    applyQuery.cancel();
    filter.q = '';
    $('f-level').value = 'all';
    filter.level = 'all';
    setSrc('all');
  }
  on($('empty-clear'), 'click', clearFilters);

  // ==========================================================================
  // ACTIONS
  // ==========================================================================
  const toast = (severity, title, message) => {
    if (Bus) Bus.send(T.UI_TOAST, { severity, title, message: message || '' });
  };

  function asText(rows) {
    return rows.map((l) => l.clock + ' [' + l.src + '] '
      + (l.level === 'info' ? '' : (LEVEL_WORD[l.level] || '') + ' ') + l.text).join('\n');
  }
  on($('copy'), 'click', async () => {
    if (!view.length) { toast('warn', 'Nothing to copy'); return; }
    try {
      await navigator.clipboard.writeText(asText(view));
      toast('ok', 'Log copied', view.length + (view.length === 1 ? ' line' : ' lines')
        + (view.length === lines.length ? '' : ' (the current filter)'));
    } catch (_) { toast('err', 'Could not copy the log'); }
  });
  // We do not own the buffer, so Clear is a request. The shell answers with an
  // empty log:sync, which is what actually empties this view.
  on($('clear'), 'click', () => {
    if (!lines.length) return;
    if (Bus) Bus.send(T.LOG_CLEAR, {}, { to: 'shell' });
  });
  on($('follow'), 'click', () => setFollow($('follow').getAttribute('aria-pressed') !== 'true'));

  // ==========================================================================
  // BUS
  // ==========================================================================
  if (Bus) {
    cleanups.push(Bus.on(T.LOG_SYNC, (p) => {
      synced = true;
      if (Number.isFinite(p && p.cap) && p.cap > 0) cap = p.cap;
      lines.length = 0;
      const incoming = (p && p.lines) || [];
      for (const l of incoming) lines.push(l);
      apply();
    }));

    cleanups.push(Bus.on(T.LOG_APPEND, (p) => {
      const incoming = (p && p.lines) || [];
      if (!incoming.length) return;
      let added = 0;
      for (const l of incoming) {
        // The sync and the first batch can overlap by a line or two; ids are
        // monotonic in the shell, so this is the whole de-duplication needed.
        if (lines.length && l.id <= lines[lines.length - 1].id) continue;
        lines.push(l);
        added += 1;
      }
      if (!added) return;
      while (lines.length > cap) lines.shift();
      // Appending to the tail of an unfiltered view is the hot path: skip the
      // whole-buffer filter pass when nothing is being filtered.
      if (!filtering()) view = lines.slice();
      else rebuild();
      repaint();
    }));

    cleanups.push(Bus.on(T.NAV_OPEN_LOGS, (p) => {
      if (!p) return;
      if (typeof p.query === 'string') {
        $('q').value = p.query;
        $('searchwrap').classList.toggle('has-value', !!p.query);
        applyQuery.cancel();
        filter.q = p.query.trim().toLowerCase();
      }
      if (typeof p.level === 'string' && $('f-level').querySelector('option[value="' + p.level + '"]')) {
        $('f-level').value = p.level;
        filter.level = p.level;
      }
      if (typeof p.source === 'string' && srcBtns.some((b) => b.dataset.src === p.source)) setSrc(p.source);
      else apply();
    }));
  }

  // Density moves --h-logrow, and a list built before the change keeps the old
  // number (CONTRACT 5). Re-read and re-apply.
  on(window, 'midi-studio:density', () => {
    if (!Tokens) return;
    Tokens.refresh();
    list.rowHeight(Tokens.num('h-logrow', 22));
    repaint();
  });

  // ==========================================================================
  // COMMANDS  (§11.5: publish, or it is not in Ctrl+K)
  // ==========================================================================
  const Commands = window.Commands;
  if (Commands) {
    Commands.setScope(FRAME);
    cleanups.push(Commands.registerAll([
      { id: 'logs.search', label: 'Filter the log', keywords: ['find', 'search', 'grep'],
        group: 'Logs', keys: 'Ctrl+F', run: () => { $('q').focus(); $('q').select(); } },
      { id: 'logs.copy', label: 'Copy the log', keywords: ['clipboard'], group: 'Logs',
        enabled: () => view.length > 0, run: () => $('copy').click() },
      { id: 'logs.clear', label: 'Clear the log', group: 'Logs',
        enabled: () => lines.length > 0, run: () => $('clear').click() },
      { id: 'logs.follow', label: 'Follow the newest line', keywords: ['autoscroll', 'tail'],
        group: 'Logs', run: () => setFollow(true) },
      { id: 'logs.errors', label: 'Show errors only', keywords: ['filter', 'level'],
        group: 'Logs', run: () => { $('f-level').value = 'error'; filter.level = 'error'; apply(); } },
      { id: 'logs.clearFilters', label: 'Clear the log filters', group: 'Logs',
        enabled: () => filtering(), run: clearFilters }
    ]));
  }

  on(window, 'keydown', (ev) => {
    if ((ev.key === 'f' || ev.key === 'F') && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      $('q').focus();
      $('q').select();
      return;
    }
    if (ev.key === 'Escape' && filtering()) { clearFilters(); return; }
    if (ev.key === 'End' && ev.target === listHost) setFollow(true);
  });

  // ==========================================================================
  // TEARDOWN
  // ==========================================================================
  function teardown() {
    for (const fn of cleanups.splice(0)) { try { fn(); } catch (_) {} }
    try { list.destroy(); } catch (_) {}
  }
  window.addEventListener('pagehide', teardown, { once: true });

  // ==========================================================================
  // BOOT
  // ==========================================================================
  setFollow(true, { scroll: false });
  rebuild();
  repaint();

  // frame:ready is the handshake, and for this tab it is also the request for
  // the history it missed: the shell answers it with a full log:sync.
  if (Bus) Bus.send(T.FRAME_READY, { frame: FRAME, title: 'Logs' });
})();

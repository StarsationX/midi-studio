// vlist.js: the virtualised list.
//
// The library can hold 4000 files. The old Self MIDI nav rebuilt up to 300 rows
// on every keystroke of an undebounced search box, each row an innerHTML parse
// plus two querySelector calls plus two listener closures: ~600 listener
// allocations thrown away on the next keypress. The Player queue, the Forge
// queue and the Editor track list all had their own variation of the same loop.
//
// This renders only the rows that are on screen plus a small overscan, reuses
// the row nodes, and puts exactly ONE click and ONE contextmenu listener on the
// host, keyed by data-index. Row nodes move with transform: translateY, so
// scrolling never relayouts the list.
//
//   const list = VList(host, {
//     rowHeight: 28,
//     createRow() { const el = document.createElement('div'); el.className='lrow'; ... },
//     renderRow(node, item, index) { node.querySelector('.lrow-name').textContent = item.name; },
//     key: item => item.path,
//     selectable: 'multi',
//     onActivate(item, index) { openFile(item.path); },
//     onContextMenu(item, index, ev) { showMenu(ev, item); }
//   });
//   list.setItems(files);
//
// Selection is by KEY, not index, so a re-sort or a re-scan keeps the same rows
// selected. Keyboard navigation follows the listbox pattern.
//
// Classic script (window.VList) or ES-module side-effect import.
(function (global) {
  'use strict';

  var DEFAULT_ROW_H = 28;
  var DEFAULT_OVERSCAN = 6;

  function num(v, d) { var n = Number(v); return isFinite(n) && n > 0 ? n : d; }

  function create(host, opts) {
    if (!host) throw new Error('VList needs a host element');
    opts = opts || {};

    var rowHeight = num(opts.rowHeight,
      (global.Tokens ? num(global.Tokens.num('h-row'), DEFAULT_ROW_H) : DEFAULT_ROW_H));
    var overscan = Math.max(0, opts.overscan === undefined ? DEFAULT_OVERSCAN : opts.overscan | 0);
    var multi = opts.selectable === 'multi';
    var selectable = opts.selectable !== false;

    var keyOf = typeof opts.key === 'function'
      ? opts.key
      : function (item, i) { return (item && (item.path || item.id)) || String(i); };

    var items = Array.isArray(opts.items) ? opts.items.slice() : [];
    var version = 0;                 // bumped on any content change
    var selected = Object.create(null);   // key -> true
    var selectedOrder = [];               // keys, in the order they were added
    var cursor = -1;                 // the focused row index
    var anchor = -1;                 // shift-range anchor
    var pool = [];                   // reusable row nodes
    var firstRendered = -1, lastRendered = -1;
    var destroyed = false;
    var rafId = 0;
    var ro = null;

    // ---------------------------------------------------------------- DOM ---

    host.classList.add('vlist');
    if (!host.hasAttribute('tabindex')) host.tabIndex = 0;
    if (!host.hasAttribute('role')) host.setAttribute('role', selectable ? 'listbox' : 'list');
    if (multi) host.setAttribute('aria-multiselectable', 'true');
    if (opts.ariaLabel) host.setAttribute('aria-label', opts.ariaLabel);

    var sizer = host.querySelector(':scope > .vlist-sizer');
    if (!sizer) {
      sizer = document.createElement('div');
      sizer.className = 'vlist-sizer';
      host.appendChild(sizer);
    }

    function makeRow() {
      var node = typeof opts.createRow === 'function' ? opts.createRow() : document.createElement('div');
      node.classList.add('vlist-row');
      if (selectable && !node.hasAttribute('role')) node.setAttribute('role', 'option');
      node.style.height = rowHeight + 'px';
      sizer.appendChild(node);
      return { node: node, index: -1, ver: -1 };
    }

    // ------------------------------------------------------------ geometry ---

    function count() { return items.length; }

    function totalHeight() { return items.length * rowHeight; }

    function visibleRange() {
      var top = host.scrollTop;
      var h = host.clientHeight || rowHeight;
      var first = Math.floor(top / rowHeight) - overscan;
      var last = Math.ceil((top + h) / rowHeight) + overscan;
      if (first < 0) first = 0;
      if (last > items.length) last = items.length;
      if (last < first) last = first;
      return [first, last];
    }

    // -------------------------------------------------------------- render ---

    function paint() {
      rafId = 0;
      if (destroyed) return;

      var hpx = totalHeight() + 'px';
      if (sizer.style.height !== hpx) sizer.style.height = hpx;

      var r = visibleRange(), first = r[0], last = r[1];
      var need = last - first;

      while (pool.length < need) pool.push(makeRow());

      for (var p = 0; p < pool.length; p++) {
        var slot = pool[p];
        var index = first + p;
        if (p >= need || index >= items.length) {
          if (!slot.node.hidden) { slot.node.hidden = true; slot.index = -1; slot.ver = -1; }
          continue;
        }
        var item = items[index];
        var k = keyOf(item, index);
        var node = slot.node;

        if (node.hidden) node.hidden = false;

        // Position first: a transform never relayouts the list.
        var y = index * rowHeight;
        var tf = 'translateY(' + y + 'px)';
        if (node.style.transform !== tf) node.style.transform = tf;

        // Content: only when the row is actually showing something else, or the
        // data version moved. This is what keeps a 4000-row re-sort cheap.
        if (slot.index !== index || slot.ver !== version) {
          node.dataset.index = String(index);
          node.dataset.key = k;
          if (selectable) {
            node.setAttribute('aria-posinset', String(index + 1));
            node.setAttribute('aria-setsize', String(items.length));
          }
          if (typeof opts.renderRow === 'function') {
            opts.renderRow(node, item, index, { key: k, selected: !!selected[k], cursor: index === cursor });
          }
          slot.index = index;
          slot.ver = version;
        }

        applyState(node, k, index);
      }

      firstRendered = first;
      lastRendered = last;
      if (typeof opts.onRender === 'function') opts.onRender(first, last);
    }

    function applyState(node, k, index) {
      var isSel = !!selected[k];
      if (selectable) {
        var want = isSel ? 'true' : 'false';
        if (node.getAttribute('aria-selected') !== want) node.setAttribute('aria-selected', want);
      }
      node.classList.toggle('is-selected', isSel);
      node.classList.toggle('is-cursor', index === cursor);
    }

    function invalidate() {
      if (destroyed || rafId) return;
      rafId = global.requestAnimationFrame(paint);
    }

    // Repaint the state classes only, without re-rendering content. Selection
    // changes go through this: nothing about the row's text has moved.
    function refreshState() {
      for (var p = 0; p < pool.length; p++) {
        var slot = pool[p];
        if (slot.index < 0 || slot.node.hidden) continue;
        applyState(slot.node, keyOf(items[slot.index], slot.index), slot.index);
      }
    }

    // ----------------------------------------------------------- selection ---

    function selectionKeys() { return selectedOrder.slice(); }

    function selectedItems() {
      var out = [];
      for (var i = 0; i < items.length; i++) {
        if (selected[keyOf(items[i], i)]) out.push(items[i]);
      }
      return out;
    }

    function clearSel(silent) {
      if (!selectedOrder.length) return false;
      selected = Object.create(null);
      selectedOrder = [];
      refreshState();
      if (!silent) emitSelection();
      return true;
    }

    function addKey(k) {
      if (selected[k]) return false;
      selected[k] = true;
      selectedOrder.push(k);
      return true;
    }

    function removeKey(k) {
      if (!selected[k]) return false;
      delete selected[k];
      var i = selectedOrder.indexOf(k);
      if (i >= 0) selectedOrder.splice(i, 1);
      return true;
    }

    function emitSelection() {
      if (typeof opts.onSelectionChange === 'function') {
        opts.onSelectionChange(selectionKeys(), selectedItems());
      }
    }

    // mode: 'set' | 'toggle' | 'range' | 'add'
    function selectIndex(index, mode, silent) {
      if (!selectable) return;
      if (index < 0 || index >= items.length) return;
      var k = keyOf(items[index], index);
      if (!multi) mode = 'set';

      if (mode === 'toggle') {
        if (selected[k]) removeKey(k); else addKey(k);
        anchor = index;
      } else if (mode === 'add') {
        addKey(k);
        anchor = index;
      } else if (mode === 'range') {
        var from = anchor < 0 ? index : anchor;
        var a = Math.min(from, index), b = Math.max(from, index);
        selected = Object.create(null);
        selectedOrder = [];
        for (var i = a; i <= b; i++) addKey(keyOf(items[i], i));
      } else {
        selected = Object.create(null);
        selectedOrder = [];
        addKey(k);
        anchor = index;
      }
      cursor = index;
      refreshState();
      if (!silent) emitSelection();
    }

    function selectKeys(keys, silent) {
      selected = Object.create(null);
      selectedOrder = [];
      for (var i = 0; i < (keys || []).length; i++) addKey(keys[i]);
      refreshState();
      if (!silent) emitSelection();
    }

    function selectAll(silent) {
      if (!multi) return;
      selected = Object.create(null);
      selectedOrder = [];
      for (var i = 0; i < items.length; i++) addKey(keyOf(items[i], i));
      refreshState();
      if (!silent) emitSelection();
    }

    function indexOfKey(k) {
      for (var i = 0; i < items.length; i++) if (keyOf(items[i], i) === k) return i;
      return -1;
    }

    // ------------------------------------------------------------ scrolling ---

    function scrollToIndex(index, align) {
      if (index < 0 || index >= items.length) return;
      var top = index * rowHeight;
      var h = host.clientHeight;
      if (align === 'center') {
        host.scrollTop = Math.max(0, top - (h - rowHeight) / 2);
      } else if (align === 'start') {
        host.scrollTop = top;
      } else {
        // nearest: only move if the row is not fully visible
        if (top < host.scrollTop) host.scrollTop = top;
        else if (top + rowHeight > host.scrollTop + h) host.scrollTop = top + rowHeight - h;
        else return;   // already visible, no repaint needed
      }
      invalidate();
    }

    function setCursor(index, opt) {
      opt = opt || {};
      if (index < 0) index = 0;
      if (index > items.length - 1) index = items.length - 1;
      cursor = index;
      if (opt.scroll !== false) scrollToIndex(index, 'nearest');
      refreshState();
      if (typeof opts.onCursor === 'function' && index >= 0) opts.onCursor(items[index], index);
    }

    // ------------------------------------------------------------- listeners ---

    function indexFromEvent(ev) {
      var el = ev.target;
      while (el && el !== host) {
        if (el.dataset && el.dataset.index !== undefined) {
          var i = Number(el.dataset.index);
          return isFinite(i) ? i : -1;
        }
        el = el.parentNode;
      }
      return -1;
    }

    function onScroll() { invalidate(); }

    function onClick(ev) {
      var index = indexFromEvent(ev);
      if (index < 0) return;
      var item = items[index];
      if (!item) return;

      // A row action button opts out of selection by carrying data-noselect.
      var act = ev.target && ev.target.closest ? ev.target.closest('[data-action]') : null;
      if (act && typeof opts.onAction === 'function') {
        ev.stopPropagation();
        opts.onAction(act.dataset.action, item, index, ev);
        return;
      }

      if (selectable) {
        var mode = 'set';
        if (multi && ev.shiftKey) mode = 'range';
        else if (multi && (ev.ctrlKey || ev.metaKey)) mode = 'toggle';
        selectIndex(index, mode);
      } else {
        cursor = index;
        refreshState();
      }
      if (typeof opts.onClick === 'function') opts.onClick(item, index, ev);
    }

    function onDblClick(ev) {
      var index = indexFromEvent(ev);
      if (index < 0 || !items[index]) return;
      if (typeof opts.onActivate === 'function') opts.onActivate(items[index], index, ev);
    }

    function onContextMenu(ev) {
      var index = indexFromEvent(ev);
      if (index < 0 || !items[index]) return;
      // Right-clicking a row that is not in the selection selects it first, so
      // the menu always acts on what the user can see is targeted.
      if (selectable && !selected[keyOf(items[index], index)]) selectIndex(index, 'set');
      if (typeof opts.onContextMenu === 'function') opts.onContextMenu(items[index], index, ev);
    }

    function onKeyDown(ev) {
      if (!items.length) return;
      var page = Math.max(1, Math.floor((host.clientHeight || rowHeight * 8) / rowHeight) - 1);
      var k = ev.key;
      var handled = true;
      var next = cursor;

      if (k === 'ArrowDown') next = cursor < 0 ? 0 : Math.min(items.length - 1, cursor + 1);
      else if (k === 'ArrowUp') next = cursor <= 0 ? 0 : cursor - 1;
      else if (k === 'PageDown') next = Math.min(items.length - 1, (cursor < 0 ? 0 : cursor) + page);
      else if (k === 'PageUp') next = Math.max(0, (cursor < 0 ? 0 : cursor) - page);
      else if (k === 'Home') next = 0;
      else if (k === 'End') next = items.length - 1;
      else if (k === 'Enter') {
        if (cursor >= 0 && typeof opts.onActivate === 'function') opts.onActivate(items[cursor], cursor, ev);
      } else if (k === ' ' || k === 'Spacebar') {
        if (cursor >= 0) selectIndex(cursor, multi ? 'toggle' : 'set');
      } else if (k === 'Escape') {
        if (!clearSel()) handled = false;
      } else if ((k === 'a' || k === 'A') && (ev.ctrlKey || ev.metaKey)) {
        selectAll();
      } else {
        handled = false;
      }

      if (next !== cursor && next >= 0) {
        // Ctrl+arrow moves the cursor without disturbing the selection, which is
        // how a listbox is expected to behave when multi-select is on.
        if (selectable && !(multi && (ev.ctrlKey || ev.metaKey))) {
          selectIndex(next, (multi && ev.shiftKey) ? 'range' : 'set');
        }
        setCursor(next);
      }

      if (handled) { ev.preventDefault(); ev.stopPropagation(); }
    }

    host.addEventListener('scroll', onScroll, { passive: true });
    host.addEventListener('click', onClick);
    host.addEventListener('dblclick', onDblClick);
    host.addEventListener('contextmenu', onContextMenu);
    host.addEventListener('keydown', onKeyDown);

    if (typeof global.ResizeObserver === 'function') {
      ro = new global.ResizeObserver(function () { invalidate(); });
      ro.observe(host);
    } else {
      global.addEventListener('resize', invalidate);
    }

    // ----------------------------------------------------------------- API ---

    var api = {
      host: host,

      get length() { return items.length; },
      items: function () { return items; },
      itemAt: function (i) { return items[i]; },

      // Replace the data. Selection is kept by key by default, so a re-sort or
      // a fresh library scan does not silently drop what the user picked.
      setItems: function (next, o) {
        o = o || {};
        items = Array.isArray(next) ? next : [];
        version++;
        if (o.keepSelection === false) {
          selected = Object.create(null);
          selectedOrder = [];
        } else {
          // Drop keys that no longer exist.
          var live = Object.create(null);
          for (var i = 0; i < items.length; i++) live[keyOf(items[i], i)] = true;
          var kept = [];
          for (var j = 0; j < selectedOrder.length; j++) {
            if (live[selectedOrder[j]]) kept.push(selectedOrder[j]);
            else delete selected[selectedOrder[j]];
          }
          selectedOrder = kept;
        }
        if (cursor > items.length - 1) cursor = items.length - 1;
        if (o.scrollTop === 0) host.scrollTop = 0;
        invalidate();
        return api;
      },

      // One row's data changed. Cheaper than setItems for a per-row state flip
      // (a job finished, a file was renamed).
      updateItem: function (index, item) {
        if (index < 0 || index >= items.length) return api;
        if (item !== undefined) items[index] = item;
        version++;
        invalidate();
        return api;
      },

      refresh: function () { version++; invalidate(); return api; },
      invalidate: function () { invalidate(); return api; },
      paintNow: function () { if (rafId) { global.cancelAnimationFrame(rafId); rafId = 0; } paint(); return api; },

      rowHeight: function (h) {
        if (h === undefined) return rowHeight;
        rowHeight = num(h, rowHeight);
        for (var p = 0; p < pool.length; p++) pool[p].node.style.height = rowHeight + 'px';
        version++;
        invalidate();
        return api;
      },

      // The rendered node for an index, or null when that row is not on screen.
      nodeAt: function (index) {
        if (index < firstRendered || index >= lastRendered) return null;
        var slot = pool[index - firstRendered];
        return slot && slot.index === index ? slot.node : null;
      },
      range: function () { return [firstRendered, lastRendered]; },

      selection: selectionKeys,
      selectedItems: selectedItems,
      selectKeys: function (keys, silent) { selectKeys(keys, silent); return api; },
      selectIndex: function (i, mode, silent) { selectIndex(i, mode || 'set', silent); return api; },
      selectAll: function (silent) { selectAll(silent); return api; },
      clearSelection: function (silent) { clearSel(silent); return api; },
      indexOfKey: indexOfKey,

      cursor: function () { return cursor; },
      setCursor: function (i, o) { setCursor(i, o); return api; },
      scrollToIndex: function (i, align) { scrollToIndex(i, align); return api; },
      scrollToKey: function (k, align) {
        var i = indexOfKey(k);
        if (i >= 0) scrollToIndex(i, align || 'nearest');
        return api;
      },
      focus: function () { host.focus(); return api; },

      destroy: function () {
        destroyed = true;
        if (rafId) { global.cancelAnimationFrame(rafId); rafId = 0; }
        host.removeEventListener('scroll', onScroll);
        host.removeEventListener('click', onClick);
        host.removeEventListener('dblclick', onDblClick);
        host.removeEventListener('contextmenu', onContextMenu);
        host.removeEventListener('keydown', onKeyDown);
        if (ro) ro.disconnect(); else global.removeEventListener('resize', invalidate);
        for (var p = 0; p < pool.length; p++) {
          if (pool[p].node.parentNode) pool[p].node.parentNode.removeChild(pool[p].node);
        }
        pool = [];
        items = [];
      }
    };

    invalidate();
    return api;
  }

  function VList(host, opts) { return create(host, opts); }
  VList.create = create;
  VList.DEFAULT_ROW_H = DEFAULT_ROW_H;

  global.VList = VList;
  if (typeof module !== 'undefined' && module.exports) module.exports = VList;
})(typeof globalThis !== 'undefined' ? globalThis : window);

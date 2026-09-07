// menu.js: the one context-menu controller.
//
// ui.css has shipped .menu / .menu-item / .menu-key / .menu-sep since the design
// system landed, but nothing drove them: every tab that wanted a right-click
// menu had to hand-roll viewport flipping, outside-click dismissal, Escape
// precedence, arrow-key roving, focus return and aria-activedescendant. VList
// hands you onContextMenu(item, index, ev) with nothing to open, so the second
// tab to need one would have written the same 120 lines again, differently.
//
// One host element per document, reused. Only one menu is ever open.
//
//   Menu.open([
//     { label: 'Play', key: 'Enter', run: () => play(file) },
//     { label: 'Send to the Editor', run: () => edit(file) },
//     { sep: true },
//     { label: 'Favourite', checked: file.fav, run: () => toggleFav(file) },
//     { group: 'Danger' },
//     { label: 'Reveal in Explorer', run: () => reveal(file) },
//   ], { x: ev.clientX, y: ev.clientY, ariaLabel: 'Library row' });
//
'use strict';

(function (global) {
  var EDGE = 8;          // keep this far from the viewport edge
  var doc = global.document;

  var host = null;        // the .menu element, created lazily and reused
  var openState = null;   // {items, rows, cursor, returnTo, onClose}
  var seq = 0;

  function ensureHost() {
    if (host) return host;
    host = doc.createElement('div');
    host.className = 'menu';
    host.setAttribute('role', 'menu');
    host.tabIndex = -1;
    host.hidden = true;
    doc.body.appendChild(host);
    return host;
  }

  function isOpen() { return !!openState; }

  // ------------------------------------------------------------- building ---

  function buildRow(def, id) {
    if (def.sep) {
      var sep = doc.createElement('div');
      sep.className = 'menu-sep';
      return { el: sep, focusable: false };
    }
    if (def.group !== undefined && def.label === undefined) {
      var lab = doc.createElement('div');
      lab.className = 'menu-label';
      lab.textContent = String(def.group);
      return { el: lab, focusable: false };
    }
    var b = doc.createElement('button');
    b.type = 'button';
    b.id = id;
    b.className = 'menu-item' + (def.danger ? ' is-danger' : '');
    b.setAttribute('role', typeof def.checked === 'boolean' ? 'menuitemcheckbox' : 'menuitem');
    b.tabIndex = -1;
    if (typeof def.checked === 'boolean') b.setAttribute('aria-checked', def.checked ? 'true' : 'false');
    if (def.disabled) { b.disabled = true; b.setAttribute('aria-disabled', 'true'); }

    // ui.css styles the icon slot as `.menu-item > .ic`, and Icon.svg() already
    // returns an <svg class="ic">, so it goes in as a direct child.
    if (def.icon && global.Icon && global.Icon.has(def.icon)) {
      b.insertAdjacentHTML('afterbegin', global.Icon.svg(def.icon, 13));
    }
    var text = doc.createElement('span');
    text.className = 'menu-text';
    text.textContent = String(def.label === undefined ? '' : def.label);
    b.appendChild(text);
    if (def.key) {
      var k = doc.createElement('span');
      k.className = 'menu-key';
      k.textContent = String(def.key);
      b.appendChild(k);
    }
    return { el: b, focusable: !def.disabled, def: def };
  }

  // ------------------------------------------------------------ placement ---

  // Measure first, then place: a fixed element that is already on screen cannot
  // be measured after it has been positioned without reading back a layout that
  // may already have been clamped.
  function place(x, y) {
    var vw = global.innerWidth || doc.documentElement.clientWidth;
    var vh = global.innerHeight || doc.documentElement.clientHeight;
    host.style.left = '0px';
    host.style.top = '0px';
    host.style.maxHeight = '';
    var r = host.getBoundingClientRect();
    var w = r.width, h = r.height;

    // A menu taller than the viewport scrolls inside itself rather than running
    // off the bottom; .menu-scroll is the class for a long list, but a menu that
    // is merely near the bottom edge must still fit.
    var room = vh - EDGE * 2;
    if (h > room) { host.style.maxHeight = room + 'px'; host.style.overflowY = 'auto'; h = room; }
    else { host.style.overflowY = ''; }

    var left = x;
    if (left + w > vw - EDGE) left = x - w;            // flip to the left
    left = Math.max(EDGE, Math.min(left, vw - w - EDGE));
    if (left < EDGE) left = EDGE;                      // narrower than the menu

    var top = y;
    if (top + h > vh - EDGE) top = y - h;              // flip upwards
    top = Math.max(EDGE, Math.min(top, vh - h - EDGE));
    if (top < EDGE) top = EDGE;

    host.style.left = Math.round(left) + 'px';
    host.style.top = Math.round(top) + 'px';
  }

  // --------------------------------------------------------------- cursor ---

  function focusables() {
    return openState ? openState.rows.filter(function (r) { return r.focusable; }) : [];
  }

  function paintCursor() {
    var list = focusables();
    for (var i = 0; i < list.length; i++) {
      list[i].el.classList.toggle('is-cursor', i === openState.cursor);
    }
    var cur = list[openState.cursor];
    if (cur) host.setAttribute('aria-activedescendant', cur.el.id);
    else host.removeAttribute('aria-activedescendant');
  }

  function moveCursor(delta) {
    var list = focusables();
    if (!list.length) return;
    var n = list.length;
    openState.cursor = ((openState.cursor + delta) % n + n) % n;
    paintCursor();
    var el = list[openState.cursor].el;
    if (el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }

  function runIndex(i) {
    var list = focusables();
    var row = list[i];
    if (!row || !row.def || row.def.disabled) return;
    var fn = row.def.run;
    close();                                  // the handler must see it gone
    if (typeof fn === 'function') fn(row.def);
  }

  // ---------------------------------------------------------------- close ---

  function close() {
    if (!openState) return;
    var st = openState;
    openState = null;

    doc.removeEventListener('pointerdown', onDocPointer, true);
    doc.removeEventListener('keydown', onDocKey, true);
    global.removeEventListener('blur', close);
    global.removeEventListener('resize', close);
    global.removeEventListener('midi-studio:onscreen', onOnscreen);
    doc.removeEventListener('scroll', close, true);
    global.removeEventListener('wheel', onWheel, true);

    host.classList.remove('is-open');
    host.hidden = true;
    host.onclick = null;
    host.onpointermove = null;
    host.style.maxHeight = '';
    host.style.overflowY = '';
    host.textContent = '';
    host.removeAttribute('aria-activedescendant');

    if (st.returnTo && typeof st.returnTo.focus === 'function') {
      try { st.returnTo.focus(); } catch (e) { /* gone from the DOM */ }
    }
    if (typeof st.onClose === 'function') st.onClose();
  }

  function onDocPointer(e) {
    if (host.contains(e.target)) return;
    close();
  }

  // Capture, and stop the key here: a menu is the innermost layer, so Escape
  // must close it WITHOUT also closing the dialog or palette behind it.
  function onDocKey(e) {
    if (!openState) return;
    var k = e.key;
    if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (k === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); moveCursor(1); return; }
    if (k === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); moveCursor(-1); return; }
    if (k === 'Home') { e.preventDefault(); e.stopPropagation(); openState.cursor = 0; paintCursor(); return; }
    if (k === 'End') { e.preventDefault(); e.stopPropagation(); openState.cursor = Math.max(0, focusables().length - 1); paintCursor(); return; }
    if (k === 'Enter' || k === ' ' || k === 'Spacebar') {
      e.preventDefault(); e.stopPropagation();
      runIndex(openState.cursor);
      return;
    }
    if (k === 'Tab') { e.preventDefault(); e.stopPropagation(); close(); }
  }

  // A scroll under an absolutely placed menu leaves it pointing at nothing.
  function onWheel(e) { if (!host.contains(e.target)) close(); }
  function onOnscreen() { if (doc.documentElement.dataset.onscreen === '0') close(); }

  // ----------------------------------------------------------------- open ---

  function open(items, opts) {
    var o = opts || {};
    close();
    ensureHost();

    var defs = (items || []).filter(Boolean);
    if (!defs.length) return null;

    var rows = [];
    seq += 1;
    for (var i = 0; i < defs.length; i++) {
      var row = buildRow(defs[i], 'menu-' + seq + '-' + i);
      rows.push(row);
      host.appendChild(row.el);
    }
    host.setAttribute('aria-label', o.ariaLabel || 'Context menu');

    openState = {
      rows: rows,
      cursor: 0,
      returnTo: o.returnFocusTo || doc.activeElement,
      onClose: o.onClose
    };

    host.hidden = false;
    var x = Number(o.x), y = Number(o.y);
    if (!isFinite(x) || !isFinite(y)) {
      var a = o.anchor && o.anchor.getBoundingClientRect ? o.anchor.getBoundingClientRect() : null;
      x = a ? a.left : EDGE;
      y = a ? a.bottom + 2 : EDGE;
    }
    place(x, y);
    host.classList.add('is-open');

    // Delegated, so a rebuilt row list never leaks a listener.
    host.onclick = function (e) {
      var b = e.target.closest ? e.target.closest('.menu-item') : null;
      if (!b) return;
      var list = focusables();
      for (var j = 0; j < list.length; j++) if (list[j].el === b) { runIndex(j); return; }
    };
    host.onpointermove = function (e) {
      var b = e.target.closest ? e.target.closest('.menu-item') : null;
      if (!b || !openState) return;
      var list = focusables();
      for (var j = 0; j < list.length; j++) {
        if (list[j].el === b) { openState.cursor = j; paintCursor(); return; }
      }
    };

    paintCursor();
    try { host.focus({ preventScroll: true }); } catch (e) { /* older Chromium */ }

    doc.addEventListener('pointerdown', onDocPointer, true);
    doc.addEventListener('keydown', onDocKey, true);
    global.addEventListener('blur', close);
    global.addEventListener('resize', close);
    global.addEventListener('midi-studio:onscreen', onOnscreen);
    doc.addEventListener('scroll', close, true);
    global.addEventListener('wheel', onWheel, true);

    return { close: close };
  }

  var API = { open: open, close: close, isOpen: isOpen, EDGE: EDGE };
  global.Menu = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : window);

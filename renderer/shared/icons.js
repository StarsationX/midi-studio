// icons.js: the one icon set for MIDI Studio.
//
// The app used to point at whatever glyph the font happened to have: transport
// symbols, arrows, a gear. Those are not a set. They arrive at different weights
// and different optical sizes, they shift when the font falls back, and a couple
// of them render as emoji on Windows, which lands a full-colour cartoon in the
// middle of a graphite panel.
//
// These are drawn on one 16-unit grid with one stroke weight and square ends, to
// match the rest of the design language: exact 1px lines, nothing rounded off.
// Transport marks are filled because a triangle and a square read faster solid;
// everything else is stroked so it sits at the same weight as the text beside it.
//
// Usage, either way round:
//   <i data-icon="play"></i>            markup, upgraded on load
//   el.innerHTML = Icon.svg('stop')     from script
'use strict';

(function (global) {
  const S = 1.6;   // one stroke weight, everywhere

  // Paths are written against a 16x16 box. Keep new ones on the same grid and
  // on whole or half units, or they will not line up with the ones already here.
  const STROKE = {
    close:      'M4 4 L12 12 M12 4 L4 12',
    plus:       'M8 3 L8 13 M3 8 L13 8',
    minus:      'M3 8 L13 8',
    check:      'M3 8.5 L6.5 12 L13 4.5',
    up:         'M8 13 L8 3 M3.5 7.5 L8 3 L12.5 7.5',
    down:       'M8 3 L8 13 M3.5 8.5 L8 13 L12.5 8.5',
    caretDown:  'M4 6.5 L8 10.5 L12 6.5',
    caretUp:    'M4 9.5 L8 5.5 L12 9.5',
    caretRight: 'M6.5 4 L10.5 8 L6.5 12',
    refresh:    'M13 8 A5 5 0 1 1 11.2 4.2 M13 2 L13 5 L10 5',
    undo:       'M3 8 L3 5 L6 5 M3.2 6 A5.5 5.5 0 1 1 4.6 12.2',
    dots:       'M8 3.4 L8 3.5 M8 7.95 L8 8.05 M8 12.5 L8 12.6',
    alert:      'M8 2.5 L14.5 13.5 L1.5 13.5 Z M8 6.5 L8 9.5 M8 11.4 L8 11.5',
    search:     'M7 2.5 A4.5 4.5 0 1 0 7 11.5 A4.5 4.5 0 1 0 7 2.5 M10.4 10.4 L14 14',
    folder:     'M1.5 12.5 L1.5 3.5 L6 3.5 L7.5 5.5 L14.5 5.5 L14.5 12.5 Z',
    send:       'M2.5 8 L11 8 M8 4.5 L11.5 8 L8 11.5 M13.5 3.5 L13.5 12.5',
    drop:       'M8 2 L8 10 M4.5 6.5 L8 10 L11.5 6.5 M2.5 13.5 L13.5 13.5',
    keyboard:   'M1.5 4.5 L14.5 4.5 L14.5 11.5 L1.5 11.5 Z M4.5 4.5 L4.5 9 M7.5 4.5 L7.5 9 M11.5 4.5 L11.5 9 M1.5 9 L14.5 9',
  };

  // Gear is its own thing: a ring plus eight teeth, drawn rather than described,
  // because a path with eight arcs is unreadable and impossible to nudge.
  function gear() {
    let teeth = '';
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4;
      const c = Math.cos(a), s = Math.sin(a);
      teeth += `M${(8 + c * 4.6).toFixed(2)} ${(8 + s * 4.6).toFixed(2)} `
        + `L${(8 + c * 6.6).toFixed(2)} ${(8 + s * 6.6).toFixed(2)} `;
    }
    return `<circle cx="8" cy="8" r="4.6" fill="none" stroke="currentColor" stroke-width="${S}"/>`
      + `<circle cx="8" cy="8" r="1.5" fill="none" stroke="currentColor" stroke-width="${S}"/>`
      + `<path d="${teeth.trim()}" fill="none" stroke="currentColor" stroke-width="${S}" stroke-linecap="square"/>`;
  }

  // Transport. Solid, and sized so play/pause/stop have the same optical weight:
  // a triangle at the same height as a square reads noticeably smaller, so the
  // triangle is given a little more.
  const FILL = {
    play:  '<path d="M4.5 2.8 L13 8 L4.5 13.2 Z"/>',
    pause: '<path d="M4.5 3 L6.9 3 L6.9 13 L4.5 13 Z M9.1 3 L11.5 3 L11.5 13 L9.1 13 Z"/>',
    stop:  '<path d="M3.8 3.8 L12.2 3.8 L12.2 12.2 L3.8 12.2 Z"/>',
    next:  '<path d="M3 3.2 L10 8 L3 12.8 Z M11.4 3.2 L13.4 3.2 L13.4 12.8 L11.4 12.8 Z"/>',
    prev:  '<path d="M13 3.2 L6 8 L13 12.8 Z M2.6 3.2 L4.6 3.2 L4.6 12.8 L2.6 12.8 Z"/>',
    record: '<circle cx="8" cy="8" r="4.4"/>',
  };

  function body(name) {
    if (FILL[name]) return FILL[name];
    if (name === 'gear') return gear();
    const d = STROKE[name];
    if (!d) return '';
    return `<path d="${d}" fill="none" stroke="currentColor" stroke-width="${S}" `
      + 'stroke-linecap="square" stroke-linejoin="miter"/>';
  }

  // size is the rendered box in px. Everything scales off the same 16 grid, so
  // an icon at 12 and one at 20 still look like the same family.
  function svg(name, size) {
    const inner = body(name);
    if (!inner) return '';
    const px = Number(size) || 16;
    return `<svg class="ic" viewBox="0 0 16 16" width="${px}" height="${px}" `
      + 'fill="currentColor" aria-hidden="true" focusable="false">' + inner + '</svg>';
  }

  // Replace every <i data-icon="name"> under root. Safe to call repeatedly: an
  // element that already holds its svg is skipped, so a re-render of part of the
  // page does not rebuild the whole set.
  function apply(root) {
    const scope = root || document;
    for (const el of scope.querySelectorAll('[data-icon]')) {
      if (el.firstElementChild && el.firstElementChild.tagName === 'svg') continue;
      const markup = svg(el.dataset.icon, el.dataset.iconSize);
      if (markup) el.innerHTML = markup;
    }
  }

  const has = (name) => !!(FILL[name] || STROKE[name] || name === 'gear');

  global.Icon = { svg, apply, has, names: () => [...Object.keys(FILL), ...Object.keys(STROKE), 'gear'] };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => apply());
  } else {
    apply();
  }
})(window);

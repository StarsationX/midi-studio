// tokens.js: the design tokens, read once, cached, invalidated on theme change.
//
// Why this exists: four separate canvas paint loops used to call
// getComputedStyle(document.documentElement) to find out what --accent is. The
// Editor did it inside its per-note loop, so a large selection resolved style
// thousands of times a second; the Player's full-song overview did it once per
// 80ms redraw; Forge's waveform did it six to eight times per repaint.
// getComputedStyle forces a style resolution and returns a live object; doing it
// in a draw loop is a self-inflicted stall on the same thread that has to
// dispatch keypresses into a game.
//
// So: read the whole table once, hand out plain strings, and re-read only when
// the theme or accent actually changes.
//
//   Tokens.get('accent')      -> '#b8e62e'   (leading -- optional)
//   Tokens.num('h-row')       -> 28          (px/number tokens)
//   Tokens.rgba('accent', .4) -> 'rgba(184,230,46,0.4)'
//   Tokens.onChange(fn)       -> unsubscribe
//
// Invalidation: the shell dispatches 'midi-studio:theme' (window and document)
// after applyTheme/applyAccent. Many setProperty writes during a colour drag
// therefore cost exactly one re-read, taken lazily on the next get().
//
// Loads as a classic script (window.Tokens) and as an ES module side-effect
// import (globalThis.Tokens). No build step, no bundler.
(function (global) {
  'use strict';

  // The tokens a renderer can ask for by name. Anything not in this list is
  // still readable (get() falls through to a live read once and caches it), but
  // listing it here means it is refreshed as a batch and documented.
  var NAMES = [
    // surfaces
    'bg', 'bg-2', 'surface', 'surface-2', 'surface-3',
    // lines
    'line', 'line-2', 'line-soft', 'edge',
    // text
    'text', 'text-2', 'text-3',
    // accent
    'accent', 'accent-2', 'accent-deep', 'accent-ink', 'accent-grad',
    'accent-soft', 'accent-line',
    // semantic
    'ok', 'ok-soft', 'warn', 'warn-soft', 'err', 'err-soft',
    // radius + spacing
    'r-sm', 'r', 'r-lg', 'r-pill',
    's1', 's2', 's3', 's4', 's5', 's6', 's8',
    // type
    't1', 't2', 't3', 't4',
    'font-body', 'font-display', 'font-mono',
    // control metrics
    'h-ctl-sm', 'h-ctl', 'h-input', 'h-ctl-lg', 'h-ctl-xl',
    'h-row', 'h-row-lg', 'h-toolbar', 'h-tabstrip',
    'pad-ctl', 'pad-panel',
    // motion
    'motion-instant', 'motion-fast', 'motion-normal', 'motion-slow',
    'ease-standard', 'ease-enter', 'ease-exit',
    // z ladder
    'z-sticky', 'z-grip', 'z-pop', 'z-scrim', 'z-modal', 'z-toast', 'z-drop'
  ];

  var cache = null;             // name (no dashes) -> string
  var numCache = Object.create(null);
  var rgbaCache = Object.create(null);
  var listeners = [];
  var version = 0;

  function key(name) {
    return name.charAt(0) === '-' ? name.replace(/^-+/, '') : name;
  }

  function readAll() {
    var out = Object.create(null);
    var cs = global.getComputedStyle ? global.getComputedStyle(document.documentElement) : null;
    for (var i = 0; i < NAMES.length; i++) {
      var n = NAMES[i];
      out[n] = cs ? String(cs.getPropertyValue('--' + n) || '').trim() : '';
    }
    return out;
  }

  function ensure() {
    if (!cache) cache = readAll();
    return cache;
  }

  // Drop every cache and bump the version. Called on a theme/accent change.
  // The re-read itself is lazy: the next get() pays for it, so a colour picker
  // firing 35 setProperty writes per pointermove costs one read per frame that
  // actually paints, not 35.
  function refresh() {
    cache = null;
    numCache = Object.create(null);
    rgbaCache = Object.create(null);
    version++;
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](version); } catch (e) { /* a bad listener must not stop the rest */ }
    }
    return version;
  }

  function get(name, fallback) {
    var k = key(name);
    var c = ensure();
    var v = c[k];
    if (v === undefined) {
      // Not in NAMES: read it live once, then cache it like the rest.
      var cs = global.getComputedStyle ? global.getComputedStyle(document.documentElement) : null;
      v = cs ? String(cs.getPropertyValue('--' + k) || '').trim() : '';
      c[k] = v;
    }
    return v === '' && fallback !== undefined ? fallback : v;
  }

  // Numeric tokens: '28px' -> 28, '1.4' -> 1.4, '' -> fallback (default 0).
  function num(name, fallback) {
    var k = key(name);
    if (k in numCache) return numCache[k];
    var raw = get(k);
    var n = parseFloat(raw);
    if (!isFinite(n)) n = (fallback === undefined ? 0 : fallback);
    numCache[k] = n;
    return n;
  }

  function ms(name, fallback) {
    var raw = get(name);
    var n = parseFloat(raw);
    if (!isFinite(n)) return fallback === undefined ? 0 : fallback;
    return /ms\s*$/.test(raw) ? n : n * 1000;
  }

  // '#b8e62e' | '#abc' | '#rrggbbaa' -> [r,g,b,a]
  function parseColor(v) {
    var s = String(v || '').trim();
    var m;
    if (s.charAt(0) === '#') {
      var h = s.slice(1);
      if (h.length === 3 || h.length === 4) {
        h = h.split('').map(function (c) { return c + c; }).join('');
      }
      if (h.length === 6 || h.length === 8) {
        return [
          parseInt(h.slice(0, 2), 16),
          parseInt(h.slice(2, 4), 16),
          parseInt(h.slice(4, 6), 16),
          h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1
        ];
      }
      return [0, 0, 0, 1];
    }
    m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.%]+))?/i.exec(s);
    if (m) {
      var a = m[4] === undefined ? 1 : (String(m[4]).indexOf('%') >= 0 ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
      return [+m[1], +m[2], +m[3], isFinite(a) ? a : 1];
    }
    return [0, 0, 0, 1];
  }

  // A colour token at a given alpha, as a canvas-ready string. Cached, because
  // a note-per-frame draw loop must never build colour strings.
  function rgba(name, alpha) {
    var k = key(name) + '|' + alpha;
    var hit = rgbaCache[k];
    if (hit !== undefined) return hit;
    var c = parseColor(get(name));
    var out = 'rgba(' + Math.round(c[0]) + ',' + Math.round(c[1]) + ',' + Math.round(c[2]) + ',' +
      (Math.round(Math.max(0, Math.min(1, alpha * (c[3] === undefined ? 1 : c[3]))) * 1000) / 1000) + ')';
    rgbaCache[k] = out;
    return out;
  }

  // Linear blend of two tokens, t in 0..1. For canvas ramps that must sit
  // between two palette entries without inventing a third colour.
  function mix(nameA, nameB, t) {
    var a = parseColor(get(nameA)), b = parseColor(get(nameB));
    var f = Math.max(0, Math.min(1, t));
    return 'rgb(' +
      Math.round(a[0] + (b[0] - a[0]) * f) + ',' +
      Math.round(a[1] + (b[1] - a[1]) * f) + ',' +
      Math.round(a[2] + (b[2] - a[2]) * f) + ')';
  }

  // A plain snapshot object of every known token, for a consumer that wants to
  // destructure once at the top of a paint and never touch this module again.
  function all() {
    var c = ensure(), out = {};
    for (var k in c) out[k] = c[k];
    return out;
  }

  function onChange(fn) {
    if (typeof fn !== 'function') return function () {};
    listeners.push(fn);
    return function () {
      var i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  function currentVersion() { return version; }

  // A version string usable as a LayerCache key: any theme change invalidates
  // every cached static layer that paints with a palette colour.
  function themeKey() {
    return (document.documentElement.getAttribute('data-theme') || 'lime') + ':' +
      (document.documentElement.getAttribute('data-density') || 'normal') + ':v' + version;
  }

  var EVENTS = ['midi-studio:theme', 'midi-studio:accent', 'midi-studio:density'];
  for (var i = 0; i < EVENTS.length; i++) {
    global.addEventListener(EVENTS[i], refresh);
    if (global.document) document.addEventListener(EVENTS[i], refresh);
  }

  var API = {
    NAMES: NAMES,
    get: get,
    num: num,
    ms: ms,
    rgba: rgba,
    mix: mix,
    parseColor: parseColor,
    all: all,
    refresh: refresh,
    onChange: onChange,
    version: currentVersion,
    themeKey: themeKey
  };

  global.Tokens = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : window);

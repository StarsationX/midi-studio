// fmt.js: the formatting helpers. Pure functions, no DOM, no state.
//
// Every tab used to grow its own mm:ss. They disagreed: one rounded, one
// truncated, one showed 0:00 for a null duration and one showed NaN:NaN. A
// transport readout and a list row that disagree about the length of the same
// file look like a bug in the file.
//
//   Fmt.clock(214.6)              -> '3:34'
//   Fmt.clock(214.6, {ms:true})   -> '3:34.600'
//   Fmt.clock(4271, {hours:true}) -> '1:11:11'
//   Fmt.ms(-12.4)                 -> '-12ms'
//   Fmt.when(Date.now() - 3600e3) -> 'an hour ago'
//   Fmt.bytes(1536)               -> '1.5 KB'
//   Fmt.parseClock('3:34.6')      -> 214.6
//
// Classic script (window.Fmt) or ES-module side-effect import.
(function (global) {
  'use strict';

  function pad2(n) { return n < 10 ? '0' + n : String(n); }
  function pad3(n) { return n < 10 ? '00' + n : (n < 100 ? '0' + n : String(n)); }

  // null / undefined / '' / a boolean are NOT zero. Number(null) is 0 and
  // isFinite(0) is true, which is how a missing duration used to render as
  // '0:00' and look like a real, empty file.
  function finite(v) {
    if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }

  // Split a second count into whole seconds and whole milliseconds, in integer
  // milliseconds, so 214.6 cannot come out as 214.599.
  function split(s) {
    var totalMs = Math.round(s * 1000);
    return { whole: Math.floor(totalMs / 1000), msec: totalMs % 1000 };
  }

  // --------------------------------------------------------------- clock ---

  // Seconds -> mm:ss, or hh:mm:ss once it passes an hour (or when opts.hours).
  // opts.ms adds three digits. opts.sign keeps a leading '-' for negatives.
  // A non-finite input returns opts.blank (default '--:--'), never 'NaN:NaN'.
  function clock(seconds, opts) {
    opts = opts || {};
    var s = finite(seconds);
    if (s === null) return opts.blank === undefined ? '--:--' : opts.blank;

    var neg = s < 0;
    if (neg) s = -s;

    // Truncate the seconds field, do not round it: a readout that shows 3:34
    // for 3:33.9 makes the last moment of a song look like it overran. The ms
    // field is taken from integer milliseconds so float noise cannot leak in.
    var parts = split(s);
    var whole = opts.ms ? parts.whole : Math.floor(s + 1e-6);
    var h = Math.floor(whole / 3600);
    var m = Math.floor((whole % 3600) / 60);
    var sec = whole % 60;

    var out;
    if (opts.hours || h > 0) out = h + ':' + pad2(m) + ':' + pad2(sec);
    else out = m + ':' + pad2(sec);

    if (opts.ms) out += '.' + pad3(parts.msec);
    if (neg && opts.sign !== false) out = '-' + out;
    return out;
  }

  // Fixed-width variant for a transport readout, so digits do not jitter.
  function clockPad(seconds, opts) {
    opts = opts || {};
    var s = finite(seconds);
    if (s === null) return opts.ms ? '00:00.000' : '00:00';
    var neg = s < 0; if (neg) s = -s;
    var parts = split(s);
    var whole = opts.ms ? parts.whole : Math.floor(s + 1e-6);
    var h = Math.floor(whole / 3600), m = Math.floor((whole % 3600) / 60), sec = whole % 60;
    var out = (opts.hours || h > 0 ? pad2(h) + ':' : '') + pad2(m) + ':' + pad2(sec);
    if (opts.ms) out += '.' + pad3(parts.msec);
    return (neg ? '-' : '') + out;
  }

  // 'mm:ss', 'mm:ss.mmm', 'hh:mm:ss', '214', '3:34.6' -> seconds, or null.
  // Used by every range/loop widget, which all accept typed times.
  function parseClock(text) {
    if (text === null || text === undefined) return null;
    var s = String(text).trim();
    if (!s) return null;
    var neg = /^-/.test(s);
    if (neg) s = s.slice(1);
    if (!/^[\d:.]+$/.test(s)) return null;
    var parts = s.split(':');
    if (parts.length > 3) return null;
    var total = 0;
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (p === '' && parts.length > 1) p = '0';
      var n = Number(p);
      if (!isFinite(n) || n < 0) return null;
      // Only the last field may carry a fraction.
      if (i < parts.length - 1 && p.indexOf('.') >= 0) return null;
      total = total * 60 + n;
    }
    return neg ? -total : total;
  }

  // Signed millisecond offset, for a latency or an offset control.
  function ms(value, opts) {
    opts = opts || {};
    var n = finite(value);
    if (n === null) return opts.blank === undefined ? '--' : opts.blank;
    var digits = opts.digits === undefined ? 0 : opts.digits;
    var v = Math.abs(n) < 1 && digits === 0 && n !== 0 ? n.toFixed(1) : n.toFixed(digits);
    var sign = n > 0 ? '+' : (n < 0 ? '' : '');   // toFixed already carries '-'
    return sign + v + (opts.unit === false ? '' : 'ms');
  }

  // A long duration in words, for a job that has been running for a while.
  function duration(seconds, opts) {
    opts = opts || {};
    var s = finite(seconds);
    if (s === null) return opts.blank === undefined ? '--' : opts.blank;
    s = Math.max(0, Math.round(s));
    if (s < 60) return s + 's';
    var m = Math.floor(s / 60), sec = s % 60;
    if (m < 60) return sec ? m + 'm ' + sec + 's' : m + 'm';
    var h = Math.floor(m / 60); m = m % 60;
    return m ? h + 'h ' + m + 'm' : h + 'h';
  }

  // ---------------------------------------------------------------- dates ---

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function toDate(v) {
    if (v instanceof Date) return isFinite(v.getTime()) ? v : null;
    var n = Number(v);
    if (isFinite(n) && n > 0) {
      // Accept seconds as well as milliseconds: mtime comes back both ways.
      return new Date(n < 1e12 ? n * 1000 : n);
    }
    if (typeof v === 'string') {
      var d = new Date(v);
      return isFinite(d.getTime()) ? d : null;
    }
    return null;
  }

  // Relative label for a library row: 'just now', '4 min ago', 'Yesterday',
  // 'Tue 14:20', '3 Mar', '3 Mar 2024'. Recent times stay relative because that
  // is the question being asked ("is this the file I just made?").
  function when(value, opts) {
    opts = opts || {};
    var d = toDate(value);
    if (!d) return opts.blank === undefined ? '' : opts.blank;
    var now = opts.now ? toDate(opts.now) : new Date();
    var diff = (now.getTime() - d.getTime()) / 1000;

    if (diff < 0 && diff > -60) return 'just now';
    if (diff < 45) return 'just now';
    if (diff < 90) return 'a minute ago';
    if (diff < 3600) return Math.round(diff / 60) + ' min ago';
    if (diff < 5400) return 'an hour ago';
    if (diff < 86400) {
      var hrs = Math.round(diff / 3600);
      // Only say "N hours ago" while it is still the same calendar day-ish.
      if (hrs < 24 && d.getDate() === now.getDate()) return hrs + ' hours ago';
    }
    var startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    var days = Math.floor((startToday - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86400000);
    if (days === 0) return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    if (days === 1) return 'Yesterday';
    if (days < 7) return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()] + ' ' +
      pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    if (d.getFullYear() === now.getFullYear()) return d.getDate() + ' ' + MONTHS[d.getMonth()];
    return d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear();
  }

  // Absolute, sortable, for a tooltip on a relative label.
  function stamp(value) {
    var d = toDate(value);
    if (!d) return '';
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
      pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  // ---------------------------------------------------------------- sizes ---

  var UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

  // 1024-based, one decimal below 10 in the unit, none above: '9.4 MB',
  // '154 MB', '1.2 GB'. Free-space readouts and download progress both use it.
  function bytes(value, opts) {
    opts = opts || {};
    var n = finite(value);
    if (n === null || n < 0) return opts.blank === undefined ? '--' : opts.blank;
    if (n < 1024) return Math.round(n) + ' B';
    var i = 0;
    while (n >= 1024 && i < UNITS.length - 1) { n /= 1024; i++; }
    var digits = opts.digits === undefined ? (n < 10 ? 1 : 0) : opts.digits;
    return n.toFixed(digits) + ' ' + UNITS[i];
  }

  // Always in GB, for a storage panel where every row must line up.
  function gb(value, opts) {
    opts = opts || {};
    var n = finite(value);
    if (n === null || n < 0) return opts.blank === undefined ? '--' : opts.blank;
    var v = n / (1024 * 1024 * 1024);
    return v.toFixed(opts.digits === undefined ? 1 : opts.digits) + ' GB';
  }

  function rate(bytesPerSec, opts) {
    var n = finite(bytesPerSec);
    if (n === null || n < 0) return (opts && opts.blank) || '--';
    return bytes(n, { digits: n < 1024 * 1024 * 10 ? 1 : 0 }) + '/s';
  }

  // ---------------------------------------------------------------- misc ---

  // Integer percent, clamped, monotonic when the caller keeps the peak. Written
  // as an integer on purpose: a progress label that rewrites 43.7 -> 43.8 forty
  // times a second is a layout thrash for no information.
  function percent(value, opts) {
    opts = opts || {};
    var n = finite(value);
    if (n === null) return opts.blank === undefined ? '' : opts.blank;
    var p = n <= 1 && opts.fraction !== false && n >= 0 && !opts.absolute ? n * 100 : n;
    p = Math.max(0, Math.min(100, p));
    return Math.round(p) + '%';
  }

  function count(n, one, many) {
    var v = Number(n) || 0;
    return v + ' ' + (v === 1 ? one : (many || one + 's'));
  }

  // basename / dirname that cope with both separators, because paths come from
  // Windows, from drag-and-drop and from the engine's own output.
  function basename(p) {
    var s = String(p || '');
    var i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    return i >= 0 ? s.slice(i + 1) : s;
  }

  function dirname(p) {
    var s = String(p || '');
    var i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    return i > 0 ? s.slice(0, i) : '';
  }

  function stem(p) {
    var b = basename(p);
    var i = b.lastIndexOf('.');
    return i > 0 ? b.slice(0, i) : b;
  }

  function ext(p) {
    var b = basename(p);
    var i = b.lastIndexOf('.');
    return i > 0 ? b.slice(i + 1).toLowerCase() : '';
  }

  // Shorten a path from the middle, keeping the drive and the basename, for a
  // chip that cannot fit the whole thing.
  function shortPath(p, max) {
    var s = String(p || '');
    var limit = max || 48;
    if (s.length <= limit) return s;
    var base = basename(s);
    var head = s.slice(0, Math.max(3, limit - base.length - 4));
    return head + '…\\' + base;
  }

  // MIDI note number -> 'C4'. The visualiser and the editor inspector both need
  // it and must agree on middle C (60 = C4).
  var PITCH = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  function note(midi) {
    var n = Math.round(Number(midi));
    if (!isFinite(n)) return '';
    return PITCH[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1);
  }

  function bpm(value, opts) {
    var n = finite(value);
    if (n === null || n <= 0) return (opts && opts.blank) || '--';
    return (Math.round(n * 10) / 10) + '';
  }

  var API = {
    clock: clock,
    clockPad: clockPad,
    parseClock: parseClock,
    ms: ms,
    duration: duration,
    when: when,
    stamp: stamp,
    bytes: bytes,
    gb: gb,
    rate: rate,
    percent: percent,
    count: count,
    basename: basename,
    dirname: dirname,
    stem: stem,
    ext: ext,
    shortPath: shortPath,
    note: note,
    bpm: bpm,
    pad2: pad2,
    pad3: pad3
  };

  global.Fmt = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : window);

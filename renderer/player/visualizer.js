// visualizer.js — the falling-note roll + piano keybed.
//
// This module OWNS NO CANVAS, NO TIMER AND NO CLOCK OF RECORD. It is handed a
// 2d context already in CSS pixels by the Draw scheduler, and it interpolates
// from playback state that the engine owns. Presentation never drives timing:
// if this file stops drawing, not one keystroke changes.
//
// The clock is local and extrapolating: elapsed = serverSync + wall delta.
// Without it notes teleport between the engine's 20Hz progress packets.
//
// Allocation discipline (the reason this file was rewritten): the old version
// allocated a createLinearGradient, two colour-string concatenations, a
// beginPath/4x arcTo path and two fresh pitch-class array literals PER VISIBLE
// NOTE PER FRAME, plus one strokeRect and one fillText per piano key. Hundreds
// of allocations a frame feed a GC that runs on the same thread that must
// service progress packets and dispatch keypresses, so this was a timing bug
// wearing a rendering costume. Now:
//   * pitch-class tests are module-level lookup tables;
//   * every colour is a precomputed string in an array, indexed by channel;
//   * the roll ground, the pitch/octave lines, the idle keybed and every key
//     label live in one offscreen LayerCache that is blitted per frame;
//   * small notes are a fillRect, only large ones get a rounded path;
//   * the active-note outlines are one batched path, the keybed separators are
//     baked into the static layer;
//   * the cull cursor is found by binary search, never by rescanning from 0.
(function (global) {
  'use strict';

  // 16 MIDI channels, one hue each. A single user colour overrides all of them.
  var CHANNEL_COLORS = [
    '#b8e62e', '#ff7a7a', '#7affb8', '#ffc857', '#c87aff', '#ff7adc', '#7adcff', '#ffff82',
    '#82ffff', '#ff82c8', '#c8ff82', '#c8c8c8', '#ffa500', '#b4b4ff', '#82b482', '#dcdcdc'
  ];
  var LOOKAHEAD = 3.0;        // seconds of music visible above the keys at 1x

  // Hoisted out of the per-note function: these were array literals allocated
  // per note per frame. Index by pitch class.
  var IS_BLACK = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0];
  var WHITE_PC = [1, 0, 1, 0, 1, 1, 0, 1, 0, 1, 0, 1];

  var FALLBACK = {
    roll: '#0f1013', grid: '#1f2126', pitch: '#16181d',
    key: '#e8e9ea', keyInk: '#141519', black: '#16181d', blackInk: '#c2c5cb',
    line: '#2b2e36', accent: '#b8e62e'
  };

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  function tok(name, fallback) {
    if (global.Tokens) {
      var v = global.Tokens.get(name, '');
      if (v) return v;
    }
    return fallback;
  }

  // '#rrggbb' -> 'rgb(r,g,b)' brightened towards white by t (0..1).
  function lift(hex, t) {
    var c = global.Tokens && global.Tokens.parseColor
      ? global.Tokens.parseColor(hex)
      : null;
    if (!c) return hex;
    var r = Math.round(c[0] + (255 - c[0]) * t);
    var g = Math.round(c[1] + (255 - c[1]) * t);
    var b = Math.round(c[2] + (255 - c[2]) * t);
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  function dim(hex, t) {
    var c = global.Tokens && global.Tokens.parseColor
      ? global.Tokens.parseColor(hex)
      : null;
    if (!c) return hex;
    return 'rgb(' + Math.round(c[0] * t) + ',' + Math.round(c[1] * t) + ',' + Math.round(c[2] * t) + ')';
  }

  function Visualizer() {
    this.events = [];            // {t, key, dur, note, ch}, sorted by t
    this.noteToKey = {};
    this.maxDur = 0;
    this.lo = 36; this.hi = 96;
    this.whiteNotes = [];
    this.whiteIdx = new Map();
    this.cursor = 0;

    this.lookahead = LOOKAHEAD;
    this.noteColor = null;       // null => per-channel rainbow
    this.showKeys = true;

    // clock
    this.syncServerElapsed = 0;
    this.syncClientNowMs = 0;
    this.frozenElapsed = null;   // non-null while paused
    this.playing = false;
    this.totalDuration = 0;
    this.dragLock = false;

    // Reused per-frame scratch. Never reallocated, so a dense passage costs no
    // garbage at all.
    this._activeNote = [];
    this._activeCh = [];
    this._activeCount = 0;
    this._outline = [];          // x,y,w,h quads of active notes
    this._outlineCount = 0;

    // precomputed colours, indexed by channel
    this._body = [];
    this._bodyActive = [];
    this._cap = [];
    this._capActive = [];

    this._layer = (global.Draw && global.Draw.LayerCache)
      ? new global.Draw.LayerCache({ alpha: false })
      : null;
    this._staticVer = 0;
    this._hitGrad = null;
    this._hitGradKey = '';
    this._pal = null;

    this._buildPalette();
    this._rebuildRange();
  }

  // --- style / palette ------------------------------------------------------

  Visualizer.prototype._buildPalette = function () {
    this._pal = {
      roll: tok('bg-2', FALLBACK.roll),
      grid: tok('line', FALLBACK.grid),
      pitch: tok('surface', FALLBACK.pitch),
      key: tok('text', FALLBACK.key),
      keyInk: tok('bg', FALLBACK.keyInk),
      black: tok('surface', FALLBACK.black),
      blackInk: tok('text-2', FALLBACK.blackInk),
      line: tok('line', FALLBACK.line),
      accent: tok('accent', FALLBACK.accent)
    };
    for (var ch = 0; ch < 16; ch++) {
      var base = this.noteColor || CHANNEL_COLORS[ch % CHANNEL_COLORS.length];
      this._body[ch] = dim(base, 0.82);
      this._bodyActive[ch] = base;
      this._cap[ch] = lift(base, 0.28);
      this._capActive[ch] = lift(base, 0.62);
    }
    this._hitGrad = null;
    this._hitGradKey = '';
    this._staticVer++;
  };

  // Called by the panel when the theme changes.
  Visualizer.prototype.retheme = function () {
    this._buildPalette();
    if (this._layer) this._layer.invalidate();
  };

  // speed 1 = default fall rate, 2 = twice as fast (half the lookahead).
  // color '#rrggbb' paints every channel the same; null restores the rainbow.
  // keys:false gives the roll the whole canvas (the Perch overlay has no room
  // for a keyboard nobody is reading).
  Visualizer.prototype.setStyle = function (o) {
    o = o || {};
    if (o.speed) this.lookahead = LOOKAHEAD / clamp(Number(o.speed) || 1, 0.1, 4);
    var nextColor = o.color || null;
    var changed = nextColor !== this.noteColor;
    this.noteColor = nextColor;
    if (o.keys !== undefined) {
      var showKeys = o.keys !== false;
      if (showKeys !== this.showKeys) { this.showKeys = showKeys; changed = true; }
    }
    if (changed) this._buildPalette();
  };

  // --- data ----------------------------------------------------------------

  Visualizer.prototype.load = function (events, noteToKey) {
    var src = events || [];
    var out = new Array(src.length);
    var maxDur = 0;
    for (var i = 0; i < src.length; i++) {
      var e = src[i];
      var dur = e[2] || 0;
      if (dur > maxDur) maxDur = dur;
      out[i] = { t: e[0], key: e[1], dur: dur, note: e[3], ch: e[4] | 0 };
    }
    // The engine emits in time order; a defensive sort costs one pass and is
    // what makes the binary-search cursor legal.
    var sorted = true;
    for (var j = 1; j < out.length; j++) { if (out[j].t < out[j - 1].t) { sorted = false; break; } }
    if (!sorted) out.sort(function (a, b) { return a.t - b.t; });
    this.events = out;
    this.maxDur = maxDur;

    this.noteToKey = {};
    var keys = Object.keys(noteToKey || {});
    for (var k = 0; k < keys.length; k++) this.noteToKey[Number(keys[k])] = noteToKey[keys[k]];

    if (out.length) {
      var lo = Infinity, hi = -Infinity;
      for (var m = 0; m < out.length; m++) {
        if (out[m].note < lo) lo = out[m].note;
        if (out[m].note > hi) hi = out[m].note;
      }
      this.lo = Math.max(21, Math.floor(lo / 12) * 12 - 1);
      this.hi = Math.min(108, Math.ceil((hi + 1) / 12) * 12);
    } else {
      this.lo = 36; this.hi = 96;
    }

    this._rebuildRange();

    this.cursor = 0;
    // Reset the clock explicitly, or a freshly loaded MIDI inherits the
    // previous track's scrub position.
    this.syncServerElapsed = 0;
    this.syncClientNowMs = (global.performance || Date).now();
    this.frozenElapsed = null;
    this.playing = false;
    this.dragLock = false;
    this._staticVer++;
    if (this._layer) this._layer.invalidate();
  };

  // whiteNotes / whiteIdx are the whole geometry: which white key each pitch
  // sits on, and therefore where every note and every label goes.
  Visualizer.prototype._rebuildRange = function () {
    this.whiteNotes = [];
    for (var n = this.lo; n <= this.hi; n++) if (WHITE_PC[n % 12]) this.whiteNotes.push(n);
    this.whiteIdx = new Map();
    for (var w = 0; w < this.whiteNotes.length; w++) this.whiteIdx.set(this.whiteNotes[w], w);
  };

  Visualizer.prototype.noteCount = function () { return this.events.length; };

  // --- clock ---------------------------------------------------------------

  Visualizer.prototype.startClock = function (totalDuration, startElapsed) {
    this.syncServerElapsed = startElapsed || 0;
    this.syncClientNowMs = performance.now();
    this.frozenElapsed = null;
    this.playing = true;
    this.totalDuration = totalDuration || 0;
    this.cursor = this._cursorAt(this.syncServerElapsed - 0.3);
  };

  Visualizer.prototype.stopClock = function () {
    this.playing = false;
    this.frozenElapsed = null;
  };

  // The engine froze the clock (the target lost focus): elapsed() is a constant
  // until the next packet, so a caller animating the roll has nothing to draw.
  Visualizer.prototype.isFrozen = function () { return this.frozenElapsed !== null; };

  Visualizer.prototype.setDragLock = function (on) { this.dragLock = !!on; };
  Visualizer.prototype.isDragLocked = function () { return this.dragLock; };

  // Resync from an engine 'progress' packet.
  Visualizer.prototype.clockSet = function (p) {
    if (this.dragLock) return;         // mid-scrub: the user's position wins
    var prev = this.elapsed();
    var frozen = p.frozen_elapsed;
    this.frozenElapsed = (frozen === null || frozen === undefined) ? null : frozen;
    this.syncServerElapsed = p.elapsed;
    this.syncClientNowMs = performance.now();
    // A backwards jump means a seek: the cull cursor is ahead of the playhead
    // and every note behind it would never reappear.
    if (p.elapsed + 0.2 < prev) this.cursor = this._cursorAt(p.elapsed - 0.3);
  };

  // Optimistic local seek so the roll tracks a drag without the engine
  // round trip.
  Visualizer.prototype.seek = function (t) {
    if (!isFinite(t)) return;
    this.syncServerElapsed = Math.max(0, t);
    this.syncClientNowMs = performance.now();
    if (this.frozenElapsed !== null) this.frozenElapsed = this.syncServerElapsed;
    this.cursor = this._cursorAt(this.syncServerElapsed - 0.3);
  };

  Visualizer.prototype.elapsed = function () {
    if (this.frozenElapsed !== null) return this.frozenElapsed;
    if (!this.playing) return this.syncServerElapsed;   // preview while stopped
    return this.syncServerElapsed + (performance.now() - this.syncClientNowMs) / 1000;
  };

  // First index that can still be visible at viewStart. Binary search, so a
  // scrub does not force the next render to walk the whole array from zero.
  Visualizer.prototype._cursorAt = function (viewStart) {
    var ev = this.events;
    if (!ev.length) return 0;
    var want = viewStart - this.maxDur;
    if (want <= ev[0].t) return 0;
    var lo = 0, hi = ev.length;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (ev[mid].t < want) lo = mid + 1; else hi = mid;
    }
    return lo;
  };

  // --- geometry ------------------------------------------------------------

  Visualizer.prototype._xOf = function (n, wkeyW, bkeyW) {
    if (IS_BLACK[n % 12]) {
      var i = this.whiteIdx.get(n - 1);
      if (i === undefined) return -1;
      return (i + 1) * wkeyW - bkeyW / 2;
    }
    var j = this.whiteIdx.get(n);
    if (j === undefined) return -1;
    return j * wkeyW;
  };

  // --- the frame -----------------------------------------------------------

  // ctx is already in CSS pixels (Draw.fitCanvas restated the transform).
  Visualizer.prototype.render = function (ctx, W, H) {
    if (W < 20 || H < 20) return;
    var pal = this._pal;
    var rollH = this.showKeys ? Math.floor(H * 0.72) : H;
    var kbH = H - rollH;
    var nWhite = Math.max(1, this.whiteNotes.length);
    var wkeyW = W / nWhite;
    var bkeyW = wkeyW * 0.6;
    var hitY = rollH - 4;
    var pxPerSec = rollH / this.lookahead;

    // 1. everything static, from an offscreen layer.
    var themeKey = global.Tokens ? global.Tokens.themeKey() : '';
    var ver = this._staticVer + '|' + (this.showKeys ? 1 : 0) + '|' +
      this.lo + ',' + this.hi + '|' + Math.round(rollH) + '|' + themeKey;
    var self = this;
    if (this._layer) {
      this._layer.paint(W, H, ver, function (lctx, info) {
        self._paintStatic(lctx, info.w, info.h, rollH, kbH, wkeyW, bkeyW);
      });
      this._layer.blit(ctx, 0, 0, W, H);
    } else {
      this._paintStatic(ctx, W, H, rollH, kbH, wkeyW, bkeyW);
    }

    this._activeCount = 0;
    this._outlineCount = 0;

    if (!this.events.length) {
      // The empty-state caption is an HTML overlay. Drawing a second one here
      // stacked two messages on top of each other.
      this._drawHitLine(ctx, W, hitY, rollH);
      return;
    }

    var elapsed = this.elapsed();
    var viewStart = elapsed - 0.3;
    var viewEnd = elapsed + this.lookahead;
    var ev = this.events;

    // 2. advance the cull cursor past what is fully behind the view.
    while (this.cursor < ev.length) {
      var head = ev[this.cursor];
      if (head.t + head.dur >= viewStart) break;
      this.cursor++;
    }

    // 3. the notes.
    var body = this._body, bodyA = this._bodyActive, cap = this._cap, capA = this._capActive;
    var an = this._activeNote, ac = this._activeCh, ol = this._outline;
    var count = 0, oCount = 0;
    for (var i = this.cursor; i < ev.length; i++) {
      var e = ev[i];
      if (e.t > viewEnd) break;
      var x = this._xOf(e.note, wkeyW, bkeyW);
      if (x < 0) continue;
      var w = IS_BLACK[e.note % 12] ? bkeyW : wkeyW;

      var yBot = hitY - (e.t - elapsed) * pxPerSec;
      var nh = e.dur * pxPerSec;
      if (nh < 3) nh = 3;
      var yTop = yBot - nh;
      if (yBot <= 0 || yTop >= rollH) continue;

      var isActive = e.t <= elapsed && elapsed <= e.t + e.dur + 0.05;
      if (isActive) { an[count] = e.note; ac[count] = e.ch; count++; }

      var bx = x + 1, bw = w - 2;
      if (bw < 1) bw = 1;
      ctx.fillStyle = isActive ? bodyA[e.ch] : body[e.ch];
      if (nh >= 9 && bw >= 7) {
        this._roundRect(ctx, bx, yTop, bw, nh, 3);
        ctx.fill();
      } else {
        ctx.fillRect(bx, yTop, bw, nh);
      }
      // A 1px lit top edge instead of a per-note gradient: same read, no
      // allocation.
      ctx.fillStyle = isActive ? capA[e.ch] : cap[e.ch];
      ctx.fillRect(bx, yTop, bw, nh >= 6 ? 1.5 : 1);

      if (isActive) {
        ol[oCount] = bx; ol[oCount + 1] = yTop; ol[oCount + 2] = bw; ol[oCount + 3] = nh;
        oCount += 4;
      }
    }
    this._activeCount = count;
    this._outlineCount = oCount;

    // 4. one batched outline path for every sounding note.
    if (oCount) {
      ctx.beginPath();
      for (var o = 0; o < oCount; o += 4) ctx.rect(ol[o] + 0.5, ol[o + 1] + 0.5, ol[o + 2] - 1, ol[o + 3] - 1);
      ctx.strokeStyle = 'rgba(255,255,255,0.62)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    this._drawHitLine(ctx, W, hitY, rollH);

    // 5. only the keys that are sounding: the idle keybed is in the layer.
    if (this.showKeys && kbH >= 8) this._litKeys(ctx, rollH, kbH, wkeyW, bkeyW);
  };

  Visualizer.prototype._drawHitLine = function (ctx, W, hitY, rollH) {
    if (hitY < 14) return;
    var key = Math.round(hitY) + '|' + this._pal.accent;
    if (this._hitGradKey !== key) {
      var g = ctx.createLinearGradient(0, hitY - 12, 0, hitY + 1);
      var a = this._pal.accent;
      var rgba = global.Tokens && global.Tokens.parseColor ? global.Tokens.parseColor(a) : null;
      var head = rgba ? 'rgba(' + rgba[0] + ',' + rgba[1] + ',' + rgba[2] + ',' : 'rgba(184,230,46,';
      g.addColorStop(0, head + '0)');
      g.addColorStop(1, head + '0.3)');
      this._hitGrad = g;
      this._hitGradKey = key;
    }
    ctx.fillStyle = this._hitGrad;
    ctx.fillRect(0, hitY - 12, W, 13);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, hitY, W, 2);
  };

  // The idle roll and keybed: ground, pitch bands, octave lines, every key and
  // every key label. Repainted only when the size, the pitch range, the theme
  // or the mapping changes.
  Visualizer.prototype._paintStatic = function (ctx, W, H, rollH, kbH, wkeyW, bkeyW) {
    var pal = this._pal;
    ctx.fillStyle = pal.roll;
    ctx.fillRect(0, 0, W, H);

    // pitch bands: a slightly darker column behind every black key, so the
    // octave shape reads even with no notes on screen.
    ctx.fillStyle = pal.pitch;
    ctx.globalAlpha = 0.5;
    for (var n = this.lo; n <= this.hi; n++) {
      if (!IS_BLACK[n % 12]) continue;
      var bx = this._xOf(n, wkeyW, bkeyW);
      if (bx < 0) continue;
      ctx.fillRect(bx, 0, bkeyW, rollH);
    }
    ctx.globalAlpha = 1;

    // octave lines, one batched path
    ctx.beginPath();
    for (var w = 0; w < this.whiteNotes.length; w++) {
      var note = this.whiteNotes[w];
      if (note % 12 !== 0) continue;
      var x = Math.round(this._xOf(note, wkeyW, bkeyW)) + 0.5;
      if (x < 0) continue;
      ctx.moveTo(x, 0); ctx.lineTo(x, rollH);
    }
    ctx.strokeStyle = pal.grid;
    ctx.lineWidth = 1;
    ctx.stroke();

    if (!this.showKeys || kbH < 8) return;
    this._paintKeybed(ctx, W, rollH, kbH, wkeyW, bkeyW);
  };

  Visualizer.prototype._paintKeybed = function (ctx, W, kbTop, kbH, wkeyW, bkeyW) {
    var pal = this._pal;
    var bkH = Math.floor(kbH * 0.62);
    var labels = wkeyW >= 14;

    // one fill for the whole white band, then one batched path for every
    // separator: the old version did a strokeRect per key.
    ctx.fillStyle = pal.key;
    ctx.fillRect(0, kbTop, W, kbH);
    ctx.beginPath();
    for (var i = 1; i < this.whiteNotes.length; i++) {
      var sx = Math.round(i * wkeyW) + 0.5;
      ctx.moveTo(sx, kbTop); ctx.lineTo(sx, kbTop + kbH);
    }
    ctx.moveTo(0, kbTop + 0.5); ctx.lineTo(W, kbTop + 0.5);
    ctx.strokeStyle = pal.line;
    ctx.lineWidth = 1;
    ctx.stroke();

    if (labels) {
      // The 9px label is the one sanctioned exception to the 12px type floor:
      // a white key is ~19px wide and these are single glyphs.
      ctx.fillStyle = pal.keyInk;
      ctx.font = '600 9px ' + tok('font-mono', 'Consolas, monospace');
      ctx.textAlign = 'center';
      for (var wi = 0; wi < this.whiteNotes.length; wi++) {
        var wn = this.whiteNotes[wi];
        var lbl = this.noteToKey[wn];
        if (!lbl) continue;
        ctx.fillText(lbl, wi * wkeyW + wkeyW / 2, kbTop + kbH - 8);
      }
    }

    ctx.fillStyle = pal.black;
    for (var n = this.lo; n <= this.hi; n++) {
      if (!IS_BLACK[n % 12]) continue;
      var bx = this._xOf(n, wkeyW, bkeyW);
      if (bx < 0) continue;
      ctx.fillRect(Math.floor(bx), kbTop, Math.ceil(bkeyW), bkH);
    }
    if (labels && bkeyW >= 10) {
      ctx.fillStyle = pal.blackInk;
      ctx.font = '600 8px ' + tok('font-mono', 'Consolas, monospace');
      ctx.textAlign = 'center';
      for (var b = this.lo; b <= this.hi; b++) {
        if (!IS_BLACK[b % 12]) continue;
        var lb = this.noteToKey[b];
        if (!lb) continue;
        var lx = this._xOf(b, wkeyW, bkeyW);
        if (lx < 0) continue;
        ctx.fillText(lb, lx + bkeyW / 2, kbTop + bkH - 6);
      }
    }
  };

  // Only the sounding keys, over the blitted idle keybed. A key lights for as
  // long as its note sounds, with the mapped label redrawn on top so the lit
  // key does not lose it.
  Visualizer.prototype._litKeys = function (ctx, kbTop, kbH, wkeyW, bkeyW) {
    var count = this._activeCount;
    if (!count) return;
    var bkH = Math.floor(kbH * 0.62);
    var labels = wkeyW >= 14;
    var mono = tok('font-mono', 'Consolas, monospace');
    var an = this._activeNote, ac = this._activeCh;
    ctx.textAlign = 'center';
    for (var i = 0; i < count; i++) {
      var n = an[i];
      var x = this._xOf(n, wkeyW, bkeyW);
      if (x < 0) continue;
      var black = !!IS_BLACK[n % 12];
      ctx.fillStyle = this._bodyActive[ac[i]];
      if (black) {
        ctx.fillRect(Math.floor(x), kbTop, Math.ceil(bkeyW), bkH);
        ctx.fillStyle = this._capActive[ac[i]];
        ctx.fillRect(Math.floor(x), kbTop, Math.ceil(bkeyW), 2);
      } else {
        ctx.fillRect(Math.floor(x) + 1, kbTop + 1, Math.floor(wkeyW) - 1, kbH - 1);
        ctx.fillStyle = this._capActive[ac[i]];
        ctx.fillRect(Math.floor(x) + 1, kbTop + 1, Math.floor(wkeyW) - 1, 2);
      }
      var lbl = this.noteToKey[n];
      if (!labels || !lbl) continue;
      ctx.fillStyle = this._pal.keyInk;
      if (black) {
        if (bkeyW < 10) continue;
        ctx.font = '600 8px ' + mono;
        ctx.fillText(lbl, x + bkeyW / 2, kbTop + bkH - 6);
      } else {
        ctx.font = '600 9px ' + mono;
        ctx.fillText(lbl, x + wkeyW / 2, kbTop + kbH - 8);
      }
    }
  };

  Visualizer.prototype._roundRect = function (ctx, x, y, w, h, r) {
    if (w <= 0 || h <= 0) return;
    var rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  };

  Visualizer.prototype.dispose = function () {
    if (this._layer) this._layer.dispose();
    this._layer = null;
    this.events = [];
    this.whiteIdx = new Map();
  };

  Visualizer.CHANNEL_COLORS = CHANNEL_COLORS;
  global.Visualizer = Visualizer;
  if (typeof module !== 'undefined' && module.exports) module.exports = Visualizer;
})(typeof globalThis !== 'undefined' ? globalThis : window);

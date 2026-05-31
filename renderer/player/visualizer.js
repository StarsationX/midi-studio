// Canvas piano-roll visualizer.
// Reads "events" once at midi_loaded, then renders at 60 FPS using a local
// extrapolating clock that's periodically resynced by Python "progress"
// packets. The smooth tween is what stops notes from teleporting between
// updates.

const CHANNEL_COLORS = [
  '#5aa9ff','#ff7a7a','#7affb8','#ffc857','#c87aff','#ff7adc','#7adcff','#ffff82',
  '#82ffff','#ff82c8','#c8ff82','#c8c8c8','#ffa500','#b4b4ff','#82b482','#dcdcdc',
];
const LOOKAHEAD = 3.0;

class Visualizer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.events = [];        // [t, key, dur, note, ch]
    this.noteToKey = {};
    this.lo = 36; this.hi = 96;
    this.whiteNotes = [];
    this.whiteIdx = new Map();
    this.cursor = 0;

    // sync state — set by clockSet(), used by elapsed()
    this.syncServerElapsed = 0;
    this.syncClientNowMs = 0;
    this.frozenElapsed = null;     // non-null while paused
    this.playing = false;
    this.totalDuration = 0;
    // While the user is dragging the scrubber, ignore incoming progress
    // packets — otherwise the visualizer flickers between the drag
    // position and the engine's stale elapsed (the seek hasn't been
    // processed yet on the engine side).
    this.dragLock = false;

    new ResizeObserver(() => this._resize()).observe(canvas);
    this._resize();
  }

  _resize() {
    const r = this.canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    this.canvas.width  = Math.round(r.width  * this.dpr);
    this.canvas.height = Math.round(r.height * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  // Called from the renderer on midi_loaded.
  load(events, noteToKey) {
    this.events = events.map(e => ({
      t: e[0], key: e[1], dur: e[2], note: e[3], ch: e[4]
    }));
    this.noteToKey = Object.fromEntries(
      Object.entries(noteToKey).map(([k, v]) => [Number(k), v]));
    if (this.events.length) {
      let lo = Infinity, hi = -Infinity;
      for (const e of this.events) {
        if (e.note < lo) lo = e.note;
        if (e.note > hi) hi = e.note;
      }
      this.lo = Math.max(21, Math.floor(lo / 12) * 12 - 1);
      this.hi = Math.min(108, Math.ceil((hi + 1) / 12) * 12);
    } else {
      this.lo = 36; this.hi = 96;
    }
    this.whiteNotes = [];
    for (let n = this.lo; n <= this.hi; n++) {
      if ([0,2,4,5,7,9,11].includes(n % 12)) this.whiteNotes.push(n);
    }
    this.whiteIdx = new Map(this.whiteNotes.map((n, i) => [n, i]));
    this.cursor = 0;
    // Reset the clock to the start so a freshly-loaded MIDI shows t=0
    // instead of inheriting the previous track's scrub position.
    this.syncServerElapsed = 0;
    this.syncClientNowMs = performance.now();
    this.frozenElapsed = null;
    this.playing = false;
    this.dragLock = false;
  }

  startClock(totalDuration, startElapsed = 0) {
    this.syncServerElapsed = startElapsed || 0;
    this.syncClientNowMs = performance.now();
    this.frozenElapsed = null;
    this.playing = true;
    this.totalDuration = totalDuration;
    this.cursor = 0;
  }

  stopClock() {
    this.playing = false;
    this.frozenElapsed = null;
  }

  setDragLock(on) { this.dragLock = !!on; }

  // Resync from a Python "progress" packet.
  clockSet({ elapsed, frozen_elapsed }) {
    if (this.dragLock) return;     // user is mid-scrub; ignore stale server time
    const prev = this.elapsed();
    this.frozenElapsed = (frozen_elapsed === null || frozen_elapsed === undefined)
      ? null : frozen_elapsed;
    this.syncServerElapsed = elapsed;
    this.syncClientNowMs = performance.now();
    // If the timeline jumped backward (a seek), roll the render cursor
    // back so notes behind the new playhead show up again.
    if (elapsed + 0.2 < prev) this.cursor = 0;
  }

  // Optimistic seek: snap the local clock to t immediately so the visualizer
  // tracks the user's drag without waiting for the engine roundtrip.
  seek(t) {
    if (!isFinite(t)) return;
    this.syncServerElapsed = Math.max(0, t);
    this.syncClientNowMs = performance.now();
    if (this.frozenElapsed !== null) this.frozenElapsed = this.syncServerElapsed;
    this.cursor = 0;
  }

  elapsed() {
    if (this.frozenElapsed !== null) return this.frozenElapsed;
    if (!this.playing) return this.syncServerElapsed; // preview-while-stopped
    return this.syncServerElapsed
      + (performance.now() - this.syncClientNowMs) / 1000;
  }

  // ------- geometry helpers -------
  _isBlack(n) { return [1,3,6,8,10].includes(n % 12); }
  _noteGeom(n, w, wkeyW, bkeyW) {
    if (this._isBlack(n)) {
      const below = n - 1;
      const i = this.whiteIdx.get(below);
      if (i === undefined) return null;
      return { x: (i + 1) * wkeyW - bkeyW / 2, w: bkeyW };
    }
    const i = this.whiteIdx.get(n);
    if (i === undefined) return null;
    return { x: i * wkeyW, w: wkeyW };
  }

  // ------- frame -------
  render() {
    const ctx = this.ctx;
    const W = this.canvas.width / this.dpr;
    const H = this.canvas.height / this.dpr;
    if (W < 20 || H < 20) return;

    ctx.fillStyle = '#0b0d12';
    ctx.fillRect(0, 0, W, H);

    const rollH = Math.floor(H * 0.72);
    const kbH   = H - rollH;
    const nWhite = Math.max(1, this.whiteNotes.length);
    const wkeyW = W / nWhite;
    const bkeyW = wkeyW * 0.6;
    const hitY = rollH - 4;
    const pxPerSec = rollH / LOOKAHEAD;

    if (!this.events.length) {
      ctx.fillStyle = '#5e667a';
      ctx.font = '500 14px -apple-system, "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Load a MIDI to begin', W / 2, H / 2);
      this._drawKeyboard(W, rollH, kbH, wkeyW, bkeyW, new Map());
      return;
    }

    const elapsed = this.elapsed();
    const viewStart = elapsed - 0.3;
    const viewEnd = elapsed + LOOKAHEAD;

    // octave grid
    ctx.strokeStyle = '#161b27';
    ctx.lineWidth = 1;
    for (const n of this.whiteNotes) {
      if (n % 12 === 0) {
        const g = this._noteGeom(n, W, wkeyW, bkeyW);
        if (g) {
          ctx.beginPath();
          ctx.moveTo(Math.round(g.x) + 0.5, 0);
          ctx.lineTo(Math.round(g.x) + 0.5, rollH);
          ctx.stroke();
        }
      }
    }

    // advance cursor past events fully behind the view
    while (this.cursor < this.events.length) {
      const e = this.events[this.cursor];
      if (e.t + e.dur >= viewStart) break;
      this.cursor++;
    }

    const active = new Map();   // note -> ch
    for (let i = this.cursor; i < this.events.length; i++) {
      const e = this.events[i];
      if (e.t > viewEnd) break;
      const g = this._noteGeom(e.note, W, wkeyW, bkeyW);
      if (!g) continue;

      const yBot = hitY - (e.t - elapsed) * pxPerSec;
      const nh = Math.max(3, e.dur * pxPerSec);
      const yTop = yBot - nh;
      if (yBot <= 0 || yTop >= rollH) continue;

      const isActive = e.t <= elapsed && elapsed <= e.t + e.dur + 0.05;
      if (isActive) active.set(e.note, e.ch);

      const baseCol = CHANNEL_COLORS[e.ch % CHANNEL_COLORS.length];
      // Subtle vertical glow per note
      const grd = ctx.createLinearGradient(0, yTop, 0, yBot);
      grd.addColorStop(0, baseCol + (isActive ? 'ff' : 'cc'));
      grd.addColorStop(1, baseCol + (isActive ? 'ff' : '99'));
      ctx.fillStyle = grd;
      this._roundRect(ctx, g.x + 1, yTop, g.w - 2, nh, 3);
      ctx.fill();
      if (isActive) {
        ctx.strokeStyle = 'rgba(255,255,255,0.65)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    // hit line (white with soft glow)
    const lg = ctx.createLinearGradient(0, hitY - 12, 0, hitY + 1);
    lg.addColorStop(0, 'rgba(90,169,255,0)');
    lg.addColorStop(1, 'rgba(90,169,255,0.35)');
    ctx.fillStyle = lg;
    ctx.fillRect(0, hitY - 12, W, 13);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, hitY, W, 2);

    this._drawKeyboard(W, rollH, kbH, wkeyW, bkeyW, active);
  }

  _drawKeyboard(W, kbTop, kbH, wkeyW, bkeyW, active) {
    const ctx = this.ctx;
    if (kbH < 8) return;
    const bkH = Math.floor(kbH * 0.62);
    const showLabels = wkeyW >= 14;

    // shadow under keyboard
    ctx.fillStyle = '#0a0c10';
    ctx.fillRect(0, kbTop, W, kbH);

    // whites
    for (const n of this.whiteNotes) {
      const g = this._noteGeom(n, W, wkeyW, bkeyW);
      if (!g) continue;
      const ch = active.get(n);
      const fill = ch !== undefined
        ? CHANNEL_COLORS[ch % CHANNEL_COLORS.length]
        : '#e4e7ee';
      ctx.fillStyle = fill;
      ctx.fillRect(Math.floor(g.x), kbTop, Math.floor(g.w) - 1, kbH);
      ctx.strokeStyle = '#1c2030';
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.floor(g.x) + 0.5, kbTop + 0.5,
                     Math.floor(g.w) - 1, kbH - 1);
      if (showLabels) {
        const lbl = this.noteToKey[n];
        if (lbl) {
          ctx.fillStyle = '#1d212c';
          ctx.font = '600 9px Consolas, monospace';
          ctx.textAlign = 'center';
          ctx.fillText(lbl, g.x + g.w / 2, kbTop + kbH - 8);
        }
      }
    }

    // blacks
    for (let n = this.lo; n <= this.hi; n++) {
      if (![1,3,6,8,10].includes(n % 12)) continue;
      const g = this._noteGeom(n, W, wkeyW, bkeyW);
      if (!g) continue;
      const ch = active.get(n);
      const fill = ch !== undefined
        ? CHANNEL_COLORS[ch % CHANNEL_COLORS.length]
        : '#13161e';
      ctx.fillStyle = fill;
      ctx.fillRect(Math.floor(g.x), kbTop, Math.ceil(g.w), bkH);
      // subtle highlight on top of black
      const hg = ctx.createLinearGradient(0, kbTop, 0, kbTop + bkH);
      hg.addColorStop(0, 'rgba(255,255,255,0.06)');
      hg.addColorStop(1, 'rgba(0,0,0,0.0)');
      ctx.fillStyle = hg;
      ctx.fillRect(Math.floor(g.x), kbTop, Math.ceil(g.w), bkH);

      if (showLabels && g.w >= 10) {
        const lbl = this.noteToKey[n];
        if (lbl) {
          ctx.fillStyle = ch !== undefined ? '#0a0c10' : '#cfd0d4';
          ctx.font = '600 8px Consolas, monospace';
          ctx.textAlign = 'center';
          ctx.fillText(lbl, g.x + g.w / 2, kbTop + bkH - 6);
        }
      }
    }
  }

  _roundRect(ctx, x, y, w, h, r) {
    if (w <= 0 || h <= 0) return;
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y,     x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x,     y + h, rr);
    ctx.arcTo(x,     y + h, x,     y,     rr);
    ctx.arcTo(x,     y,     x + w, y,     rr);
    ctx.closePath();
  }
}

window.Visualizer = Visualizer;

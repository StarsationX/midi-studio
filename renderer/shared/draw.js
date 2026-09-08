// draw.js: the ONE draw scheduler, the HiDPI canvas helper and the layer cache.
//
// Before this, every canvas in the app ran its own rAF loop and its own copy of
// the budget logic. Measured consequences, all of them real bugs:
//   - ~500 wakeups a second in Self MIDI because the loop re-armed at full rate
//     even when its own budget said Infinity.
//   - The Editor read data-onscreen but never listened for the event that turns
//     it back on, so coming back to the tab left a stale canvas.
//   - The Player's budget function re-read two dataset attributes and ran a
//     Number() on every wakeup.
//   - A past version folded the user's percent and "a game is running" into one
//     flag, which LATCHED the limit on permanently the first time Roblox was
//     seen, and then an unfocused penalty compounded on top of that: 5fps, and
//     the piano roll teleported from note to note instead of scrolling.
//
// So the budget here is built from THREE SEPARATE INPUTS that never compound:
//
//   1. the user's budget          <html data-drawms="16">   ms per frame
//      a detected game RAISES it  <html data-game="1">      x3, never lowers,
//                                                          never overwrites
//   2. the window-unfocused penalty                        a max() clamp to
//                                                          250ms, never a
//                                                          multiplier
//   3. the playback floor                                  min(base, 33): at
//                                                          least 30fps while
//                                                          notes are moving,
//                                                          and it beats both of
//                                                          the above
//
// Playing into a game means this window is normally NOT focused, so unfocused
// is the usual case during playback and never a reason to go choppy.
//
// Off-screen suppression: an iframe cannot detect that it is occluded
// (document.hidden tracks the window only) and the app deliberately disables
// renderer backgrounding, so the platform will never throttle a hidden panel.
// The shell stamps data-onscreen on each panel's <html> and dispatches
// 'midi-studio:onscreen' when a panel comes back. While data-onscreen is '0'
// the scheduler is PARKED: no rAF is armed at all.
//
//   const layer = new Draw.LayerCache();
//   const h = Draw.register({ key: 'player:viz', draw: paint, el: canvasHost });
//   h.invalidate();              // ask for a frame
//   h.setLive(true);             // this consumer is animating right now
//   Draw.setPlaybackActive(true) // input 3
//
// Classic script (window.Draw) or ES-module side-effect import.
(function (global) {
  'use strict';

  var GAME_RAISE = 3;            // a game RAISES the interval, never lowers it
  var UNFOCUSED_MS = 250;        // clamp, not a multiplier
  var PLAYBACK_FLOOR_MS = 33;    // >= 30fps while playback is live
  var IDLE_MS = 250;             // a consumer that is not animating: 4/sec

  var now = (global.performance && global.performance.now)
    ? function () { return global.performance.now(); }
    : function () { return Date.now(); };

  var consumers = [];            // registration order = draw order
  var byKey = Object.create(null);
  var dirtyCount = 0;

  // Two id spaces, tracked separately: a rAF handle and a timeout handle can
  // collide numerically, so clearTimeout(rafId) could cancel someone else's
  // timer.
  var rafId = 0, timerId = 0;
  var lastFrameAt = 0;
  var frames = 0, lastFrameMs = 0;

  var env = {
    baseMs: 33,          // input 1: the user's budget, in ms per frame
    gameActive: false,   // input 1b: raise only
    gamePreRaised: false,// the stamped data-drawms already includes the x3
    focused: true,       // input 2
    playback: false,     // input 3
    onscreen: true,      // panel visibility
    hidden: false        // window minimised
  };
  var budget = 33;
  var budgetListeners = [];

  var io = null;         // one IntersectionObserver for every registered element

  // Local overrides, kept OUT of env so that re-reading the attributes cannot
  // silently clear them. A page with no shell above it (the Perch overlay) owns
  // its own state; a page inside the shell gets it stamped onto <html>. Both
  // must work, and neither may quietly cancel the other.
  var localGame = false;
  var localOnscreen = null;   // null = follow the attribute
  var localBaseMs = null;     // null = follow data-drawms

  var parked = null;          // last value stamped on <html>, so we only write on a change

  // ------------------------------------------------------- minimised window ---
  //
  // env.hidden has always been documented above as "window minimised", and it
  // was dead code: document.hidden and document.visibilityState BOTH stay
  // 'visible' for ever in this app, because webPreferences.backgroundThrottling
  // is false by design (an invariant) and Electron then never marks the page
  // hidden. Measured directly with an Electron probe: minimise AND hide both
  // leave visibilityState === 'visible', while screenX/screenY go to
  // -32000/-32000 -- the position Windows parks a minimised window at.
  //
  // So the position IS the signal, and it is read EVENT-DRIVEN, never polled:
  // Windows fires blur on minimise and focus on restore, and both are already
  // listened for at the bottom of this file. A poll would be exactly the "wakes
  // up with nothing to do" waste this module exists to remove.
  //
  // Unfocused is NOT minimised. Playing into a game means this window is
  // normally not focused, so blur is only the moment to RE-READ the position;
  // the decision is the position itself, and a merely unfocused window keeps
  // its real coordinates and its full frame budget.
  //
  // TOP FRAME ONLY. A panel iframe reads the same -32000 (verified), but it
  // receives no blur, focus, resize or visibilitychange at all when the window
  // is minimised, so a panel that parked on this would have nothing left to
  // un-park it. Panels keep the data-onscreen stamp the shell already drives.
  var isTop = false;
  try { isTop = (global.top === global); } catch (e) { isTop = false; }

  var MINIMIZED_AT = -20000;   // the real value is -32000; this is the margin

  function windowMinimized() {
    if (!isTop) return false;
    var x = global.screenX, y = global.screenY;
    return typeof x === 'number' && typeof y === 'number'
      && x <= MINIMIZED_AT && y <= MINIMIZED_AT;
  }

  // ---------------------------------------------------------------- inputs ---

  function readAttrs() {
    var root = document.documentElement;
    var ds = root.dataset;
    var n = Number(ds.drawms);
    env.baseMs = localBaseMs !== null ? localBaseMs : (isFinite(n) && n > 0 ? n : 33);
    // Two ways to say "a game is running". data-game is the clean one: the
    // shell says a game is up and draw.js applies the raise. data-game-raised
    // means the stamped data-drawms ALREADY carries the x3, so applying it here
    // as well would be exactly the compounding bug this module exists to stop.
    env.gameActive = localGame || ds.game === '1' || ds.gameActive === '1' || ds.gameRaised === '1';
    env.gamePreRaised = ds.gameRaised === '1';
    env.onscreen = localOnscreen === null ? (ds.onscreen !== '0') : localOnscreen;
    env.hidden = !!document.hidden || windowMinimized();
    env.focused = typeof document.hasFocus === 'function' ? document.hasFocus() : true;
  }

  // The whole budget, in one place, with each input applied exactly once.
  function computeBudget() {
    if (!env.onscreen || env.hidden) return Infinity;   // parked

    var base = env.baseMs;                              // input 1
    var ms = (env.gameActive && !env.gamePreRaised) ? base * GAME_RAISE : base;

    if (!env.focused) ms = Math.max(ms, UNFOCUSED_MS);  // input 2: a clamp

    // input 3 wins over both: at least 30fps while notes are moving, and never
    // slower than the user's own base asked for.
    if (env.playback) ms = Math.min(ms, Math.min(base, PLAYBACK_FLOOR_MS));

    return ms;
  }

  // A looping CSS animation is the one moving thing in this app that the frame
  // budget above cannot reach: the compositor runs it every vsync whether or
  // not any consumer asked for a frame, and the app disables Chromium's
  // background throttling on purpose (an invariant), so nothing else stops it.
  //
  // Measured, benchmarks/anim-cost.js, two pulsing 8px status dots, 20s
  // samples, same window and same DOM in every row:
  //   visible, pulsing               1.060% renderer / 2.902% GPU
  //   parked,  pulsing (old)         1.084% renderer / 2.990% GPU
  //   parked,  paused  (now)         0.000% renderer / 0.008% GPU
  //   really minimised, pulsing      0.005% renderer / 0.248% GPU
  //   really minimised, paused       0.000% renderer / 0.009% GPU
  // The VISIBLE row is deliberately untouched: the pulse is the affordance for
  // the blocked state and a smooth one costs a composite per vsync, which is a
  // price, not a defect. Minimising already recovers most of the cost on its
  // own (2.902% -> 0.248% GPU); what is left is what this removes, and it is
  // held for as long as the window stays minimised.
  //
  // So the scheduler's own park state -- exactly the condition under which it
  // arms no rAF at all -- is published on <html data-parked>, and ui.css /
  // tokens.css pause the decorative loops off it. PAUSED, not stopped: the
  // animation resumes mid-cycle the moment the document is visible again, so
  // nothing about how it looks on screen changes.
  function reflectPark() {
    var now2 = !env.onscreen || env.hidden;
    if (now2 === parked) return;
    parked = now2;
    var root = document.documentElement;
    if (!root) return;
    if (now2) root.setAttribute('data-parked', '1');
    else root.removeAttribute('data-parked');
  }

  function refreshEnv(force) {
    readAttrs();
    reflectPark();
    var next = computeBudget();
    if (next !== budget || force) {
      budget = next;
      for (var i = 0; i < budgetListeners.length; i++) {
        try { budgetListeners[i](budget); } catch (e) { /* keep going */ }
      }
    }
    schedule();
    return budget;
  }

  function budgetMs() { return budget; }

  function onBudgetChange(fn) {
    if (typeof fn !== 'function') return function () {};
    budgetListeners.push(fn);
    return function () {
      var i = budgetListeners.indexOf(fn);
      if (i >= 0) budgetListeners.splice(i, 1);
    };
  }

  // ------------------------------------------------------------- scheduling ---

  function cancelPending() {
    if (rafId) { global.cancelAnimationFrame(rafId); rafId = 0; }
    if (timerId) { global.clearTimeout(timerId); timerId = 0; }
  }

  // The interval this consumer is allowed right now: the global budget, plus a
  // per-consumer idle clamp for a consumer that is not currently animating.
  // Both are clamps; neither multiplies the other.
  function intervalFor(c) {
    if (budget === Infinity) return Infinity;
    return c.live ? budget : Math.max(budget, c.idleMs);
  }

  function schedule() {
    if (!dirtyCount || budget === Infinity) return;   // park: arm nothing
    if (rafId || timerId) return;                     // already armed

    var t = now();
    var wait = Infinity;
    for (var i = 0; i < consumers.length; i++) {
      var c = consumers[i];
      if (!c.dirty || !c.visible) continue;
      var due = c.lastAt + intervalFor(c);
      var w = due - t;
      if (w < wait) wait = w;
    }
    if (wait === Infinity) return;                    // everything dirty is hidden
    if (wait <= 1) {
      rafId = global.requestAnimationFrame(run);
    } else {
      timerId = global.setTimeout(function () {
        timerId = 0;
        rafId = global.requestAnimationFrame(run);
      }, wait);
    }
  }

  function run(ts) {
    rafId = 0;
    var t0 = now();
    lastFrameAt = t0;
    frames++;

    // Snapshot: clearing dirty BEFORE the draw means a consumer that
    // invalidates itself from inside its own draw asks for the NEXT frame
    // instead of spinning inside this one.
    var ran = 0;
    for (var i = 0; i < consumers.length; i++) {
      var c = consumers[i];
      if (!c.dirty) continue;
      if (!c.visible) continue;                       // stays dirty for later
      if (t0 - c.lastAt < intervalFor(c) - 1) continue;
      c.dirty = false; dirtyCount--;
      c.lastAt = t0;
      ran++;
      try {
        c.draw(ts === undefined ? t0 : ts, c);
      } catch (e) {
        // One broken consumer must not take the whole app's rendering with it.
        if (global.console && console.error) console.error('[draw] ' + c.key, e);
      }
    }
    lastFrameMs = now() - t0;
    if (ran === 0 && dirtyCount === 0) return;        // nothing to re-arm for
    schedule();
  }

  // Draw everything dirty right now, synchronously. For a resize or a divider
  // commit, where waiting a frame shows a stretched canvas.
  function frame() {
    cancelPending();
    if (budget === Infinity) return;
    for (var i = 0; i < consumers.length; i++) consumers[i].lastAt = 0;
    run(now());
  }

  // ------------------------------------------------------------ consumers ---

  function ensureIO() {
    if (io || typeof global.IntersectionObserver !== 'function') return io;
    io = new global.IntersectionObserver(function (entries) {
      var wake = false;
      for (var i = 0; i < entries.length; i++) {
        var c = entries[i].target.__drawConsumer;
        if (!c) continue;
        var vis = entries[i].isIntersecting;
        if (c.visible !== vis) {
          c.visible = vis;
          if (vis && c.dirty) wake = true;
        }
      }
      if (wake) schedule();
    }, { root: null, threshold: 0 });
    return io;
  }

  function register(opts) {
    if (!opts || typeof opts.draw !== 'function') {
      throw new Error('Draw.register needs {key, draw}');
    }
    var key = String(opts.key || ('anon' + (consumers.length + 1)));
    // Re-registering the same key replaces the old consumer. dispose() lives on
    // the returned handle, not on the record kept here, so it has to be reached
    // through c.handle: calling dispose() on the record itself threw a TypeError
    // and took out the boot of whatever panel was rebuilding its canvas.
    if (byKey[key] && byKey[key].handle) byKey[key].handle.dispose();

    var c = {
      key: key,
      draw: opts.draw,
      el: opts.el || null,
      idleMs: typeof opts.idleMs === 'number' ? opts.idleMs : IDLE_MS,
      live: !!opts.live,
      dirty: false,
      visible: true,
      lastAt: 0,
      handle: null
    };

    if (c.el) {
      c.el.__drawConsumer = c;
      var obs = ensureIO();
      if (obs) { c.visible = false; obs.observe(c.el); }
    }

    consumers.push(c);
    byKey[key] = c;

    var handle = {
      key: key,
      invalidate: function () {
        if (!c.dirty) { c.dirty = true; dirtyCount++; }
        schedule();
        return handle;
      },
      // Mark this consumer as animating (playback, a drag) or back to idle.
      // Idle consumers are clamped to idleMs so a canvas nobody is watching
      // still self-heals a few times a second without costing a frame budget.
      setLive: function (on) {
        c.live = !!on;
        if (c.live) { c.lastAt = 0; }
        schedule();
        return handle;
      },
      setIdle: function (ms) {
        c.idleMs = typeof ms === 'number' && ms >= 0 ? ms : IDLE_MS;
        return handle;
      },
      setElement: function (el) {
        if (c.el && io) { try { io.unobserve(c.el); } catch (e) {} delete c.el.__drawConsumer; }
        c.el = el || null;
        c.visible = true;
        if (c.el) {
          c.el.__drawConsumer = c;
          var o = ensureIO();
          if (o) { c.visible = false; o.observe(c.el); }
        }
        schedule();
        return handle;
      },
      isDirty: function () { return c.dirty; },
      isVisible: function () { return c.visible; },
      dispose: function () {
        var i = consumers.indexOf(c);
        if (i >= 0) consumers.splice(i, 1);
        if (c.dirty) { c.dirty = false; dirtyCount--; }
        if (c.el && io) { try { io.unobserve(c.el); } catch (e) {} delete c.el.__drawConsumer; }
        if (byKey[key] === c) delete byKey[key];
        if (!dirtyCount) cancelPending();
      }
    };
    c.handle = handle;
    return handle;
  }

  function invalidate(key) {
    if (key === undefined) return invalidateAll();
    var c = byKey[key];
    if (!c) return false;
    if (!c.dirty) { c.dirty = true; dirtyCount++; }
    schedule();
    return true;
  }

  function invalidateAll() {
    for (var i = 0; i < consumers.length; i++) {
      var c = consumers[i];
      if (!c.dirty) { c.dirty = true; dirtyCount++; }
    }
    schedule();
    return consumers.length;
  }

  // ------------------------------------------------------- external inputs ---

  // Input 3. The transport owner sets this: while it is true every consumer
  // gets at least 30fps whatever the allowance and the focus state say.
  function setPlaybackActive(on) {
    on = !!on;
    if (env.playback === on) return budget;
    env.playback = on;
    return refreshEnv(true);
  }

  // Input 1b. Only ever RAISES the interval. The user's percent is untouched,
  // and this never latches: it is a plain boolean that the caller clears.
  function setGameActive(on) {
    on = !!on;
    if (localGame === on) return budget;
    localGame = on;
    return refreshEnv(true);
  }

  // Input 1. For a page that owns its own budget (the Perch overlay window has
  // no shell above it to stamp data-drawms).
  // Pass null to hand control back to the data-drawms attribute, the same way
  // setOnscreen does. Writing env.baseMs directly did nothing: refreshEnv's
  // first act is readAttrs(), which reads the attribute back over it.
  function setBaseMs(ms) {
    if (ms === null) { localBaseMs = null; return refreshEnv(true); }
    var n = Number(ms);
    localBaseMs = isFinite(n) && n > 0 ? n : 33;
    return refreshEnv(true);
  }

  // For a page that has no shell above it. Pass null to hand control back to
  // the data-onscreen attribute.
  function setOnscreen(on) {
    localOnscreen = on === null ? null : !!on;
    var b = refreshEnv(true);
    if (env.onscreen) invalidateAll();
    return b;
  }

  function isOnscreen() { return env.onscreen && !env.hidden; }
  function isPlaybackActive() { return env.playback; }
  function isGameActive() { return env.gameActive; }

  function stats() {
    return {
      consumers: consumers.length,
      dirty: dirtyCount,
      budgetMs: budget,
      baseMs: env.baseMs,
      focused: env.focused,
      onscreen: env.onscreen,
      parked: !!parked,
      playback: env.playback,
      gameActive: env.gameActive,
      frames: frames,
      lastFrameMs: Math.round(lastFrameMs * 100) / 100
    };
  }

  // ------------------------------------------------------------- listeners ---

  // Coming back on screen: refresh the budget, repaint everything once so a
  // stale canvas cannot survive a tab switch, and resume the loop.
  global.addEventListener('midi-studio:onscreen', function () {
    readAttrs();
    refreshEnv(true);
    invalidateAll();
  });
  document.addEventListener('visibilitychange', function () { refreshEnv(true); if (!document.hidden) invalidateAll(); });
  // focus/blur are also how a minimise and a restore are noticed (see
  // windowMinimized above): Windows fires them, and the window position is
  // already updated by the time they run. Coming back from a park, repaint
  // everything once, exactly as the onscreen handler does, so no canvas can
  // survive showing stale pixels.
  global.addEventListener('focus', function () {
    var wasHidden = env.hidden;
    refreshEnv(true);
    if (wasHidden && !env.hidden) invalidateAll();
  });
  global.addEventListener('blur', function () { refreshEnv(true); });
  global.addEventListener('midi-studio:theme', function () { invalidateAll(); });

  // data-drawms / data-onscreen / data-game are pushed onto this document's
  // <html> from outside, so watch the attributes rather than waiting to be told.
  if (typeof global.MutationObserver === 'function') {
    new global.MutationObserver(function () { refreshEnv(false); })
      .observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-drawms', 'data-onscreen', 'data-game', 'data-game-active', 'data-game-raised']
      });
  }

  // ----------------------------------------------------------- HiDPI canvas ---

  function dpr() {
    return Math.min(global.devicePixelRatio || 1, 2);
  }

  // Size a canvas for the current device pixel ratio.
  //
  // The backing store is reallocated ONLY when the pixel size actually changed:
  // assigning canvas.width or canvas.height reallocates AND clears the surface
  // even when the value is identical, and doing that per frame stalls playback.
  //
  // Returns { ctx, dpr, w, h, pxW, pxH, resized }. w/h are CSS pixels: draw in
  // CSS pixels and let the transform handle the ratio.
  function fitCanvas(canvas, cssW, cssH, opts) {
    opts = opts || {};
    var d = opts.dpr || dpr();
    var w = Math.max(1, Math.round(cssW));
    var h = Math.max(1, Math.round(cssH));
    var pxW = Math.max(1, Math.round(w * d));
    var pxH = Math.max(1, Math.round(h * d));

    var resized = false;
    if (canvas.width !== pxW || canvas.height !== pxH) {
      canvas.width = pxW;
      canvas.height = pxH;
      resized = true;
    }
    if (opts.style !== false && canvas.style) {
      var sw = w + 'px', sh = h + 'px';
      if (canvas.style.width !== sw) canvas.style.width = sw;
      if (canvas.style.height !== sh) canvas.style.height = sh;
    }

    var ctx = canvas.getContext('2d', opts.contextAttributes || undefined);
    // A resize resets the transform, and an unresized canvas may have been left
    // with someone else's. Restating it is cheap and does not clear anything.
    ctx.setTransform(d, 0, 0, d, 0, 0);
    return { ctx: ctx, dpr: d, w: w, h: h, pxW: pxW, pxH: pxH, resized: resized };
  }

  // CSS size of an element without touching offsetWidth (which forces layout on
  // read in the middle of a paint). Cache the result for a gesture.
  function measure(el) {
    var r = el.getBoundingClientRect();
    return { w: r.width, h: r.height, left: r.left, top: r.top };
  }

  // ------------------------------------------------------------ LayerCache ---

  // An offscreen canvas holding everything static in a view: the background,
  // the grid, the waveform peaks, the note bars, the onset ticks. The moving
  // parts (playhead, selection, active keys) are drawn on top of a blit.
  //
  // The cache is keyed by a caller-supplied version string plus the css size
  // and the dpr, so a data change, a zoom change, a resize, a dpr change or a
  // theme change all repaint it exactly once. Tokens.themeKey() is the right
  // thing to fold into version for anything painted with palette colours.
  function LayerCache(opts) {
    opts = opts || {};
    this.canvas = null;
    this.ctx = null;
    this._key = '';
    this.w = 0; this.h = 0; this.dpr = 0;
    this.repaints = 0;
    this._alpha = opts.alpha !== false;
    this._offscreen = opts.offscreen !== false;
  }

  LayerCache.prototype._alloc = function (pxW, pxH) {
    var made = false;
    if (!this.canvas) {
      if (this._offscreen && typeof global.OffscreenCanvas === 'function') {
        this.canvas = new global.OffscreenCanvas(pxW, pxH);
      } else {
        this.canvas = document.createElement('canvas');
        this.canvas.width = pxW; this.canvas.height = pxH;
      }
      made = true;
    } else if (this.canvas.width !== pxW || this.canvas.height !== pxH) {
      // Same rule as fitCanvas: only reallocate when the pixel size changed.
      this.canvas.width = pxW;
      this.canvas.height = pxH;
      made = true;
    }
    if (made || !this.ctx) this.ctx = this.canvas.getContext('2d', { alpha: this._alpha });
    return made;
  };

  // Paint the layer if (and only if) its key changed. paintFn(ctx, info) gets a
  // cleared surface already transformed into CSS pixels.
  // Returns { canvas, repainted }.
  LayerCache.prototype.paint = function (cssW, cssH, version, paintFn) {
    var d = dpr();
    var w = Math.max(1, Math.round(cssW));
    var h = Math.max(1, Math.round(cssH));
    var key = w + 'x' + h + '@' + d + '#' + String(version);
    if (key === this._key && this.canvas) return { canvas: this.canvas, repainted: false };

    this._alloc(Math.max(1, Math.round(w * d)), Math.max(1, Math.round(h * d)));
    var ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(d, 0, 0, d, 0, 0);

    this.w = w; this.h = h; this.dpr = d;
    if (typeof paintFn === 'function') paintFn(ctx, { w: w, h: h, dpr: d, version: version });
    this._key = key;
    this.repaints++;
    return { canvas: this.canvas, repainted: true };
  };

  // Blit onto a destination context that is already in CSS-pixel space.
  LayerCache.prototype.blit = function (ctx, x, y, w, h) {
    if (!this.canvas) return false;
    ctx.drawImage(this.canvas, x || 0, y || 0, w || this.w, h || this.h);
    return true;
  };

  LayerCache.prototype.isValid = function (cssW, cssH, version) {
    var d = dpr();
    var key = Math.max(1, Math.round(cssW)) + 'x' + Math.max(1, Math.round(cssH)) + '@' + d + '#' + String(version);
    return !!this.canvas && key === this._key;
  };

  LayerCache.prototype.invalidate = function () { this._key = ''; return this; };

  LayerCache.prototype.dispose = function () {
    // Zeroing the backing store is what actually frees the pixels.
    if (this.canvas) { this.canvas.width = 1; this.canvas.height = 1; }
    this.canvas = null; this.ctx = null; this._key = '';
  };

  // ------------------------------------------------------------------ boot ---

  readAttrs();
  reflectPark();
  budget = computeBudget();

  var API = {
    // scheduler
    register: register,
    invalidate: invalidate,
    invalidateAll: invalidateAll,
    frame: frame,
    budgetMs: budgetMs,
    onBudgetChange: onBudgetChange,
    setPlaybackActive: setPlaybackActive,
    setGameActive: setGameActive,
    setBaseMs: setBaseMs,
    setOnscreen: setOnscreen,
    isOnscreen: isOnscreen,
    isPlaybackActive: isPlaybackActive,
    isGameActive: isGameActive,
    refresh: function () { return refreshEnv(true); },
    stats: stats,
    now: now,
    // canvas
    fitCanvas: fitCanvas,
    measure: measure,
    dpr: dpr,
    LayerCache: LayerCache,
    // constants, exported so nothing re-guesses them
    GAME_RAISE: GAME_RAISE,
    UNFOCUSED_MS: UNFOCUSED_MS,
    PLAYBACK_FLOOR_MS: PLAYBACK_FLOOR_MS,
    IDLE_MS: IDLE_MS
  };

  global.Draw = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : window);

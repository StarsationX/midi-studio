// bus.js: cross-frame messaging, the transport owner registry and the command
// registry. Three things, one file, because all three are "exactly one of these
// exists per app" and they call each other.
//
// ---------------------------------------------------------------------------
// (a) Bus: cross-frame messaging
//
// The shell and its panels talk over postMessage. The old router looked at
// event.data.type and acted, with NO origin check and no idea who sent it: any
// frame could drive tab switching and file loading, and the whole payload object
// doubled as the arguments object. Everything is 'self' under the CSP today, so
// it is not exploitable today, which is exactly the kind of thing that stops
// being true quietly.
//
// So there is ONE envelope and every message is verified twice before it is
// acted on:
//
//     { ns: 'midi-studio', v: 1, kind: 'event'|'request'|'response',
//       type: '<from Bus.TYPES>', payload: {...}, id?: n, error?: s }
//
//   1. origin must be our own origin (file: pages serialise to an opaque
//      origin, so "null"/"" is accepted only when we are ourselves file:)
//   2. event.source must be a window we know: our parent/top, or an iframe we
//      explicitly trusted with Bus.trustFrame()
//
// Anything else is dropped silently. Payloads are still DATA, never code: a
// handler reads named fields, it never spreads the envelope into an argument
// list.
//
// ---------------------------------------------------------------------------
// (b) Transport: the single-owner registry
//
// The bottom transport is one document's chrome, but the thing that actually
// plays is in a panel: the Player's Python sidecar, Self MIDI's Web Audio
// synth, or the Editor's preview engine. Exactly ONE of them may own the
// transport at a time and the other two park. Two owners means two clocks and
// two Space handlers fighting over one keypress.
//
// ---------------------------------------------------------------------------
// (c) Commands: the registry behind Ctrl+K
//
// Every action registers {id, label, keywords, scope, enabled, run}. The
// palette, the key router and the context menus all read this one list, so a
// new action appears in all three or in none.
//
// Classic script (window.Bus / window.Transport / window.Commands) or ES-module
// side-effect import.
(function (global) {
  'use strict';

  var NS = 'midi-studio';
  var VERSION = 1;
  var doc = global.document;
  var loc = global.location;

  // postMessage needs '*' for a file: page, because the target origin of an
  // opaque origin cannot be named. The origin check on receive is what carries
  // the security here, not this.
  var TARGET_ORIGIN = (loc && loc.protocol === 'file:') ? '*' : (loc ? loc.origin : '*');

  // ==========================================================================
  // MESSAGE TYPES. The complete list. Nothing sends a type that is not here.
  // ==========================================================================
  var TYPES = {
    // -- navigation / hand-off (frame -> shell, shell -> frames) -------------
    NAV_ACTIVATE:       'nav:activate',        // {tab, focus?}
    NAV_ACTIVATED:      'nav:activated',       // {tab, previous}
    NAV_OPEN_FORGE:     'nav:open-forge',      // {inputPath?, url?}
    NAV_OPEN_EDITOR:    'nav:open-editor',     // {projectPath?, midiPath?}
    NAV_OPEN_PLAYER:    'nav:open-player',     // {midiPath?, play?}
    NAV_OPEN_SELFMIDI:  'nav:open-selfmidi',   // {midiPath?, play?}
    NAV_OPEN_LIBRARY:   'nav:open-library',    // {selectPath?, query?}
    NAV_OPEN_LOGS:      'nav:open-logs',       // {query?, source?, level?}

    // -- frame lifecycle -----------------------------------------------------
    FRAME_READY:        'frame:ready',         // {frame, title?}
    FRAME_ONSCREEN:     'frame:onscreen',      // {frame, on}
    FRAME_BUSY:         'frame:busy',          // {frame, busy, label?}

    // -- files / library -----------------------------------------------------
    FILE_OPEN:          'file:open',           // {path, kind, from?}
    FILE_DROPPED:       'file:dropped',        // {paths, kind, frame?}
    FILE_REVEAL:        'file:reveal',         // {path}
    LIBRARY_CHANGED:    'library:changed',     // {reason?}
    LIBRARY_SELECT:     'library:select',      // {path}

    // -- transport -----------------------------------------------------------
    TRANSPORT_CLAIM:    'transport:claim',     // {owner, caps}
    TRANSPORT_RELEASE:  'transport:release',   // {owner}
    TRANSPORT_OWNER:    'transport:owner',     // {owner, previous}
    TRANSPORT_PARK:     'transport:park',      // {owner}
    TRANSPORT_COMMAND:  'transport:command',   // {action, value?}
    TRANSPORT_STATE:    'transport:state',     // {owner, status, position, ...}
    TRANSPORT_QUERY:    'transport:query',     // {}

    // -- commands ------------------------------------------------------------
    COMMAND_PUBLISH:    'command:publish',     // {scope, commands:[descriptor]}
    COMMAND_WITHDRAW:   'command:withdraw',    // {scope, ids?}
    COMMAND_RUN:        'command:run',         // {id, arg?}
    COMMAND_RESULT:     'command:result',      // {id, ok, error?}

    // -- shell chrome / app-wide ---------------------------------------------
    UI_TOAST:           'ui:toast',            // {severity, title, message?, key?, timeout?}
    UI_STATUS:          'ui:status',           // {frame, text, severity?}
    UI_PALETTE:         'ui:palette',          // {open, query?}
    UI_SETTINGS:        'ui:settings',         // {open, pane?}
    UI_SHORTCUT:        'ui:shortcut',         // {id}
    UI_THEME:           'ui:theme',            // {theme, accent?}
    UI_DENSITY:         'ui:density',          // {density}
    UI_PERF:            'ui:perf',             // {drawMs, percent, gameActive, whenGaming}

    // -- main-process events, mirrored into every frame by the shell ---------
    ENGINE_EVENT:       'engine:event',        // {event, ...}
    ENGINE_ERROR:       'engine:error',        // {message}
    FORGE_STATUS:       'forge:status',        // {stage, percent, ...}
    GAME_ACTIVE:        'game:active',         // {name}
    UPDATE_STATUS:      'update:status',       // {state, percent?, version?, staged?}
    OVERLAY_STATE:      'overlay:state',       // {open, bounds?}

    // -- the activity log. The shell OWNS the ring buffer (it is the sink for
    // forge:status, engine:error, provisioning output and ui:status from every
    // frame, and it collects whether or not the Logs tab has ever been opened).
    // The Logs frame is a VIEW of it: it gets one full sync on frame:ready and
    // batched appends after that. Never one message per line -- a Forge run
    // emits hundreds of lines per stage.
    LOG_SYNC:           'log:sync',            // shell->logs {lines:[line], cap, seq}
    LOG_APPEND:         'log:append',          // shell->logs {lines:[line]}
    LOG_CLEAR:          'log:clear',           // logs->shell {} (shell answers with log:sync)

    // -- diagnostics ---------------------------------------------------------
    PING:               'bus:ping',            // {}
    PONG:               'bus:pong'             // {t}
  };

  // Legacy names the current shell already speaks. Accepted on receive and
  // rewritten to the new type, so a half-migrated app keeps working.
  var ALIASES = {
    'studio:open-player': TYPES.NAV_OPEN_PLAYER,
    'studio:open-audition': TYPES.NAV_OPEN_SELFMIDI,
    'studio:open-review': TYPES.NAV_OPEN_EDITOR
  };

  var VALID = Object.create(null);
  for (var tk in TYPES) VALID[TYPES[tk]] = true;

  // Types the host re-broadcasts to every other frame. These are the ones whose
  // audience is "everybody except whoever sent it".
  var RELAY = Object.create(null);
  [
    TYPES.TRANSPORT_STATE, TYPES.TRANSPORT_OWNER, TYPES.LIBRARY_CHANGED,
    TYPES.UI_THEME, TYPES.UI_DENSITY, TYPES.UI_PERF, TYPES.GAME_ACTIVE
  ].forEach(function (t) { RELAY[t] = true; });

  // ==========================================================================
  // (a) BUS
  // ==========================================================================
  var handlers = Object.create(null);     // type -> [fn]
  var responders = Object.create(null);   // type -> fn
  var trusted = [];                       // windows we accept messages from
  var pending = Object.create(null);      // request id -> {resolve, reject, timer}
  var reqSeq = 0;
  var relayInstalled = false;
  var isTop = (global.parent === global);

  function originOk(origin) {
    if (!loc) return false;
    if (origin === loc.origin) return true;
    // A file: document has an opaque origin: Chromium reports "null" (and, for
    // some frames, ""). Accept those ONLY when we are ourselves a file: page.
    if ((origin === 'null' || origin === '') && loc.protocol === 'file:') return true;
    return false;
  }

  function sourceOk(src) {
    if (!src) return false;
    if (src === global) return true;
    if (global.parent && global.parent !== global && src === global.parent) return true;
    if (global.top && global.top !== global && src === global.top) return true;
    for (var i = 0; i < trusted.length; i++) if (trusted[i] === src) return true;
    return false;
  }

  function trust(win) {
    if (!win) return function () {};
    if (trusted.indexOf(win) < 0) trusted.push(win);
    return function () { untrust(win); };
  }

  function untrust(win) {
    var i = trusted.indexOf(win);
    if (i >= 0) trusted.splice(i, 1);
  }

  // Trust an iframe's window, now and after every navigation of that frame.
  function trustFrame(iframe) {
    if (!iframe) return function () {};
    var attach = function () { if (iframe.contentWindow) trust(iframe.contentWindow); };
    attach();
    iframe.addEventListener('load', attach);
    return function () {
      iframe.removeEventListener('load', attach);
      if (iframe.contentWindow) untrust(iframe.contentWindow);
    };
  }

  function frames() { return trusted.slice(); }

  function envelope(kind, type, payload, id, error) {
    var e = { ns: NS, v: VERSION, kind: kind, type: type, payload: payload === undefined ? {} : payload };
    if (id !== undefined) e.id = id;
    if (error !== undefined) e.error = error;
    return e;
  }

  function postTo(win, env) {
    if (!win || win === global) return false;
    try { win.postMessage(env, TARGET_ORIGIN); return true; } catch (e) { return false; }
  }

  // Resolve a target spec into a list of windows.
  //   'parent'  the shell (default inside a panel)
  //   'frames'  every trusted frame (default in the shell)
  //   'all'     parent + frames
  //   an <iframe>, or a Window
  function targets(to) {
    var out = [];
    if (!to) to = isTop ? 'frames' : 'parent';
    if (to === 'parent' || to === 'shell') {
      if (global.parent && global.parent !== global) out.push(global.parent);
    } else if (to === 'frames') {
      out = trusted.slice();
    } else if (to === 'all') {
      if (global.parent && global.parent !== global) out.push(global.parent);
      out = out.concat(trusted);
    } else if (to && to.contentWindow) {
      out.push(to.contentWindow);
    } else if (to && typeof to.postMessage === 'function') {
      out.push(to);
    }
    return out;
  }

  function fire(type, payload, meta) {
    var list = handlers[type];
    if (!list || !list.length) return 0;
    var copy = list.slice();
    for (var i = 0; i < copy.length; i++) {
      try { copy[i](payload, meta); } catch (e) {
        if (global.console && console.error) console.error('[bus] handler for ' + type, e);
      }
    }
    return copy.length;
  }

  // Send an event. Also delivers to this document's own handlers when
  // opts.local is true, which is how the shell reacts to its own broadcasts.
  function send(type, payload, opts) {
    opts = opts || {};
    if (!VALID[type]) {
      if (global.console && console.warn) console.warn('[bus] unknown type ' + type);
      return 0;
    }
    var env = envelope('event', type, payload);
    var wins = targets(opts.to);
    var n = 0;
    for (var i = 0; i < wins.length; i++) if (postTo(wins[i], env)) n++;
    if (opts.local) fire(type, env.payload, { type: type, local: true, source: global, origin: loc ? loc.origin : '' });
    return n;
  }

  function on(type, handler) {
    if (typeof handler !== 'function') return function () {};
    if (!handlers[type]) handlers[type] = [];
    handlers[type].push(handler);
    return function () {
      var l = handlers[type];
      if (!l) return;
      var i = l.indexOf(handler);
      if (i >= 0) l.splice(i, 1);
    };
  }

  function once(type, handler) {
    var off = on(type, function (p, m) { off(); handler(p, m); });
    return off;
  }

  // Register the one handler that answers requests of this type.
  function respond(type, handler) {
    responders[type] = handler;
    return function () { if (responders[type] === handler) delete responders[type]; };
  }

  // Ask one window for an answer. Resolves with the responder's return value.
  function request(type, payload, opts) {
    opts = opts || {};
    var timeout = opts.timeout === undefined ? 5000 : opts.timeout;
    var wins = targets(opts.to);
    if (!wins.length) return Promise.reject(new Error('bus: no target for ' + type));
    var id = ++reqSeq;
    var env = envelope('request', type, payload, id);
    return new Promise(function (resolve, reject) {
      var rec = {
        resolve: resolve, reject: reject,
        timer: global.setTimeout(function () {
          delete pending[id];
          reject(new Error('bus: timeout waiting for ' + type));
        }, timeout)
      };
      pending[id] = rec;
      if (!postTo(wins[0], env)) {
        global.clearTimeout(rec.timer);
        delete pending[id];
        reject(new Error('bus: could not post ' + type));
      }
    });
  }

  function handleRequest(env, src) {
    var fn = responders[env.type];
    var reply = function (payload, error) {
      postTo(src, envelope('response', env.type, payload, env.id, error));
    };
    if (typeof fn !== 'function') { reply(undefined, 'no responder for ' + env.type); return; }
    var out;
    try { out = fn(env.payload, { type: env.type, source: src, request: true }); }
    catch (e) { reply(undefined, String(e && e.message || e)); return; }
    if (out && typeof out.then === 'function') {
      out.then(function (v) { reply(v); }, function (e) { reply(undefined, String(e && e.message || e)); });
    } else {
      reply(out);
    }
  }

  function handleResponse(env) {
    var rec = pending[env.id];
    if (!rec) return;
    delete pending[env.id];
    global.clearTimeout(rec.timer);
    if (env.error) rec.reject(new Error(env.error));
    else rec.resolve(env.payload);
  }

  function onMessage(ev) {
    var d = ev.data;
    if (!d || typeof d !== 'object' || d.ns !== NS) return;   // not ours
    if (!originOk(ev.origin)) return;                          // check 1
    if (!sourceOk(ev.source)) return;                          // check 2

    var type = ALIASES[d.type] || d.type;
    if (!VALID[type]) return;

    if (d.kind === 'response') { handleResponse({ id: d.id, type: type, payload: d.payload, error: d.error }); return; }
    if (d.kind === 'request') { handleRequest({ type: type, payload: d.payload, id: d.id }, ev.source); return; }

    var meta = {
      type: type,
      source: ev.source,
      origin: ev.origin,
      local: false,
      reply: function (payload) { postTo(ev.source, envelope('event', type, payload)); }
    };
    fire(type, d.payload || {}, meta);

    // The host forwards the shared-state types on to every other frame, so a
    // panel does not have to know how many other panels exist.
    if (relayInstalled && RELAY[type]) {
      var env = envelope('event', type, d.payload || {});
      for (var i = 0; i < trusted.length; i++) {
        if (trusted[i] !== ev.source) postTo(trusted[i], env);
      }
    }
  }

  global.addEventListener('message', onMessage);

  function installRelay() { relayInstalled = true; }

  respond(TYPES.PING, function () { return { t: Date.now() }; });

  var Bus = {
    NS: NS,
    TYPES: TYPES,
    ALIASES: ALIASES,
    RELAY: RELAY,
    send: send,
    on: on,
    once: once,
    request: request,
    respond: respond,
    trust: trust,
    untrust: untrust,
    trustFrame: trustFrame,
    frames: frames,
    installRelay: installRelay,
    isTop: function () { return isTop; },
    targetOrigin: TARGET_ORIGIN
  };

  // ==========================================================================
  // (b) TRANSPORT: single-owner registry
  // ==========================================================================
  var STATUS = {
    IDLE: 'idle',
    PLAYING: 'playing',
    PAUSED: 'paused',
    BLOCKED: 'blocked',     // cannot play: no engine, no file, env not ready
    COUNTING: 'counting'    // count-in / lead-in before notes start
  };
  var OWNERS = ['player', 'selfmidi', 'editor'];
  var ACTIONS = ['play', 'pause', 'stop', 'toggle', 'seek', 'rate', 'loop', 'next', 'prev'];

  var tState = {
    owner: null,
    status: STATUS.IDLE,
    position: 0,
    duration: 0,
    rate: 1,
    loop: null,        // {a, b} in seconds, or null
    label: '',         // what is loaded, for the transport readout
    dirty: false,      // the Editor's unsaved marker
    caps: {}           // {seek:true, rate:true, loop:true, queue:false}
  };
  var tListeners = [];
  var localImpl = null;      // the impl claimed in THIS document
  var localOwner = null;
  var isHost = false;        // this document holds the registry (the shell)
  var ownerWin = null;       // which frame owns it, when we are the host

  function tNotify() {
    var snap = tSnapshot();
    for (var i = 0; i < tListeners.length; i++) {
      try { tListeners[i](snap); } catch (e) { /* keep going */ }
    }
  }

  function tSnapshot() {
    return {
      owner: tState.owner, status: tState.status,
      position: tState.position, duration: tState.duration,
      rate: tState.rate, loop: tState.loop ? { a: tState.loop.a, b: tState.loop.b } : null,
      label: tState.label, dirty: tState.dirty, caps: tState.caps
    };
  }

  // The playback floor lives in draw.js and is driven from exactly here, so no
  // panel has to remember to raise its own frame rate while notes are moving.
  function syncDrawFloor() {
    if (!global.Draw || typeof global.Draw.setPlaybackActive !== 'function') return;
    var live = tState.status === STATUS.PLAYING || tState.status === STATUS.COUNTING;
    global.Draw.setPlaybackActive(live);
  }

  function applyState(patch, fromBus) {
    if (!patch) return;
    if (patch.owner !== undefined) tState.owner = patch.owner;
    if (patch.status !== undefined) tState.status = patch.status;
    if (patch.position !== undefined) tState.position = Number(patch.position) || 0;
    if (patch.duration !== undefined) tState.duration = Number(patch.duration) || 0;
    if (patch.rate !== undefined) tState.rate = Number(patch.rate) || 1;
    if (patch.loop !== undefined) tState.loop = patch.loop ? { a: +patch.loop.a, b: +patch.loop.b } : null;
    if (patch.label !== undefined) tState.label = String(patch.label);
    if (patch.dirty !== undefined) tState.dirty = !!patch.dirty;
    if (patch.caps !== undefined) tState.caps = patch.caps || {};
    syncDrawFloor();
    tNotify();
    // A local owner's update has to reach everybody else.
    if (!fromBus && localOwner && tState.owner === localOwner) {
      var msg = tSnapshot();
      if (isHost) {
        Bus.send(TYPES.TRANSPORT_STATE, msg, { to: 'frames' });
      } else {
        Bus.send(TYPES.TRANSPORT_STATE, msg, { to: 'parent' });
      }
    }
  }

  function becomeHost() {
    isHost = true;
    Bus.installRelay();

    Bus.on(TYPES.TRANSPORT_CLAIM, function (p, meta) {
      if (!p || OWNERS.indexOf(p.owner) < 0) return;
      setOwner(p.owner, meta.source, p.caps || {});
    });
    Bus.on(TYPES.TRANSPORT_RELEASE, function (p) {
      if (!p || p.owner !== tState.owner) return;
      setOwner(null, null, {});
    });
    // TRANSPORT_STATE is handled by the one module-level listener below (which
    // already drops reports from anyone but the current owner) and forwarded to
    // the other frames by the relay. Registering a second handler here would
    // apply every packet twice and notify every listener twice.
    Bus.on(TYPES.TRANSPORT_COMMAND, function (p) {
      if (!p || ACTIONS.indexOf(p.action) < 0) return;
      routeCommand(p.action, p.value);
    });
    Bus.respond(TYPES.TRANSPORT_QUERY, function () { return tSnapshot(); });
    return Transport;
  }

  function setOwner(owner, win, caps) {
    var prev = tState.owner, prevWin = ownerWin;
    if (prev === owner) { ownerWin = win || ownerWin; tState.caps = caps || tState.caps; tNotify(); return; }

    // Park the outgoing owner. It must stop its clock and let go of Space.
    if (prev) {
      if (prevWin) Bus.send(TYPES.TRANSPORT_PARK, { owner: prev }, { to: prevWin });
      else if (localImpl && localOwner === prev && typeof localImpl.park === 'function') {
        try { localImpl.park(); } catch (e) {}
      }
    }

    tState.owner = owner;
    ownerWin = win || null;
    tState.caps = caps || {};
    tState.status = STATUS.IDLE;
    tState.position = 0;
    syncDrawFloor();
    Bus.send(TYPES.TRANSPORT_OWNER, { owner: owner, previous: prev }, { to: 'frames' });
    tNotify();
  }

  function routeCommand(action, value) {
    // Host side: run it on whoever owns the transport.
    if (!tState.owner) return false;
    if (localOwner && localOwner === tState.owner && localImpl) return invokeLocal(action, value);
    if (ownerWin) { Bus.send(TYPES.TRANSPORT_COMMAND, { action: action, value: value }, { to: ownerWin }); return true; }
    return false;
  }

  function invokeLocal(action, value) {
    if (!localImpl) return false;
    try {
      switch (action) {
        case 'play': if (localImpl.play) localImpl.play(); break;
        case 'pause': if (localImpl.pause) localImpl.pause(); break;
        case 'stop': if (localImpl.stop) localImpl.stop(); break;
        case 'toggle':
          if (localImpl.toggle) localImpl.toggle();
          else if (tState.status === STATUS.PLAYING) { if (localImpl.pause) localImpl.pause(); }
          else if (localImpl.play) localImpl.play();
          break;
        case 'seek': if (localImpl.seek) localImpl.seek(Number(value) || 0); break;
        case 'rate': if (localImpl.rate) localImpl.rate(Number(value) || 1); break;
        case 'loop': if (localImpl.setLoop) localImpl.setLoop(value || null); break;
        case 'next': if (localImpl.next) localImpl.next(); break;
        case 'prev': if (localImpl.prev) localImpl.prev(); break;
        default: return false;
      }
    } catch (e) {
      if (global.console && console.error) console.error('[transport] ' + action, e);
      return false;
    }
    return true;
  }

  // Claim the transport. Returns a handle; the previous owner is parked.
  //
  //   const t = Transport.claim('player', {
  //     play(){}, pause(){}, stop(){}, seek(s){}, rate(r){}, setLoop(l){},
  //     position(){ return elapsed; }, park(){ stopClockAndDropSpace(); }
  //   });
  //   t.update({ status: Transport.STATUS.PLAYING, position: 3.2, duration: 214 });
  //
  function claim(owner, impl, caps) {
    if (OWNERS.indexOf(owner) < 0) throw new Error('Transport.claim: unknown owner ' + owner);
    localOwner = owner;
    localImpl = impl || null;
    if (isHost) {
      setOwner(owner, null, caps || {});
    } else {
      Bus.send(TYPES.TRANSPORT_CLAIM, { owner: owner, caps: caps || {} }, { to: 'parent' });
      tState.owner = owner;
      tState.caps = caps || {};
      tNotify();
    }

    var handle = {
      owner: owner,
      update: function (patch) {
        if (!patch) return handle;
        patch = Object.assign({}, patch);
        patch.owner = owner;
        applyState(patch, false);
        return handle;
      },
      status: function (status, extra) {
        var p = Object.assign({}, extra || {});
        p.status = status;
        return handle.update(p);
      },
      release: function () {
        if (isHost) setOwner(null, null, {});
        else Bus.send(TYPES.TRANSPORT_RELEASE, { owner: owner }, { to: 'parent' });
        if (localOwner === owner) { localOwner = null; localImpl = null; }
        return handle;
      },
      isOwner: function () { return tState.owner === owner; }
    };
    return handle;
  }

  // Drive the transport from anywhere: the bottom bar, a hotkey, the palette.
  function command(action, value) {
    if (ACTIONS.indexOf(action) < 0) return false;
    if (isHost) return routeCommand(action, value);
    if (localOwner && tState.owner === localOwner) return invokeLocal(action, value);
    return Bus.send(TYPES.TRANSPORT_COMMAND, { action: action, value: value }, { to: 'parent' }) > 0;
  }

  // Panels listen for these two whether or not they are the owner.
  Bus.on(TYPES.TRANSPORT_OWNER, function (p) {
    if (!p) return;
    tState.owner = p.owner || null;
    if (localOwner && p.owner !== localOwner && localImpl && typeof localImpl.park === 'function') {
      try { localImpl.park(); } catch (e) {}
    }
    tNotify();
  });
  Bus.on(TYPES.TRANSPORT_PARK, function (p) {
    if (!p || (localOwner && p.owner !== localOwner)) return;
    if (localImpl && typeof localImpl.park === 'function') {
      try { localImpl.park(); } catch (e) {}
    }
    tNotify();
  });
  Bus.on(TYPES.TRANSPORT_STATE, function (p) {
    if (!p) return;
    if (localOwner && p.owner === localOwner) return;   // our own echo
    // Only the current owner may report state. Without this a parked panel that
    // is still winding down could keep writing position into the transport that
    // now belongs to somebody else: two clocks again, by the back door.
    if (p.owner !== tState.owner) return;
    applyState(p, true);
  });
  Bus.on(TYPES.TRANSPORT_COMMAND, function (p) {
    if (!p || !localImpl) return;
    if (localOwner && tState.owner !== localOwner) return;
    invokeLocal(p.action, p.value);
  });

  var Transport = {
    STATUS: STATUS,
    OWNERS: OWNERS,
    ACTIONS: ACTIONS,
    host: becomeHost,
    claim: claim,
    release: function (owner) {
      if (owner && tState.owner !== owner) return false;
      if (isHost) setOwner(null, null, {});
      else Bus.send(TYPES.TRANSPORT_RELEASE, { owner: owner || localOwner }, { to: 'parent' });
      if (!owner || localOwner === owner) { localOwner = null; localImpl = null; }
      return true;
    },
    owner: function () { return tState.owner; },
    isOwner: function (o) { return tState.owner === o; },
    state: tSnapshot,
    status: function () { return tState.status; },
    position: function () {
      if (localOwner && tState.owner === localOwner && localImpl && localImpl.position) {
        try { return Number(localImpl.position()) || 0; } catch (e) { return tState.position; }
      }
      return tState.position;
    },
    duration: function () { return tState.duration; },
    onChange: function (fn) {
      if (typeof fn !== 'function') return function () {};
      tListeners.push(fn);
      return function () {
        var i = tListeners.indexOf(fn);
        if (i >= 0) tListeners.splice(i, 1);
      };
    },
    command: command,
    play: function () { return command('play'); },
    pause: function () { return command('pause'); },
    stop: function () { return command('stop'); },
    toggle: function () { return command('toggle'); },
    seek: function (s) { return command('seek', s); },
    rate: function (r) { return command('rate', r); },
    setLoop: function (l) { return command('loop', l); },
    next: function () { return command('next'); },
    prev: function () { return command('prev'); },
    // Ask the host for the current state, for a panel that just loaded.
    sync: function () {
      return Bus.request(TYPES.TRANSPORT_QUERY, {}, { to: 'parent', timeout: 1500 })
        .then(function (s) { applyState(s, true); return tSnapshot(); })
        .catch(function () { return tSnapshot(); });
    }
  };

  // ==========================================================================
  // (c) COMMANDS: one registry for the palette, the keys and the menus
  // ==========================================================================
  var cmds = Object.create(null);      // id -> descriptor (local, has run())
  var remote = Object.create(null);    // id -> descriptor (from another frame)
  var cListeners = [];
  var cScope = 'global';
  var publishTimer = 0;
  var cHost = false;

  function cNotify() {
    for (var i = 0; i < cListeners.length; i++) {
      try { cListeners[i](); } catch (e) { /* keep going */ }
    }
  }

  function normalise(d) {
    if (!d || !d.id || !d.label) throw new Error('Commands.register needs {id, label, run}');
    return {
      id: String(d.id),
      label: String(d.label),
      keywords: Array.isArray(d.keywords) ? d.keywords.slice() : (d.keywords ? String(d.keywords).split(/\s+/) : []),
      scope: d.scope || cScope || 'global',
      group: d.group || '',
      keys: d.keys || '',
      danger: !!d.danger,
      enabled: d.enabled === undefined ? true : d.enabled,
      run: typeof d.run === 'function' ? d.run : null,
      remote: false
    };
  }

  function isEnabled(d) {
    if (!d) return false;
    if (typeof d.enabled === 'function') {
      try { return !!d.enabled(); } catch (e) { return false; }
    }
    return d.enabled !== false;
  }

  function schedulePublish() {
    if (cHost || Bus.isTop()) return;     // the host does not publish to itself
    if (publishTimer) return;
    publishTimer = global.setTimeout(function () {
      publishTimer = 0;
      publish();
    }, 60);
  }

  // Send the serialisable shape of every local command to the host. Functions
  // cannot cross a postMessage boundary, so `enabled` collapses to a boolean and
  // `run` becomes a command:run round trip.
  function publish() {
    var list = [];
    for (var id in cmds) {
      var d = cmds[id];
      list.push({
        id: d.id, label: d.label, keywords: d.keywords, scope: d.scope,
        group: d.group, keys: d.keys, danger: d.danger, enabled: isEnabled(d)
      });
    }
    Bus.send(TYPES.COMMAND_PUBLISH, { scope: cScope, commands: list }, { to: 'parent' });
    return list.length;
  }

  function register(desc) {
    var d = normalise(desc);
    cmds[d.id] = d;
    schedulePublish();
    cNotify();
    return function () { unregister(d.id); };
  }

  function registerAll(list) {
    var offs = [];
    for (var i = 0; i < (list || []).length; i++) offs.push(register(list[i]));
    return function () { for (var j = 0; j < offs.length; j++) offs[j](); };
  }

  function unregister(id) {
    if (!cmds[id]) return false;
    delete cmds[id];
    Bus.send(TYPES.COMMAND_WITHDRAW, { scope: cScope, ids: [id] }, { to: 'parent' });
    cNotify();
    return true;
  }

  function get(id) { return cmds[id] || remote[id] || null; }

  // Every command visible from here: local first, then the ones other frames
  // published. opts.scope filters to 'global' + that scope.
  function list(opts) {
    opts = opts || {};
    var out = [], id;
    for (id in cmds) out.push(cmds[id]);
    for (id in remote) if (!cmds[id]) out.push(remote[id]);
    if (opts.scope) {
      out = out.filter(function (d) { return d.scope === 'global' || d.scope === opts.scope; });
    }
    if (opts.enabledOnly) out = out.filter(isEnabled);
    out.sort(function (a, b) {
      if (a.group !== b.group) return a.group < b.group ? -1 : 1;
      return a.label < b.label ? -1 : (a.label > b.label ? 1 : 0);
    });
    return out;
  }

  // Multi-term AND match over label, keywords, group and id. Pure: the caller
  // owns the debounce.
  function search(q, opts) {
    opts = opts || {};
    var all = list(opts);
    var query = String(q || '').trim().toLowerCase();
    if (!query) return all.slice(0, opts.limit || 50);
    var terms = query.split(/\s+/);
    var scored = [];
    for (var i = 0; i < all.length; i++) {
      var d = all[i];
      var hay = (d.label + ' ' + d.keywords.join(' ') + ' ' + d.group + ' ' + d.id).toLowerCase();
      var ok = true, score = 0;
      for (var t = 0; t < terms.length; t++) {
        var at = hay.indexOf(terms[t]);
        if (at < 0) { ok = false; break; }
        // A hit at the start of the label is worth more than one buried in an id.
        score += (d.label.toLowerCase().indexOf(terms[t]) === 0) ? 3 : (at === 0 ? 2 : 1);
      }
      if (ok) scored.push({ d: d, s: score });
    }
    scored.sort(function (a, b) { return b.s - a.s; });
    var out = [];
    for (var j = 0; j < scored.length && j < (opts.limit || 50); j++) out.push(scored[j].d);
    return out;
  }

  // Run a command by id. A local command runs here; a remote one is dispatched
  // to the frame that published it (fire and forget: the palette closes either
  // way, and the frame reports failure through a toast).
  function run(id, arg) {
    var d = cmds[id];
    if (d && d.run) {
      if (!isEnabled(d)) return Promise.resolve({ ok: false, error: 'disabled' });
      try {
        var out = d.run(arg);
        return (out && typeof out.then === 'function')
          ? out.then(function (v) { return { ok: true, value: v }; },
                     function (e) { return { ok: false, error: String(e && e.message || e) }; })
          : Promise.resolve({ ok: true, value: out });
      } catch (e) {
        return Promise.resolve({ ok: false, error: String(e && e.message || e) });
      }
    }
    var r = remote[id];
    if (r) {
      Bus.send(TYPES.COMMAND_RUN, { id: id, arg: arg === undefined ? null : arg },
        { to: r.win || (Bus.isTop() ? 'frames' : 'parent') });
      return Promise.resolve({ ok: true, dispatched: true });
    }
    return Promise.resolve({ ok: false, error: 'unknown command ' + id });
  }

  function onChange(fn) {
    if (typeof fn !== 'function') return function () {};
    cListeners.push(fn);
    return function () {
      var i = cListeners.indexOf(fn);
      if (i >= 0) cListeners.splice(i, 1);
    };
  }

  // The scope new commands default to, and what the palette filters against.
  // A panel calls this once at boot with its own frame key.
  function setScope(scope) {
    cScope = scope || 'global';
    schedulePublish();
    return cScope;
  }

  // The shell collects what the panels publish so the palette can list them.
  function commandsHost() {
    cHost = true;
    Bus.on(TYPES.COMMAND_PUBLISH, function (p, meta) {
      if (!p || !Array.isArray(p.commands)) return;
      var scope = p.scope || 'global';
      // Replace this scope's published set wholesale: a panel always publishes
      // everything it has, so anything missing has genuinely gone away.
      for (var id in remote) if (remote[id].fromScope === scope) delete remote[id];
      for (var i = 0; i < p.commands.length; i++) {
        var d = p.commands[i];
        if (!d || !d.id || !d.label) continue;
        remote[d.id] = {
          id: String(d.id), label: String(d.label),
          keywords: Array.isArray(d.keywords) ? d.keywords : [],
          scope: d.scope || scope, group: d.group || '', keys: d.keys || '',
          danger: !!d.danger, enabled: d.enabled !== false,
          run: null, remote: true, fromScope: scope, win: meta && meta.source
        };
      }
      cNotify();
    });
    Bus.on(TYPES.COMMAND_WITHDRAW, function (p) {
      if (!p) return;
      var ids = Array.isArray(p.ids) ? p.ids : null;
      if (ids) { for (var i = 0; i < ids.length; i++) delete remote[ids[i]]; }
      else if (p.scope) { for (var id in remote) if (remote[id].fromScope === p.scope) delete remote[id]; }
      cNotify();
    });
    return Commands;
  }

  // A panel runs the commands the host dispatches back to it.
  Bus.on(TYPES.COMMAND_RUN, function (p) {
    if (!p || !p.id || !cmds[p.id]) return;
    run(p.id, p.arg === null ? undefined : p.arg).then(function (r) {
      if (!r.ok) Bus.send(TYPES.COMMAND_RESULT, { id: p.id, ok: false, error: r.error }, { to: 'parent' });
    });
  });

  var Commands = {
    register: register,
    registerAll: registerAll,
    unregister: unregister,
    get: get,
    list: list,
    search: search,
    run: run,
    isEnabled: isEnabled,
    onChange: onChange,
    setScope: setScope,
    scope: function () { return cScope; },
    publish: publish,
    host: commandsHost
  };

  global.Bus = Bus;
  global.Transport = Transport;
  global.Commands = Commands;
  var API = { Bus: Bus, Transport: Transport, Commands: Commands };
  global.MidiBus = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : window);

// overlay.js: "Perch", the always-on-top playback overlay.
//
// Playing into a game means the game is fullscreen and MIDI Studio is behind
// it, so the piano roll, the clock and the reason playback stopped are all
// invisible exactly when they matter. Perch is a small frameless window that
// sits above the game and shows them.
//
// It is a second BrowserWindow, not a second app: it receives the same
// engine-event stream the Player tab does, so there is one source of truth for
// what is playing and no separate clock to drift.
'use strict';

const path = require('path');
const { BrowserWindow, screen } = require('electron');

// Per mode, so switching modes does not squeeze the roll into a strip meant for
// the clock. Width is remembered per mode too, in bounds.<mode>.
const MODE_SIZE = {
  full: { width: 460, height: 300, minWidth: 260, minHeight: 170 },
  slim: { width: 420, height: 96, minWidth: 240, minHeight: 72 },
  mini: { width: 168, height: 64, minWidth: 120, minHeight: 52 },
};

const DEFAULTS = {
  mode: 'full',
  opacity: 0.92,
  clickThrough: false,
  locked: false,
  autoShow: true,       // appear when playback starts
  autoHide: true,       // and step aside when it ends
  lookahead: 3,         // seconds of music visible
  showKeys: true,
  showTransport: true,
  bounds: {},
};

class Overlay {
  constructor({ settings, indexHtml, preload, onLog }) {
    this.settings = settings;
    this.indexHtml = indexHtml;
    this.preload = preload;
    this.log = onLog || (() => {});
    this.win = null;
    this.pending = [];    // events that arrived before the page was ready
    this.ready = false;
  }

  config() {
    const raw = (this.settings.get('overlay') || {});
    const cfg = { ...DEFAULTS, ...raw };
    if (!MODE_SIZE[cfg.mode]) cfg.mode = 'full';
    cfg.opacity = Math.max(0.2, Math.min(1, Number(cfg.opacity) || DEFAULTS.opacity));
    cfg.lookahead = Math.max(1, Math.min(12, Number(cfg.lookahead) || DEFAULTS.lookahead));
    cfg.bounds = cfg.bounds && typeof cfg.bounds === 'object' ? cfg.bounds : {};
    return cfg;
  }

  save(patch) {
    const next = { ...this.config(), ...patch };
    this.settings.merge({ overlay: next });
    return next;
  }

  isOpen() { return !!(this.win && !this.win.isDestroyed()); }

  // Where to open. A remembered position on a monitor that is no longer
  // plugged in leaves the window off-screen with no way to grab it, so any
  // saved rectangle has to be checked against the displays that exist now.
  _placement(cfg) {
    const size = MODE_SIZE[cfg.mode];
    const saved = cfg.bounds[cfg.mode] || {};
    const width = Math.max(size.minWidth, Math.round(Number(saved.width) || size.width));
    const height = Math.max(size.minHeight, Math.round(Number(saved.height) || size.height));
    const hasPos = Number.isFinite(Number(saved.x)) && Number.isFinite(Number(saved.y));
    if (!hasPos) {
      // No saved spot: top-right of the primary display, clear of the corner.
      const area = screen.getPrimaryDisplay().workArea;
      return { x: area.x + area.width - width - 24, y: area.y + 24, width, height };
    }
    const x = Math.round(Number(saved.x));
    const y = Math.round(Number(saved.y));
    const onScreen = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      // Any decent overlap counts; requiring the whole window to fit would
      // reject a deliberate hang off the edge of the screen.
      return x + width > a.x + 40 && x < a.x + a.width - 40
        && y + height > a.y && y < a.y + a.height - 40;
    });
    if (!onScreen) {
      const area = screen.getPrimaryDisplay().workArea;
      return { x: area.x + area.width - width - 24, y: area.y + 24, width, height };
    }
    return { x, y, width, height };
  }

  open() {
    if (this.isOpen()) { this.win.showInactive(); return this.win; }
    const cfg = this.config();
    const size = MODE_SIZE[cfg.mode];
    const place = this._placement(cfg);

    this.ready = false;
    this.pending = [];
    this.win = new BrowserWindow({
      ...place,
      minWidth: size.minWidth, minHeight: size.minHeight,
      frame: false, transparent: true, hasShadow: false,
      resizable: !cfg.locked, movable: !cfg.locked,
      skipTaskbar: true, show: false, fullscreenable: false,
      // 'screen-saver' is the level that stays above a borderless-fullscreen
      // game. Plain alwaysOnTop loses to one.
      alwaysOnTop: true,
      backgroundColor: '#00000000',
      title: 'Perch',
      webPreferences: {
        preload: this.preload,
        contextIsolation: true, nodeIntegration: false, sandbox: false,
        backgroundThrottling: false,
      },
    });
    this.win.setAlwaysOnTop(true, 'screen-saver');
    // Follow the game onto every virtual desktop; an overlay that vanishes
    // when you switch desktops is worse than no overlay.
    try { this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (_) {}
    this.win.setIgnoreMouseEvents(!!cfg.clickThrough, { forward: true });

    this.win.loadFile(this.indexHtml);
    this.win.once('ready-to-show', () => {
      // showInactive, not show: taking focus off the game mid-song would pause
      // playback, which is the exact problem this window exists to explain.
      this.win.showInactive();
      this.win.setOpacity(cfg.opacity);
    });

    const remember = () => {
      if (!this.isOpen()) return;
      const b = this.win.getBounds();
      const c = this.config();
      this.save({ bounds: { ...c.bounds, [c.mode]: b } });
    };
    let saveTimer = null;
    const rememberSoon = () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(remember, 400);   // dragging fires this constantly
    };
    this.win.on('move', rememberSoon);
    this.win.on('resize', rememberSoon);
    this.win.on('closed', () => {
      clearTimeout(saveTimer);
      this.win = null;
      this.ready = false;
      this.pending = [];
    });
    return this.win;
  }

  close() {
    if (!this.isOpen()) return;
    try {
      const b = this.win.getBounds();
      const c = this.config();
      this.save({ bounds: { ...c.bounds, [c.mode]: b } });
    } catch (_) {}
    this.win.destroy();
    this.win = null;
  }

  toggle() {
    if (this.isOpen()) this.close(); else this.open();
    return this.isOpen();
  }

  // The renderer says it has loaded; flush anything that happened first (a
  // midi_loaded replay, most importantly) so the roll is not empty.
  markReady() {
    this.ready = true;
    const queued = this.pending;
    this.pending = [];
    // Its saved settings first. The page boots on the markup's defaults, so
    // without this a user who chose Mini at 40% opacity reopens it at Full.
    this.send('overlay-config', this.config());
    for (const [channel, payload] of queued) this.send(channel, payload);
  }

  send(channel, payload) {
    if (!this.isOpen()) return;
    if (!this.ready) { this.pending.push([channel, payload]); return; }
    try { this.win.webContents.send(channel, payload); } catch (_) {}
  }

  setClickThrough(on) {
    const cfg = this.save({ clickThrough: !!on });
    if (this.isOpen()) this.win.setIgnoreMouseEvents(!!on, { forward: true });
    this.send('overlay-config', cfg);
    return cfg;
  }

  setOpacity(value) {
    const cfg = this.save({ opacity: Math.max(0.2, Math.min(1, Number(value) || 1)) });
    if (this.isOpen()) this.win.setOpacity(cfg.opacity);
    return cfg;
  }

  setLocked(on) {
    const cfg = this.save({ locked: !!on });
    if (this.isOpen()) {
      this.win.setResizable(!cfg.locked);
      this.win.setMovable(!cfg.locked);
    }
    this.send('overlay-config', cfg);
    return cfg;
  }

  setMode(mode) {
    if (!MODE_SIZE[mode]) return this.config();
    if (this.isOpen()) {
      // Remember the size of the mode being left before resizing, or the modes
      // slowly overwrite each other's remembered dimensions.
      const before = this.config();
      this.save({ bounds: { ...before.bounds, [before.mode]: this.win.getBounds() } });
    }
    const cfg = this.save({ mode });
    if (this.isOpen()) {
      const size = MODE_SIZE[mode];
      const place = this._placement(cfg);
      this.win.setMinimumSize(size.minWidth, size.minHeight);
      this.win.setBounds(place);
    }
    this.send('overlay-config', cfg);
    return cfg;
  }

  // Park in one of the nine screen positions. Dragging a window into an exact
  // corner by hand is fiddly; this is the same job in one click.
  snap(where) {
    if (!this.isOpen()) return this.config();
    const b = this.win.getBounds();
    const area = screen.getDisplayMatching(b).workArea;
    const pad = 24;
    const parts = String(where || '').split('-');
    const vert = parts[0] || 'top';
    const horiz = parts[1] || 'right';
    const x = horiz === 'left' ? area.x + pad
      : horiz === 'center' ? area.x + Math.round((area.width - b.width) / 2)
        : area.x + area.width - b.width - pad;
    const y = vert === 'top' ? area.y + pad
      : vert === 'middle' ? area.y + Math.round((area.height - b.height) / 2)
        : area.y + area.height - b.height - pad;
    this.win.setBounds({ x, y, width: b.width, height: b.height });
    return this.config();
  }

  apply(patch) {
    if (!patch || typeof patch !== 'object') return this.config();
    if ('clickThrough' in patch) this.setClickThrough(patch.clickThrough);
    if ('opacity' in patch) this.setOpacity(patch.opacity);
    if ('locked' in patch) this.setLocked(patch.locked);
    if ('mode' in patch) this.setMode(patch.mode);
    const rest = { ...patch };
    delete rest.clickThrough; delete rest.opacity; delete rest.locked; delete rest.mode;
    if (Object.keys(rest).length) {
      const cfg = this.save(rest);
      this.send('overlay-config', cfg);
      return cfg;
    }
    return this.config();
  }
}

module.exports = { Overlay, OVERLAY_DEFAULTS: DEFAULTS, OVERLAY_MODE_SIZE: MODE_SIZE };

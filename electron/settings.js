// settings.js: tiny dependency-free JSON settings store in %APPDATA%.
// Holds only light user prefs (window bounds, forge defaults). The player tab
// keeps its own UI prefs in renderer localStorage (unchanged original behavior).
'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  window: { width: 1240, height: 880, x: null, y: null, maximized: false },
  library: { dirs: [] },        // extra folders Self Midi scans for MIDI files
  performance: {
    percent: 100,               // how much of the machine MIDI Studio may use
    whenGaming: 'limit',        // nothing | limit | pause, on seeing a game
    advanced: {},               // optional hard overrides: { threads, batch }
  },
  forge: {
    pipeline: 'melody',       // melody | piano | general | fast | drums
    skipSeparation: false,
    advanced: {},             // USE_TTA, BIGSHIFTS, VELOCITY_GAMMA, ...
    outputDir: '',
    timing: { enabled: false, start: '', end: '' },
  },
  paths: { forgeEnvDir: '', forgePythonPath: '', modelsDir: '' },
  ui: { lastTab: 'forge', autoCheckUpdates: true, alwaysOnTop: true },
  // Perch, the always-on-top playback overlay. See electron/overlay.js; the
  // shape is kept there so the two cannot drift apart.
  overlay: {
    mode: 'full', opacity: 0.92, clickThrough: false, locked: false,
    autoShow: true, autoHide: true, lookahead: 3,
    showKeys: true, showTransport: true, bounds: {},
  },
  libraryDir: '',    // manual override: folder the Midi-Player lists .mid files from
  lastOutputDir: '', // folder the most recent Forge transcription was written to (the default)
};

function deepMerge(a, b) {
  const out = Array.isArray(a) ? a.slice() : { ...a };
  for (const k of Object.keys(b || {})) {
    if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && typeof out[k] === 'object') {
      out[k] = deepMerge(out[k] || {}, b[k]);
    } else {
      out[k] = b[k];
    }
  }
  return out;
}

class Settings {
  constructor() {
    this._file = path.join(app.getPath('userData'), 'midi-studio-settings.json');
    this._data = deepMerge(DEFAULTS, this._read());
  }
  _read() {
    try { return JSON.parse(fs.readFileSync(this._file, 'utf-8')); } catch { return {}; }
  }
  _write() {
    try {
      fs.mkdirSync(path.dirname(this._file), { recursive: true });
      fs.writeFileSync(this._file, JSON.stringify(this._data, null, 2), 'utf-8');
    } catch (_) { /* non-fatal */ }
  }
  getAll() { return JSON.parse(JSON.stringify(this._data)); }
  get(dotted) {
    return String(dotted || '').split('.').filter(Boolean)
      .reduce((o, k) => (o == null ? undefined : o[k]), this._data);
  }
  merge(patch) { this._data = deepMerge(this._data, patch || {}); this._write(); return this.getAll(); }
  // Flattened view used by paths.* (forgeEnvDir/forgePythonPath/modelsDir/outputDir).
  forgePaths() {
    return {
      forgeEnvDir: this.get('paths.forgeEnvDir') || '',
      forgePythonPath: this.get('paths.forgePythonPath') || '',
      modelsDir: this.get('paths.modelsDir') || '',
    };
  }
}

module.exports = { Settings, DEFAULTS };

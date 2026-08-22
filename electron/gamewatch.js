// gamewatch.js — is a game running right now?
// MIDI Studio is a companion app: while Roblox is up, it must get out of the
// way. Polls tasklist on a slow interval (only ever while it matters) and tells
// the app to go easy on the GPU/CPU.
'use strict';

const { execFile } = require('child_process');

const GAMES = ['RobloxPlayerBeta.exe', 'RobloxStudioBeta.exe', 'javaw.exe'];
const POLL_MS = 20000;

function probe() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') { resolve(''); return; }
    const filters = [];
    for (const name of GAMES) filters.push('/FI', `IMAGENAME eq ${name}`);
    // tasklist ANDs multiple filters, so ask once per name — still one process
    // every 20s, and only while something is actually watching.
    let index = 0;
    const next = () => {
      if (index >= GAMES.length) { resolve(''); return; }
      const name = GAMES[index++];
      execFile('tasklist.exe', ['/FI', `IMAGENAME eq ${name}`, '/NH'], { windowsHide: true },
        (error, stdout) => {
          if (!error && stdout && stdout.toLowerCase().includes(name.toLowerCase())) resolve(name);
          else next();
        });
    };
    next();
  });
}

class GameWatch {
  constructor(onChange) {
    this._onChange = onChange || (() => {});
    this._timer = null;
    this.active = '';
  }

  start() {
    if (this._timer) return;
    const tick = async () => {
      const found = await probe();
      if (found !== this.active) { this.active = found; this._onChange(found); }
    };
    tick();
    this._timer = setInterval(tick, POLL_MS);
    if (this._timer.unref) this._timer.unref();
  }

  stop() { if (this._timer) { clearInterval(this._timer); this._timer = null; } }
}

module.exports = { GameWatch, GAMES };

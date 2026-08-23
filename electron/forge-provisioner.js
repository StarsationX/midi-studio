// forge-provisioner.js — runs provision_forge.py under the LIGHT player python
// (stdlib only; it bootstraps the heavy env). Parses the MSTEP/MLOG/MDONE/MFAIL
// protocol into forge:status events for the renderer's setup panel.
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const { bundledPlayerPython } = require('./paths');
const forgeStorage = require('./forge-storage');

function lightPython() {
  // Prefer a bundled python; else PATH python (dev). The provisioner only needs
  // stdlib, so any 3.10+ works.
  return bundledPlayerPython() || (process.platform === 'win32' ? 'python' : 'python3');
}

class ForgeProvisioner {
  constructor({ emit, getSettings, settings } = {}) {
    this._emit = emit || (() => {});
    this._getSettings = getSettings || (() => ({}));
    this._settingsStore = settings || null;
    this._child = null;
  }

  isRunning() { return !!(this._child && this._child.exitCode === null); }

  start() {
    if (this.isRunning()) {
      this._emit({ event: 'forge.provision.log', line: 'Setup is already running.' });
      return;
    }
    // Open the log FIRST. Everything below can fail, and when it did there was
    // no file anywhere to explain why — the panel just sat on its placeholder.
    this._logPath = paths.forgeSetupLog();
    try {
      fs.mkdirSync(path.dirname(this._logPath), { recursive: true });
      this._logFd = fs.openSync(this._logPath, 'w');
      fs.writeSync(this._logFd, `=== Midi Forge setup log — ${new Date().toISOString()} ===\n`);
    } catch { this._logFd = null; }

    const envDir = paths.forgeEnvDir(this._getSettings());
    const py = lightPython();
    const say = (line) => {
      if (this._logFd != null) { try { fs.writeSync(this._logFd, line + '\n'); } catch {} }
      this._emit({ event: 'forge.provision.log', line });
    };
    say(`log file: ${this._logPath}`);
    say(`install target: ${envDir}`);
    say(`launcher: ${py}`);

    const fail = (message) => {
      say(`FAILED before start: ${message}`);
      if (this._logFd != null) { try { fs.closeSync(this._logFd); } catch {} this._logFd = null; }
      this._emit({ event: 'forge.provision.error', message, logPath: this._logPath });
    };

    try { forgeStorage.markManaged(envDir); }
    catch (error) {
      // A drive root ("D:\MIDI Studio Forge") needs administrator rights on
      // most machines, and that is the default when the app is installed off
      // C:. Fall back to the user profile rather than dead-ending.
      say(`cannot write ${envDir}: ${error.message}`);
      const fallback = paths.legacyDefaultForgeEnvDir();
      try {
        forgeStorage.markManaged(fallback);
        this._settingsStore && this._settingsStore.merge({ paths: { forgeEnvDir: fallback } });
        say(`using ${fallback} instead — change it in Settings if you want another drive`);
      } catch (second) {
        fail(`Cannot create the Forge folder at ${envDir} (${error.message}) or at ${fallback} (${second.message}). `
          + 'Pick another folder with "Change folder…".');
        return;
      }
    }
    const env = paths.forgeChildEnv(this._getSettings());
    let child;
    try {
      child = spawn(py, [path.join(paths.pythonEngineDir(), 'provision_forge.py')], {
        cwd: paths.pythonEngineDir(), env, windowsHide: process.platform === 'win32',
      });
    } catch (e) {
      fail(`Couldn't start setup: ${e.message}`);
      return;
    }
    this._child = child;
    this._emit({ event: 'forge.provision.progress', percent: 0, step: 'Start', message: 'Setting up Midi Forge…' });
    // A step that prints nothing for a while is normal (a 3 GB download prints
    // once), but silence with no explanation reads as a hang. Say it's alive.
    this._lastOutput = Date.now();
    this._lastStep = 'Preparing';
    clearInterval(this._watchdog);
    this._watchdog = setInterval(() => {
      if (!this.isRunning()) return;
      const quiet = Math.round((Date.now() - this._lastOutput) / 1000);
      if (quiet >= 45) {
        this._emit({ event: 'forge.provision.log',
          line: `still working — ${this._lastStep} has been running for ${Math.floor(quiet / 60)}m ${quiet % 60}s with no output. Downloads print only when they finish.` });
        this._lastOutput = Date.now();
      }
    }, 15000);
    if (this._watchdog.unref) this._watchdog.unref();
    let buf = '';
    const onLine = (line) => {
      this._lastOutput = Date.now();
      if (line.startsWith('MSTEP|')) {
        const p = line.split('|', 4);
        if (p.length === 4) this._lastStep = p[2];
        if (p.length === 4) { const pct = parseInt(p[1], 10); this._emit({ event: 'forge.provision.progress', percent: Number.isNaN(pct) ? -1 : pct, step: p[2], message: p[3] }); }
        return;
      }
      if (line.startsWith('MLOG|')) { this._emit({ event: 'forge.provision.log', line: line.slice(5) }); return; }
      if (line.startsWith('MDONE|')) { this._emit({ event: 'forge.provision.done' }); return; }
      if (line.startsWith('MFAIL|')) { this._emit({ event: 'forge.provision.error', message: line.slice(6) }); return; }
      this._emit({ event: 'forge.provision.log', line });
    };
    const pump = (c) => { if (this._logFd != null) { try { fs.writeSync(this._logFd, c); } catch {} } buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1); if (l.trim()) onLine(l.trim()); } };
    child.stdout.setEncoding('utf-8'); child.stdout.on('data', pump);
    child.stderr.setEncoding('utf-8'); child.stderr.on('data', pump);
    child.on('exit', (code) => {
      this._child = null;
      clearInterval(this._watchdog); this._watchdog = null;
      if (this._logFd != null) { try { fs.writeSync(this._logFd, `\n=== exited code=${code} cancelled=${!!child.__cancelled} ===\n`); fs.closeSync(this._logFd); } catch {} this._logFd = null; }
      if (child.__cancelled) this._emit({ event: 'forge.provision.error', message: 'Setup cancelled.' });
      else if (code !== 0) this._emit({ event: 'forge.provision.error', message: `Setup failed (exit ${code}). Full log: ${this._logPath}`, logPath: this._logPath });
      // success already signaled by MDONE
    });
  }

  cancel() {
    if (!this._child) return;
    this._child.__cancelled = true;
    try { if (process.platform === 'win32') spawn('taskkill', ['/pid', String(this._child.pid), '/t', '/f'], { windowsHide: true }); else this._child.kill('SIGTERM'); } catch {}
  }
}

module.exports = { ForgeProvisioner };

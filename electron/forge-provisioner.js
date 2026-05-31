// forge-provisioner.js — runs provision_forge.py under the LIGHT player python
// (stdlib only; it bootstraps the heavy env). Parses the MSTEP/MLOG/MDONE/MFAIL
// protocol into forge:status events for the renderer's setup panel.
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const paths = require('./paths');
const { bundledPlayerPython } = require('./paths');

function lightPython() {
  // Prefer a bundled python; else PATH python (dev). The provisioner only needs
  // stdlib, so any 3.10+ works.
  return bundledPlayerPython() || (process.platform === 'win32' ? 'python' : 'python3');
}

class ForgeProvisioner {
  constructor({ emit, getSettings } = {}) {
    this._emit = emit || (() => {});
    this._getSettings = getSettings || (() => ({}));
    this._child = null;
  }

  isRunning() { return !!(this._child && this._child.exitCode === null); }

  start() {
    if (this.isRunning()) return;
    const py = lightPython();
    const env = paths.forgeChildEnv(this._getSettings());
    let child;
    try {
      child = spawn(py, [path.join(paths.pythonEngineDir(), 'provision_forge.py')], {
        cwd: paths.pythonEngineDir(), env, windowsHide: process.platform === 'win32',
      });
    } catch (e) {
      this._emit({ event: 'forge.provision.error', message: `Couldn't start setup: ${e.message}` });
      return;
    }
    this._child = child;
    this._emit({ event: 'forge.provision.progress', percent: 0, step: 'Start', message: 'Setting up Midi-Forge…' });
    let buf = '';
    const onLine = (line) => {
      if (line.startsWith('MSTEP|')) {
        const p = line.split('|', 4);
        if (p.length === 4) { const pct = parseInt(p[1], 10); this._emit({ event: 'forge.provision.progress', percent: Number.isNaN(pct) ? -1 : pct, step: p[2], message: p[3] }); }
        return;
      }
      if (line.startsWith('MLOG|')) { this._emit({ event: 'forge.provision.log', line: line.slice(5) }); return; }
      if (line.startsWith('MDONE|')) { this._emit({ event: 'forge.provision.done' }); return; }
      if (line.startsWith('MFAIL|')) { this._emit({ event: 'forge.provision.error', message: line.slice(6) }); return; }
      this._emit({ event: 'forge.provision.log', line });
    };
    const pump = (c) => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1); if (l.trim()) onLine(l.trim()); } };
    child.stdout.setEncoding('utf-8'); child.stdout.on('data', pump);
    child.stderr.setEncoding('utf-8'); child.stderr.on('data', pump);
    child.on('exit', (code) => {
      this._child = null;
      if (child.__cancelled) this._emit({ event: 'forge.provision.error', message: 'Setup cancelled.' });
      else if (code !== 0) this._emit({ event: 'forge.provision.error', message: `Setup failed (exit ${code}).` });
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

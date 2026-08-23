// sidecar.js — the PLAYER engine sidecar (python-engine/ipc_main.py).
// NDJSON over stdio. Prefers a bundled light Python; else probes the Windows
// launcher / PATH. Surfaces actionable errors (missing module -> run install).
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const paths = require('./paths');

function pythonCandidates() {
  if (process.env.PYTHON) return [[process.env.PYTHON, []]];
  if (process.platform === 'win32') return [['py', ['-3']], ['py', []], ['python', []], ['python3', []]];
  return [['python3', []], ['python', []]];
}

function probePython(exe, prefix) {
  return new Promise((resolve) => {
    let done = false; let timer = null;
    const finish = (ok) => { if (done) return; done = true; if (timer) clearTimeout(timer); resolve(ok); };
    let child;
    try {
      child = spawn(exe, [...prefix, '--version'], { stdio: 'ignore', windowsHide: true });
    } catch { return finish(false); }
    child.once('error', () => finish(false));
    child.once('exit', (code) => finish(code === 0));
    timer = setTimeout(() => { try { child.kill(); } catch {} finish(false); }, 4000);
  });
}

class PlayerSidecar {
  constructor({ getSettings, onEvent, onError } = {}) {
    this._getSettings = getSettings || (() => ({}));
    this._onEvent = onEvent || (() => {});
    this._onError = onError || (() => {});
    this._proc = null;
    this._buf = '';
    this._stderrTail = '';
    this._lastError = '';
    this._killing = false;
  }

  isAlive() { return !!(this._proc && this._proc.exitCode === null && !this._proc.killed); }

  async start() {
    if (this.isAlive()) return;
    // In-flight guard: rapid send()-triggered restarts must not spawn N sidecars.
    if (this._startPromise) return this._startPromise;
    this._startPromise = this._doStart().finally(() => { this._startPromise = null; });
    return this._startPromise;
  }

  async _doStart() {
    if (this.isAlive()) return;
    const engineDir = paths.pythonEngineDir();
    const script = path.join(engineDir, 'ipc_main.py');
    if (!fs.existsSync(script)) { this._fail(`ipc_main.py not found at ${script}`); return; }

    const bundled = paths.bundledPlayerPython();
    let exe, prefix;
    if (bundled) {
      exe = bundled; prefix = [];
    } else {
      const cands = pythonCandidates();
      let chosen = null;
      for (const [e, p] of cands) { if (await probePython(e, p)) { chosen = [e, p]; break; } }
      if (!chosen) {
        this._fail('Couldn\'t launch Python for the player engine. Install Python 3.10+ ' +
          'from https://python.org (tick "Add to PATH"), then restart.');
        return;
      }
      [exe, prefix] = chosen;
    }

    let child;
    try {
      child = spawn(exe, [...prefix, '-u', script], {
        cwd: engineDir,
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUNBUFFERED: '1',
          // The bundled embeddable Python doesn't put the script dir on sys.path,
          // so sibling imports (midi_player) fail without this.
          PYTHONPATH: engineDir + (process.env.PYTHONPATH ? path.delimiter + process.env.PYTHONPATH : ''),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) { this._fail(`Failed to spawn player engine: ${e.message}`); return; }
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_ABOVE_NORMAL); } catch {}
    this._bind(child, [exe, ...prefix].join(' '));
  }

  _bind(child, launchCmd) {
    this._proc = child; this._buf = ''; this._stderrTail = ''; this._lastError = '';
    // Its executable lives inside the install folder, so a leftover copy makes
    // the next installer refuse with "MIDI Studio cannot be closed".
    try { require('./forge-runner').trackPid(child.pid); } catch (_) {}
    this._onEvent({ event: 'log', level: 'info', message: `Player engine via: ${launchCmd}` });

    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk) => {
      this._buf += chunk;
      let i;
      while ((i = this._buf.indexOf('\n')) >= 0) {
        const line = this._buf.slice(0, i).trim();
        this._buf = this._buf.slice(i + 1);
        if (!line) continue;
        try { this._onEvent(JSON.parse(line)); }
        catch { this._onEvent({ event: 'log', level: 'error', message: `bad json: ${line.slice(0, 200)}` }); }
      }
    });

    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (chunk) => {
      this._stderrTail = (this._stderrTail + chunk).slice(-4000);
      chunk.split(/\r?\n/).filter(Boolean).forEach((line) =>
        this._onEvent({ event: 'log', level: 'warn', message: `[py] ${line}` }));
    });

    child.on('exit', (code, signal) => {
      const m = this._stderrTail.match(/ModuleNotFoundError: No module named ['"]([^'"]+)['"]/);
      if (m) {
        this._fail(`Player engine is missing the "${m[1]}" module. Reinstall MIDI Studio ` +
          `(or: pip install -r python-engine/requirements-player.txt), then restart.`);
      } else if (code !== 0 && !this._killing) {
        this._fail(`Player engine crashed (code=${code} signal=${signal}). ` +
          (this._stderrTail ? `Last: ${this._stderrTail.trim().split(/\r?\n/).slice(-2).join(' | ')}` : ''));
      }
      // Without this the renderer never learns playback ended: Play stays
      // disabled and the queue stays locked until the whole app is restarted.
      this._onEvent({ event: 'playback_done', crashed: true });
      try { require('./forge-runner').untrackPid(child.pid); } catch (_) {}
      this._proc = null; this._killing = false;
    });
  }

  _fail(message) { this._lastError = message; this._onError(message); }

  send(msg) {
    if (!this.isAlive()) {
      this.start();
      this._onError(this._lastError
        ? `Can't reach player engine. ${this._lastError}`
        : 'Player engine is not running. Check the log, or reinstall MIDI Studio.');
      return false;
    }
    try { this._proc.stdin.write(JSON.stringify(msg) + '\n'); return true; }
    catch (e) { this._onError(`Failed to send to player engine: ${e.message}`); return false; }
  }

  kill() {
    if (!this._proc) return;
    this._killing = true;
    try { this._proc.stdin.write(JSON.stringify({ cmd: 'shutdown' }) + '\n'); } catch {}
    const proc = this._proc;
    setTimeout(() => {
      try {
        if (proc.exitCode === null && !proc.killed) {
          if (process.platform === 'win32') spawn('taskkill', ['/pid', String(proc.pid), '/t', '/f'], { windowsHide: true });
          else proc.kill('SIGKILL');
        }
      } catch {}
    }, 400);
  }
}

module.exports = { PlayerSidecar };

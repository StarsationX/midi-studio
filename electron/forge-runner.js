// forge-runner.js — drives the Midi-Forge pipeline scripts as cancellable child
// jobs under the FORGE-ENV interpreter (never the player python). Streams coarse,
// honest progress to the renderer via the injected emit() callback.
'use strict';

const { spawn, execFile, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const paths = require('./paths');

const NO_WINDOW = process.platform === 'win32';
const STAGES_3 = [['[1/3]', 'Separate', 15], ['[2/3]', 'Transcribe', 55], ['[3/3]', 'Clean', 90]];
const STAGES_4 = [['[1/4]', 'Isolate lead', 12], ['[2/4]', 'Detect melody', 48], ['[3/4]', 'Build candidates', 78], ['[4/4]', 'Prepare review', 94]];
const STAGES_2 = [['[1/2]', 'Transcribe', 40], ['[2/2]', 'Clean', 90]];
// Keyword fallback: transcribe.py / stem_to_midi.py emit prose ("Normalizing…",
// "Transcribing…", "MIDI cleanup…") not [N/M] markers, so progress would freeze.
// Map the actual phrases the scripts print to a coarse stage/percent.
const STAGE_KEYWORDS = [
  [/separat/i, 'Separating', 18],
  [/normaliz/i, 'Transcribing', 50],
  [/transcrib/i, 'Transcribing', 60],
  [/clean/i, 'Cleaning', 90],
];

function selectScript(pipeline, skipSeparation) {
  if (pipeline === 'melody') return ['melody_to_midi.py', STAGES_4];
  if (pipeline === 'drums') return ['drums_to_midi.py', STAGES_3];  // handles its own skip-sep
  // 'fast' is checked BEFORE skipSeparation: both mean "no separation", and
  // testing skip first silently routed Fast to Transkun — minutes of CPU work
  // the user explicitly opted out of.
  if (pipeline === 'fast') return ['stem_to_midi.py', STAGES_2];  // basic-pitch, quick/rough
  if (skipSeparation) return ['transcribe.py', STAGES_2];   // input is already a stem
  // 'piano' and 'general' both separate + Transkun; GENERAL_MODE (set in run())
  // makes 'general' mix every pitched stem instead of only the piano stem.
  return ['song_to_midi.py', STAGES_3];
}

function parseTimeSeconds(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function outputMidiPath(inputPath, timing, outputName) {
  const named = String(outputName || '').trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '').slice(0, 120);
  // A custom name replaces the song's filename but keeps the range suffix, so
  // two ranges of the same song still land side by side instead of colliding.
  const extless = named
    ? path.join(path.dirname(inputPath), named.replace(/\.midi?$/i, ''))
    : inputPath.replace(/\.[^./\\]+$/, '');
  const start = timing && parseTimeSeconds(timing.start);
  const end = timing && parseTimeSeconds(timing.end);
  if (start == null && end == null) return extless + '.mid';
  const fmt = (n) => String(Math.round(n * 1000) / 1000).replace(/\./g, 'p');
  const suffix = `_range_${fmt(start || 0)}_${end != null ? fmt(end) : 'end'}`;
  return extless + suffix + '.mid';
}

// Line pump that treats \r as a line ending too, so progress bars stream.
function makePump(onLine) {
  let buf = '';
  return (chunk) => {
    buf += chunk;
    let match;
    while ((match = /\r\n|\n|\r/.exec(buf))) {
      const line = buf.slice(0, match.index).trim();
      buf = buf.slice(match.index + match[0].length);
      if (line) onLine(line);
    }
    if (buf.length > 8192) buf = buf.slice(-1024);
  };
}

// Windows has no SIGSTOP. NtSuspendProcess/NtResumeProcess do the same job and
// are reachable from PowerShell, which is enough for a button the user presses
// by hand. The job keeps its GPU memory but stops issuing work.
function suspendProcess(pid, resume) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32' || !pid) { resolve(false); return; }
    const fn = resume ? 'NtResumeProcess' : 'NtSuspendProcess';
    const script = [
      '$sig = @"',
      '[DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr h);',
      '[DllImport("ntdll.dll")] public static extern int NtResumeProcess(IntPtr h);',
      '[DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(int a, bool i, int p);',
      '[DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);',
      '"@',
      '$t = Add-Type -MemberDefinition $sig -Name MsProc -Namespace Ms -PassThru',
      `$h = $t::OpenProcess(0x0800, $false, ${pid})`,
      'if ($h -eq [IntPtr]::Zero) { exit 1 }',
      `[void]$t::${fn}($h)`,
      '[void]$t::CloseHandle($h)',
    ].join('\n');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 8000 }, (error) => resolve(!error));
  });
}

// --- orphan protection ------------------------------------------------------
// A Forge job is a separate python.exe holding the GPU. Killing MIDI Studio the
// hard way (Task Manager, a crash) never runs our cleanup, and the job then
// transcribes forever at 100% GPU with no window to stop it.
function readPids() {
  try { return JSON.parse(fs.readFileSync(paths.forgeJobsFile(), 'utf-8')) || []; }
  catch { return []; }
}
function writePids(pids) {
  try { fs.writeFileSync(paths.forgeJobsFile(), JSON.stringify(pids)); } catch (_) {}
}
function trackPid(pid) { const pids = readPids(); if (!pids.includes(pid)) { pids.push(pid); writePids(pids); } }
function untrackPid(pid) { writePids(readPids().filter((p) => p !== pid)); }

function isOurPython(pid) {
  if (process.platform !== 'win32') return false;
  try {
    const out = execFileSync('tasklist.exe', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
      { windowsHide: true, encoding: 'utf-8', timeout: 5000 });
    return /^"python(w)?\.exe"/i.test(out.trim());
  } catch { return false; }
}

// Called once at startup: anything still alive from a previous run is ours to kill.
function reapOrphanJobs() {
  const pids = readPids();
  if (!pids.length) return 0;
  let killed = 0;
  for (const pid of pids) {
    if (!isOurPython(pid)) continue;
    try { execFileSync('taskkill.exe', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, timeout: 5000 }); killed += 1; }
    catch (_) { /* already gone */ }
  }
  writePids([]);
  return killed;
}

class ForgeRunner {
  constructor({ emit, getSettings } = {}) {
    this._emit = emit || (() => {});
    this._getSettings = getSettings || (() => ({}));
    this._jobs = new Map();
    this._seq = 0;
  }

  isRunning() { return this._jobs.size > 0; }
  isPaused() { return !!this._paused; }

  // Pause frees the GPU without losing the minutes already spent.
  async setPaused(paused) {
    const entries = [...this._jobs.values()];
    if (!entries.length) return { ok: false, error: 'Nothing is running.' };
    let done = false;
    for (const child of entries) done = (await suspendProcess(child.pid, !paused)) || done;
    if (!done) return { ok: false, error: 'Could not pause the job on this system.' };
    this._paused = !!paused;
    this._emit({ event: 'forge.paused', paused: this._paused });
    return { ok: true, paused: this._paused };
  }

  // Drop to idle priority while a game is in the foreground, back to
  // below-normal when it closes.
  setBackground(background) {
    this._background = !!background;
    for (const child of this._jobs.values()) {
      try {
        os.setPriority(child.pid, background ? os.constants.priority.PRIORITY_LOW
          : os.constants.priority.PRIORITY_BELOW_NORMAL);
      } catch (_) { /* the job may have just exited */ }
    }
  }

  _settings() { try { return this._getSettings() || {}; } catch { return {}; } }
  _forgePython() { return paths.forgeEnvPython(this._settings()); }

  // Out-of-process capability probe. Resolves { forgeReady, gpu, torch, missing }.
  check() {
    return new Promise((resolve) => {
      const py = this._forgePython();
      const base = { forgeReady: false, forgePython: py, gpu: null, torch: false, missing: [] };
      if (!py) { base.missing = ['forge-env']; return resolve(base); }
      let out = '', done = false, timer = null;
      const finish = () => {
        if (done) return; done = true; if (timer) clearTimeout(timer);
        let probe = null;
        for (const ln of out.split(/\r?\n/).reverse()) { const t = ln.trim(); if (t.startsWith('{')) { try { probe = JSON.parse(t); } catch {} break; } }
        const torch = !!(probe && probe.torch);
        const ready = paths.forgeEnvReady(this._settings()) && torch;
        const missing = [];
        if (!torch) missing.push('torch');
        if (probe) {
          if (!probe.transkun) missing.push('transkun');
          if (!probe.basic_pitch) missing.push('basic-pitch');
          if (!probe.yt_dlp) missing.push('yt-dlp');
        }
        resolve({ forgeReady: ready, forgePython: py, gpu: probe ? probe.gpu : null, torch, missing });
      };
      let child;
      try {
        child = spawn(py, [path.join(paths.pythonEngineDir(), 'env_probe.py')], { cwd: paths.pythonEngineDir(), windowsHide: NO_WINDOW });
      } catch { base.missing = ['forge-env']; return resolve(base); }
      if (child.stdout) child.stdout.on('data', (d) => (out += d));
      child.once('error', finish);
      child.once('exit', finish);
      timer = setTimeout(() => { try { child.kill(); } catch {} finish(); }, 30000);
    });
  }

  _spawnJob(jobId, args, env, stageTable, audioOut, meta = {}) {
    let child;
    try { child = spawn(args[0], args.slice(1), { cwd: paths.pythonEngineDir(), env, windowsHide: NO_WINDOW }); }
    catch (e) { this._emit({ event: 'forge.done', jobId, ok: false, error: `spawn failed: ${e.message}` }); return; }
    this._jobs.set(jobId, child);
    trackPid(child.pid);
    // Forge can saturate a GPU and several CPU cores. Keep the realtime player
    // and Electron renderer responsive while a transcription runs.
    try {
      const perf = (this._settings() && this._settings().performance) || {};
      os.setPriority(child.pid, (this._background || perf.lowPriority)
        ? os.constants.priority.PRIORITY_LOW
        : os.constants.priority.PRIORITY_BELOW_NORMAL);
    } catch {}
    // "exit code 1" tells a user nothing. Keep the tail of the output and any
    // line that looks like a cause, and report that instead.
    const recent = [];
    const causes = [];
    let peak = -1;
    const progress = (stage, pct, message) => {
      peak = Math.max(peak, pct);          // a bar that walks backwards reads as a bug
      this._emit({ event: 'forge.progress', jobId, stage, percent: peak, message });
    };
    const remember = (line) => {
      recent.push(line); if (recent.length > 15) recent.shift();
      if (/error|traceback|exception|no such file|not found|out of memory|CUDA|permission/i.test(line)
          && !/^\s*$/.test(line) && causes.length < 6) causes.push(line);
    };
    const onLine = (line) => {
      remember(line);
      if (line.startsWith('RESULT|')) {
        try { child.__result = JSON.parse(line.slice(7)); }
        catch { this._emit({ event: 'forge.log', jobId, line: 'Could not read pipeline result metadata.', level: 'error' }); }
        return;
      }
      if (line.startsWith('DONE')) {
        // Scripts write {input}.mid (no custom output name is passed), so the
        // derived audioOut is authoritative — don't parse the noisy DONE text.
        child.__finalized = true;
        this._emit({ event: 'forge.progress', jobId, stage: 'Done', percent: 100, message: 'Extraction complete' });
        this._emit({ event: 'forge.done', jobId, ok: true,
          result: Object.assign({ midiPath: audioOut }, child.__result || {}, meta) });
        return;
      }
      for (const [marker, stage, pct] of stageTable) {
        if (line.includes(marker)) { progress(stage, pct, line); return; }
      }
      // Only prose lines from the scripts may drive the keyword fallback — the
      // "Input: Clean Bandit - Symphony.mp3" echo used to jump the bar to 90%.
      if (!/^input:/i.test(line)) {
        for (const [re, stage, pct] of STAGE_KEYWORDS) {
          if (re.test(line)) { progress(stage, pct, line); return; }
        }
      }
      this._emit({ event: 'forge.log', jobId, line, level: /error|traceback/i.test(line) ? 'error' : 'info' });
    };
    // MSST's tqdm bar and yt-dlp rewrite one line with \r and never send \n, so a
    // newline-only split buffered the entire progress stream and showed nothing
    // for the longest part of the run. Split on either.
    const pump = makePump(onLine);
    if (child.stdout) { child.stdout.setEncoding('utf-8'); child.stdout.on('data', pump); }
    if (child.stderr) { child.stderr.setEncoding('utf-8'); child.stderr.on('data', pump); }
    child.on('exit', (code) => {
      this._jobs.delete(jobId);
      untrackPid(child.pid);
      if (!this._jobs.size) this._paused = false;
      if (child.__finalized) return;                       // DONE already finalized success
      if (child.__cancelled) this._emit({ event: 'forge.done', jobId, ok: false, error: 'cancelled' });
      else if (code !== 0) {
        const why = (causes.length ? causes : recent.slice(-4)).join('\n').slice(0, 900);
        this._emit({ event: 'forge.done', jobId, ok: false,
          error: why ? `${why}\n(exit code ${code})` : `exit code ${code}` });
      } else this._emit({ event: 'forge.done', jobId, ok: false, error: 'finished without producing output' });
    });
  }

  run({ inputPath, pipeline, skipSeparation, advanced, timing, outputName }) {
    const jobId = `job-${++this._seq}`;
    const py = this._forgePython();
    // forgeEnvReady, not just "python.exe exists": a cancelled or out-of-disk
    // setup leaves an interpreter with no torch, and the job died on import.
    if (!py || !paths.forgeEnvReady(this._settings())) {
      setTimeout(() => this._emit({ event: 'forge.done', jobId, ok: false,
        error: 'Midi Forge isn\'t set up yet. Open the Midi Forge tab and click "Set up Midi Forge".' }), 0);
      return jobId;
    }
    if (!inputPath) { setTimeout(() => this._emit({ event: 'forge.done', jobId, ok: false, error: 'No input file.' }), 0); return jobId; }
    const [script, stageTable] = selectScript(pipeline, skipSeparation);
    const env = Object.assign({}, paths.forgeChildEnv(this._settings()));
    // Derived from the user's allowance, halved again while a game is up front.
    const perf = (this._settings() && this._settings().performance) || {};
    const half = (n) => Math.max(1, Math.round(n / 2));
    const batch = this._background ? half(perf.batch || 2) : (perf.batch || 2);
    const threads = this._background ? half(perf.threads || 4) : (perf.threads || 4);
    env.SEPARATION_BATCH = env.SEPARATION_BATCH || String(batch);
    env.TRANSCRIBE_BATCH = env.TRANSCRIBE_BATCH || String(batch);
    env.OMP_NUM_THREADS = env.OMP_NUM_THREADS || String(threads);
    env.MKL_NUM_THREADS = env.MKL_NUM_THREADS || String(threads);
    for (const [k, v] of Object.entries(advanced || {})) { if (v !== null && v !== undefined && v !== '') env[k] = (v === true ? '1' : v === false ? '0' : String(v)); }
    const start = timing && parseTimeSeconds(timing.start);
    const end = timing && parseTimeSeconds(timing.end);
    if (start != null) env.FORGE_START_SEC = String(start);
    if (end != null) env.FORGE_END_SEC = String(end);
    if (start != null && end != null && end <= start) {
      setTimeout(() => this._emit({ event: 'forge.done', jobId, ok: false, error: 'Stop time must be after start time.' }), 0);
      return jobId;
    }
    if (pipeline === 'general') env.GENERAL_MODE = '1';  // mix all pitched stems for Transkun
    if ((pipeline === 'drums' || pipeline === 'melody') && skipSeparation) env.SKIP_SEPARATION = '1';
    const audioOut = outputMidiPath(inputPath, { start, end }, outputName);
    this._emit({ event: 'forge.progress', jobId, stage: 'Queued', percent: -1, message: `Starting ${script}` });
    this._spawnJob(jobId, [py, path.join(paths.pythonEngineDir(), script), inputPath, audioOut], env, stageTable, audioOut,
      { pipeline, timing: { start, end } });
    return jobId;
  }

  ytDownload({ url, outDir }) {
    const jobId = `yt-${++this._seq}`;
    const py = this._forgePython();
    if (!py) { setTimeout(() => this._emit({ event: 'forge.done', jobId, ok: false, error: 'Midi-Forge isn\'t set up yet.' }), 0); return jobId; }
    if (!url) { setTimeout(() => this._emit({ event: 'forge.done', jobId, ok: false, error: 'No URL.' }), 0); return jobId; }
    const env = paths.forgeChildEnv(this._settings());
    // Empty outDir -> let yt_download.py use its own writable default (never cwd).
    const args = outDir ? [py, path.join(paths.pythonEngineDir(), 'yt_download.py'), url, outDir]
                        : [py, path.join(paths.pythonEngineDir(), 'yt_download.py'), url];
    this._emit({ event: 'forge.progress', jobId, stage: 'Download', percent: -1, message: `Downloading ${url}` });
    let child;
    try { child = spawn(args[0], args.slice(1), { cwd: paths.pythonEngineDir(), env, windowsHide: NO_WINDOW }); }
    catch (e) { this._emit({ event: 'forge.done', jobId, ok: false, error: `spawn failed: ${e.message}` }); return jobId; }
    this._jobs.set(jobId, child);
    trackPid(child.pid);
    const onLine = (line) => {
      if (line.startsWith('DOWNLOADED:')) { const p = line.split('DOWNLOADED:', 2)[1].trim(); child.__finalized = true; this._emit({ event: 'forge.progress', jobId, stage: 'Done', percent: 100, message: 'Download complete' }); this._emit({ event: 'forge.done', jobId, ok: true, result: { downloadedPath: p } }); return; }
      const m = line.match(/(\d{1,3}(?:\.\d+)?)%/); if (m) { this._emit({ event: 'forge.progress', jobId, stage: 'Download', percent: Math.max(5, Math.min(99, Math.round(parseFloat(m[1])))), message: line }); return; }
      this._emit({ event: 'forge.log', jobId, line, level: 'info' });
    };
    const pump = makePump(onLine);
    if (child.stdout) { child.stdout.setEncoding('utf-8'); child.stdout.on('data', pump); }
    if (child.stderr) { child.stderr.setEncoding('utf-8'); child.stderr.on('data', pump); }
    child.on('exit', (code) => { this._jobs.delete(jobId); untrackPid(child.pid); if (child.__finalized) return; if (child.__cancelled) this._emit({ event: 'forge.done', jobId, ok: false, error: 'cancelled' }); else if (code !== 0) this._emit({ event: 'forge.done', jobId, ok: false, error: `exit code ${code}` }); });
    return jobId;
  }

  cancel(jobId) {
    const child = this._jobs.get(jobId);
    if (!child) return false;
    child.__cancelled = true;
    try { if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }); else child.kill('SIGTERM'); } catch {}
    return true;
  }

  cancelAll() { for (const id of [...this._jobs.keys()]) this.cancel(id); }
}

module.exports = { ForgeRunner, reapOrphanJobs, trackPid, untrackPid };

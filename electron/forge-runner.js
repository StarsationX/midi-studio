// forge-runner.js: drives the Midi-Forge pipeline scripts as cancellable child
// jobs under the FORGE-ENV interpreter (never the player python). Streams coarse,
// honest progress to the renderer via the injected emit() callback.
'use strict';

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const paths = require('./paths');

const NO_WINDOW = process.platform === 'win32';
const STAGES_3 = [['[1/3]', 'Separate', 15], ['[2/3]', 'Transcribe', 55], ['[3/3]', 'Clean', 90]];
const STAGES_4 = [['[1/4]', 'Isolate lead', 12], ['[2/4]', 'Detect melody', 48], ['[3/4]', 'Build candidates', 78], ['[4/4]', 'Prepare review', 94]];
const STAGES_EXPRESSIVE = [
  ['[1/6]', 'Prepare model', 5], ['[2/6]', 'Separate', 15],
  ['[3/6]', 'Transcribe accompaniment', 48], ['[4/6]', 'Detect melody', 72],
  ['[5/6]', 'Arrange', 87], ['[6/6]', 'Prepare review', 96],
];
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
  if (pipeline === 'expressive') return ['forge-rs', STAGES_EXPRESSIVE];
  if (pipeline === 'melody') return ['melody_to_midi.py', STAGES_4];
  if (pipeline === 'drums') return ['drums_to_midi.py', STAGES_3];  // handles its own skip-sep
  // 'fast' is checked BEFORE skipSeparation: both mean "no separation", and
  // testing skip first silently routed Fast to Transkun, minutes of CPU work
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

// How long a Forge capability verdict may be reused. Short on purpose: nothing
// that would change the answer (provisioning several GB) can happen inside ten
// seconds, and the point is only to stop two frames asking at the same launch.
const CHECK_TTL_MS = 10000;

// Line pump that treats \r as a line ending too, so progress bars stream.
function makePump(onLine) {
  let buf = '';
  const pump = (chunk) => {
    buf += chunk;
    let match;
    while ((match = /\r\n|\n|\r/.exec(buf))) {
      const line = buf.slice(0, match.index).trim();
      buf = buf.slice(match.index + match[0].length);
      if (line) onLine(line);
    }
    if (buf.length > 8192) buf = buf.slice(-1024);
  };
  pump.flush = () => {
    const line = buf.trim();
    buf = '';
    if (line) onLine(line);
  };
  return pump;
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

// ASYNCHRONOUS on purpose. tasklist.exe costs 107-342ms per pid on this
// machine (main-perf.js "reap"), and this used to run with execFileSync inside
// createServices(), i.e. BEFORE the window existed -- 320ms of a 619ms startup
// with three stale pids, and it grows linearly with them. Nothing on the first
// frame depends on the answer, so the probe is spawned instead of waited on.
// The ordering that DOES matter (invariant 10: a leftover job must be reaped
// before a new one is started) is preserved by main.js awaiting the promise
// this returns before forge:run/forge:yt spawn anything.
function isOurPython(pid) {
  if (process.platform !== 'win32') return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      execFile('tasklist.exe', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
        { windowsHide: true, timeout: 5000 },
        (error, stdout) => resolve(!error && /^"(python(w)?|midi-player)\.exe"/i.test(String(stdout || '').trim())));
    } catch { resolve(false); }
  });
}

function killPid(pid) {
  return new Promise((resolve) => {
    try {
      execFile('taskkill.exe', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, timeout: 5000 },
        (error) => resolve(!error));
    } catch { resolve(false); }
  });
}

// Called once at startup: anything still alive from a previous run is ours to
// kill. Resolves with how many were killed.
function reapOrphanJobs() {
  const pids = readPids();
  if (!pids.length) return Promise.resolve(0);
  // All pids at once. They are independent probes and there are never many, so
  // the reap costs ONE tasklist round trip instead of N sequential ones -- the
  // synchronous version paid 107-342ms per pid, one after another.
  return Promise.all(pids.map(async (pid) => {
    if (!(await isOurPython(pid))) return 0;
    return (await killPid(pid)) ? 1 : 0;
  })).then((results) => {
    // Forget only the pids THIS reap examined. The list is no longer cleared
    // wholesale, because the reap is asynchronous now and the player sidecar
    // registers its own pid here while it runs (its spawn is deferred 1200ms,
    // and a loaded machine has been measured taking 2.5s for one tasklist).
    // Clearing the file would have made that sidecar unreapable next boot.
    writePids(readPids().filter((pid) => !pids.includes(pid)));
    return results.reduce((a, b) => a + b, 0);
  });
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
      if (!child.pid) continue; // Browser-backed downloads do not own a worker PID.
      try {
        os.setPriority(child.pid, background ? os.constants.priority.PRIORITY_LOW
          : os.constants.priority.PRIORITY_BELOW_NORMAL);
      } catch (_) { /* the job may have just exited */ }
    }
  }

  _settings() { try { return this._getSettings() || {}; } catch { return {}; } }
  _forgePython() { return paths.forgeEnvPython(this._settings()); }

  // Out-of-process capability probe. Resolves { forgeReady, gpu, torch, missing }.
  // Two frames ask independently (the Forge tab 250ms after it loads, the shell
  // as a fallback if no GPU verdict arrived), and one probe is a full `import
  // torch` in a fresh interpreter -- 2.7s of CPU measured, competing with the
  // boot path and the player sidecar's own startup. So: callers that arrive
  // while a probe is running share it, and a verdict is reused for CHECK_TTL_MS
  // afterwards. The TTL is short on purpose -- provisioning takes minutes, so
  // nothing can become true inside it -- and invalidateCheck() drops it the
  // moment setup finishes or the Forge paths change. check({ fresh: true })
  // bypasses both, which is what an explicit "re-check the engine" must do.
  invalidateCheck() { this._checkCache = null; }

  check(opts) {
    if (opts && opts.mode === 'expressive') {
      const exe = paths.rustForgeExe();
      if (!exe) return Promise.resolve({forgeReady:false, missing:['forge-rs.exe'], engine:'rust'});
      return new Promise(resolve => execFile(exe, ['probe','--mode','expressive','--mem-limit-gb','0'], {
        env: paths.forgeChildEnv(this._settings()), windowsHide: true, timeout: 15000,
      }, (err, stdout) => {
        try {
          const probe = JSON.parse(stdout.trim().split(/\r?\n/).pop());
          resolve({forgeReady: !!probe.ready, gpu: probe.ep === 'cuda' ? 'CUDA' : null,
            missing: probe.missing, engine:'rust'});
        } catch (_) { resolve({forgeReady:false, missing:[err?.message || 'Could not probe Rust Forge'], engine:'rust'}); }
      }));
    }
    const fresh = !!(opts && opts.fresh);
    const py = this._forgePython();
    if (fresh) this._checkCache = null;
    const cached = this._checkCache;
    if (cached && cached.py === py && Date.now() - cached.at < CHECK_TTL_MS) return Promise.resolve(cached.value);
    if (this._checkInFlight && this._checkInFlight.py === py && !fresh) return this._checkInFlight.promise;
    const promise = this._runCheck(py).then((value) => {
      this._checkCache = { py, at: Date.now(), value };
      if (this._checkInFlight && this._checkInFlight.promise === promise) this._checkInFlight = null;
      return value;
    }, (e) => {
      if (this._checkInFlight && this._checkInFlight.promise === promise) this._checkInFlight = null;
      throw e;
    });
    this._checkInFlight = { py, promise };
    return promise;
  }

  _runCheck(py) {
    return new Promise((resolve) => {
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
    const cwd = args[1] === 'pipeline' ? path.dirname(args[0]) : paths.pythonEngineDir();
    try { child = spawn(args[0], args.slice(1), { cwd, env, windowsHide: NO_WINDOW }); }
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
    // Where the Transcribe stage sits in this pipeline's table, and where the
    // next one starts, so segment counts can walk the bar between them.
    const tIdx = stageTable.findIndex(([, stage]) => stage === 'Transcribe');
    const tFrom = tIdx >= 0 ? stageTable[tIdx][2] : 0;
    const tTo = tIdx >= 0 && stageTable[tIdx + 1] ? stageTable[tIdx + 1][2] - 2 : tFrom;

    const onLine = (line) => {
      remember(line);
      // TSEG|k|N from transcribe_fast.py. GPU and DirectML paths only; the CPU
      // path runs stock transkun, which has nothing to report.
      if (line.startsWith('TSEG|')) {
        const [, k, n] = line.split('|');
        const done = Number(k), total = Number(n);
        if (tIdx >= 0 && total > 0) {
          progress('Transcribe', Math.round(tFrom + (tTo - tFrom) * (done / total)),
                   `Transcribing segment ${done}/${total}`);
        }
        return;
      }
      if (line.startsWith('RESULT|')) {
        try { child.__result = JSON.parse(line.slice(7)); }
        catch { this._emit({ event: 'forge.log', jobId, line: 'Could not read pipeline result metadata.', level: 'error' }); }
        return;
      }
      if (line.startsWith('DONE')) {
        // Scripts write {input}.mid (no custom output name is passed), so the
        // derived audioOut is authoritative, don't parse the noisy DONE text.
        child.__finalized = true;
        this._emit({ event: 'forge.progress', jobId, stage: 'Done', percent: 100, message: 'Extraction complete' });
        this._emit({ event: 'forge.done', jobId, ok: true,
          result: Object.assign({ midiPath: audioOut }, child.__result || {}, meta) });
        return;
      }
      for (const [marker, stage, pct] of stageTable) {
        if (line.includes(marker)) { progress(stage, pct, line); return; }
      }
      // Only prose lines from the scripts may drive the keyword fallback, the
      // "Input: Clean Bandit - Symphony.mp3" echo used to jump the bar to 90%.
      if (stageTable !== STAGES_EXPRESSIVE && !/^input:/i.test(line)) {
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

  run({ inputPath, pipeline, skipSeparation, advanced, timing, outputName, outputDir }) {
    const jobId = `job-${++this._seq}`;
    const py = this._forgePython();
    // forgeEnvReady, not just "python.exe exists": a cancelled or out-of-disk
    // setup leaves an interpreter with no torch, and the job died on import.
    if (pipeline !== 'expressive' && (!py || !paths.forgeEnvReady(this._settings()))) {
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
    env.SEPARATION_BATCH = env.SEPARATION_BATCH || String(pipeline === 'expressive' ? 1 : batch);
    env.TRANSCRIBE_BATCH = env.TRANSCRIBE_BATCH || String(batch);
    env.OMP_NUM_THREADS = env.OMP_NUM_THREADS || String(threads);
    env.MKL_NUM_THREADS = env.MKL_NUM_THREADS || String(threads);
    // Torch's OpenMP pool SPIN-WAITS between parallel regions by default: idle
    // worker threads burn a full core doing nothing rather than sleeping. On a
    // 2-4 core machine that starves the UI even though this job already runs
    // below normal priority, because a spinning thread never yields. It is what
    // makes the app go unresponsive in ~0.2s bursts while a song transcribes.
    // PASSIVE/blocktime 0 puts idle workers to sleep instead. It costs a little
    // on very short parallel regions and gives the machine back the rest of the
    // time.
    env.OMP_WAIT_POLICY = env.OMP_WAIT_POLICY || 'PASSIVE';
    env.KMP_BLOCKTIME = env.KMP_BLOCKTIME || '0';
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
    const expressive = pipeline === 'expressive';
    const targetInput = expressive && outputDir ? path.join(outputDir, path.basename(inputPath)) : inputPath;
    const name = outputName || (expressive ? path.basename(inputPath, path.extname(inputPath)) + ' - Medley' : '');
    const audioOut = outputMidiPath(targetInput, { start, end }, name);
    this._emit({ event: 'forge.progress', jobId, stage: 'Queued', percent: -1, message: `Starting ${script}` });
    const exe = expressive && paths.rustForgeExe();
    if (expressive && !exe) {
      setTimeout(() => this._emit({event:'forge.done',jobId,ok:false,error:'The Rust Forge executable is missing.'}), 0);
      return jobId;
    }
    const args = expressive ? [exe, 'pipeline', inputPath, audioOut, '--mode', 'expressive']
      : [py, path.join(paths.pythonEngineDir(), script), inputPath, audioOut];
    this._spawnJob(jobId, args, env, stageTable, audioOut,
      { pipeline, engine: expressive ? 'rust' : 'python', timing: { start, end } });
    return jobId;
  }

  ytDownload({ url, outDir }) {
    const jobId = `yt-${++this._seq}`;
    let museScore = false;
    try {
      const parsed = new URL(url), host = parsed.hostname.toLowerCase().replace(/\.$/, '');
      museScore = /^https?:$/.test(parsed.protocol) && (host === 'musescore.com' || host.endsWith('.musescore.com'));
    } catch (_) {}
    if (museScore) {
      // Public MIDI playback uses the bundled browser, not the audio/ML Python env.
      const holder = { __browserDownload: true, cancel: null };
      this._jobs.set(jobId, holder);
      try {
        const job = require('./musescore-download').startDownload({ url, outDir, emit: (event) => {
          if (event.event === 'forge.done') { this._jobs.delete(jobId); if (!this._jobs.size) this._paused = false; }
          this._emit({ ...event, jobId });
        } });
        holder.cancel = job.cancel;
      } catch (error) {
        this._jobs.delete(jobId);
        setTimeout(() => this._emit({ event: 'forge.done', jobId, ok: false, error: String(error.message || error) }), 0);
      }
      return jobId;
    }
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
    if (child.pid) trackPid(child.pid);
    const recent = [], causes = [];
    const onLine = (line) => {
      if (child.__finalized || child.__cancelled) return;
      const text = line.slice(0, 900);
      recent.push(text); if (recent.length > 4) recent.shift();
      if (/error|traceback|exception|no such file|not found|out of memory|CUDA|permission|^hint:| -m pip /i.test(line)) {
        causes.push(text); if (causes.length > 6) causes.shift();
      }
      if (line.startsWith('DOWNLOADED:') && line.slice(11).trim()) { const p = line.slice(11).trim(); child.__finalized = true; this._emit({ event: 'forge.progress', jobId, stage: 'Done', percent: 100, message: 'Download complete' }); this._emit({ event: 'forge.done', jobId, ok: true, result: { downloadedPath: p } }); return; }
      const m = line.match(/(\d{1,3}(?:\.\d+)?)%/); if (m) { this._emit({ event: 'forge.progress', jobId, stage: 'Download', percent: Math.max(5, Math.min(99, Math.round(parseFloat(m[1])))), message: line }); return; }
      this._emit({ event: 'forge.log', jobId, line, level: /error|traceback/i.test(line) ? 'error' : 'info' });
    };
    const stdout = makePump(onLine), stderr = makePump(onLine);
    if (child.stdout) { child.stdout.setEncoding('utf-8'); child.stdout.on('data', stdout); }
    if (child.stderr) { child.stderr.setEncoding('utf-8'); child.stderr.on('data', stderr); }
    const finish = (code, spawnError) => {
      this._jobs.delete(jobId);
      if (child.pid) untrackPid(child.pid);
      stdout.flush(); stderr.flush();
      if (child.__finalized) return;
      child.__finalized = true;
      const why = (causes.length ? causes : recent).join('\n').slice(-900);
      const error = child.__cancelled ? 'cancelled'
        : spawnError ? `spawn failed: ${spawnError.message}`
          : code !== 0 ? (why ? `${why}\n(exit code ${code})` : `exit code ${code}`)
            : 'finished without producing output';
      this._emit({ event: 'forge.done', jobId, ok: false, error });
    };
    // close follows both streams' EOF; exit can arrive before their final error line.
    child.on('close', (code) => finish(code));
    child.on('error', (error) => finish(null, error));
    return jobId;
  }

  cancel(jobId) {
    const child = this._jobs.get(jobId);
    if (!child) return false;
    if (child.__browserDownload) { if (child.cancel) child.cancel(); return true; }
    child.__cancelled = true;
    try { if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }); else child.kill('SIGTERM'); } catch {}
    return true;
  }

  cancelAll() { for (const id of [...this._jobs.keys()]) this.cancel(id); }
}

module.exports = { ForgeRunner, reapOrphanJobs, trackPid, untrackPid, makePump };

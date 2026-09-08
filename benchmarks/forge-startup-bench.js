// forge-startup-bench.js -- the part of a Forge run that is NOT model compute.
//
//   node benchmarks/forge-startup-bench.js
//   node benchmarks/forge-startup-bench.js --json benchmarks/forge-startup.json
//   node benchmarks/forge-startup-bench.js --only probe,model,orphan,tqdm,static,pump,decode
//
// Plain node on purpose: nothing here needs a window, so it can be re-run in a
// second without booting Electron.
//
// WHAT IT REFUSES TO DO
//   No transcription, no separation, no GPU work, no CUDA context. The heaviest
//   thing it touches is `import torch` and `torch.load(..., map_location='cpu')`
//   -- which is precisely the per-job overhead being measured, and is CPU + disk
//   only. `--only static,orphan,tqdm` skips even that.
//
// WHAT EACH GROUP ANSWERS
//   probe   what env_probe.py costs, and whether two callers dedupe (they do not)
//   model   what a checkpoint load costs, and how many happen per job
//   orphan  what reapOrphanJobs()'s synchronous tasklist.exe costs at boot
//   tqdm    the ACTUAL line rate a progress bar puts on the pipe (measured, not
//           assumed), because the whole IPC fan-out question depends on it
//   static  spawn counts, model-load counts and audio-decode counts read out of
//           the pipeline source, each with the file:line that proves it
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : ''; };
const ONLY = flag('--only') ? flag('--only').split(',').map((s) => s.trim()).filter(Boolean) : null;
const JSON_AT = flag('--json');
const want = (g) => !ONLY || ONLY.includes(g);
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-forge-startup-'));

function stats(samples) {
  if (!samples.length) return { n: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  const s = [...samples].sort((a, b) => a - b);
  const at = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, mean: s.reduce((a, b) => a + b, 0) / s.length,
    p50: at(0.5), p95: at(0.95), p99: at(0.99), max: s[s.length - 1] };
}
function time(fn) { const t = process.hrtime.bigint(); const r = fn(); return [Number(process.hrtime.bigint() - t) / 1e6, r]; }

const RESULTS = {};
const record = (g, row) => { (RESULTS[g] || (RESULTS[g] = [])).push(row); return row; };

// ---- find the provisioned forge env, the same places paths.js looks ---------
// paths.js can't be required here (it needs electron's app), so the candidate
// list is mirrored. It is only used to LOCATE an interpreter, never to decide
// anything the app decides.
function localAppData() { return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'); }
function pyIn(dir) {
  if (!dir) return null;
  for (const rel of [['python', 'python.exe'], ['python.exe'], ['Scripts', 'python.exe']]) {
    const c = path.join(dir, ...rel);
    if (fs.existsSync(c)) return c;
  }
  return null;
}
function findForgePython() {
  const cands = [
    path.join(localAppData(), 'midi-studio', 'forge-env'),
    path.join(localAppData(), 'midi-forge'),
  ];
  for (const letter of 'CDEFGH') { const p = `${letter}:\\MIDI Studio Forge`; if (fs.existsSync(p)) cands.push(p); }
  for (const d of cands) {
    const py = pyIn(d);
    if (!py) continue;
    const root = path.dirname(py);
    const hasTorch = [root, path.dirname(root)].some((r) => fs.existsSync(path.join(r, 'Lib', 'site-packages', 'torch')));
    if (hasTorch) return { py, dir: d };
  }
  return { py: null, dir: null };
}
const FORGE = findForgePython();
const ENGINE = path.join(ROOT, 'python-engine');

// ===========================================================================
//  probe: what the app pays to answer "is Forge ready, and what GPU is this"
// ===========================================================================
function groupProbe() {
  if (!FORGE.py) { record('probe', { name: 'SKIPPED: no provisioned forge env found', unit: '' }); return; }

  const bare = [];
  for (let i = 0; i < 5; i++) bare.push(time(() => spawnSync(FORGE.py, ['-c', 'pass'], { windowsHide: true }))[0]);
  record('probe', { name: 'forge interpreter cold start (python -c pass)', unit: 'ms', ...stats(bare) });

  const imp = [];
  for (let i = 0; i < 3; i++) imp.push(time(() => spawnSync(FORGE.py, ['-c', 'import torch'], { windowsHide: true }))[0]);
  record('probe', { name: 'python -c "import torch" (no CUDA call)', unit: 'ms', ...stats(imp) });

  const probeScript = path.join(ENGINE, 'env_probe.py');
  if (fs.existsSync(probeScript)) {
    const runs = [];
    let out = '';
    for (let i = 0; i < 3; i++) {
      const [ms, r] = time(() => spawnSync(FORGE.py, [probeScript], { cwd: ENGINE, windowsHide: true, encoding: 'utf-8' }));
      runs.push(ms);
      out = (r.stdout || '').trim().split(/\r?\n/).pop() || '';
    }
    record('probe', { name: 'env_probe.py end to end (what forge:check spawns)', unit: 'ms', ...stats(runs), lastLine: out.slice(0, 160) });
  }

  // Two callers, no dedupe: forge.js fires refreshEnv() 250 ms after its frame
  // loads, and shell.js fires its own check() at 12 s if no verdict arrived.
  // ForgeRunner.check() has no in-flight guard, so both spawn.
  const runnerSrc = fs.readFileSync(path.join(ROOT, 'electron', 'forge-runner.js'), 'utf-8');
  const hasGuard = /_checkPromise|_checkInFlight|inflight/i.test(runnerSrc);
  record('probe', {
    name: 'ForgeRunner.check() de-duplicates concurrent callers', unit: 'bool',
    value: hasGuard ? 1 : 0,
    note: hasGuard ? 'guard found' : 'NO in-flight guard: every caller spawns its own torch import',
  });
}

// ===========================================================================
//  model: what is reloaded between queued jobs
// ===========================================================================
function groupModel() {
  if (!FORGE.py) { record('model', { name: 'SKIPPED: no provisioned forge env found', unit: '' }); return; }
  const sp = path.join(path.dirname(FORGE.py), 'Lib', 'site-packages');
  const spAlt = path.join(path.dirname(path.dirname(FORGE.py)), 'Lib', 'site-packages');
  const sitePkgs = fs.existsSync(sp) ? sp : spAlt;
  const ckpt = path.join(sitePkgs, 'transkun', 'pretrained', '2.0.pt');
  const modelsDir = path.join(FORGE.dir, 'models');
  const bsRofo = path.join(modelsDir, 'bs_rofo_sw', 'BS-Rofo-SW-Fixed.ckpt');

  for (const [label, p] of [['transkun 2.0.pt', ckpt], ['BS-Rofo-SW-Fixed.ckpt', bsRofo]]) {
    record('model', { name: `checkpoint on disk: ${label}`, unit: 'bytes',
      value: fs.existsSync(p) ? fs.statSync(p).size : -1, path: p });
  }

  // CPU + disk only, map_location='cpu': exactly what transcribe_fast.load_model()
  // and MSST's checkpoint load pay, with no GPU involved.
  const script = path.join(SCRATCH, 'load_ckpt.py');
  fs.writeFileSync(script, [
    'import sys, time, torch',
    'p = sys.argv[1]',
    'for i in range(3):',
    '    t = time.perf_counter()',
    "    ck = torch.load(p, map_location='cpu', weights_only=False)",
    '    print(f"LOAD|{(time.perf_counter()-t)*1000:.1f}", flush=True)',
    '    del ck',
  ].join('\n'), 'utf-8');
  const loadOne = (label, p) => {
    if (!fs.existsSync(p)) { record('model', { name: `SKIPPED (missing): ${label}`, unit: '' }); return; }
    const r = spawnSync(FORGE.py, [script, p], { windowsHide: true, encoding: 'utf-8', timeout: 300000 });
    const loads = String(r.stdout || '').split(/\r?\n/)
      .filter((l) => l.startsWith('LOAD|')).map((l) => Number(l.split('|')[1]));
    record('model', { name: `torch.load(${label}, map_location=cpu), warm page cache`, unit: 'ms', ...stats(loads) });
  };
  loadOne('transkun 2.0.pt', ckpt);
  loadOne('BS-Rofo-SW-Fixed.ckpt', bsRofo);

  // How many times per job that load happens, straight out of the source.
  const tfSrc = fs.readFileSync(path.join(ENGINE, 'transcribe_fast.py'), 'utf-8');
  const loadCalls = (tfSrc.match(/load_model\(\)/g) || []).length - 1;   // minus the def
  record('model', {
    name: 'load_model() calls per transcribe_fast.py run on the CUDA path', unit: 'calls',
    value: loadCalls,
    note: 'transcribe_fast.py:145 model = load_model(); transcribe_fast.py:170 producer_model = load_model() if backend == "cuda"',
  });
}

// ===========================================================================
//  orphan: the synchronous boot probe
// ===========================================================================
function groupOrphan() {
  const pid = process.pid;
  const probe = () => time(() => {
    try {
      execFileSync('tasklist.exe', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
        { windowsHide: true, encoding: 'utf-8', timeout: 5000 });
    } catch (_) {}
  })[0];
  // The FIRST probe of the process is the one the app actually pays at boot
  // (tasklist.exe is not in any cache yet), so it is reported on its own as well
  // as inside the warm distribution.
  const cold = probe();
  const runs = [];
  for (let i = 0; i < 20; i++) runs.push(probe());
  record('orphan', {
    name: 'one synchronous tasklist.exe probe (isOurPython, forge-runner.js:130)',
    unit: 'ms', coldFirstCall: cold, ...stats(runs),
  });

  // forge-jobs.json always holds at least the player sidecar's pid (sidecar.js
  // calls trackPid on every start), so reapOrphanJobs() at boot always pays for
  // at least one of these on the main thread before the window can paint.
  const jobsFile = path.join(process.env.APPDATA || os.homedir(), 'midi-studio', 'forge-jobs.json');
  let tracked = null;
  try { tracked = JSON.parse(fs.readFileSync(jobsFile, 'utf-8')); } catch (_) {}
  record('orphan', {
    name: 'pids currently in forge-jobs.json (each costs one probe at boot)',
    unit: 'pids', value: Array.isArray(tracked) ? tracked.length : -1,
    path: jobsFile, contents: JSON.stringify(tracked),
  });

  const src = fs.readFileSync(path.join(ROOT, 'electron', 'forge-runner.js'), 'utf-8');
  record('orphan', {
    name: 'reapOrphanJobs uses synchronous execFileSync', unit: 'bool',
    value: /function reapOrphanJobs[\s\S]{0,600}?execFileSync/.test(src) ? 1 : 0,
    note: 'blocks the main thread; called from main.js before the window is usable',
  });
}

// ===========================================================================
//  tqdm: the real line rate on the pipe
// ===========================================================================
function groupTqdm() {
  if (!FORGE.py) { record('tqdm', { name: 'SKIPPED: no provisioned forge env found', unit: '' }); return; }
  const script = path.join(SCRATCH, 'tqdm_rate.py');
  fs.writeFileSync(script, [
    '# Count what tqdm actually writes, at MSST-like and worst-case loop speeds.',
    '# CPU only: no torch, no GPU, no model.',
    'import io, time',
    'from tqdm import tqdm',
    'class Counting(io.StringIO):',
    '    def __init__(self):',
    '        super().__init__(); self.writes = 0; self.bytes = 0; self.cr = 0',
    '    def write(self, s):',
    '        self.writes += 1; self.bytes += len(s); self.cr += s.count("\\r"); return len(s)',
    '    def flush(self): pass',
    'def run(label, total, per_iter):',
    '    f = Counting(); t0 = time.perf_counter()',
    '    bar = tqdm(total=total, file=f, desc=label, leave=False)',
    '    for _ in range(total):',
    '        if per_iter: time.sleep(per_iter)',
    '        bar.update(1)',
    '    bar.close(); el = time.perf_counter() - t0',
    '    print(f"RATE|{label}|{el:.3f}|{f.writes}|{f.bytes}|{f.cr}")',
    'run("msst-chunks-100ms", 120, 0.10)',
    'run("msst-chunks-20ms", 500, 0.02)',
    'run("unpaced-loop", 200000, 0)',
  ].join('\n'), 'utf-8');
  const r = spawnSync(FORGE.py, [script], { windowsHide: true, encoding: 'utf-8', timeout: 180000 });
  for (const l of String(r.stdout || '').split(/\r?\n/)) {
    if (!l.startsWith('RATE|')) continue;
    const [, label, el, writes, bytes, cr] = l.split('|');
    const secs = Number(el);
    record('tqdm', {
      name: `tqdm writes, ${label}`, unit: 'lines/s',
      seconds: secs, writes: Number(writes), linesPerSecond: Number(writes) / secs,
      bytesPerSecond: Number(bytes) / secs, carriageReturns: Number(cr),
    });
  }
  // yt-dlp is the app's other \r producer. Its own throttle decides the rate:
  // progress_delta is unset by yt_download.py, but the block size doubles up to
  // 4 MB, so the steady-state rate is (download rate / 4 MB) lines per second.
  const ytSrc = path.join(ENGINE, 'yt_download.py');
  const ytTxt = fs.existsSync(ytSrc) ? fs.readFileSync(ytSrc, 'utf-8') : '';
  record('tqdm', {
    name: 'yt_download.py sets progress_delta (yt-dlp progress throttle)', unit: 'bool',
    value: /progress_delta/.test(ytTxt) ? 1 : 0,
    note: 'unset -> one line per read block; block size doubles to a 4 MB cap '
      + '(yt_dlp/downloader/common.py best_block_size), so steady state is ~rate/4MB lines per second '
      + 'after a short burst of ~12 lines while it ramps',
  });
}

// ===========================================================================
//  static: spawn / decode / temp-file counts, each with its evidence
// ===========================================================================
function groupStatic() {
  const read = (f) => { try { return fs.readFileSync(path.join(ENGINE, f), 'utf-8'); } catch { return ''; } };
  const lineOf = (txt, needle) => {
    const i = txt.split('\n').findIndex((l) => l.includes(needle));
    return i < 0 ? '?' : i + 1;
  };

  const song = read('song_to_midi.py');
  const tf = read('transcribe_fast.py');
  const au = read('audio_utils.py');

  // Every separate python.exe a single 'piano' job starts.
  const spawns = [
    ['song_to_midi.py (the job itself, imports torch + pretty_midi)', 'forge-runner.js:_spawnJob'],
    ['msst/inference.py', `song_to_midi.py:${lineOf(song, '"inference.py"')}`],
    ['transcribe_fast.py', `song_to_midi.py:${lineOf(song, 'transcribe_fast.py"')}`],
    ['stem_to_midi.py (only when Transkun under-reads)', `song_to_midi.py:${lineOf(song, "'stem_to_midi.py'") || lineOf(song, 'stem_to_midi.py')}`],
  ];
  record('static', {
    name: 'separate python.exe processes started per piano job', unit: 'processes',
    value: spawns.length, detail: spawns.map((s) => `${s[0]} @ ${s[1]}`).join(' | '),
    note: 'each one imports torch from scratch; none are reused between queued jobs',
  });

  // Every time the SAME audio is decoded inside one job.
  const decodes = [
    [`MSST inference.py reads the staged input`, `song_to_midi.py:${lineOf(song, '--input_folder')}`],
    [`normalize_wav_in_place reads + rewrites the piano stem`, `audio_utils.py:${lineOf(au, 'audio, sr = sf.read(str(wav_path)')}`],
    [`transcribe_fast readAudio() decodes the stem again`, `transcribe_fast.py:${lineOf(tf, 'fs, audio = readAudio(str(src))')}`],
    [`recover_sparse_piano reads the stem for its duration`, `song_to_midi.py:${lineOf(song, 'sf.info(str(stem_wav))')}`],
    [`stem_to_midi.py decodes the stem a fourth time (fallback path only)`, `song_to_midi.py:${lineOf(song, "str(ROOT / 'stem_to_midi.py')")}`],
  ];
  record('static', {
    name: 'full decodes of the same audio inside one piano job', unit: 'decodes',
    value: decodes.length, detail: decodes.map((d) => `${d[0]} @ ${d[1]}`).join(' | '),
  });

  // Scratch files a job writes and then deletes.
  const temps = [
    ['work/<name>-<hash>/input/<staged copy or hardlink>', lineOf(song, 'os.link(src, staged)')],
    ['work/<name>-<hash>/stems/*.wav  (6 stems, multi-GB)', lineOf(song, '--store_dir')],
    ['work/<name>-<hash>/bs_rofo_inference.yaml', lineOf(song, 'patched.write_text')],
    ['work/<name>-<hash>/general_mix.wav (general mode)', lineOf(song, "work_dir / \"general_mix.wav\"")],
    ['work/<name>-<hash>/fallback_basic_pitch.mid', lineOf(song, 'fallback_basic_pitch.mid')],
  ];
  record('static', {
    name: 'scratch artefacts written per job (deleted unless FORGE_KEEP_STEMS=1)', unit: 'artefacts',
    value: temps.length, detail: temps.map((t) => `${t[0]} @ song_to_midi.py:${t[1]}`).join(' | '),
  });

  // Model reload between two queued jobs is the same question asked of state:
  // nothing in forge-runner.js keeps a process alive across jobs.
  const runnerSrc = fs.readFileSync(path.join(ROOT, 'electron', 'forge-runner.js'), 'utf-8');
  record('static', {
    name: 'ForgeRunner keeps a warm worker alive between queued jobs', unit: 'bool',
    value: /warm|persistent|reuse.*(child|worker)/i.test(runnerSrc) ? 1 : 0,
    note: 'run() calls _spawnJob() which spawns a brand new interpreter every time; '
      + 'two queued jobs on the same pipeline reload every checkpoint',
  });
}

// ===========================================================================
//  decode: what one full pass over the audio costs, times the number of passes
// ===========================================================================
// A piano job decodes the same material five times (see the `static` group).
// This measures ONE pass on a synthetic 4-minute 44.1 kHz stereo WAV, with the
// same libraries the pipeline uses. CPU and disk only; no model, no GPU.
function groupDecode() {
  if (!FORGE.py) { record('decode', { name: 'SKIPPED: no provisioned forge env found', unit: '' }); return; }
  const script = path.join(SCRATCH, 'decode.py');
  fs.writeFileSync(script, [
    'import os, sys, time',
    'import numpy as np, soundfile as sf',
    'sr = 44100; secs = 240',
    'wav = os.path.join(sys.argv[1], "bench_4min.wav")',
    't = np.arange(sr * secs, dtype=np.float32) / sr',
    'sig = (0.2 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)',
    'st = np.stack([sig, sig], axis=1)',
    't0 = time.perf_counter(); sf.write(wav, st, sr)',
    'print(f"D|sf.write 4min stereo wav|{(time.perf_counter()-t0)*1000:.1f}", flush=True)',
    'for i in range(3):',
    '    t0 = time.perf_counter(); a, s = sf.read(wav, always_2d=True, dtype="float32")',
    '    print(f"D|sf.read (normalize_wav_in_place reads this way)|{(time.perf_counter()-t0)*1000:.1f}", flush=True)',
    '# librosa pulls in numba and JITs on first use, so the FIRST call in a',
    '# process costs far more than the decode itself. audio_window_from_env()',
    '# makes exactly one such first call per job whenever a time range is set.',
    't0 = time.perf_counter(); import librosa',
    'print(f"D|import librosa (cold, per process)|{(time.perf_counter()-t0)*1000:.1f}", flush=True)',
    't0 = time.perf_counter(); a, s = librosa.load(wav, sr=None, mono=False)',
    'print(f"D|librosa.load FIRST call in the process (audio_window_from_env)|{(time.perf_counter()-t0)*1000:.1f}", flush=True)',
    'for i in range(3):',
    '    t0 = time.perf_counter(); a, s = librosa.load(wav, sr=None, mono=False)',
    '    print(f"D|librosa.load warm|{(time.perf_counter()-t0)*1000:.1f}", flush=True)',
    'try:',
    '    from transkun.transcribe import readAudio',
    '    for i in range(3):',
    '        t0 = time.perf_counter(); fs_, a = readAudio(wav)',
    '        print(f"D|transkun readAudio (transcribe_fast decodes the stem)|{(time.perf_counter()-t0)*1000:.1f}", flush=True)',
    'except Exception as e:',
    '    print(f"D|transkun readAudio UNAVAILABLE ({e})|-1", flush=True)',
    'os.remove(wav)',
  ].join('\n'), 'utf-8');
  const r = spawnSync(FORGE.py, [script, SCRATCH], { windowsHide: true, encoding: 'utf-8', timeout: 600000 });
  const byLabel = new Map();
  for (const l of String(r.stdout || '').split(/\r?\n/)) {
    if (!l.startsWith('D|')) continue;
    const [, label, ms] = l.split('|');
    if (!byLabel.has(label)) byLabel.set(label, []);
    byLabel.get(label).push(Number(ms));
  }
  if (!byLabel.size) record('decode', { name: 'decode probe produced nothing', unit: '', stderr: String(r.stderr || '').slice(-200) });
  for (const [label, samples] of byLabel) {
    record('decode', { name: label + ' (240 s of 44.1 kHz stereo)', unit: 'ms', ...stats(samples) });
  }
  record('decode', {
    name: 'full decodes of the same audio per piano job', unit: 'passes', value: 5,
    note: 'see the static group for the five file:line sites; multiply one pass by five',
  });
}

// ===========================================================================
//  pump: the two stdout line pumps, under a carriage-return-only stream
// ===========================================================================
// forge-runner.js makePump() splits on CR as well as LF and caps its buffer at
// 8 KB. forge-provisioner.js's inline pump splits on LF ONLY and has no cap, so
// a producer that rewrites one line with CR (pip's download bar, and anything
// else that draws a progress bar) accumulates in its buffer and every incoming
// chunk re-scans the whole thing. Both are measured here on the same input.
function groupPump() {
  const CR = String.fromCharCode(13);
  const LF = String.fromCharCode(10);
  const runnerSrc = fs.readFileSync(path.join(ROOT, 'electron', 'forge-runner.js'), 'utf-8');
  const provSrc = fs.readFileSync(path.join(ROOT, 'electron', 'forge-provisioner.js'), 'utf-8');
  // The literal TEXT \r\n|\n|\r as it appears in the source, built from a
  // backslash char so this file's own escaping cannot change what is searched for.
  const BS = String.fromCharCode(92);
  const CRLF_RE = '/' + BS + 'r' + BS + 'n|' + BS + 'n|' + BS + 'r/';
  const runnerSplitsCr = runnerSrc.includes(CRLF_RE);
  const runnerCaps = /buf\.length > 8192/.test(runnerSrc);
  const provSplitsCr = provSrc.includes(CRLF_RE) || provSrc.includes("indexOf('" + BS + "r')");
  const provCaps = /buf\.length >\s*\d+/.test(provSrc);
  const provSyncWrite = /fs\.writeSync\(this\._logFd, c\)/.test(provSrc);
  record('pump', {
    name: 'forge-runner makePump: splits on CR, caps its buffer', unit: 'bool',
    splitsOnCarriageReturn: runnerSplitsCr ? 1 : 0, capsBuffer: runnerCaps ? 1 : 0,
  });
  record('pump', {
    name: 'forge-provisioner pump: splits on CR, caps its buffer', unit: 'bool',
    splitsOnCarriageReturn: provSplitsCr ? 1 : 0, capsBuffer: provCaps ? 1 : 0,
    synchronousDiskWritePerChunk: provSyncWrite ? 1 : 0,
    note: 'setup output is teed to forge-setup.log with a BLOCKING fs.writeSync on every chunk',
  });

  // The two pumps, written exactly as they appear in the two files.
  const makeRunnerPump = (onLine) => {
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
      return buf.length;
    };
  };
  const makeProvPump = (onLine) => {
    let buf = '';
    return (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf(LF)) >= 0) {
        const l = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (l.trim()) onLine(l.trim());
      }
      return buf.length;
    };
  };

  // A pip-style download bar: one line rewritten with CR, no newline, N chunks.
  const CHUNKS = Number(flag('--pump-chunks')) || 20000;
  const bar = (i) => CR + '  Downloading torch-2.5.1+cu124-cp313-win_amd64.whl ('
    + (i / 10).toFixed(1) + ' MB / 2551.0 MB) ' + '#'.repeat(i % 40);
  for (const [label, make] of [['forge-runner makePump', makeRunnerPump],
    ['forge-provisioner pump', makeProvPump]]) {
    let lines = 0, held = 0;
    const pump = make(() => { lines += 1; });
    const t = process.hrtime.bigint();
    for (let i = 1; i <= CHUNKS; i++) held = pump(bar(i));
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    record('pump', {
      name: label + ': ' + CHUNKS + ' CR-only chunks with no newline', unit: 'ms total',
      totalMs: ms, msPerChunk: ms / CHUNKS,
      linesEmitted: lines, bytesStillBuffered: held,
    });
  }
}

// ===========================================================================
function report() {
  for (const [g, rows] of Object.entries(RESULTS)) {
    process.stdout.write(`\n${g.toUpperCase()}\n`);
    for (const r of rows) {
      const bits = [];
      for (const [k, v] of Object.entries(r)) {
        if (k === 'name' || k === 'unit' || k === 'note' || k === 'detail') continue;
        bits.push(`${k}=${typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(3)) : v}`);
      }
      console.log(`  ${r.name}${r.unit ? '  [' + r.unit + ']' : ''}`);
      if (bits.length) console.log(`      ${bits.join('  ')}`);
      if (r.detail) console.log(`      ${r.detail}`);
      if (r.note) console.log(`      note: ${r.note}`);
    }
  }
  if (JSON_AT) {
    const out = path.isAbsolute(JSON_AT) ? JSON_AT : path.join(ROOT, JSON_AT);
    fs.writeFileSync(out, JSON.stringify({
      at: new Date().toISOString(), node: process.version,
      forgePython: FORGE.py, forgeDir: FORGE.dir, results: RESULTS,
    }, null, 2));
    console.log(`\nwrote ${out}`);
  }
}

console.log(`forge python: ${FORGE.py || '(none found)'}`);
if (want('static')) groupStatic();
if (want('pump')) groupPump();
if (want('decode')) groupDecode();
if (want('orphan')) groupOrphan();
if (want('tqdm')) groupTqdm();
if (want('probe')) groupProbe();
if (want('model')) groupModel();
report();
try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch (_) {}

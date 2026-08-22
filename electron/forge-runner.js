// forge-runner.js — drives the Midi-Forge pipeline scripts as cancellable child
// jobs under the FORGE-ENV interpreter (never the player python). Streams coarse,
// honest progress to the renderer via the injected emit() callback.
'use strict';

const { spawn } = require('child_process');
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
  if (skipSeparation) return ['transcribe.py', STAGES_2];   // input is already a stem
  if (pipeline === 'fast') return ['stem_to_midi.py', STAGES_2];  // basic-pitch, quick/rough
  // 'piano' and 'general' both separate + Transkun; GENERAL_MODE (set in run())
  // makes 'general' mix every pitched stem instead of only the piano stem.
  return ['song_to_midi.py', STAGES_3];
}

function parseTimeSeconds(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function outputMidiPath(inputPath, timing) {
  const extless = inputPath.replace(/\.[^./\\]+$/, '');
  const start = timing && parseTimeSeconds(timing.start);
  const end = timing && parseTimeSeconds(timing.end);
  if (start == null && end == null) return extless + '.mid';
  const fmt = (n) => String(Math.round(n * 1000) / 1000).replace(/\./g, 'p');
  const suffix = `_range_${fmt(start || 0)}_${end != null ? fmt(end) : 'end'}`;
  return extless + suffix + '.mid';
}

class ForgeRunner {
  constructor({ emit, getSettings } = {}) {
    this._emit = emit || (() => {});
    this._getSettings = getSettings || (() => ({}));
    this._jobs = new Map();
    this._seq = 0;
  }

  isRunning() { return this._jobs.size > 0; }

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
    // Forge can saturate a GPU and several CPU cores. Keep the realtime player
    // and Electron renderer responsive while a transcription runs.
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
    let buf = '';
    const onLine = (line) => {
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
        if (line.includes(marker)) { this._emit({ event: 'forge.progress', jobId, stage, percent: pct, message: line }); return; }
      }
      for (const [re, stage, pct] of STAGE_KEYWORDS) {
        if (re.test(line)) { this._emit({ event: 'forge.progress', jobId, stage, percent: pct, message: line }); return; }
      }
      this._emit({ event: 'forge.log', jobId, line, level: /error|traceback/i.test(line) ? 'error' : 'info' });
    };
    const pump = (chunk) => { buf += chunk; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1); if (l.trim()) onLine(l.trim()); } };
    if (child.stdout) { child.stdout.setEncoding('utf-8'); child.stdout.on('data', pump); }
    if (child.stderr) { child.stderr.setEncoding('utf-8'); child.stderr.on('data', pump); }
    child.on('exit', (code) => {
      this._jobs.delete(jobId);
      if (child.__finalized) return;                       // DONE already finalized success
      if (child.__cancelled) this._emit({ event: 'forge.done', jobId, ok: false, error: 'cancelled' });
      else if (code !== 0) this._emit({ event: 'forge.done', jobId, ok: false, error: `exit code ${code}` });
      else this._emit({ event: 'forge.done', jobId, ok: false, error: 'finished without producing output' });
    });
  }

  run({ inputPath, pipeline, skipSeparation, advanced, timing }) {
    const jobId = `job-${++this._seq}`;
    const py = this._forgePython();
    if (!py) { setTimeout(() => this._emit({ event: 'forge.done', jobId, ok: false, error: 'Midi-Forge isn\'t set up yet. Click "Set up Midi-Forge".' }), 0); return jobId; }
    if (!inputPath) { setTimeout(() => this._emit({ event: 'forge.done', jobId, ok: false, error: 'No input file.' }), 0); return jobId; }
    const [script, stageTable] = selectScript(pipeline, skipSeparation);
    const env = Object.assign({}, paths.forgeChildEnv(this._settings()));
    env.SEPARATION_BATCH = env.SEPARATION_BATCH || '2';
    env.TRANSCRIBE_BATCH = env.TRANSCRIBE_BATCH || '2';
    env.OMP_NUM_THREADS = env.OMP_NUM_THREADS || '4';
    env.MKL_NUM_THREADS = env.MKL_NUM_THREADS || '4';
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
    const audioOut = outputMidiPath(inputPath, { start, end });
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
    let buf = '';
    const onLine = (line) => {
      if (line.startsWith('DOWNLOADED:')) { const p = line.split('DOWNLOADED:', 2)[1].trim(); child.__finalized = true; this._emit({ event: 'forge.progress', jobId, stage: 'Done', percent: 100, message: 'Download complete' }); this._emit({ event: 'forge.done', jobId, ok: true, result: { downloadedPath: p } }); return; }
      const m = line.match(/(\d{1,3}(?:\.\d+)?)%/); if (m) { this._emit({ event: 'forge.progress', jobId, stage: 'Download', percent: Math.max(5, Math.min(99, Math.round(parseFloat(m[1])))), message: line }); return; }
      this._emit({ event: 'forge.log', jobId, line, level: 'info' });
    };
    const pump = (c) => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1); if (l.trim()) onLine(l.trim()); } };
    if (child.stdout) { child.stdout.setEncoding('utf-8'); child.stdout.on('data', pump); }
    if (child.stderr) { child.stderr.setEncoding('utf-8'); child.stderr.on('data', pump); }
    child.on('exit', (code) => { this._jobs.delete(jobId); if (child.__finalized) return; if (child.__cancelled) this._emit({ event: 'forge.done', jobId, ok: false, error: 'cancelled' }); else if (code !== 0) this._emit({ event: 'forge.done', jobId, ok: false, error: `exit code ${code}` }); });
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

module.exports = { ForgeRunner };

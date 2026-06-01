// paths.js — centralized path resolution for the Electron main process.
// Two interpreters, kept strictly separate:
//   * PLAYER python   — tiny (mido/pynput/psutil/pywin32). Bundled or on PATH.
//                       Runs ipc_main.py (the realtime keypress engine).
//   * FORGE python    — heavy (torch/CUDA + model). Provisioned on demand into
//                       %LOCALAPPDATA%\midi-studio\forge-env. Single source of
//                       truth for the ML pipeline; adopts a legacy midi-forge env.
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { app } = require('electron');

const DEV_ROOT = path.resolve(__dirname, '..');

function isPackaged() { return !!app.isPackaged; }
function exists(p) { try { return !!p && fs.existsSync(p); } catch { return false; } }
function localAppData() {
  return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
}

function pythonEngineDir() {
  return isPackaged()
    ? path.join(process.resourcesPath, 'python-engine')
    : path.join(DEV_ROOT, 'python-engine');
}

// A light Python bundled next to the engine (built by build-portable.bat).
// Returns null in dev when not built — sidecar.js then probes PATH.
function bundledPlayerPython() {
  const p = path.join(pythonEngineDir(), 'python', 'python.exe');
  return exists(p) ? p : null;
}

// ---- forge heavy env --------------------------------------------------------

function forgeEnvDir(settings) {
  const override = settings && settings.forgeEnvDir;
  if (override) return override;
  return path.join(localAppData(), 'midi-studio', 'forge-env');
}
function legacyForgeEnvDir() { return path.join(localAppData(), 'midi-forge'); }

function _pyInDir(dir) {
  if (!dir) return null;
  for (const rel of [['python', 'python.exe'], ['python.exe'], ['Scripts', 'python.exe']]) {
    const c = path.join(dir, ...rel);
    if (exists(c)) return c;
  }
  return null;
}

// SINGLE SOURCE OF TRUTH for the heavy interpreter. null => not provisioned.
function forgeEnvPython(settings) {
  const override = settings && settings.forgePythonPath;
  if (override && exists(override)) return override;
  return _pyInDir(forgeEnvDir(settings)) || _pyInDir(legacyForgeEnvDir()) || null;
}

// Cheap readiness: interpreter resolves, torch is installed, AND a '.ready'
// marker exists (provisioning ran to completion / verify passed). The marker
// guard means a half-built env (interrupted after torch, before verify) is NOT
// treated as ready and re-provisions instead of failing every job.
function forgeEnvReady(settings) {
  const py = forgeEnvPython(settings);
  if (!py) return false;
  const dir = path.dirname(py);
  const roots = [dir, path.dirname(dir)];
  const hasTorch = roots.some((r) => exists(path.join(r, 'Lib', 'site-packages', 'torch')));
  const hasReady = roots.some((r) => exists(path.join(r, '.ready')));
  return hasTorch && hasReady;
}

function modelsDir(settings) {
  const override = settings && settings.modelsDir;
  if (override) return override;
  const inForge = path.join(forgeEnvDir(settings), 'models');
  if (exists(inForge)) return inForge;
  const legacy = path.join(legacyForgeEnvDir(), 'models');
  if (exists(legacy)) return legacy;
  return path.join(pythonEngineDir(), 'models');
}

// A persistent, user-writable home for mappings. The portable .exe re-extracts
// to a fresh temp dir each launch, so mappings kept beside the bundled ones get
// wiped; this folder lives in %APPDATA%\midi-studio and survives relaunch/update.
function userMappingsDir() {
  return path.join(app.getPath('userData'), 'mappings');
}

// Ensure the folder exists and seed it (first run only) with the bundled presets
// so it's discoverable and editable. Never overwrites existing files — user
// edits and custom mappings are preserved. Returns the directory path.
function ensureUserMappings() {
  const dir = userMappingsDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    const src = path.join(pythonEngineDir(), 'mappings');
    if (exists(src)) {
      for (const f of fs.readdirSync(src)) {
        if (!/\.json$/i.test(f)) continue;
        const dst = path.join(dir, f);
        if (!exists(dst)) { try { fs.copyFileSync(path.join(src, f), dst); } catch (_) {} }
      }
    }
  } catch (_) {}
  return dir;
}

function appIcon() {
  const ico = isPackaged()
    ? path.join(process.resourcesPath, 'build', 'icon.ico')
    : path.join(DEV_ROOT, 'build', 'icon.ico');
  return exists(ico) ? ico : null;
}

function rendererIndexHtml() {
  return isPackaged()
    ? path.join(app.getAppPath(), 'renderer', 'index.html')
    : path.join(DEV_ROOT, 'renderer', 'index.html');
}
function preloadScript() { return path.join(__dirname, 'preload.js'); }

// Env passed to the forge child processes so they find their model/ffmpeg.
function forgeChildEnv(settings) {
  const engineDir = pythonEngineDir();
  return Object.assign({}, process.env, {
    MIDI_STUDIO_MODELS_DIR: modelsDir(settings),
    MIDI_STUDIO_ENGINE_DIR: engineDir,
    MIDI_STUDIO_FORGE_ENV_DIR: forgeEnvDir(settings),
    // Forge scripts import siblings (audio_utils, analyze, ...) and the forge
    // interpreter is also an embeddable Python that omits the script dir from
    // sys.path — put the engine dir on PYTHONPATH so those imports resolve.
    PYTHONPATH: engineDir + (process.env.PYTHONPATH ? path.delimiter + process.env.PYTHONPATH : ''),
    PYTHONUNBUFFERED: '1',
    PYTHONIOENCODING: 'utf-8',
  });
}

module.exports = {
  isPackaged, exists, localAppData,
  pythonEngineDir, bundledPlayerPython,
  forgeEnvDir, legacyForgeEnvDir, forgeEnvPython, forgeEnvReady,
  modelsDir, rendererIndexHtml, preloadScript, forgeChildEnv, appIcon, DEV_ROOT,
  userMappingsDir, ensureUserMappings,
};

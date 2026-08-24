// tools/run-tests.js. Electron-free unit tests for merge-gate logic.
'use strict';
const Module = require('module');
const path = require('path');
const realLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === 'electron') return { app: { isPackaged: false, getVersion: () => '2.0.0', getPath: () => require('os').tmpdir(), getAppPath: () => process.cwd() }, shell: {} };
  return realLoad(req, parent, isMain);
};
const root = path.join(__dirname, '..');
const u = require(path.join(root, 'electron', 'updater.js'));
const p = require(path.join(root, 'electron', 'paths.js'));
const storage = require(path.join(root, 'electron', 'forge-storage.js'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL:', m); } };
const sgn = (a, b, m) => ok(Math.sign(a) === b, `${m} (got ${Math.sign(a)}, want ${b})`);

// SemVer compare (the original bug dropped -rc)
sgn(u.cmpVer('2.1.0', '2.0.0'), 1, '2.1.0 > 2.0.0');
sgn(u.cmpVer('2.0.0', '2.1.0'), -1, '2.0.0 < 2.1.0');
sgn(u.cmpVer('2.0.0', '2.0.0'), 0, 'equal');
sgn(u.cmpVer('v2.1.0', '2.0.9'), 1, 'v-prefix');
sgn(u.cmpVer('2.0.0', '2.0.0-rc1'), 1, 'release > prerelease');
sgn(u.cmpVer('2.0.0-rc2', '2.0.0-rc1'), 1, 'rc2 > rc1');
sgn(u.cmpVer('2.1.0', '2.10.0'), -1, 'numeric not lexical');

// asset selection: updates always use the full NSIS installer
const assets = [
  { name: 'MIDI-Studio-2.1.0-Setup.exe', browser_download_url: 'https://x/s', size: 1 },
  { name: 'MIDI-Studio-2.1.0-portable.exe', browser_download_url: 'https://x/p', size: 1 },
];
ok(u.pickSetupAsset(assets).name === 'MIDI-Studio-2.1.0-Setup.exe', 'picks Setup not portable');

// NEVER pass /S. This is an assisted installer and NSIS skips every page in
// silent mode, so /S does not install quietly, it re-decides the install
// directory and the Forge storage location from defaults. That relocated a
// Program Files install to a per-user one (running the old uninstaller on the
// way) and rewrote a deliberate "Forge env on D:" to a default on C:.
delete process.env.PORTABLE_EXECUTABLE_FILE;
ok(u.installerArgs().length === 0, 'installed build shows the wizard, never /S');
process.env.PORTABLE_EXECUTABLE_FILE = '/tmp/MIDI-Studio-portable.exe';
ok(u.installerArgs().length === 0, 'portable build runs the installer visibly');
delete process.env.PORTABLE_EXECUTABLE_FILE;
ok(!/'\/S'|"\/S"/.test(require('fs').readFileSync(path.join(root, 'electron', 'updater.js'), 'utf8')),
  'no /S anywhere in the updater');

// The installer must not overwrite a Forge storage choice it never asked about.
{
  const nsh2 = require('fs').readFileSync(path.join(root, 'build', 'installer.nsh'), 'utf8');
  ok(/\$\{If\} \$\{Silent\}/.test(nsh2), 'customInstall guards the registry write on silent mode');
  ok(/ExistingForgeStorage/.test(nsh2), 'installer reads the existing Forge storage before deciding');
}

// The self-kill regression. The updater starts the installer, so the installer
// is in MIDI Studio's process tree. Two things must stay true or "check for
// updates" closes the app and silently installs nothing:
//   1. the installer's app-close step must not use taskkill /t (kills the tree,
//      and the installer is IN that tree)
//   2. the updater must not spawn the installer directly on Windows
{
  const fsx = require('fs');
  const nsh = fsx.readFileSync(path.join(root, 'build', 'installer.nsh'), 'utf8');
  const killLine = nsh.split('\n').find((l) => /taskkill/i.test(l) && /APP_EXECUTABLE_FILENAME/.test(l)) || '';
  ok(killLine !== '', 'installer.nsh still closes the running app');
  ok(!/\/t\b/i.test(killLine), 'installer app-close does NOT use taskkill /t (would kill the installer itself)');

  const up = fsx.readFileSync(path.join(root, 'electron', 'updater.js'), 'utf8');
  const launch = up.slice(up.indexOf('function launchInstaller'), up.indexOf('let cached'));
  ok(/Start-Process/.test(launch), 'launchInstaller hands the launch to Start-Process');
  ok(/process\.platform !== 'win32'/.test(launch), 'launchInstaller only spawns directly off Windows');
}

// Torch's OpenMP pool spin-waits by default, which pins every core at 100%
// between parallel regions and makes the whole app stutter while a song
// transcribes. Below-normal priority does not help: a spinning thread never
// yields. These two have to stay set.
{
  const fsx = require('fs');
  const runner = fsx.readFileSync(path.join(root, 'electron', 'forge-runner.js'), 'utf8');
  ok(/OMP_WAIT_POLICY.*PASSIVE/.test(runner), 'forge children run OpenMP with a passive wait policy');
  ok(/KMP_BLOCKTIME.*'0'/.test(runner), 'forge children set KMP_BLOCKTIME=0');
}

// A bad Forge path must never beat a working one. 2.20.0's silent update wrote
// a computed default into the installer registry value; adopting that pointed
// provisioned installs at an empty folder and reported "torch missing".
{
  const fsx = require('fs');
  const m = fsx.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8');
  ok(/ignored installer Forge storage/.test(m), 'adopt refuses an unprovisioned installer path over a working one');
  ok(/function recoverForgeEnv/.test(m), 'startup can recover a Forge env that moved');
  ok(/recoverForgeEnv\(\);/.test(m), 'recoverForgeEnv actually runs at startup');
  const pj = fsx.readFileSync(path.join(root, 'electron', 'paths.js'), 'utf8');
  ok(/function findReadyForgeEnv/.test(pj), 'paths can search for a provisioned env');
}

// Forge layouts. The blocks are MOVED between arrangements rather than
// duplicated, so the markup must contain exactly one of each control and the
// classic layout must be restorable from the original child order.
{
  const fsx = require('fs');
  const html = fsx.readFileSync(path.join(root, 'renderer', 'forge', 'index.html'), 'utf8');
  const js = fsx.readFileSync(path.join(root, 'renderer', 'forge', 'forge.js'), 'utf8');
  for (const id of ['dropzone', 'pipeline', 'queue-wrap', 'waveform', 'adv', 'log', 'start']) {
    const n = (html.match(new RegExp('id="' + id + '"', 'g')) || []).length;
    ok(n === 1, `forge markup has exactly one #${id} (found ${n})`);
  }
  ok(/const LAYOUTS = \['classic', 'cards', 'bench', 'console'\]/.test(js), 'all four layouts are offered');
  ok(/applyLayout\('classic'\)/.test(js), 'classic is the fallback layout');
  ok(/original = \[\.\.\.work\.children\]/.test(js), 'classic is restored from the original child order');
  // classic must put the preview/advanced trio back by appending, not by
  // insertBefore a sibling that may itself have moved into another lane.
  ok(/for \(const node of \[b\.time, b\.advToggle, b\.adv\]\) if \(node\) b\.pipeline\.appendChild\(node\)/.test(js),
    'classic restore does not depend on a sibling that may have moved');

  const shell = fsx.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
  for (const id of ['s-forge-layout', 'snav', 's-perf-percent', 's-forgedir', 's-theme', 's-recheck']) {
    ok(shell.includes('id="' + id + '"'), `settings still has #${id}`);
  }
  const panes = (shell.match(/class="spane[^"]*" data-pane=/g) || []).length;
  const navs = (shell.match(/data-pane="[a-z]+"/g) || []).length;
  ok(panes === 5, `settings has 5 panes (found ${panes})`);
  ok(navs === panes * 2, `every settings pane has a nav button (${navs} refs for ${panes} panes)`);
}

// verifyDigest, verifies a file against GitHub's per-asset "sha256:<hex>" digest
(async () => {
  const os = require('os'); const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
  const f = path.join(os.tmpdir(), `ms-digest-test-${process.pid}`);
  fs.writeFileSync(f, 'hello midi studio');
  const sha = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  ok(await u.verifyDigest(f, 'sha256:' + sha) === true, 'verifyDigest accepts matching digest');
  ok(await u.verifyDigest(f, '') === false, 'verifyDigest returns false when digest absent');
  let threw = false; try { await u.verifyDigest(f, 'sha256:' + 'ab'.repeat(32)); } catch { threw = true; }
  ok(threw, 'verifyDigest throws on mismatch');
  try { fs.unlinkSync(f); } catch {}

  // Forge storage can move to another user-selected location without touching
  // folders that are not explicitly managed by MIDI Studio.
  const base = path.join(os.tmpdir(), `ms-forge-storage-test-${process.pid}`);
  const source = path.join(base, 'default-forge-env');
  const destinationParent = path.join(base, 'another-drive');
  const destination = storage.targetForSelection(destinationParent);
  storage.markManaged(source);
  fs.mkdirSync(path.join(source, 'models'), { recursive: true });
  fs.writeFileSync(path.join(source, 'models', 'model.bin'), 'model');
  ok(storage.isManaged(source), 'managed Forge marker recognized');
  ok(path.basename(destination) === storage.FOLDER_NAME, 'storage selection gets dedicated subfolder');
  await storage.moveManaged(source, destination, source);
  ok(!fs.existsSync(source) && fs.existsSync(path.join(destination, 'models', 'model.bin')), 'managed Forge storage moves intact');
  const unrelated = path.join(base, 'unrelated');
  fs.mkdirSync(unrelated, { recursive: true });
  let refused = false;
  try { await storage.moveManaged(unrelated, path.join(base, 'refused')); } catch { refused = true; }
  ok(refused && fs.existsSync(unrelated), 'unmanaged folder move refused');

  const configuredSource = path.join(base, 'configured-source');
  const configuredTarget = path.join(base, 'configured-target');
  storage.markManaged(configuredSource);
  fs.writeFileSync(path.join(configuredSource, '.ready'), 'ready');
  let saved = null;
  const fakeSettings = { merge: (patch) => { saved = patch; } };
  const configured = await storage.configure(fakeSettings, configuredTarget, configuredSource, configuredSource);
  ok(configured.moved && fs.existsSync(path.join(configuredTarget, '.ready')), 'installer storage choice migrates managed files');
  ok(saved && saved.paths.forgeEnvDir === configuredTarget, 'installer storage choice is persisted');

  // Editing a plain .mid must never write back over the user's own file.
  const taken = new Set([path.join('C:', 'out', 'song_clean.mid').toLowerCase()]);
  const fakeExists = (p) => taken.has(String(p).toLowerCase());
  ok(storage.candidateTarget({ existing: path.join('C:', 'songs', 'mine.mid'), projectDir: path.join('C:', 'out'),
    fromProject: false, fallbackName: 'song_clean.mid' }, fakeExists) === path.join('C:', 'out', 'song_clean (2).mid'),
    'a plain .mid is never overwritten, and the fallback name is de-duplicated');
  ok(storage.candidateTarget({ existing: path.join('C:', 'songs', 'mine.mid'), projectDir: path.join('C:', 'out'),
    fromProject: true, fallbackName: 'x.mid' }, fakeExists) === path.join('C:', 'songs', 'mine.mid'),
    'a real project keeps writing to its own candidate files');
  ok(storage.candidateTarget({ existing: path.join('C:', 'out', 'a_clean.mid'), projectDir: path.join('C:', 'out'),
    fromProject: false, fallbackName: 'x.mid' }, fakeExists) === path.join('C:', 'out', 'a_clean.mid'),
    'a candidate already inside the project folder is written in place');
  ok(storage.uniquePath(path.join('C:', 'out', 'free.mid'), fakeExists) === path.join('C:', 'out', 'free.mid'),
    'a free name is left alone');

  // The melody shaper has its own assert-based self-check; run it if a python
  // with pretty_midi is around (the Forge env). Skipped, not failed, otherwise.
  const { execFileSync } = require('child_process');
  const shaper = path.join(root, 'python-engine', 'melody_shape.py');
  const pys = [path.join(process.env.LOCALAPPDATA || '', 'midi-studio', 'forge-env', 'python', 'python.exe')];
  const py = pys.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
  if (py) {
    let out = '';
    try { out = execFileSync(py, [shaper], { encoding: 'utf-8', timeout: 60000 }); } catch (e) { out = String((e && e.stdout) || '') + String((e && e.stderr) || ''); }
    ok(/melody_shape demo: OK/.test(out), 'melody shaper self-check: ' + out.trim().slice(-120));
  } else {
    console.log('  (skipped melody shaper self-check: no forge python)');
  }

  const installer = fs.readFileSync(path.join(root, 'build', 'installer.nsh'), 'utf-8');
  const pkg = require(path.join(root, 'package.json'));
  const lock = require(path.join(root, 'package-lock.json'));
  ok(/^\d+\.\d+\.\d+$/.test(pkg.version), 'package version is semver');
  ok(lock.version === pkg.version && lock.packages[''].version === pkg.version, 'package-lock version matches package.json');
  ok(pkg.build.nsis.include === 'build/installer.nsh', 'NSIS includes custom Forge storage page');
  // The installer records the choice; the app applies it on first run. It must
  // NOT launch the app itself - that broke shortcut creation and left a process
  // behind for the next install's "app is running" check.
  ok(installer.indexOf('WriteRegStr HKCU') >= 0 && installer.indexOf('ForgeStorageDir') >= 0,
    'installer records the Forge storage choice');
  ok(installer.indexOf('$appExe') < 0, 'installer does not launch the app during install');
  try { fs.rmSync(base, { recursive: true, force: true }); } catch {}

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

// paths: forge resolution
ok(typeof p.forgeEnvReady({}) === 'boolean', 'forgeEnvReady boolean');
const fp = p.forgeEnvPython({});
ok(fp === null || typeof fp === 'string', 'forgeEnvPython string|null');
const env = p.forgeChildEnv({});
ok(typeof env.MIDI_STUDIO_FORGE_ENV_DIR === 'string' && env.MIDI_STUDIO_FORGE_ENV_DIR.length > 0, 'forgeChildEnv has env dir');
// (the async verifyDigest IIFE above prints the final pass/fail + exits)

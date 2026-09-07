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

  // The rewritten settings sheet: #set-nav + eight .set-pane sections. The four
  // Forge layouts and their picker (#s-forge-layout) are gone on purpose, and
  // the old #snav is now #set-nav, so neither may come back.
  const shell = fsx.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
  for (const id of ['set-nav', 'set-panes', 's-perf-percent', 's-forgedir', 's-theme', 's-recheck']) {
    ok(shell.includes('id="' + id + '"'), `settings still has #${id}`);
  }
  ok(!shell.includes('id="s-forge-layout"'), 'the removed Forge layout picker has not come back');
  const panes = (shell.match(/class="set-pane[^"]*" data-pane=/g) || []).length;
  const navs = (shell.match(/data-pane="[a-z]+"/g) || []).length;
  ok(panes === 8, `settings has 8 panes (found ${panes})`);
  ok(navs === panes * 2, `every settings pane has a nav button (${navs} refs for ${panes} panes)`);
}

// Slow-machine races. A fast PC always wins these, so they only ever showed up
// as "it opens white" and "the updater never appears" from one user.
{
  const fsx = require('fs');
  const m = fsx.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8');
  ok(/winPainted/.test(m), 'window tracks whether it has painted');
  ok(/if \(winPainted && !win\.isVisible\(\)\) win\.show\(\)/.test(m),
    'second-instance never shows an unpainted (white) window');
  ok(/lastUpdateStatus/.test(m), 'update status is remembered for a late renderer');
  ok(/did-finish-load[\s\S]{0,200}lastUpdateStatus/.test(m),
    'a renderer that loads late is told the update status it missed');
  ok(/loadAttempts <= 2/.test(m), 'a failed renderer load is retried before giving up');
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
  // Relative to the repo root, so a test reads like the path it is checking.
  const read = (rel) => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');

  // ---- always-on-top -----------------------------------------------------
  const settingsSrc = read('electron/settings.js');
  const mainSrc = read('electron/main.js');
  ok(/alwaysOnTop:\s*true/.test(settingsSrc), 'always-on-top defaults to on');
  ok(/alwaysOnTop:\s*settings\.get\('ui\.alwaysOnTop'\)\s*!==\s*false/.test(mainSrc),
    'the window is created with the saved always-on-top choice');
  ok(/win\.setAlwaysOnTop\(ui\.alwaysOnTop !== false\)/.test(mainSrc),
    'toggling always-on-top applies without a restart');
  ok(read('renderer/index.html').includes('id="s-ontop"'), 'settings has the always-on-top control');
  // The shell drives every switch through wireSwitch(id, fn), so that is what
  // "wired" looks like now; grepping for a bare $('s-ontop') found nothing while
  // the control worked end to end.
  ok(/wireSwitch\('s-ontop',/.test(read('renderer/shell/shell.js')),
    'the always-on-top control is wired');

  // ---- Perch, the overlay -------------------------------------------------
  const ovSrc = read('electron/overlay.js');
  const ovJs = read('renderer/overlay/overlay.js');
  const ovHtml = read('renderer/overlay/overlay.html');
  const ovCss = read('renderer/overlay/overlay.css');
  ok(/setAlwaysOnTop\(true, 'screen-saver'\)/.test(ovSrc),
    "overlay uses the screen-saver level, the only one that beats a fullscreen game");
  ok(/showInactive\(\)/.test(ovSrc) && !/\bthis\.win\.show\(\)/.test(ovSrc),
    'overlay never steals focus (taking it would pause playback)');
  ok(/setIgnoreMouseEvents/.test(ovSrc), 'overlay supports click-through');
  ok(/Control\+Alt\+P/.test(mainSrc), 'a global key can undo click-through');
  ok(/onScreen/.test(ovSrc) && /getAllDisplays/.test(ovSrc),
    'a saved position is checked against the displays that exist now');
  ok(/overlay\.close\(\)/.test(mainSrc), 'the overlay is closed with the app');
  // window.api and window.perch are both injected into this frame; a top-level
  // const of either name is a redeclaration that kills the whole script.
  ok(!/^const (api|perch)\s*=/m.test(ovJs), 'overlay declares no name the preload already owns');
  ok(/window\.perch/.test(ovJs), 'overlay talks to the main process through its own bridge');
  for (const m of ['full', 'slim', 'mini']) {
    ok(ovHtml.includes(`data-mode="${m}"`), `overlay offers the ${m} size`);
    ok(ovCss.includes(`data-mode="${m}"`), `overlay styles the ${m} size`);
  }
  ok(ovHtml.split('data-snap=').length - 1 === 9, 'overlay parks in all nine screen positions');
  // .seg is a shared component in tokens.css with a radio-dot ::before; reusing
  // the class name drew that dot straight through the overlay's own labels.
  ok(!/class="seg"/.test(ovHtml), 'overlay does not reuse the shared .seg component');

  // ---- icons --------------------------------------------------------------
  const iconsSrc = read('renderer/shared/icons.js');
  ok(/window\.Icon|global\.Icon/.test(iconsSrc), 'the icon set is exposed');
  for (const name of ['play', 'pause', 'stop', 'next', 'prev', 'close', 'gear', 'check']) {
    ok(iconsSrc.includes(`${name}:`) || iconsSrc.includes(`'${name}'`), `icon set has ${name}`);
  }
  ok(/button\[role="radio"\][\s\S]*appearance: none/.test(read('renderer/shared/tokens.css')),
    'role=radio buttons do not get a native radio widget painted over them');
  for (const page of ['renderer/index.html', 'renderer/player/index.html',
    'renderer/forge/index.html', 'renderer/audition/index.html',
    'renderer/review/index.html', 'renderer/overlay/overlay.html']) {
    ok(read(page).includes('icons.js'), `${page} loads the icon set`);
  }
  // The glyphs the icon set replaced. A font-dependent character is not an icon:
  // some of these render as full-colour emoji on Windows.
  for (const page of ['renderer/index.html', 'renderer/player/index.html',
    'renderer/forge/index.html', 'renderer/overlay/overlay.html']) {
    const src = read(page);
    for (const glyph of ['▶', '⏸', '■', '⏭', '⏮', '⚙', '✕', '✖', '✓']) {
      ok(!src.includes(glyph), `${page} has no bare ${escape(glyph)} glyph`);
    }
  }

  // ---- tempo as BPM -------------------------------------------------------
  const playerJs = read('renderer/player/app.js');
  ok(/function setBpm/.test(playerJs), 'tempo can be set as a BPM number');
  ok(/bpm_estimate/.test(playerJs), 'the onset-based tempo estimate reaches the UI');
  ok(read('renderer/player/index.html').includes('id="tempo-bpm"'), 'the BPM field exists');
  ok(read('python-engine/ipc_main.py').includes('"bpm_estimate"'), 'the engine reports a tempo estimate');

  // ---- hotkeys can be unbound --------------------------------------------
  ok(!/playHotkey = hk\(els\.hkPlay\) \|\| /.test(playerJs),
    'clearing Play/Stop/Pause is respected instead of springing back to F6/F7/F8');
  ok(/hk-clear/.test(playerJs) && /hk-clear/.test(read('renderer/player/style.css')),
    'every hotkey box has a visible unbind');
  ok(/els\.hkNext, els\.hkPrev/.test(playerJs),
    'the next/prev hotkey boxes capture keys (they were never wired)');

  // ---- playback fixes -----------------------------------------------------
  const engineSrc = read('python-engine/midi_player.py');
  ok(/def make_resolver/.test(engineSrc), 'out-of-range notes fold by octave instead of being dropped');
  ok(/time\.sleep\(0\.025\)/.test(engineSrc), 'the focus monitor polls fast enough not to leak keystrokes');
  ok(/_spin_until/.test(engineSrc), 'a re-articulated note is separated from its own release');
  ok(/def panic_release/.test(read('python-engine/ipc_main.py')),
    'stdin EOF releases held keys instead of leaving them down');
  ok(/60 \* percent \/ 100/.test(mainSrc), 'the draw budget allows 60fps at full allowance');
  ok(/Math\.min\(base, 33\)/.test(playerJs), 'the roll keeps 30fps while notes are moving');

  // ---- resizable panes ----------------------------------------------------
  const resizeSrc = read('renderer/shared/resize.js');
  ok(/window\.Resize|global\.Resize/.test(resizeSrc), 'the resize component is exposed');
  // Every tab is a separate frame sharing one localStorage. Writing a whole
  // snapshot back erased the other tabs' saved sizes.
  ok(/function remember/.test(resizeSrc) && !/save\(sizes\)/.test(resizeSrc),
    'pane sizes merge into the store instead of overwriting it');
  ok(/aria-orientation/.test(resizeSrc) && /ArrowLeft/.test(resizeSrc),
    'dividers are reachable from the keyboard');
  for (const page of ['renderer/player/index.html', 'renderer/forge/index.html',
    'renderer/review/index.html', 'renderer/audition/index.html']) {
    ok(read(page).includes('resize.js'), `${page} loads the resize component`);
  }
  for (const [page, prop] of [['renderer/player/index.html', 'side'],
    ['renderer/review/index.html', 'wave'], ['renderer/audition/index.html', 'side']]) {
    ok(read(page).includes(`data-resize="${prop}"`), `${page} has a --${prop} divider`);
  }
  for (const [sheet, prop] of [['renderer/player/style.css', 'side'],
    ['renderer/review/review.css', 'wave'], ['renderer/audition/audition.css', 'side'],
    ['renderer/forge/forge.css', 'rail']]) {
    ok(read(sheet).includes(`var(--${prop}`), `${sheet} drives its grid from --${prop}`);
  }
  // Dividers live on the grid, not inside a lane, so the lane cleanup missed
  // them: they piled up and appeared in the single-column layouts.
  ok(/> \.grip-h, :scope > \.grip-v'\)\) stale\.remove\(\)/.test(read('renderer/forge/forge.js')),
    'the forge layout engine clears its dividers before rebuilding');

  // ---- melody: dense electronic ------------------------------------------
  const shapeSrc = read('python-engine/melody_shape.py');
  ok(/class TempoMap/.test(shapeSrc),
    'the shaper measures local tempo (this material changes speed mid-track)');
  ok(/def merge_repeats\(notes, tempo_map\)/.test(shapeSrc),
    'repeat-merging is grid-aware, so a 32nd repeated-note riff is not one held note');
  ok(/_GHOST_INTERVALS/.test(shapeSrc) && /\b7:/.test(shapeSrc),
    'a supersaw stack has its fifth partial removed, not just its octave');
  ok(/def _metrical_weight/.test(shapeSrc), 'density thinning keeps the beat, not the loudest');
  ok(/dynamics \* 0\.35/.test(shapeSrc), 'the lead line prefers to stay on one layer');

  // ---- drums -------------------------------------------------------------
  const drumSrc = read('python-engine/drums_to_midi.py');
  ok(/GAP_SCALE/.test(drumSrc),
    'each drum has its own retrigger gap (one figure killed hat rolls)');
  ok(/def level\(band, pct, floor\)/.test(drumSrc),
    'drum thresholds come from the track, not from constants tuned on one mix');
  ok(/drum = None/.test(drumSrc) && !/labels\[:2\]/.test(drumSrc),
    'a hit is one drum plus one cymbal, not the first two labels that matched');

  try { fs.rmSync(base, { recursive: true, force: true }); } catch {}


// Self Midi library: melody candidates fold into their primary; a candidate
// with no primary on disk still shows (nothing gets hidden with no way back).
{
  const fs = require('fs'), os = require('os');
  const lib = require(path.join(root, 'electron', 'library.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-lib-'));
  for (const n of ['song_melody.mid', 'song_melody_balanced.mid', 'song_melody_detailed.mid',
                   'orphan_detailed.mid', 'piano.mid']) fs.writeFileSync(path.join(dir, n), '');
  const names = lib.list([dir]).files.map((f) => f.name).sort();
  ok(names.join(',') === 'orphan_detailed,piano,song_melody', `candidate fold (got ${names.join(',')})`);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// The rewritten design system + shell. These six all shipped broken once and
// every one of them is silent when it regresses, which is exactly what a
// regression guard is for.
// ---------------------------------------------------------------------------
{
  const fs = require('fs');
  const rd = (rel) => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
  const drawSrc = rd('renderer/shared/draw.js');
  const shellSrc = rd('renderer/shell/shell.js');
  const tokensCss = rd('renderer/shared/tokens.css');
  const uiCss = rd('renderer/shared/ui.css');
  const shellCss = rd('renderer/shell/shell.css');

  // 1. Re-registering a Draw consumer must REPLACE it, not throw. dispose()
  // lives on the returned handle, never on the record kept in byKey.
  ok(/byKey\[key\]\s*&&\s*byKey\[key\]\.handle/.test(drawSrc) && !/byKey\[key\]\.dispose\(\)/.test(drawSrc),
    'Draw.register replaces an existing key through the handle, not the record');

  // 2. setBaseMs must survive readAttrs(), which runs first inside refreshEnv
  // and would otherwise read data-drawms straight back over it.
  ok(/var localBaseMs/.test(drawSrc) && /localBaseMs !== null \? localBaseMs/.test(drawSrc),
    'Draw.setBaseMs is a local override, not an env write readAttrs erases');

  // 3. debounce().flush() must INVOKE. It is the only send path for the volume
  // knob and the only thing a keyboard arrow-press on a slider ever produces.
  const dbnc = /function debounce\(fn, ms\)\s*\{[\s\S]*?\n  \}/.exec(shellSrc);
  ok(!!dbnc, 'the shell has a debounce helper');
  ok(!!dbnc && /flush = \(\) => \{[\s\S]*?fn\(\.\.\.p\)/.test(dbnc[0]),
    'debounce().flush() invokes the pending call instead of cancelling it');
  ok(!!dbnc && /cancel = \(\)/.test(dbnc[0]), 'debounce() also offers cancel()');
  ok(/vol\.addEventListener\('change'[\s\S]{0,320}?ownerCommand\('volume'/.test(shellSrc),
    'the volume knob sends on change even with no pending debounce');

  // 4. Grabbing the scrub thumb and letting go must not seek. It used to rewind
  // live playback to 0:00 because scrubValue started at 0.
  ok(/scrubMoved = false/.test(shellSrc) && /if \(scrubMoved && window\.Transport\) window\.Transport\.seek/.test(shellSrc),
    'the transport only seeks when the scrub actually moved');

  // 5. Chromium fires load for a src-less iframe's about:blank document, and all
  // five frames start src-less. Treating that as "the panel is up" let the boot
  // splash hand over to an empty stage.
  ok(/function frameNavigated\(f\)/.test(shellSrc) && /if \(!frameNavigated\(f\)\) return;/.test(shellSrc),
    'onFrameLoad ignores the initial about:blank load');
  ok(/if \(f\.loaded && frameNavigated\(f\)\) done\(\);/.test(shellSrc),
    'the splash hand-over waits for a real panel document');

  // 6. The 12px type floor (invariant 31). The 9px visualiser keyboard label is
  // the one sanctioned exception and does not live in these three files.
  const TINY = /font(?:-size)?:[^;}]*\b(?:8(?:\.5)?|9|10|11)px\b/g;
  for (const [rel, src] of [['renderer/shared/tokens.css', tokensCss],
                            ['renderer/shared/ui.css', uiCss],
                            ['renderer/shell/shell.css', shellCss]]) {
    const hits = (src.match(TINY) || []);
    ok(hits.length === 0, `${rel} keeps the 12px type floor (found ${hits.join(' | ')})`);
  }
  ok(!/#63666e/.test(shellCss), 'the log timestamp uses --text-3, not a hard-coded sub-AA grey');

  // 7. Motion is never the only signal: the blanket reduced-motion rule leaves a
  // one-iteration animation at its END frame, which parked the indeterminate bar
  // one full track width off-screen and left a busy button blank.
  const rmBlocks = tokensCss.slice(tokensCss.indexOf('@media (prefers-reduced-motion'));
  ok(/\.bar-fill\.indet\s*\{[^}]*animation: none/.test(rmBlocks) && /width: 100% !important/.test(rmBlocks),
    'the indeterminate bar has a static reduced-motion form');
  const uiRm = uiCss.slice(uiCss.indexOf('@media (prefers-reduced-motion'));
  ok(/\.btn\.is-busy\s*\{\s*color: inherit/.test(uiRm),
    'a busy button shows its label again under reduced motion');

  // 8. Finished-transcription offer: SYNTHESIS maps it to a strip action, and
  // index.html tells the user so. A 7s toast is not that.
  ok(/forged: null/.test(shellSrc) && /id: 'queue', label: 'Add to queue'/.test(shellSrc),
    'a finished transcription is offered on the activity strip, not only as a toast');
  ok(/clearForged\(\);\s*\/\/ the next job supersedes/.test(shellSrc),
    'the next Forge job supersedes the previous offer');

  // 9. The shared modules the contract now documents must exist and export.
  for (const rel of ['renderer/shared/icons.js', 'renderer/shared/resize.js',
                     'renderer/shared/timeline-zoom.js', 'renderer/shared/menu.js']) {
    ok(fs.existsSync(path.join(root, ...rel.split('/'))), `${rel} exists`);
  }
  const contract = rd('docs/rewrite/CONTRACT.md');
  for (const name of ['window.Icon', 'window.Resize', 'window.TimelineZoom', 'window.Menu']) {
    ok(contract.indexOf(name) >= 0, `CONTRACT documents ${name}`);
  }
  ok(/library\.list\(\)/.test(contract), 'CONTRACT documents the Library data surface');
}

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

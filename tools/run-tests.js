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

// Forge is ONE three-column layout now. The four arrangements (classic/cards/
// bench/console) and the block-moving engine are removed on purpose (SYNTHESIS
// orphan 1, migration_map 90-95): a CSS grid with two persisted dividers
// replaces them, which is what deletes the DOM churn and the Resize re-wiring.
// The markup must still contain exactly one of each control.
{
  const fsx = require('fs');
  const html = fsx.readFileSync(path.join(root, 'renderer', 'forge', 'index.html'), 'utf8');
  const js = fsx.readFileSync(path.join(root, 'renderer', 'forge', 'forge.js'), 'utf8');
  for (const id of ['dropzone', 'pipeline', 'queue-wrap', 'waveform', 'adv', 'log', 'start']) {
    const n = (html.match(new RegExp('id="' + id + '"', 'g')) || []).length;
    ok(n === 1, `forge markup has exactly one #${id} (found ${n})`);
  }
  // The layout engine must NOT come back: no LAYOUTS table, no applyLayout, no
  // lane building, and no window.setForgeLayout for the shell to call.
  ok(!/const LAYOUTS =/.test(js) && !/function applyLayout/.test(js),
    'the four-layout block-moving engine is gone');
  ok(!/setForgeLayout/.test(js) && !html.includes('id="layout-picker"'),
    'the Forge layout picker is gone');
  // One grid, two dividers, persisted per CONTRACT 9.3 as forge:rail / forge:insp.
  ok(html.includes('data-split="forge"'), 'forge owns one split namespace');
  for (const prop of ['rail', 'insp']) {
    ok(html.includes(`data-resize="${prop}"`), `forge has a --${prop} divider`);
  }
  // Every advanced key must reach main on every write: settings are deep-merged,
  // so an omitted key silently keeps its old on-disk value (invariant 8).
  ok(/for \(const k of ADV_KEYS\)/.test(js) && (js.match(/'MELODY_FOLD'/g) || []).length >= 1,
    'collectAdvanced walks the whole ADV_KEYS list');
  ok(/LEGACY_DEFAULTS = \{ MIN_NOTE_SEC: '0\.05', MELODY_MIN_NOTE_MS: '45' \}/.test(js),
    'the two legacy defaults are still treated as unset');
  // The cached env verdict is painted before the probe answers: probing imports
  // torch and takes tens of seconds.
  ok(js.indexOf('localStorage.getItem(ENV_CACHE_KEY)') > 0
    && js.indexOf('localStorage.getItem(ENV_CACHE_KEY)') < js.indexOf('await F.check()'),
    'the cached engine verdict is read before the probe runs');
  // Seven stages, and the frame handshake that drains queued hand-offs.
  ok((html.match(/class="stg"/g) || []).length === 7, 'the progress checklist has seven stages');
  ok(/FRAME_READY, \{ frame: FRAME/.test(js), 'forge sends frame:ready');
  // No hand-rolled draw loop: everything paints through the shared scheduler.
  ok(!/requestAnimationFrame\(function frame|rafLoop/.test(js) && /Draw\.register\(/.test(js),
    'forge paints through the Draw scheduler');

  // A VList renderRow must never assign a bare className: vlist.js adds
  // `vlist-row` once in makeRow(), and that class is what supplies the
  // position:absolute + pointer-events:auto the rows need inside the
  // pointer-events:none sizer. Wiping it let .lrow's own position:relative lay
  // each pool row out in flow AS WELL as translating it, which doubled the row
  // pitch, broke refreshLog's scroll-to-bottom arithmetic and made every log
  // line unhoverable (must_survive feature 39).
  {
    const NL = String.fromCharCode(10);
    const blocks = js.split('renderRow(node').slice(1)
      .map((chunk) => chunk.split(NL + '    },')[0]);
    ok(blocks.length > 0, 'forge has at least one VList renderRow to check');
    for (const b of blocks) {
      ok(!/node\.className\s*=\s*(['"`])(?!vlist-row)/.test(b),
        'a forge renderRow never drops the vlist-row class');
    }
  }
  ok(/node\.className = 'vlist-row lrow is-' \+ it\.level/.test(js),
    'the log rows keep vlist-row when their level class changes');

  // Nothing derived or transient may reach localStorage: a Float32Array of note
  // onsets stringifies as {"0":..,"1":..} (~30KB a row), walked the blob into
  // the 5MB quota behind a silent try/catch, and came back lengthless so every
  // restored row's density strip read "no data".
  ok(!/it\.onsets = /.test(js), 'parsed onsets are never written onto a history row');
  ok(/HISTORY_KEEP = \[/.test(js) && !/HISTORY_KEEP = \[[^\]]*onsets/.test(js)
    && !/HISTORY_KEEP = \[[^\]]*freshUntil/.test(js),
    'saveHistory persists an explicit field whitelist without onsets or freshUntil');
  ok(/function onsetsFor\(it\)/.test(js) && /metaCache\.get\(lower\(it\.path\)\)/.test(js),
    'the density strip reads onsets back out of metaCache');

  // Invariant 20: the resize-edge zone exists only above 14px. A fixed 8px grab
  // on a narrow range made a click anywhere near it resolve to 'start', and an
  // unmoved click in that mode neither seeks nor starts a new selection.
  ok(/width > 14 \? Math\.min\(8, width \* 0\.3\) : 0/.test(js),
    'the waveform edge grab zone stays proportional (invariant 20)');

  // Rule 12 / invariant 31: 12px is the type floor in both densities, and the
  // visualiser's 9px keyboard label is the only sanctioned exception.
  const fcss = fsx.readFileSync(path.join(root, 'renderer', 'forge', 'forge.css'), 'utf8');
  for (const [where, text, re] of [
    ['forge.css', fcss, /(?:font(?:-size)?:[^;}]*?)(8|9|10|11)(?:\.\d+)?px/g],
    ['forge.js', js, /ctx\.font = '(8|9|10|11)(?:\.\d+)?px/g],
  ]) {
    const hit = text.match(re);
    ok(!hit, `${where} keeps every type size at the 12px floor (${hit ? hit.join(', ') : 'clean'})`);
  }

  // Collapsing a column is a side-by-side affordance. The inspector becomes the
  // full-width bottom row under 1181px, so its collapse rules must not reach
  // into that range -- a 34px strip in a 268px-tall row is an empty band.
  const wide = fcss.indexOf('@media (min-width: 1181px)');
  ok(wide > 0 && /@media \(min-width: 1181px\)[\s\S]{0,900}\.fg-insp\.is-collapsed/.test(fcss),
    'the inspector collapse rules are scoped to the wide (>=1181px) layout');
  ok(!/@media \(min-width: 901px\)[\s\S]{0,900}\.fg-col\.is-collapsed \{ width: 34px !important/.test(fcss),
    'no !important collapse width leaks across the 1180px re-layout');
  ok(/@media \(max-width: 1180px\)[\s\S]{0,2600}\.fg-insp \.fg-collapse \{ display: none/.test(fcss),
    'the inspector chevron is hidden where the inspector cannot collapse');

  // One source of truth for the results selection: the list and the Selected
  // Result panel with its four live hand-off buttons must not disagree after an
  // Escape or an arrow key (vlist's own Escape stops propagation).
  ok(/onSelectionChange\(keys, rows\) \{ select\(/.test(js),
    'the results list drives select() from onSelectionChange');

  // Every one-shot timer takes its own disposer out of the registry when it
  // fires; `disposers` is only drained on teardown, so a per-stage /
  // per-result / per-flash push grew unboundedly for the life of the panel.
  ok(/function later\(ms, fn\)/.test(js) && /disposers\.splice\(i, 1\)/.test(js),
    'forge has a self-cleaning one-shot timer helper');
  ok(!/disposers\.push\(\(\) => clearTimeout\(id\)\)/.test(js),
    'no one-shot timer leaves a dead closure in the teardown registry');

  // AudioSampleEntry: channelcount at box+24, then samplesize, pre_defined and
  // reserved before the 16.16 samplerate at box+32. `o` is box+4.
  ok(/rate: d\.getUint16\(o \+ 28, false\), channels: d\.getUint16\(o \+ 20, false\)/.test(js),
    'the mp4a sample rate is read at the 16.16 field, not at `reserved`');

  // The shell must not drop a tab's own forge:status packets: forge.job is the
  // documented way a tab names the job it started (CONTRACT 11.3), and a yt-dlp
  // download never echoes the `Input:` line the strip otherwise recovers.
  const shellJs = fsx.readFileSync(path.join(root, 'renderer', 'shell', 'shell.js'), 'utf8');
  ok(/Bus\.on\(T\.FORGE_STATUS, \(p\) => \{[\s\S]{0,400}adoptEnvProbe\(p\);[\s\S]{0,120}else handleForgeStatus\(p\);/.test(shellJs),
    'the shell forwards a frame non-env forge:status to handleForgeStatus');

  // CONTRACT 9.3's divider registry exists so two tabs cannot collide on a key
  // inside the single shared localStorage['midi-studio:splits'].
  const contract = fsx.readFileSync(path.join(root, 'docs', 'rewrite', 'CONTRACT.md'), 'utf8');
  for (const key of ['forge:rail', 'forge:insp']) {
    ok(contract.includes('`' + key + '`'), `CONTRACT 9.3 claims ${key}`);
  }

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
  const drawSrcTop = read('renderer/shared/draw.js');
  ok(/function setBpm/.test(playerJs), 'tempo can be set as a BPM number');
  ok(/bpm_estimate/.test(playerJs), 'the onset-based tempo estimate reaches the UI');
  ok(read('renderer/player/index.html').includes('id="tempo-bpm"'), 'the BPM field exists');
  ok(read('python-engine/ipc_main.py').includes('"bpm_estimate"'), 'the engine reports a tempo estimate');

  // ---- hotkeys can be unbound --------------------------------------------
  // The widget is shared (CONTRACT §9.7): the pynput tables, the e.code rule and
  // the capture box live in one module, not once per tab that wants a remapper.
  const hotkeyJs = read('renderer/shared/hotkey.js');
  ok(/window\.Hotkey|global\.Hotkey/.test(hotkeyJs), 'the hotkey capture widget is exposed');
  ok(/hk-clear/.test(hotkeyJs) && /hk-clear/.test(read('renderer/player/style.css')),
    'every hotkey box has a visible unbind');
  ok(/CODE_CHAR/.test(hotkeyJs) && !/CODE_CHAR/.test(playerJs),
    'the e.code table lives in the shared widget, not a second copy in the panel');
  ok(read('renderer/player/index.html').includes('shared/hotkey.js'),
    'the Player loads the shared hotkey widget');
  ok(!/playHotkey = hk\(els\.hkPlay\) \|\| /.test(playerJs),
    'clearing Play/Stop/Pause is respected instead of springing back to F6/F7/F8');
  ok(/onCapture/.test(hotkeyJs) && /onCapture: \(\) => suspendHotkeys\(\)/.test(playerJs),
    'focusing a capture box suspends the global hotkeys (invariant 13)');
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
  // The floor is computed in ONE place, and it is only an allowance: Draw is
  // dirty-driven, so a consumer that does not ask for the next frame runs at
  // whatever rate its events arrive (20Hz of engine 'progress' packets) no matter
  // what the budget permits. Both halves have to be asserted, and the assertion
  // has to point at the code that runs, not at a comment claiming it does.
  ok(/PLAYBACK_FLOOR_MS = 33/.test(drawSrcTop)
    && /Math\.min\(ms, Math\.min\(base, PLAYBACK_FLOOR_MS\)\)/.test(drawSrcTop),
    'the draw budget floors at 30fps while playback is live');
  ok(/isPlaying && !isPaused && !viz\.isFrozen\(\)\) vizHandle\.invalidate\(\)/.test(playerJs),
    'the roll asks for the next frame while notes are moving (30fps, not 20Hz of packets)');
  // Same shape for the two self-issued stops: playback_done carries no reason, so
  // a restart must be distinguishable from the end of the song or the renderer
  // advances the queue and starts typing into the game unasked.
  ok(/const selfRestart = pendingRestartAt !== null \|\| restarting;/.test(playerJs)
    && /restarting = true;/.test(playerJs),
    'a paused tempo/opts restart is not mistaken for the end of the song');
  ok(/userStopped = false;[\s\S]{0,400}?cmd: 'play'/.test(playerJs),
    'the user-stop flag is cleared where playback begins, not in one caller');

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
  // The lane/divider sweep existed only because layouts rebuilt the grid. With
  // one static grid there is nothing to sweep, and nothing may re-create it.
  ok(!/stale\.remove\(\)/.test(read('renderer/forge/forge.js')),
    'forge no longer rebuilds its dividers on a layout switch');

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

  // 10. THE SIX-TAB MAP. Ctrl+1..6 is handled twice -- in the shell, and again in
  // main's before-input-event, because the stage swallows the keydown once focus
  // is inside a panel. The two maps have to list the same six frame keys in the
  // same order or the app disagrees with itself about what Ctrl+6 means, and
  // nothing at runtime notices.
  const NAV_ORDER = ['forge', 'player', 'review', 'audition', 'library', 'logs'];
  {
    const mainSrc2 = rd('electron/main.js');
    const html = rd('renderer/index.html');

    // the shell's FRAMES array, in order
    const framesBlock = shellSrc.slice(shellSrc.indexOf('const FRAMES = ['),
                                       shellSrc.indexOf('const ORDER = FRAMES.map'));
    const shellKeys = (framesBlock.match(/\{ key: '([a-z]+)'/g) || []).map((m) => m.slice(8, -1));
    ok(String(shellKeys) === String(NAV_ORDER),
      'shell FRAMES is the six tabs in nav order (got ' + shellKeys + ')');

    // main's before-input-event map, in order
    const mapLine = (mainSrc2.match(/const tab = \{[^}]*\}\[input\.key\]/) || [''])[0];
    const mainKeys = (mapLine.match(/'([a-z]+)'/g) || []).map((m) => m.slice(1, -1));
    ok(String(mainKeys) === String(NAV_ORDER),
      'main before-input-event maps the same six tabs in the same order (got ' + mainKeys + ')');
    ok(/\b6: 'logs'/.test(mapLine), 'main maps Ctrl+6 to the Logs tab');

    // the shell's own digit handler must cover all six
    ok(/'123456'\.indexOf\(e\.key\)/.test(shellSrc), 'the shell key router covers Ctrl+1..6');

    // and the chrome has to exist for all six
    for (const k of NAV_ORDER) {
      ok(html.indexOf('data-frame="' + k + '"') >= 0, 'index.html has the ' + k + ' nav item and frame');
    }
    ok(html.indexOf('data-src="./logs/index.html"') >= 0, 'the Logs frame is lazily loaded from logs/index.html');
    ok(fs.existsSync(path.join(root, 'renderer', 'logs', 'index.html'))
      && fs.existsSync(path.join(root, 'renderer', 'logs', 'logs.js'))
      && fs.existsSync(path.join(root, 'renderer', 'logs', 'logs.css')),
      'the Logs tab ships all three of its files');
  }

  // 11. THE DRAWER IS GONE. Two log UIs is worse than either one, and the drawer
  // was the one that could not be reached from a tab that had focus.
  {
    const html = rd('renderer/index.html');
    const logsJs = rd('renderer/logs/logs.js');
    for (const dead of ['as-log-toggle', 'id="alog"', 'alog-list', 'alog-filter', 'alog-copy', 'alog-clear', 'alog-close']) {
      ok(html.indexOf(dead) < 0, 'the log drawer markup is gone: ' + dead);
    }
    for (const dead of ['setLogOpen', 'alog', 'logPinned', 'logVisible']) {
      ok(shellSrc.indexOf(dead) < 0, 'the log drawer code is gone from the shell: ' + dead);
    }
    ok(!/\.alog|\.as-log-toggle|--h-logdrawer/.test(shellCss), 'the log drawer CSS is gone');
    ok(shellSrc.indexOf('logOpen') < 0, 'the drawer open/closed preference is gone');
    ok(/id="as-errors"/.test(html) && /\$\('as-errors'\)\.addEventListener\('click', \(\) => activate\('logs'\)\)/.test(shellSrc),
      'the strip keeps an error count that switches to the Logs tab');
    ok(/activate\('logs'\); e\.preventDefault\(\)/.test(shellSrc), 'Ctrl+Alt+L goes to the Logs tab');

    // The shell still OWNS the buffer: it must collect whether or not the tab
    // has ever been opened (frames load lazily), and publish in BATCHES.
    ok(/const LOG_CAP = 600/.test(shellSrc) && /function logPush/.test(shellSrc),
      'the shell still owns the capped ring buffer');
    ok(/logOut\.push\(line\)/.test(shellSrc) && /T\.LOG_APPEND, \{ lines: batch \}/.test(shellSrc),
      'the shell publishes log lines in coalesced batches, not one message per line');
    ok(/if \(f\.key === 'logs'\) logSync\(f\.frame\)/.test(shellSrc),
      'a freshly opened Logs tab gets a full sync on frame:ready');
    ok(/Bus\.on\(T\.LOG_CLEAR, \(\) => logClear\(\)\)/.test(shellSrc),
      'Clear is a request to the buffer owner, not a local act in the viewer');

    // A panel sends frame:ready from its own script, which runs BEFORE the
    // iframe's load event, so the load handler must NOT clear busReady
    // unconditionally: doing so retracted the handshake of the document that
    // had just arrived, and every later push to that panel was dropped. That
    // is silent, and it is what stopped log:append reaching the Logs tab.
    ok(!/f\.busReady = false;\s*\/\/ a reload retracts/.test(shellSrc),
      'the load handler no longer clobbers a frame:ready it already received');
    ok(/if \(!f\.readyForLoad\) f\.busReady = false;/.test(shellSrc)
      && /f\.readyForLoad = true;/.test(shellSrc),
      'busReady is retracted only for a document that never announced itself');

    // and the viewer is a viewer: no second buffer, no hand-rolled rAF
    ok(/Bus\.send\(T\.FRAME_READY, \{ frame: FRAME/.test(logsJs), 'the Logs tab sends frame:ready');
    ok(/Draw\.register\(/.test(logsJs) && !/requestAnimationFrame/.test(logsJs),
      'the Logs tab paints through the Draw scheduler, never its own rAF');
    ok(/window\.VList\(listHost/.test(logsJs), 'the Logs tab virtualises the scrollback');
    ok(!/Transport\.claim/.test(logsJs), 'the Logs tab claims no transport');
    ok(/n\.className = 'lrow is-grid'/.test(logsJs) && !/n\.className =/.test(logsJs.slice(logsJs.indexOf('renderRow'))),
      'the Logs rows are built once and never have className reassigned in renderRow');

    const busSrc = rd('renderer/shared/bus.js');
    for (const t of ["'log:sync'", "'log:append'", "'log:clear'", "'nav:open-logs'"]) {
      ok(busSrc.indexOf(t) >= 0, 'bus.js declares ' + t);
      ok(contract.indexOf(t.replace(/'/g, '`')) >= 0 || contract.indexOf(t.slice(1, -1)) >= 0,
        'CONTRACT documents ' + t);
    }
  }

  // 12. The version and its release name. The chip stays bare; the About pane is
  // where the release name is spelt out.
  {
    const pkg2 = require(path.join(root, 'package.json'));
    ok(pkg2.version === '3.0.0', 'package version is 3.0.0');
    ok(pkg2.releaseName === 'Graphite', 'package declares the release name');
    const mainSrc3 = rd('electron/main.js');
    ok(/ipcMain\.handle\('app:release'/.test(mainSrc3), 'main exposes the release name');
    ok(/getRelease/.test(rd('electron/preload.js')), 'preload exposes getRelease');
    ok(/chip\.textContent = 'v' \+ appVersion/.test(shellSrc), 'the titlebar chip shows just the version');
    ok(/s-about-version'\)\.textContent = appVersion \+ \(releaseName/.test(shellSrc),
      'the About pane shows the version and the release name');
  }

  // 13. The real logo. The CSS waveform mark is gone; the artwork on the
  // first-paint path is the 7.7KB badge, and the 151KB lockup is splash-only.
  {
    const html = rd('renderer/index.html');
    ok(fs.existsSync(path.join(root, 'renderer', 'shared', 'mark.png'))
      && fs.existsSync(path.join(root, 'renderer', 'shared', 'lockup.png')),
      'both optimised logo assets ship');
    ok(/class="brand-img" src="\.\/shared\/mark\.png"/.test(html), 'the titlebar shows the real badge');
    ok(/class="splash-logo" src="\.\/shared\/lockup\.png"/.test(html), 'the splash shows the real lockup');
    ok(html.indexOf('class="wf"') < 0 && !/\.wf\b/.test(shellCss), 'the CSS waveform mark is gone');
    ok(html.indexOf('logo.png') < 0, 'the 597KB source logo is never on a page');
    // transform/opacity only, one-shot, and a static reduced-motion form: the
    // blanket kill switch leaves an animation at its END frame.
    const logoIn = shellCss.slice(shellCss.indexOf('@keyframes logo-in'), shellCss.indexOf('@keyframes logo-in') + 160);
    ok(/transform: scale/.test(logoIn) && !/width|height/.test(logoIn), 'the splash logo animates transform and opacity only');
    const rm = shellCss.slice(shellCss.indexOf('@media (prefers-reduced-motion'));
    ok(/\.splash-logo[^{]*\{[^}]*animation: none/.test(rm), 'the splash logo has a static reduced-motion form');
  }
}

// ---------------------------------------------------------------------------
// WHAT'S NEW. The parser reads a file a user can edit and release notes fetched
// from GitHub, so "it must not throw" is the whole contract: every failure has
// to come back as { ok:false } and let the screen degrade to a link.
// ---------------------------------------------------------------------------
{
  const fs = require('fs');
  const rd = (rel) => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
  const C = require(path.join(root, 'renderer', 'shell', 'changelog.js'));
  const pkg = JSON.parse(rd('package.json'));

  // ---- 1. a well-formed file: the project's own CHANGELOG.md ---------------
  const parsed = C.parse(rd('CHANGELOG.md'));
  ok(parsed.ok && parsed.releases.length >= 1, 'CHANGELOG.md parses');
  const rel = C.find(parsed.releases, pkg.version);
  ok(!!rel, `CHANGELOG.md carries an entry for the shipping version (${pkg.version})`);
  if (rel) {
    ok(rel.version === pkg.version, `the entry's version is ${pkg.version} (got ${rel.version})`);
    ok(rel.name === pkg.releaseName, `the entry's release name is ${pkg.releaseName} (got ${rel.name})`);
    ok(/^\d{4}-\d{2}-\d{2}$/.test(rel.date), `the entry carries a date (got "${rel.date}")`);
    ok(rel.intro.length >= 1, 'the entry keeps its intro paragraph');
    const titles = rel.sections.map((s) => s.title);
    ok(titles[0] === 'New', `New is rendered first (got ${titles.join(', ')})`);
    ok(titles.indexOf('Known issues') === titles.length - 1,
      'Known issues is rendered last: it is the caveat, not the news');
    ok(titles.indexOf('Changed') > 0 && titles.indexOf('Fixed') > titles.indexOf('Changed'),
      'Changed then Fixed, between the two');
    ok(C.count(rel) >= 25, `every bullet survives the parse (got ${C.count(rel)})`);
    // A wrapped bullet is ONE bullet, joined, not one per source line.
    const lib = rel.sections[0].items[0];
    ok(lib.lead === 'Library.', `a leading bold run becomes the bullet's lead (got "${lib.lead}")`);
    ok(/note count and length/.test(lib.text) && !/\n/.test(lib.text),
      'a bullet wrapped over four source lines is joined into one');
    // '**Forge** is one workspace' is mid-sentence emphasis. Pulling it out as a
    // lead left the bullet reading 'Forge' / 'is one three-column workspace'.
    const forge = rel.sections[1].items.find((i) => /^Forge is one/.test(i.text));
    ok(!!forge && forge.lead === '', 'mid-sentence bold is flattened, never promoted to a lead');
    ok(!/[*_`]/.test(rel.sections.map((s) => s.items.map((i) => i.lead + i.text).join(' ')).join(' ')),
      'no markdown syntax survives into the rendered text');
  }

  // ---- 2. a MISSING file ---------------------------------------------------
  // main answers { ok:false, error:'not found' } and the renderer never gets a
  // string to parse; the parser has to be safe with what it does get anyway.
  ok(C.parse('').ok === false && C.parse('').releases.length === 0, 'an empty changelog degrades, not throws');
  for (const bad of [null, undefined, 0, [], {}, () => {}]) {
    const r = C.parse(bad);
    ok(r && r.ok === false && Array.isArray(r.releases), `parse(${typeof bad}) degrades cleanly`);
  }
  ok(typeof p.changelogFile === 'function' && /CHANGELOG\.md$/.test(p.changelogFile()),
    'paths resolves CHANGELOG.md the way it resolves every other bundled resource');
  ok(fs.existsSync(p.changelogFile()), 'the resolved changelog exists in a dev tree');
  {
    const mainSrc = rd('electron/main.js');
    const h = mainSrc.slice(mainSrc.indexOf("ipcMain.handle('app:changelog'"), mainSrc.indexOf("ipcMain.handle('app:whatsNew'"));
    ok(/paths\.exists\(file\)/.test(h) && /'not found'/.test(h),
      'app:changelog answers "not found" instead of throwing on a missing file');
    ok(/try \{/.test(h) && /catch/.test(h), 'app:changelog cannot reject');
    // Packaged, CHANGELOG.md lives inside the asar next to package.json, so it
    // has to be in build.files or the screen is permanently degraded in a real
    // install while working perfectly in dev.
    ok((pkg.build.files || []).includes('CHANGELOG.md'),
      'CHANGELOG.md is packaged, so What’s New works in an installed build');
  }

  // ---- 3. MALFORMED input --------------------------------------------------
  ok(C.parse('# Changelog\n\njust prose, no releases\n\n- and a stray bullet').ok === false,
    'a file with no release heading degrades');
  ok(C.parse('## Changelog\n### New\n- x').ok === false,
    '"## Changelog" is not read as a release called "Changelog"');
  {
    // Half a heading, an unterminated bold run, a stray bracket, 60KB of one
    // line, control bytes: none of it may throw and none of it may hang.
    const nasty = [
      '## 3.0.0 "Graphite\n### New\n- **unterminated bold\n- [link](\n',
      '##3.0.0\n###New\n-nospace',
      '## 1.0.0\n' + '- ' + 'x'.repeat(60000) + '\n',
      '## 1.0.0 - \n### \n- \n-\n\n###\n',
      '## 1.0.0\n �\n- a\r\n- b\r\n',
      '## 1.0\n### New\n\t- tabbed\n      - deeply indented\n',
      '**'.repeat(4000),
      '## 9.9.9 "X" - 2026-01-01\n'.repeat(500),
    ];
    let threw = 0, hung = 0;
    const t0 = Date.now();
    for (const s of nasty) {
      try { const r = C.parse(s); if (!r || typeof r.ok !== 'boolean') threw++; }
      catch (_) { threw++; }
      try { C.parseNotes(s, { version: '1.0.0' }); } catch (_) { threw++; }
    }
    if (Date.now() - t0 > 2000) hung++;
    ok(threw === 0, `${nasty.length} malformed inputs, none throws (${threw} did)`);
    ok(hung === 0, 'the parser is linear: no input makes it spin');
    // A heading that IS well formed still yields a release even when its body is
    // rubbish, so a half-written entry shows what it has rather than nothing.
    const half = C.parse('## 3.1.0 "Slate" - 2026-10-01\n### New\n- one real bullet\n### \n- \n');
    ok(half.ok && half.releases[0].version === '3.1.0' && half.releases[0].name === 'Slate',
      'a good heading over a ragged body still parses');
    ok(C.count(half.releases[0]) === 1, 'empty bullets are dropped, not rendered as blank rows');
  }

  // ---- 4. GitHub release notes (the AVAILABLE-update path) -----------------
  {
    const n = C.parseNotes('### New\n- **A.** one\n- two\n\n### Fixed\n- three\n', { version: '3.1.0' });
    ok(n.ok && n.release.version === '3.1.0' && n.release.sections[0].title === 'New',
      'a GitHub body with no version heading parses into one release');
    ok(C.count(n.release) === 3, 'every bullet in a release body survives');
    const loose = C.parseNotes('- just\n- bullets\n', { version: '3.1.0' });
    ok(loose.ok && loose.release.sections[0].title === 'Notes',
      'bullets with no heading still get a group');
    ok(C.parseNotes('', { version: '3.1.0' }).ok === false, 'an empty release body degrades');
    ok(C.parseNotes(null).ok === false, 'a missing release body degrades');
  }

  // ---- 5. the screen's wiring ---------------------------------------------
  {
    const shellSrc = rd('renderer/shell/shell.js');
    const html = rd('renderer/index.html');
    const pre = rd('electron/preload.js');
    const mainSrc = rd('electron/main.js');

    ok(/<script src="\.\/shell\/changelog\.js"><\/script>[\s\S]{0,80}<script src="\.\/shell\/shell\.js">/.test(html),
      'the parser loads before the shell that uses it');
    for (const id of ['wn-scrim', 'wn-dlg', 'wn-body', 'wn-secs', 'wn-fallback', 'wn-modes',
                      'wn-full', 'wn-done', 'wn-check', 'wn-apply', 'wn-close']) {
      ok(html.indexOf(`id="${id}"`) > 0, `index.html carries #${id}`);
    }
    ok(/class="dlg-scrim" id="wn-scrim"/.test(html) && /class="dlg wn"/.test(html),
      'What’s New is built from the CONTRACT dialog primitives, not a parallel one');
    ok(/role="dialog" aria-modal="true"/.test(html.slice(html.indexOf('id="wn-dlg"') - 200, html.indexOf('id="wn-dlg"') + 200)),
      'the dialog announces itself as modal');

    // A fixed overlay is composited UNDER an iframe, so the strip's frames have
    // to be told they are covered or the panel draws straight through the modal.
    ok(/anyOverlayOpen = \(\) =>[^;]*wn-scrim/.test(shellSrc),
      'the modal counts as an overlay, so the tab frames go off-screen behind it');
    // Escape order, and the modal is the topmost thing when it is up.
    const esc = shellSrc.slice(shellSrc.indexOf("if (e.key === 'Escape') {"), shellSrc.indexOf("if (e.ctrlKey && !e.altKey"));
    ok(esc.indexOf('wnOpen') >= 0 && esc.indexOf('wnOpen') < esc.indexOf('palOpen'),
      'Escape closes What’s New before anything else');
    ok(/wnDlg\.addEventListener\('keydown'[\s\S]{0,900}e\.key !== 'Tab'/.test(shellSrc),
      'the modal traps Tab');
    ok(/closeWhatsNew\(\);\s*\n\s*e\.preventDefault\(\);/.test(shellSrc), 'Enter closes it');
    ok(/wnReturn && wnReturn\.focus/.test(shellSrc), 'closing restores the focus it took');

    // Four ways in, and checking for updates is still one click away.
    ok(/\$\('version-chip'\)\.addEventListener\('click', \(\) => \{[\s\S]{0,120}openWhatsNew\(\)/.test(shellSrc),
      'the titlebar version chip opens the notes');
    ok(/\$\('s-whatsnew'\)\.addEventListener/.test(shellSrc) && /id="s-whatsnew"/.test(html),
      'Settings > Updates offers What’s New');
    ok(/id: 'app\.whatsNew'/.test(shellSrc), 'the command palette offers What’s New');
    ok(/id: 'app\.updates', label: 'Check for updates'/.test(shellSrc)
      && /id="s-recheck"/.test(html) && /\$\('wn-check'\)\.addEventListener/.test(shellSrc),
      'checking for updates survives in the palette, in Settings and in the modal');

    // Once, and only once. autoShow is main's answer; the renderer records the
    // version the moment the sheet goes up, not when it is dismissed.
    const wn = mainSrc.slice(mainSrc.indexOf("ipcMain.handle('app:whatsNew'"), mainSrc.indexOf("ipcMain.handle('app:notesShown'"));
    ok(/POST_UPDATE && shownFor !== version/.test(wn),
      'autoShow needs BOTH --post-update and a version whose notes have not been shown');
    ok(/settings\.merge\(\{ ui: \{ notesShownFor: version \} \}\)/.test(mainSrc),
      'the shown version is persisted in settings, so a restart does not repeat it');
    ok(/if \(!w\.autoShow\) return;[\s\S]{0,240}markNotesShown\(shown\)[\s\S]{0,120}onBooted\(\(\) => openWhatsNew/.test(shellSrc),
      'the renderer marks it shown BEFORE opening, and never opens in front of the splash');

    // The offered update reuses the notes the updater already fetched.
    ok(/notes: rel\.body/.test(rd('electron/updater.js')) && /parseNotes\(u\.notes/.test(shellSrc),
      'the available-update notes come from the status already in hand, not a second request');
    ok(!/fetch\(|XMLHttpRequest/.test(shellSrc), 'the shell makes no network request of its own');

    // Additive only: the IPC the screen needs, and nothing removed.
    for (const ch of ['app:changelog', 'app:whatsNew', 'app:notesShown']) {
      ok(pre.indexOf(ch) > 0 && mainSrc.indexOf(`ipcMain.handle('${ch}'`) > 0, `${ch} is wired end to end`);
    }
    ok(/getVersion:|checkForUpdates:|applyUpdate:/.test(pre), 'the existing update surface is untouched');

    // The type floor and the label treatment: section headings are body-font
    // title case, and the only mono in this screen is on machine values.
    const wnCss = rd('renderer/shell/shell.css');
    const block = wnCss.slice(wnCss.indexOf('9. WHAT\'S NEW'));
    ok(/\.wn-sec-h \{[^}]*var\(--font-body\)/.test(block), 'section headings are in the body font');
    ok(!/\.wn-sec-h \{[^}]*text-transform: uppercase/.test(block), 'section headings are not uppercased');
    ok(/\.wn-ver \{[^}]*var\(--font-mono\)/.test(block), 'the version string is mono');
    ok(/\.wn-date \{[\s\S]{0,240}?var\(--font-mono\)/.test(block), 'the date is mono');
    ok(!/font(?:-size)?:[^;}]*\b(?:8(?:\.5)?|9|10|11)px\b/.test(block), 'What’s New keeps the 12px type floor');
  }
}


// ---- Perch shares the Player visualizer -------------------------------------
// The overlay window and the Player tab load the same visualizer.js. When the
// Player copy moved to a caller-supplied 2D context, Perch kept calling the old
// no-argument form and threw once per frame, painting nothing. The window still
// opened, so the toggle looked wired, and only the renderer console said why.
// These fail the moment the two drift apart again.
{
  const rd = (rel) => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
  const ovHtml = rd('renderer/overlay/overlay.html');
  const ovJs   = rd('renderer/overlay/overlay.js');
  const vizJs  = rd('renderer/player/visualizer.js');

  if (/global\.Tokens/.test(vizJs)) {
    ok(/shared\/tokens\.js/.test(ovHtml), 'Perch loads tokens.js, which its visualizer reads');
    ok(ovHtml.indexOf('shared/tokens.js') < ovHtml.indexOf('player/visualizer.js'),
       'Perch loads tokens.js before the visualizer that reads it');
  }
  if (/global\.Draw/.test(vizJs)) {
    ok(/shared\/draw\.js/.test(ovHtml), 'Perch loads draw.js, which its visualizer reads');
  }

  const ctor = /function Visualizer\(([^)]*)\)/.exec(vizJs);
  ok(!!ctor, 'the Visualizer constructor is findable');
  if (ctor && !ctor[1].trim()) {
    ok(/new Visualizer\(\s*\)/.test(ovJs), 'Perch constructs the Visualizer with no canvas');
  }

  const rend = /Visualizer\.prototype\.render = function \(([^)]*)\)/.exec(vizJs);
  ok(!!rend, 'the render signature is findable');
  if (rend && rend[1].split(',').length === 3) {
    ok(/viz\.render\([^)]*,[^)]*,[^)]*\)/.test(ovJs), 'Perch passes a context and a size to render');
    ok(!/viz\.render\(\s*\)/.test(ovJs), 'Perch never calls the old no-argument render');
  }
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

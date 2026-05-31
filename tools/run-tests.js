// tools/run-tests.js — Electron-free unit tests for merge-gate logic.
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

// asset selection: never grab Setup.exe for portable
const assets = [
  { name: 'MIDI-Studio-2.1.0-Setup.exe', browser_download_url: 'https://x/s', size: 1 },
  { name: 'MIDI-Studio-2.1.0-portable.exe', browser_download_url: 'https://x/p', size: 1 },
];
ok(u.pickPortableAsset(assets).name === 'MIDI-Studio-2.1.0-portable.exe', 'picks portable not Setup');

// SHA256SUMS parsing
const sums = u.parseSums('aa'.repeat(32) + '  a.exe\n' + 'bb'.repeat(32) + ' *b.exe');
ok(sums['a.exe'] === 'aa'.repeat(32) && sums['b.exe'] === 'bb'.repeat(32), 'sums parse');

// paths: forge resolution
ok(typeof p.forgeEnvReady({}) === 'boolean', 'forgeEnvReady boolean');
const fp = p.forgeEnvPython({});
ok(fp === null || typeof fp === 'string', 'forgeEnvPython string|null');
const env = p.forgeChildEnv({});
ok(typeof env.MIDI_STUDIO_FORGE_ENV_DIR === 'string' && env.MIDI_STUDIO_FORGE_ENV_DIR.length > 0, 'forgeChildEnv has env dir');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

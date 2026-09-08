// gamewatch.js: is a game running right now?
// MIDI Studio is a companion app: while Roblox is up, it must get out of the
// way. Polls tasklist on a slow interval (only ever while it matters) and tells
// the app to go easy on the GPU/CPU.
'use strict';

const { execFile } = require('child_process');

const GAMES = ['RobloxPlayerBeta.exe', 'RobloxStudioBeta.exe', 'javaw.exe'];

// How many child processes probe() has spawned, so a benchmark can prove the
// poll cost without re-implementing the poll.
let probeSpawns = 0;
function probeSpawnCount() { return probeSpawns; }
const POLL_MS = 20000;

// TWO processes per poll, not three, and they run at the same time.
//
// tasklist ANDs multiple /FI filters, so this used to ask once per game name,
// sequentially -- and the early exit only helped when a game WAS found, so the
// common case (nothing running) always paid for all three, one after another:
// 271ms mean wall per poll, measured, every 20 seconds forever.
//
// Two things were changed and both were measured against the alternatives in
// benchmarks/gamewatch-ab.js (7 variants, interleaved, same answer required):
//   * IMAGENAME accepts a wildcard, so the two Roblox executables are ONE
//     query. Three spawns become two.
//   * The queries are independent, so they run in parallel instead of in
//     sequence. 271ms -> 151ms mean wall per poll (p95 283 -> 168, max 283 ->
//     168 over 8 interleaved rounds).
// What was tried and REJECTED: a single unfiltered enumeration matched in
// process. It is one spawn instead of two, but tasklist gathers per-process
// detail for the whole table when it is not filtering, and it measured worse on
// every run -- 448ms mean wall against 151ms, and the worst machine-wide CPU of
// any variant. Fewer processes is not automatically less work.
//
// Detection is unchanged: same games, same 20s cadence, same 8s deferred start,
// and GAMES order still decides which name wins when two are up. Matching got
// STRICTER, not looser -- CSV quotes each image name, so a game name can no
// longer match as a substring of some unrelated process.
const PROBE_FILTERS = ['Roblox*', 'javaw.exe'];

// A GAMES entry is covered by a filter when the filter is the name itself or a
// prefix wildcard that the name starts with. Only used by the tests, which
// assert every watched game is actually asked about -- adding a game to GAMES
// without a filter would otherwise stop it being detected, silently.
function filterCovers(filter, name) {
  const f = String(filter).toLowerCase();
  const n = String(name).toLowerCase();
  return f.endsWith('*') ? n.startsWith(f.slice(0, -1)) : f === n;
}

function tasklist(filter) {
  return new Promise((resolve) => {
    // maxBuffer is generous because a filter can match many rows on a busy
    // machine; overflowing it would otherwise report "no game" forever.
    execFile('tasklist.exe', ['/FI', `IMAGENAME eq ${filter}`, '/NH', '/FO', 'CSV'],
      { windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: 15000 },
      (error, stdout) => resolve(error ? '' : String(stdout || '')));
  });
}

function probe() {
  if (process.platform !== 'win32') return Promise.resolve('');
  probeSpawns += PROBE_FILTERS.length;
  return Promise.all(PROBE_FILTERS.map(tasklist)).then((outs) => {
    const table = outs.join('').toLowerCase();
    for (const name of GAMES) if (table.includes(`"${name.toLowerCase()}"`)) return name;
    return '';
  });
}

class GameWatch {
  constructor(onChange) {
    this._onChange = onChange || (() => {});
    this._timer = null;
    this.active = '';
  }

  start() {
    if (this._timer) return;
    const tick = async () => {
      const found = await probe();
      if (found !== this.active) { this.active = found; this._onChange(found); }
    };
    tick();
    this._timer = setInterval(tick, POLL_MS);
    if (this._timer.unref) this._timer.unref();
  }

  stop() { if (this._timer) { clearInterval(this._timer); this._timer = null; } }
}

module.exports = { GameWatch, GAMES, PROBE_FILTERS, filterCovers, probe, probeSpawnCount };

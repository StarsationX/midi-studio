// gamewatch-ab.js -- how should "is a game running?" be asked?
//
//   node benchmarks/gamewatch-ab.js --reps 10 --json benchmarks/gamewatch-ab.json
//
// GameWatch runs forever on a 20s cadence, so its cost is IDLE cost and wall
// clock alone is the wrong metric: a variant that merely runs its spawns in
// parallel finishes sooner while burning exactly as much of the machine. So
// this measures both, and the CPU number is the one that decides.
//
// CPU is taken machine-wide from os.cpus() tick counters (user+nice+sys+irq
// across every core), with an idle control of the same length subtracted, so
// whatever else the machine is doing cancels out as long as it is steady. Each
// variant is run in an interleaved round-robin for the same reason: a load
// spike then lands on all of them instead of on one.
//
// Every variant must return the SAME answer; the run prints whether they agreed
// and refuses to be read as a comparison if they did not.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const REPS = Number(flag('--reps', 10));
const CPU_POLLS = Number(flag('--cpu-polls', 12));
const JSON_OUT = flag('--json', '');
const GAMES = ['RobloxPlayerBeta.exe', 'RobloxStudioBeta.exe', 'javaw.exe'];
const now = () => Number(process.hrtime.bigint()) / 1e6;

function stats(a) {
  const s = [...a].sort((x, y) => x - y);
  const at = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return { n: s.length, mean: +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2),
    p50: +at(0.5).toFixed(2), p95: +at(0.95).toFixed(2), max: +s[s.length - 1].toFixed(2), min: +s[0].toFixed(2) };
}

// Machine-wide busy milliseconds since boot, summed over every core.
function busyMs() {
  let busy = 0;
  for (const c of os.cpus()) busy += c.times.user + c.times.nice + c.times.sys + c.times.irq;
  return busy;
}

function run(args) {
  return new Promise((resolve) => {
    execFile('tasklist.exe', args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => resolve(error ? '' : String(stdout || '')));
  });
}

// A filtered tasklist prints the matching rows; whichever GAMES entry appears
// in them is the answer, so a wildcard filter is exactly as precise as a
// per-name one -- it just asks the OS once for a family of names.
function firstGameIn(text) {
  const t = String(text || '').toLowerCase();
  for (const name of GAMES) if (t.includes(name.toLowerCase())) return name;
  return '';
}

const VARIANTS = {
  'A three filtered calls, sequential (the original)': async () => {
    for (const name of GAMES) {
      const out = await run(['/FI', `IMAGENAME eq ${name}`, '/NH']);
      if (firstGameIn(out) === name) return { found: name, spawns: GAMES.indexOf(name) + 1 };
    }
    return { found: '', spawns: GAMES.length };
  },
  'B three filtered calls, parallel': async () => {
    const outs = await Promise.all(GAMES.map((n) => run(['/FI', `IMAGENAME eq ${n}`, '/NH'])));
    for (let i = 0; i < GAMES.length; i++) if (firstGameIn(outs[i]) === GAMES[i]) return { found: GAMES[i], spawns: 3 };
    return { found: '', spawns: 3 };
  },
  'C one full enumeration, CSV, matched in process': async () => {
    const out = await run(['/NH', '/FO', 'CSV']);
    const t = out.toLowerCase();
    for (const name of GAMES) if (t.includes(`"${name.toLowerCase()}"`)) return { found: name, spawns: 1 };
    return { found: '', spawns: 1 };
  },
  'D one full enumeration, table format': async () => {
    const out = await run(['/NH']);
    return { found: firstGameIn(out), spawns: 1 };
  },
  'E two wildcard-filtered calls, parallel (Roblox* + javaw.exe)': async () => {
    const outs = await Promise.all([run(['/FI', 'IMAGENAME eq Roblox*', '/NH']),
      run(['/FI', 'IMAGENAME eq javaw.exe', '/NH'])]);
    return { found: firstGameIn(outs[0]) || firstGameIn(outs[1]), spawns: 2 };
  },
  'F two wildcard-filtered calls, parallel, CSV (exact name match)': async () => {
    const outs = await Promise.all([run(['/FI', 'IMAGENAME eq Roblox*', '/NH', '/FO', 'CSV']),
      run(['/FI', 'IMAGENAME eq javaw.exe', '/NH', '/FO', 'CSV'])]);
    const t = (outs[0] + outs[1]).toLowerCase();
    for (const name of GAMES) if (t.includes('"' + name.toLowerCase() + '"')) return { found: name, spawns: 2 };
    return { found: '', spawns: 2 };
  },
  'G two wildcard-filtered calls, sequential, CSV': async () => {
    for (const filter of ['Roblox*', 'javaw.exe']) {
      const out = await run(['/FI', 'IMAGENAME eq ' + filter, '/NH', '/FO', 'CSV']);
      const t = out.toLowerCase();
      for (const name of GAMES) if (t.includes('"' + name.toLowerCase() + '"')) return { found: name, spawns: filter === 'Roblox*' ? 1 : 2 };
    }
    return { found: '', spawns: 2 };
  },
};

async function wallGroup() {
  const times = {};
  const answers = {};
  const spawns = {};
  for (const k of Object.keys(VARIANTS)) { times[k] = []; answers[k] = new Set(); spawns[k] = 0; }
  for (const k of Object.keys(VARIANTS)) await VARIANTS[k]();               // warm
  for (let i = 0; i < REPS; i++) {
    for (const [k, fn] of Object.entries(VARIANTS)) {
      const t0 = now();
      const r = await fn();
      times[k].push(now() - t0);
      answers[k].add(r.found);
      spawns[k] += r.spawns;
    }
  }
  return Object.keys(VARIANTS).map((k) => ({ variant: k, ...stats(times[k]),
    spawnsPerPoll: +(spawns[k] / REPS).toFixed(2), answers: [...answers[k]].map((a) => a || '(none)') }));
}

// Per-SAMPLE cost, interleaved and taken as a median.
//
// A block-per-variant design was tried first and thrown away: on a machine with
// 4x background load the idle correction swamped the signal and the ranking
// flipped between runs. Interleaving every sample and reporting the median
// makes a load spike land on all variants equally and stops one spike from
// moving the answer. Background load is still subtracted per sample, because a
// slower variant would otherwise be charged for more of it.
async function cpuGroup(rounds) {
  const samples = {};
  for (const k of Object.keys(VARIANTS)) samples[k] = [];
  // Idle control, measured in the same interleaved way as everything else.
  const idleRates = [];
  for (let i = 0; i < 6; i++) {
    const b0 = busyMs();
    const w0 = now();
    await new Promise((r) => setTimeout(r, 250));
    idleRates.push((busyMs() - b0) / (now() - w0));
  }
  idleRates.sort((a, b) => a - b);
  const idlePerMs = idleRates[Math.floor(idleRates.length / 2)];
  for (let round = 0; round < rounds; round++) {
    for (const [k, fn] of Object.entries(VARIANTS)) {
      const b0 = busyMs();
      const w0 = now();
      await fn();
      const wall = now() - w0;
      samples[k].push((busyMs() - b0) - idlePerMs * wall);
    }
  }
  const out = {};
  for (const [k, arr] of Object.entries(samples)) {
    const s2 = [...arr].sort((a, b) => a - b);
    out[k] = {
      cpuMsPerPoll: +s2[Math.floor(s2.length / 2)].toFixed(1),
      p25: +s2[Math.floor(s2.length * 0.25)].toFixed(1),
      p75: +s2[Math.floor(s2.length * 0.75)].toFixed(1),
      polls: s2.length,
    };
  }
  return { idleBusyMsPerWallMs: +idlePerMs.toFixed(3), perVariant: out };
}

(async () => {
  const wall = await wallGroup();
  const cpu = await cpuGroup(CPU_POLLS);
  const all = new Set(wall.flatMap((r) => r.answers));
  console.log(`every variant agreed on the answer: ${all.size === 1} -> ${[...all].join(' | ')}`);
  console.log(`machine background load during the CPU group: ${cpu.idleBusyMsPerWallMs} busy-ms per wall-ms (${os.cpus().length} cores)\n`);
  for (const r of wall) {
    const c = cpu.perVariant[r.variant];
    console.log(r.variant);
    console.log(`  wall  mean ${r.mean}  p50 ${r.p50}  p95 ${r.p95}  max ${r.max}  min ${r.min}`);
    console.log(`  CPU   ${c.cpuMsPerPoll} ms/poll median (p25 ${c.p25}, p75 ${c.p75}, machine-wide, idle-corrected)   spawns/poll ${r.spawnsPerPoll}`);
  }
  if (JSON_OUT) {
    fs.writeFileSync(path.join(ROOT, JSON_OUT.replace(/^\.\//, '')),
      JSON.stringify({ when: new Date().toISOString(), reps: REPS, cores: os.cpus().length,
        agreed: all.size === 1, wall, cpu }, null, 2));
    console.log(`\nwrote ${JSON_OUT}`);
  }
})();

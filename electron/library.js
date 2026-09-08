// library.js: finds every MIDI the user has, and remembers what it learned.
//
// Two jobs live here now.
//
// 1. THE SCAN. Same contract as before — the Forge output folder plus any folder
//    the user added, depth 4, cap 4000, the skip set, melody candidates folded
//    into their primary, the truncated flag — but the walk is asynchronous and
//    the stats are batched. The old version was a recursive readdirSync with one
//    statSync per file executed straight inside the library:list IPC handler, so
//    the entire app (all IPC, all window input) froze for the length of the
//    walk, and library-changed fires after every finished Forge job and every
//    Editor export. `scan()` also reports partial batches through onBatch so the
//    Library tab paints as the list fills instead of after it.
//
// 2. THE INDEX. Length / Notes have no source in a directory listing: they come
//    out of the file's own header and track data, which is far too expensive to
//    do per render, per sort or for four thousand files up front. So each file is
//    parsed at most ONCE, keyed by path + mtime + size (the only cheap change
//    detector there is), and the answers live in a JSON file next to the app's
//    other state — never in settings, which is a small deep-merged document read
//    on every settings.get. Tags and usage (play counts, "opened in the Editor")
//    ride in the same file because they are keyed the same way and want the same
//    atomic write. Favourites deliberately do NOT: they are ui.libraryFavorites
//    in settings, one store shared with Self MIDI.
//
// Nothing in here blocks: the parser yields between files, the writes are
// debounced and atomic (temp file + rename), and every read path tolerates a
// missing or corrupt cache by rebuilding it.
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { app } = require('electron');

const MIDI_RE = /\.midi?$/i;
const PROJECT_RE = /\.midstudio\.json$/i;
const MAX_DEPTH = 4;
const MAX_FILES = 4000;
const SKIP = new Set(['node_modules', '.git', 'forge-env', 'MIDI Studio Forge', 'pip-cache', '__pycache__']);
// X_melody.mid plus _balanced and _detailed siblings are VERSIONS of one song,
// not three songs; the Version picker switches between them once the primary is
// open. An orphaned candidate (no primary on disk) is still listed.
const CANDIDATE_RE = /_(balanced|detailed)$/i;

const STAT_BATCH = 48;      // fs.stat calls in flight at once
const BATCH_MS = 70;        // no partial batch more often than this
const BATCH_FILES = 250;    // ...or before this many new files
const FRESH_MS = 2000;      // a completed scan this recent is reused verbatim
const PARSE_CAP = 32;       // files parsed per library:meta request
const ROLL_NOTES = 2200;    // notes kept for an inspector thumbnail

// ===========================================================================
// SHARED SHAPING (identical for the sync and the async walk)
// ===========================================================================

function normRoots(list) {
  const out = [];
  const seen = new Set();
  for (const r of list || []) {
    if (!r) continue;
    const abs = path.resolve(String(r));
    const key = abs.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(abs);
  }
  return out;
}

// One entry per file path: the same folder can be reached from two roots.
function dedupe(found) {
  const byPath = new Map();
  for (const file of found) {
    const key = file.path.toLowerCase();
    if (!byPath.has(key)) byPath.set(key, file);
  }
  return [...byPath.values()];
}

function foldCandidates(unique) {
  const primaries = new Set(unique.map((f) => path.join(f.dir, f.name).toLowerCase()));
  return unique.filter((f) => {
    const m = f.name.match(CANDIDATE_RE);
    if (!m) return true;
    const primary = path.join(f.dir, f.name.slice(0, -m[0].length)).toLowerCase();
    return !primaries.has(primary);   // orphaned candidate: still show it
  });
}

function byNewest(a, b) { return b.modified - a.modified; }

function shape(found) {
  const files = foldCandidates(dedupe(found)).sort(byNewest);
  return { files, truncated: found.length >= MAX_FILES };
}

// ===========================================================================
// THE SYNCHRONOUS WALK
// Kept because it is the merge-gate's fixture for the candidate fold and the
// fallback if the async path ever throws before producing anything. Nothing in
// the IPC layer calls it any more.
// ===========================================================================

function scanDirSync(root, out, depth = 0) {
  if (out.length >= MAX_FILES || depth > MAX_DEPTH) return;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (out.length >= MAX_FILES) return;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
      scanDirSync(full, out, depth + 1);
    } else if (MIDI_RE.test(entry.name)) {
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      out.push({ path: full, name: entry.name.replace(MIDI_RE, ''), dir: root,
        size: stat.size, modified: stat.mtimeMs });
    }
  }
}

function list(roots) {
  const found = [];
  for (const root of normRoots(roots)) scanDirSync(root, found);
  return shape(found);
}

// ===========================================================================
// THE ASYNCHRONOUS WALK
// Breadth-first over an explicit queue (no recursion depth to blow), stats in
// batches of STAT_BATCH, and a partial batch handed to onBatch every BATCH_MS
// or BATCH_FILES so the list paints as it fills.
// ===========================================================================

// The .midstudio.json sidecars found on the way. Source is DERIVED, never
// parsed: a sidecar next to a file means Forge wrote it, and finding them costs
// nothing because the directory entries are already in hand.
function sidecarKey(dir, stem) { return path.join(dir, stem).toLowerCase(); }

async function scan(roots, opts) {
  const o = opts || {};
  const onBatch = typeof o.onBatch === 'function' ? o.onBatch : null;
  const found = [];
  const sidecars = new Set();
  const queue = normRoots(roots).map((dir) => ({ dir, depth: 0 }));
  const seenDir = new Set(queue.map((q) => q.dir.toLowerCase()));

  let pending = [];
  let lastFlush = Date.now();

  const flush = (force) => {
    if (!onBatch || !pending.length) return;
    if (!force && pending.length < BATCH_FILES && Date.now() - lastFlush < BATCH_MS) return;
    // Fold what we can already see. The primaries known so far are enough
    // almost always (a primary and its candidates share a directory), and the
    // final authoritative list replaces this anyway.
    const known = new Set(found.map((f) => path.join(f.dir, f.name).toLowerCase()));
    const out = pending.filter((f) => {
      const m = f.name.match(CANDIDATE_RE);
      if (!m) return true;
      return !known.has(sidecarKey(f.dir, f.name.slice(0, -m[0].length)));
    });
    pending = [];
    lastFlush = Date.now();
    if (out.length) { try { onBatch(out); } catch { /* a reporting failure is not a scan failure */ } }
  };

  while (queue.length && found.length < MAX_FILES) {
    const job = queue.shift();
    let entries;
    try { entries = await fsp.readdir(job.dir, { withFileTypes: true }); } catch { continue; }
    const midis = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
        if (job.depth + 1 > MAX_DEPTH) continue;
        const full = path.join(job.dir, entry.name);
        const key = full.toLowerCase();
        if (seenDir.has(key)) continue;
        seenDir.add(key);
        queue.push({ dir: full, depth: job.depth + 1 });
      } else if (MIDI_RE.test(entry.name)) {
        midis.push(entry.name);
      } else if (PROJECT_RE.test(entry.name)) {
        sidecars.add(sidecarKey(job.dir, entry.name.replace(PROJECT_RE, '')));
      }
    }
    for (let i = 0; i < midis.length && found.length < MAX_FILES; i += STAT_BATCH) {
      const chunk = midis.slice(i, i + STAT_BATCH);
      const stats = await Promise.all(chunk.map((n) =>
        fsp.stat(path.join(job.dir, n)).then((s) => s, () => null)));
      for (let j = 0; j < chunk.length; j++) {
        if (found.length >= MAX_FILES) break;
        const st = stats[j];
        if (!st || !st.isFile()) continue;
        const file = { path: path.join(job.dir, chunk[j]), name: chunk[j].replace(MIDI_RE, ''),
          dir: job.dir, size: st.size, modified: st.mtimeMs };
        found.push(file);
        pending.push(file);
      }
      flush(false);
    }
    flush(false);
  }
  flush(true);
  const out = shape(found);
  out.sidecars = sidecars;
  return out;
}

// A .midstudio.json next to a file (its own, or its primary's) is what carries
// the source recording Preview plays, so its mere PRESENCE is the cheap answer
// to "could this row be previewed at all" -- available from the scan, without
// the per-file roll round trip the renderer would otherwise have to wait for.
function sidecarOf(file, ctx) {
  const stem = file.name.replace(CANDIDATE_RE, '');
  return ctx.sidecars.has(sidecarKey(file.dir, file.name))
    || ctx.sidecars.has(sidecarKey(file.dir, stem));
}

// Source is derived, never parsed. A sidecar means Forge produced it; so does
// living under the program output folder. A file in a folder the user added is
// Imported. Everything else is Library.
function sourceOf(file, ctx) {
  if (sidecarOf(file, ctx)) return 'generated';
  const dir = file.dir.toLowerCase();
  if (ctx.output && (dir === ctx.output || dir.startsWith(ctx.output + path.sep))) return 'generated';
  for (const extra of ctx.extra) {
    if (dir === extra || dir.startsWith(extra + path.sep)) return 'imported';
  }
  return 'library';
}

function withSource(result, dirs, extra) {
  const ctx = {
    sidecars: result.sidecars || new Set(),
    output: dirs && dirs[0] ? path.resolve(String(dirs[0])).toLowerCase() : '',
    extra: normRoots(extra || []).map((d) => d.toLowerCase())
  };
  for (const file of result.files) {
    file.source = sourceOf(file, ctx);
    file.hasAudio = sidecarOf(file, ctx);
  }
  return result;
}

// ---- one shared, coalesced scan --------------------------------------------
// Every frame re-lists on library-changed. Without this, one finished Forge job
// meant five simultaneous full walks.
let cache = null;         // {sig, at, files, truncated}
let inflight = null;      // {sig, promise, listeners:Set<fn>}

function signature(roots) { return normRoots(roots).join('|').toLowerCase(); }

function cachedScan(roots, extra, onBatch) {
  const sig = signature(roots);
  if (cache && cache.sig === sig && Date.now() - cache.at < FRESH_MS) {
    return Promise.resolve({ files: cache.files, truncated: cache.truncated });
  }
  if (inflight && inflight.sig === sig) {
    if (onBatch) inflight.listeners.add(onBatch);
    return inflight.promise;
  }
  const listeners = new Set();
  if (onBatch) listeners.add(onBatch);
  const job = { sig, listeners, promise: null };
  job.promise = scan(roots, {
    onBatch: (batch) => { for (const fn of listeners) { try { fn(batch); } catch {} } }
  }).then((result) => {
    withSource(result, roots, extra);
    reconcile(result.files);
    cache = { sig, at: Date.now(), files: result.files, truncated: result.truncated };
    if (inflight === job) inflight = null;
    return { files: result.files, truncated: result.truncated };
  }, (error) => {
    if (inflight === job) inflight = null;
    // Last resort only: a synchronous walk is what this module exists to avoid,
    // but returning nothing would empty the user's library on a transient error.
    const fallback = withSource(Object.assign(list(roots), { sidecars: new Set() }), roots, extra);
    void error;
    return { files: fallback.files, truncated: fallback.truncated };
  });
  inflight = job;
  return job.promise;
}

function invalidate() { cache = null; }

// ===========================================================================
// THE MIDI PARSER
// A standard-MIDI-file reader that answers exactly two questions — how many
// notes, and how long — plus an optional downsampled note list for the
// inspector thumbnail. Running status, SMPTE division and a tempo map spread
// across tracks are all handled, because real transcriptions use all three.
// ===========================================================================

function readVarInt(buf, pos) {
  let value = 0;
  let i = pos;
  for (let n = 0; n < 4; n++) {
    if (i >= buf.length) return [value, i];
    const byte = buf[i++];
    value = (value << 7) | (byte & 0x7f);
    if (!(byte & 0x80)) break;
  }
  return [value, i];
}

function parseMidi(buf, opts) {
  const wantRoll = !!(opts && opts.roll);
  if (!buf || buf.length < 14 || buf.toString('ascii', 0, 4) !== 'MThd') return null;
  const headerLen = buf.readUInt32BE(4);
  const division = buf.readInt16BE(12);
  let pos = 8 + headerLen;

  const tempos = [];            // {tick, usPerQuarter}
  const notes = [];             // {tick, endTick, pitch}
  let noteOns = 0;
  let lastTick = 0;

  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const len = buf.readUInt32BE(pos + 4);
    const start = pos + 8;
    const end = Math.min(buf.length, start + len);
    pos = start + len;
    if (id !== 'MTrk') continue;

    let p = start;
    let tick = 0;
    let running = 0;
    const open = new Map();     // pitch|channel -> index into notes

    while (p < end) {
      let delta;
      [delta, p] = readVarInt(buf, p);
      tick += delta;
      if (p >= end) break;
      let status = buf[p];
      if (status & 0x80) { p++; if (status < 0xf0) running = status; }
      else status = running;
      if (!status) break;

      const type = status & 0xf0;
      if (status === 0xff) {
        const metaType = buf[p++];
        let mlen;
        [mlen, p] = readVarInt(buf, p);
        if (metaType === 0x51 && mlen >= 3 && p + 3 <= end) {
          tempos.push({ tick, us: (buf[p] << 16) | (buf[p + 1] << 8) | buf[p + 2] });
        }
        p += mlen;
      } else if (status === 0xf0 || status === 0xf7) {
        let slen;
        [slen, p] = readVarInt(buf, p);
        p += slen;
      } else if (type === 0x90 || type === 0x80) {
        const pitch = buf[p++] & 0x7f;
        const vel = buf[p++] & 0x7f;
        const chan = status & 0x0f;
        const key = (chan << 8) | pitch;
        if (type === 0x90 && vel > 0) {
          noteOns++;
          const at = notes.length;
          notes.push({ tick, endTick: tick, pitch });
          const prev = open.get(key);
          if (prev !== undefined) notes[prev].endTick = Math.max(notes[prev].endTick, tick);
          open.set(key, at);
        } else {
          const at = open.get(key);
          if (at !== undefined) { notes[at].endTick = tick; open.delete(key); }
        }
      } else if (type === 0xc0 || type === 0xd0) {
        p += 1;
      } else if (type === 0xa0 || type === 0xb0 || type === 0xe0) {
        p += 2;
      } else {
        break;                  // nothing legible left in this track
      }
      if (tick > lastTick) lastTick = tick;
    }
    for (const at of open.values()) notes[at].endTick = Math.max(notes[at].endTick, tick);
  }

  // ---- ticks -> seconds ---------------------------------------------------
  let toSeconds;
  let bpm = null;
  if (division < 0) {
    // SMPTE: frames per second in the high byte (negative), ticks per frame in
    // the low byte. Tempo events do not apply.
    const frames = -(division >> 8);
    const perFrame = division & 0xff;
    const perTick = frames > 0 && perFrame > 0 ? 1 / (frames * perFrame) : 1 / 480;
    toSeconds = (t) => t * perTick;
  } else {
    const ppq = division > 0 ? division : 480;
    tempos.sort((a, b) => a.tick - b.tick);
    const segs = [{ tick: 0, sec: 0, spt: 500000 / 1e6 / ppq }];
    for (const t of tempos) {
      const last = segs[segs.length - 1];
      if (t.tick <= last.tick) { last.spt = t.us / 1e6 / ppq; continue; }
      segs.push({ tick: t.tick, sec: last.sec + (t.tick - last.tick) * last.spt, spt: t.us / 1e6 / ppq });
    }
    bpm = Math.round((6e7 / (tempos.length ? tempos[0].us : 500000)) * 10) / 10;
    toSeconds = (tick) => {
      let lo = 0, hi = segs.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (segs[mid].tick <= tick) lo = mid; else hi = mid - 1; }
      const s = segs[lo];
      return s.sec + (tick - s.tick) * s.spt;
    };
  }

  let endTick = lastTick;
  for (const n of notes) if (n.endTick > endTick) endTick = n.endTick;
  const duration = Math.round(toSeconds(endTick) * 1000) / 1000;

  const out = { notes: noteOns, duration, bpm };
  if (wantRoll) {
    const step = notes.length > ROLL_NOTES ? Math.ceil(notes.length / ROLL_NOTES) : 1;
    const roll = [];
    for (let i = 0; i < notes.length; i += step) {
      const n = notes[i];
      const s = toSeconds(n.tick);
      const e = toSeconds(Math.max(n.endTick, n.tick + 1));
      roll.push([Math.round(s * 1000) / 1000, Math.max(0.01, Math.round((e - s) * 1000) / 1000), n.pitch]);
    }
    out.roll = roll;
    out.rollSampled = step > 1;
  }
  return out;
}

// ===========================================================================
// THE PERSISTED INDEX  (metadata cache + tags + usage)
// ===========================================================================

const INDEX_V = 1;
const USAGE_EVENTS = 24;        // kept per file
const PLAY_KINDS = new Set(['player', 'selfmidi', 'preview']);

let store = null;
let storePath = '';
let saveTimer = 0;
let dirty = false;

function indexFile() {
  if (!storePath) {
    let dir = '';
    try { dir = app.getPath('userData'); } catch { dir = require('os').tmpdir(); }
    storePath = path.join(dir, 'library-index.json');
  }
  return storePath;
}

function blank() { return { v: INDEX_V, files: {}, tags: {}, usage: {} }; }

function load() {
  if (store) return store;
  store = blank();
  try {
    const raw = fs.readFileSync(indexFile(), 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.v === INDEX_V) {
      if (parsed.files && typeof parsed.files === 'object') store.files = parsed.files;
      if (parsed.tags && typeof parsed.tags === 'object') store.tags = parsed.tags;
      if (parsed.usage && typeof parsed.usage === 'object') store.usage = parsed.usage;
    }
  } catch { /* missing or corrupt: rebuild from nothing, which is always safe */ }
  return store;
}

// Temp file + rename, so a crash mid-write cannot leave half a JSON document
// where the cache used to be.
function writeNow() {
  if (!dirty) return;
  dirty = false;
  const file = indexFile();
  const tmp = file + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(load()), 'utf-8');
    fs.renameSync(tmp, file);
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function saveSoon() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = 0; writeNow(); }, 800);
  if (saveTimer.unref) saveTimer.unref();
}

function flush() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = 0; }
  writeNow();
}

const keyOf = (p) => String(p || '').toLowerCase();

// A scan is also the moment we learn what is gone. Entries whose file has
// disappeared are dropped; entries whose mtime or size moved are stale and get
// re-parsed on demand. Tags and usage are USER data and are never pruned by a
// scan — a removable drive coming back must not have lost them.
function reconcile(files) {
  const s = load();
  const live = new Set();
  for (const f of files) live.add(keyOf(f.path));
  let changed = false;
  for (const key of Object.keys(s.files)) {
    if (!live.has(key)) { delete s.files[key]; changed = true; }
  }
  for (const f of files) {
    const e = s.files[keyOf(f.path)];
    if (e && (e.m !== f.modified || e.s !== f.size)) { delete s.files[keyOf(f.path)]; changed = true; }
  }
  if (changed) saveSoon();
}

function metaOf(file) {
  const e = load().files[keyOf(file.path)];
  if (!e || e.m !== file.modified || e.s !== file.size) return null;
  return e;
}

async function parseInto(file) {
  const s = load();
  const key = keyOf(file.path);
  let entry;
  try {
    const buf = await fsp.readFile(file.path);
    const parsed = parseMidi(buf, { roll: false });
    entry = parsed
      ? { m: file.modified, s: file.size, n: parsed.notes, d: parsed.duration, bpm: parsed.bpm }
      : { m: file.modified, s: file.size, bad: 1 };
  } catch {
    entry = { m: file.modified, s: file.size, bad: 1 };
  }
  s.files[key] = entry;
  saveSoon();
  return entry;
}

// Parse at most PARSE_CAP files, yielding to the event loop between each so the
// main process keeps servicing IPC and window input while it works.
async function metaFor(requests, opts) {
  const out = {};
  const list = Array.isArray(requests) ? requests.slice(0, PARSE_CAP) : [];
  for (const req of list) {
    if (!req || !req.path) continue;
    const file = { path: String(req.path), modified: Number(req.modified) || 0, size: Number(req.size) || 0 };
    let entry = metaOf(file);
    if (!entry) {
      entry = await parseInto(file);
      await new Promise((r) => setImmediate(r));
    }
    out[file.path] = entry.bad ? { bad: true } : { notes: entry.n, duration: entry.d, bpm: entry.bpm };
  }
  const result = { meta: out };
  if (opts && opts.roll) result.roll = await rollFor(opts.roll);
  return result;
}

// The inspector's thumbnail plus whatever the Forge sidecar knows about where
// this file came from. One file, on selection — never a list.
async function rollFor(target) {
  const p = String(target || '');
  if (!p) return null;
  const out = { path: p };
  try {
    const buf = await fsp.readFile(p);
    const parsed = parseMidi(buf, { roll: true });
    if (parsed) {
      out.notes = parsed.notes;
      out.duration = parsed.duration;
      out.bpm = parsed.bpm;
      out.roll = parsed.roll;
      out.sampled = !!parsed.rollSampled;
    }
  } catch { /* an unreadable file simply has no thumbnail */ }
  const stem = path.basename(p).replace(MIDI_RE, '').replace(CANDIDATE_RE, '');
  const project = path.join(path.dirname(p), stem + '.midstudio.json');
  try {
    const raw = await fsp.readFile(project, 'utf-8');
    const doc = JSON.parse(raw);
    out.projectPath = project;
    out.previewAudio = doc.previewAudio || doc.sourceAudio || '';
    out.sourceAudio = doc.sourceAudio || '';
    out.pipeline = doc.pipeline || '';
    out.createdAt = doc.createdAt || '';
  } catch { /* no sidecar: not a Forge output, so no preview audio */ }
  return out;
}

// ---- the background full index --------------------------------------------
let indexJob = null;

function indexRunning() { return !!indexJob; }

function startIndex(files, report) {
  if (indexJob) return { ok: false, running: true };
  const todo = (files || []).filter((f) => !metaOf(f));
  const total = todo.length;
  if (!total) { try { report({ done: true, indexed: 0, total: 0 }); } catch {} return { ok: true, total: 0 }; }
  const job = { cancelled: false };
  indexJob = job;
  (async () => {
    let n = 0;
    let last = 0;
    for (const file of todo) {
      if (job.cancelled) break;
      await parseInto(file);
      n++;
      const now = Date.now();
      if (now - last > 180 || n === total) {
        last = now;
        try { report({ indexed: n, total, done: false }); } catch {}
      }
      await new Promise((r) => setImmediate(r));
    }
    indexJob = null;
    flush();
    try { report({ indexed: n, total, done: true, cancelled: job.cancelled }); } catch {}
  })();
  return { ok: true, total };
}

function cancelIndex() {
  if (indexJob) indexJob.cancelled = true;
  return { ok: true };
}

// ---- tags -----------------------------------------------------------------
function setTags(file, tags) {
  const s = load();
  const key = keyOf(file);
  const clean = [];
  const seen = new Set();
  for (const raw of Array.isArray(tags) ? tags : []) {
    const t = String(raw || '').trim().slice(0, 32);
    if (!t) continue;
    const low = t.toLowerCase();
    if (seen.has(low)) continue;
    seen.add(low);
    clean.push(t);
    if (clean.length >= 12) break;
  }
  if (clean.length) s.tags[key] = clean; else delete s.tags[key];
  saveSoon();
  return clean;
}

// ---- usage ----------------------------------------------------------------
function recordUsage(file, kind, at) {
  const s = load();
  const key = keyOf(file);
  const k = String(kind || '').toLowerCase();
  if (!key || !k) return null;
  const u = s.usage[key] || (s.usage[key] = { c: 0, l: 0, e: [] });
  const t = Number(at) || Date.now();
  if (PLAY_KINDS.has(k)) { u.c = (u.c || 0) + 1; u.l = t; }
  if (!Array.isArray(u.e)) u.e = [];
  u.e.unshift({ k, t });
  if (u.e.length > USAGE_EVENTS) u.e.length = USAGE_EVENTS;
  saveSoon();
  return u;
}

function userState() {
  const s = load();
  return { tags: s.tags, usage: s.usage };
}

// ---- free space -----------------------------------------------------------
// The number belongs next to the folder it describes, and the drive is what the
// user actually thinks in.
function storageFor(dir) {
  const target = String(dir || '');
  try {
    const probe = fs.existsSync(target) ? target : path.parse(path.resolve(target)).root;
    const st = fs.statfsSync(probe);
    const total = st.blocks * st.bsize;
    const free = st.bavail * st.bsize;
    return { root: path.parse(path.resolve(target)).root, totalBytes: total, freeBytes: free,
      usedBytes: Math.max(0, total - free) };
  } catch {
    return { root: '', totalBytes: null, freeBytes: null, usedBytes: null };
  }
}

module.exports = {
  list, scan, cachedScan, invalidate, withSource,
  parseMidi, metaFor, rollFor, reconcile,
  startIndex, cancelIndex, indexRunning,
  setTags, recordUsage, userState, storageFor,
  flush,
  MAX_FILES, MAX_DEPTH, SKIP, CANDIDATE_RE
};

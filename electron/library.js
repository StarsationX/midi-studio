// library.js — finds every MIDI the user has, so Self Midi can list them.
// Scans the Forge output folder plus any folders the user adds, and remembers
// nothing but the folder list: the files themselves are re-read on demand.
'use strict';

const fs = require('fs');
const path = require('path');

const MIDI_RE = /\.midi?$/i;
const MAX_DEPTH = 4;
const MAX_FILES = 4000;
const SKIP = new Set(['node_modules', '.git', 'forge-env', 'MIDI Studio Forge', 'pip-cache', '__pycache__']);

function scanDir(root, out, depth = 0) {
  if (out.length >= MAX_FILES || depth > MAX_DEPTH) return;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (out.length >= MAX_FILES) return;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
      scanDir(full, out, depth + 1);
    } else if (MIDI_RE.test(entry.name)) {
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      out.push({ path: full, name: entry.name.replace(MIDI_RE, ''), dir: root,
        size: stat.size, modified: stat.mtimeMs });
    }
  }
}

// One entry per file path — the same folder can be reached from two roots.
function list(roots) {
  const found = [];
  const seenRoot = new Set();
  for (const root of roots) {
    const key = path.resolve(String(root || '')).toLowerCase();
    if (!root || seenRoot.has(key)) continue;
    seenRoot.add(key);
    scanDir(path.resolve(root), found);
  }
  const byPath = new Map();
  for (const file of found) {
    const key = file.path.toLowerCase();
    if (!byPath.has(key)) byPath.set(key, file);
  }
  const files = [...byPath.values()].sort((a, b) => b.modified - a.modified);
  return { files, truncated: found.length >= MAX_FILES };
}

module.exports = { list, MAX_FILES };

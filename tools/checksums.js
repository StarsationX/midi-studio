// tools/checksums.js — write dist/SHA256SUMS.txt over every dist/*.exe so the
// self-updater can verify a new build before swapping. Runs after each build.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dist = path.join(__dirname, '..', 'dist');
function sha256(f) { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); }

if (!fs.existsSync(dist)) { console.error('[checksums] no dist/ — build first'); process.exit(1); }
const exes = fs.readdirSync(dist).filter((f) => /\.exe$/i.test(f)).sort();
if (!exes.length) { console.error('[checksums] no .exe in dist/'); process.exit(1); }
const lines = exes.map((n) => `${sha256(path.join(dist, n))}  ${n}`);
fs.writeFileSync(path.join(dist, 'SHA256SUMS.txt'), lines.join('\n') + '\n', 'utf8');
console.log('[checksums] dist/SHA256SUMS.txt');
lines.forEach((l) => console.log('  ' + l));

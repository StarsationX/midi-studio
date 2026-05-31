// updater.js — hardened built-in self-updater for the portable build.
// GitHub Releases -> SemVer compare -> download portable .exe -> SHA-256 verify
// against GitHub's per-asset `digest` -> atomic swap (move + .bak backup +
// bounded wait + restore on failure). The forge env in %LOCALAPPDATA% is never
// touched by an app update.
'use strict';

const { app, shell } = require('electron');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const REPO = 'StarsationX/midi-studio';
const LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`;

// ---- SemVer-correct compare (handles -rc/-beta) ----------------------------
function parseVer(v) {
  const s = String(v || '').trim().replace(/^v/i, '');
  const [core, pre = ''] = s.split('-', 2);
  const rel = core.split('.').map((n) => parseInt(n, 10) || 0);
  while (rel.length < 3) rel.push(0);
  const preParts = pre ? pre.split('.').map((p) => (/^\d+$/.test(p) ? parseInt(p, 10) : p)) : [];
  return { rel, pre: preParts };
}
function cmpVer(a, b) {
  const pa = parseVer(a), pb = parseVer(b);
  for (let i = 0; i < 3; i++) { const d = (pa.rel[i] || 0) - (pb.rel[i] || 0); if (d) return d > 0 ? 1 : -1; }
  if (!pa.pre.length && !pb.pre.length) return 0;
  if (!pa.pre.length) return 1;
  if (!pb.pre.length) return -1;
  const len = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < len; i++) {
    const x = pa.pre[i], y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = typeof x === 'number', yn = typeof y === 'number';
    if (xn && yn) { if (x !== y) return x > y ? 1 : -1; }
    else if (xn !== yn) return xn ? -1 : 1;
    else if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

// ---- HTTPS helpers (enforce https, manual redirect follow) -----------------
function assertHttps(url) { if (!/^https:\/\//i.test(url)) throw new Error(`Refusing non-HTTPS URL: ${url}`); }
function getJson(url, n = 0) {
  return new Promise((res, rej) => {
    try { assertHttps(url); } catch (e) { return rej(e); }
    if (n > 5) return rej(new Error('Too many redirects'));
    https.get(url, { headers: { 'User-Agent': 'midi-studio-updater', Accept: 'application/vnd.github+json' } }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) { r.resume(); return res(getJson(r.headers.location, n + 1)); }
      if (r.statusCode !== 200) { r.resume(); return rej(new Error(`GitHub API HTTP ${r.statusCode}`)); }
      let b = ''; r.setEncoding('utf8'); r.on('data', (c) => (b += c)); r.on('end', () => { try { res(JSON.parse(b)); } catch { rej(new Error('Bad JSON')); } });
    }).on('error', rej);
  });
}
function download(url, dest, onProgress, n = 0) {
  return new Promise((res, rej) => {
    try { assertHttps(url); } catch (e) { return rej(e); }
    if (n > 5) return rej(new Error('Too many redirects'));
    https.get(url, { headers: { 'User-Agent': 'midi-studio-updater' } }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) { r.resume(); return res(download(r.headers.location, dest, onProgress, n + 1)); }
      if (r.statusCode !== 200) { r.resume(); return rej(new Error(`Download HTTP ${r.statusCode}`)); }
      const total = parseInt(r.headers['content-length'] || '0', 10); let got = 0;
      const out = fs.createWriteStream(dest);
      r.on('data', (c) => { got += c.length; if (total && onProgress) onProgress(got / total); });
      r.pipe(out);
      out.on('finish', () => out.close(() => res(dest)));
      out.on('error', (e) => { try { fs.unlinkSync(dest); } catch {} rej(e); });
      r.on('error', (e) => { try { fs.unlinkSync(dest); } catch {} rej(e); });
    }).on('error', rej);
  });
}
function sha256File(p) {
  return new Promise((res, rej) => {
    const h = crypto.createHash('sha256'); const s = fs.createReadStream(p);
    s.on('error', rej); s.on('data', (d) => h.update(d)); s.on('end', () => res(h.digest('hex').toLowerCase()));
  });
}

const pickPortable = (a) => (a || []).find((x) => /-portable\.exe$/i.test(x.name)) || (a || []).find((x) => /portable.*\.exe$/i.test(x.name));
const pickSetup = (a) => (a || []).find((x) => /setup.*\.exe$/i.test(x.name)) || (a || []).find((x) => /\.exe$/i.test(x.name) && !/portable/i.test(x.name));
let cached = null;
function stagingDir() { const d = path.join(app.getPath('userData'), 'updates'); try { fs.mkdirSync(d, { recursive: true }); } catch {} return d; }

async function checkForUpdates(send, { manual } = {}) {
  try {
    if (manual) send({ state: 'checking' });
    const rel = await getJson(LATEST_API);
    const latest = rel.tag_name || rel.name || '';
    const current = app.getVersion();
    const portable = pickPortable(rel.assets), setup = pickSetup(rel.assets);
    if (cmpVer(latest, current) > 0 && (portable || setup)) {
      cached = {
        version: String(latest).replace(/^v/i, ''), current,
        // GitHub serves a per-asset `digest` ("sha256:…") in the release API,
        // so we verify against that — no SHA256SUMS.txt sidecar needed.
        portable: portable ? { url: portable.browser_download_url, name: portable.name, size: portable.size, digest: portable.digest } : null,
        setup: setup ? { url: setup.browser_download_url, name: setup.name, size: setup.size, digest: setup.digest } : null,
        notes: rel.body || '', htmlUrl: rel.html_url,
      };
      const isPortable = !!process.env.PORTABLE_EXECUTABLE_FILE;
      send({ state: 'available', version: cached.version, current,
        size: (isPortable ? cached.portable : cached.setup || cached.portable)?.size || 0,
        notes: cached.notes.slice(0, 4000), canSelfUpdate: isPortable && !!cached.portable, htmlUrl: cached.htmlUrl });
    } else { cached = null; if (manual) send({ state: 'none', current, manual: true }); }
  } catch (e) { if (manual) send({ state: 'error', message: String((e && e.message) || e), manual: true }); }
}

// Verify a downloaded file against the GitHub asset's `digest` ("sha256:<hex>").
// Returns false if the digest is absent (older release) so the caller can fall
// back to opening the release page; throws on a real MISMATCH (never swap then).
async function verifyDigest(file, digest) {
  const want = String(digest || '').replace(/^sha256:/i, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(want)) return false;
  const got = await sha256File(file);
  if (got !== want) throw new Error('Checksum mismatch — download does not match the GitHub release digest');
  return true;
}

async function applyUpdate(send) {
  if (!cached) { send({ state: 'error', message: 'No update staged.' }); return; }
  const target = process.env.PORTABLE_EXECUTABLE_FILE;

  if (!target) { // dev / NSIS
    if (cached.setup) {
      try {
        send({ state: 'downloading', percent: 0 });
        const dst = path.join(stagingDir(), cached.setup.name);
        await download(cached.setup.url, dst, (p) => send({ state: 'downloading', percent: Math.round(p * 100) }));
        send({ state: 'verifying' });
        if (!(await verifyDigest(dst, cached.setup.digest))) { try { fs.unlinkSync(dst); } catch {} shell.openExternal(cached.htmlUrl); send({ state: 'manual', htmlUrl: cached.htmlUrl }); return; }
        send({ state: 'ready' });
        spawn(dst, ['/S'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
        setTimeout(() => app.quit(), 400);
      } catch (e) { send({ state: 'error', message: String((e && e.message) || e) }); }
    } else { shell.openExternal(cached.htmlUrl); send({ state: 'manual', htmlUrl: cached.htmlUrl }); }
    return;
  }

  if (!cached.portable) { shell.openExternal(cached.htmlUrl); send({ state: 'manual', htmlUrl: cached.htmlUrl }); return; }
  try {
    send({ state: 'downloading', percent: 0 });
    const newExe = path.join(stagingDir(), `MIDI-Studio-${cached.version}-portable.exe`);
    await download(cached.portable.url, newExe, (p) => send({ state: 'downloading', percent: Math.round(p * 100) }));
    send({ state: 'verifying' });
    let verified = false;
    try { verified = await verifyDigest(newExe, cached.portable.digest); }
    catch (mm) { try { fs.unlinkSync(newExe); } catch {} send({ state: 'error', message: String(mm.message || mm) }); return; }
    if (!verified) { try { fs.unlinkSync(newExe); } catch {} shell.openExternal(cached.htmlUrl); send({ state: 'manual', htmlUrl: cached.htmlUrl, reason: 'no-digest' }); return; }

    send({ state: 'ready' });
    const bak = `${target}.bak`, pid = process.pid;
    const bat = [
      '@echo off', 'setlocal enableextensions',
      `set "SRC=${newExe}"`, `set "DST=${target}"`, `set "BAK=${bak}"`, `set "PID=${pid}"`,
      'set /a tries=0',
      ':waitloop', 'tasklist /fi "PID eq %PID%" 2>nul | find "%PID%" >nul', 'if errorlevel 1 goto exited',
      'set /a tries+=1', 'if %tries% GEQ 60 goto giveup', 'ping 127.0.0.1 -n 2 >nul', 'goto waitloop',
      ':exited',
      'if exist "%BAK%" del "%BAK%" >nul 2>nul',
      'if exist "%DST%" move /y "%DST%" "%BAK%" >nul 2>nul',
      'if exist "%DST%" goto restore',          // first move failed -> DST still locked
      'move /y "%SRC%" "%DST%" >nul 2>nul',
      'if not exist "%DST%" goto restore',       // new exe did not land -> recover
      'start "" "%DST%" --post-update',
      'del "%BAK%" >nul 2>nul',
      'goto cleanup',
      ':restore', 'if exist "%BAK%" move /y "%BAK%" "%DST%" >nul 2>nul', 'start "" "%DST%"', 'goto cleanup',
      ':giveup', 'del "%SRC%" >nul 2>nul',
      ':cleanup', 'del "%SRC%" >nul 2>nul', '(goto) 2>nul & del "%~f0"', '',
    ].join('\r\n');
    const batPath = path.join(stagingDir(), `apply-update-${cached.version}.bat`);
    fs.writeFileSync(batPath, bat, 'utf8');
    spawn('cmd.exe', ['/c', batPath], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    setTimeout(() => app.quit(), 400);
  } catch (e) { send({ state: 'error', message: String((e && e.message) || e) }); }
}

module.exports = { checkForUpdates, applyUpdate, cmpVer, parseVer, verifyDigest, pickPortableAsset: pickPortable };

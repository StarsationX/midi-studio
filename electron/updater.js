// updater.js: full-installer updater for MIDI Studio.
// GitHub Releases -> SemVer compare -> download Setup.exe -> SHA-256 verify
// against GitHub's per-asset digest -> run the NSIS installer silently.
'use strict';

const { app, shell } = require('electron');
const { execFile } = require('child_process');
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

const pickSetup = (a) => (a || []).find((x) => /setup.*\.exe$/i.test(x.name)) || (a || []).find((x) => /\.exe$/i.test(x.name) && !/portable/i.test(x.name));
// Installed builds update silently in place. A leftover portable .exe from 2.7.0
// or earlier cannot replace itself with an installer, so show the wizard.
// otherwise it silently installs a second copy and keeps nagging forever.
const installerArgs = () => (process.env.PORTABLE_EXECUTABLE_FILE ? [] : ['/S']);

// Can this process write where the app is installed?
// An app in C:\Program Files cannot be replaced by a silent installer run
// without elevation, the installer exits 1223 immediately and nothing happens,
// which is exactly what "the updater does nothing" looked like.
function installDirWritable() {
  try {
    const dir = path.dirname(app.getPath('exe'));
    const probe = path.join(dir, `.midi-studio-update-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch (_) { return false; }
}

// Launch the installer, elevating when the install location needs it. Resolves
// once it is actually running (or the user refused the UAC prompt).
//
// On Windows the installer is ALWAYS started through Start-Process, never with
// a direct spawn. A directly spawned process stays a child of MIDI Studio.exe
// (detached:true does not change that on Windows), and the installer's own
// "close the running app" step used to taskkill that tree, so the installer
// killed itself. Start-Process hands the launch to a helper that exits
// immediately, so the installer is not sitting in our process tree.
function launchInstaller(file) {
  return new Promise((resolve) => {
    const args = installerArgs();
    if (process.platform !== 'win32') {
      try {
        spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
        resolve({ ok: true });
      } catch (e) { resolve({ ok: false, error: String(e.message || e) }); }
      return;
    }
    const elevate = !installDirWritable();
    const quoted = file.replace(/'/g, "''");
    const argList = args.length ? ` -ArgumentList '${args.join("','")}'` : '';
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Start-Process -FilePath '${quoted}'${argList}${elevate ? ' -Verb RunAs' : ''}`],
      { windowsHide: true, timeout: 120000 }, (error) => {
        if (!error) { resolve({ ok: true, elevated: elevate }); return; }
        resolve({ ok: false, elevated: elevate,
          error: elevate
            ? 'Windows needs permission to replace the installed files. '
              + 'Approve the prompt, or run the downloaded installer yourself.'
            : 'The installer could not be started. Run the downloaded file yourself.' });
      });
  });
}
let cached = null;
function stagingDir() { const d = path.join(app.getPath('userData'), 'updates'); try { fs.mkdirSync(d, { recursive: true }); } catch {} return d; }

async function checkForUpdates(send, { manual } = {}) {
  try {
    if (manual) send({ state: 'checking' });
    const rel = await getJson(LATEST_API);
    const latest = rel.tag_name || rel.name || '';
    const current = app.getVersion();
    const setup = pickSetup(rel.assets);
    if (cmpVer(latest, current) > 0 && setup) {
      cached = {
        version: String(latest).replace(/^v/i, ''), current,
        // GitHub serves a per-asset `digest` ("sha256:…") in the release API,
        // so we verify against that, no SHA256SUMS.txt sidecar needed.
        setup: { url: setup.browser_download_url, name: setup.name, size: setup.size, digest: setup.digest },
        notes: rel.body || '', htmlUrl: rel.html_url,
      };
      send({ state: 'available', version: cached.version, current,
        size: cached.setup.size || 0,
        notes: cached.notes.slice(0, 4000),
        canSelfUpdate: true, htmlUrl: cached.htmlUrl });
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
  if (got !== want) throw new Error('Checksum mismatch, download does not match the GitHub release digest');
  return true;
}

async function applyUpdate(send) {
  if (!cached) { send({ state: 'error', message: 'No update staged.' }); return; }
  try {
    send({ state: 'downloading', percent: 0 });
    const installer = path.join(stagingDir(), cached.setup.name);
    await download(cached.setup.url, installer, (p) => send({ state: 'downloading', percent: Math.round(p * 100) }));
    send({ state: 'verifying' });
    if (!(await verifyDigest(installer, cached.setup.digest))) {
      try { fs.unlinkSync(installer); } catch {}
      shell.openExternal(cached.htmlUrl);
      send({ state: 'manual', htmlUrl: cached.htmlUrl, reason: 'no-digest' });
      return;
    }
    send({ state: 'ready' });
    const started = await launchInstaller(installer);
    if (!started.ok) {
      // Leave the app running and hand the user the file rather than quitting
      // into nothing.
      shell.showItemInFolder(installer);
      send({ state: 'error', message: started.error || 'The installer could not be started.' });
      return;
    }
    setTimeout(() => app.quit(), 400);
  } catch (e) { send({ state: 'error', message: String((e && e.message) || e) }); }
}

module.exports = { checkForUpdates, applyUpdate, cmpVer, parseVer, verifyDigest,
  pickSetupAsset: pickSetup, installerArgs, installDirWritable };

// editor-open-paths.js: the Editor's open path has three shapes, and only one
// of them is a plain .mid. This drives all three through the REAL panel with the
// REAL preload and the REAL main-process loader, and checks what came back.
//
//   npx electron benchmarks/editor-open-paths.js
//
//   1. a plain .mid                    -> the renderer reader
//   2. a .midstudio.json project with
//      two candidates                  -> the renderer reader, both takes
//   3. a file the renderer reader
//      REFUSES (a type 2 MIDI)         -> falls back to python, still opens
//   4. a file that does not exist      -> the same error the python path gives
//
// It is a correctness check, not a benchmark: it asserts and exits non-zero.
'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ENGINE = path.join(ROOT, 'python-engine');
const FIXTURES = path.join(__dirname, 'fixtures');

// the real loader, verbatim from electron/main.js
function runMidiDocument(action, midiPath) {
  return new Promise((resolve, reject) => {
    const py = path.join(ENGINE, 'python', 'python.exe');
    const child = spawn(py, [path.join(ENGINE, 'midi_document.py'), action, midiPath],
      { cwd: ENGINE, windowsHide: true, env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' }) });
    let out = '', err = '';
    child.stdout.setEncoding('utf-8'); child.stdout.on('data', (d) => { out += d; });
    child.stderr.setEncoding('utf-8'); child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) { reject(new Error(err.trim() || 'exit ' + code)); return; }
      try { resolve(JSON.parse(out.trim())); } catch { reject(new Error('invalid data')); }
    });
  });
}
async function loadReviewFile(filePath) {
  if (!fs.existsSync(filePath)) throw new Error('Project or MIDI file was not found.');
  if (/\.midi?$/i.test(filePath)) {
    return { projectPath: '',
      project: { format: 'midi-studio-project', version: 1, name: path.basename(filePath, path.extname(filePath)),
        sourceAudio: '', selectedCandidate: 'clean', candidates: { clean: filePath } },
      documents: { clean: await runMidiDocument('load', filePath) } };
  }
  const project = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  if (project.format !== 'midi-studio-project' || !project.candidates) throw new Error('This is not a MIDI Studio project.');
  const documents = {};
  for (const [name, midiPath] of Object.entries(project.candidates)) {
    if (fs.existsSync(midiPath)) documents[name] = await runMidiDocument('load', midiPath);
  }
  if (!Object.keys(documents).length) throw new Error('The project MIDI files could not be found.');
  return { projectPath: filePath, project, documents };
}

const HANDLERS = {
  'app:getUi': () => ({ ok: true, ui: {} }),
  'app:settings': () => ({ ok: true, settings: {} }),
  'settings:get': () => ({ ok: true, value: null }),
  'settings:set': () => ({ ok: true }),
  'review:pick': () => '',
  'review:load': async (p) => {
    try { return { ok: true, data: await loadReviewFile(String(p || '')) }; }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  },
  'review:saveProject': () => ({ ok: false, canceled: true }),
  'review:exportMidi': () => ({ ok: false, canceled: true }),
  'library:list': () => ({ dirs: [], extra: [], files: [], truncated: false }),
  'shell:openPath': () => ({ ok: true }),
};

app.on('window-all-closed', () => {});

// A type 2 (asynchronous) file. Both readers refuse it, with the same message,
// which is what makes it a good probe: the renderer reader must decline and the
// python loader must be the one that produces the error the user sees.
function type2File(dir) {
  const b = fs.readFileSync(path.join(FIXTURES, 'tiny.mid'));
  b[9] = 2;                                   // MThd format field
  const f = path.join(dir, 'type2.mid');
  fs.writeFileSync(f, b);
  return f;
}

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok   ' + m); } else { fail++; console.log('  FAIL ' + m); } };

(async () => {
  await app.whenReady();
  for (const [ch, fn] of Object.entries(HANDLERS)) {
    ipcMain.removeHandler(ch);
    ipcMain.handle(ch, async (_e, a) => { try { return await fn(a); } catch (e) { return { ok: false, error: String(e) }; } });
  }
  for (const ch of ['win:minimize', 'win:maximize', 'win:unmaximize', 'win:toggleMaximize', 'win:close']) {
    ipcMain.removeAllListeners(ch); ipcMain.on(ch, () => {});
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'midi-studio-paths-'));
  const win = new BrowserWindow({ width: 1400, height: 900, show: true,
    webPreferences: { preload: path.join(ROOT, 'electron', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
      nodeIntegrationInSubFrames: true, backgroundThrottling: false } });
  try {
    await win.loadFile(path.join(ROOT, 'renderer', 'review', 'index.html'));
    win.focus(); win.webContents.focus();
    await new Promise((r) => setTimeout(r, 900));

    const open = async (p) => {
      await win.webContents.executeJavaScript(`window.openReviewProject(${JSON.stringify(p)})`);
      await new Promise((r) => setTimeout(r, 300));
      return JSON.parse(await win.webContents.executeJavaScript(`JSON.stringify({
        via: window.__review.loadedVia,
        status: (document.getElementById('status') || {}).textContent || '',
        name: document.getElementById('proj-name').value,
        takes: Array.from(document.querySelectorAll('#src-list .lrow-name')).map((e) => e.textContent),
        notes: (window.__review.snapshot() || { notes: [] }).notes.length,
        say: (document.getElementById('detail') || {}).textContent || '',
      })`));
    };

    // 1. a plain .mid
    console.log('\nplain .mid');
    let r = await open(path.join(FIXTURES, 'big-10k.mid'));
    ok(r.via === 'js', 'read by the renderer parser (via=' + r.via + ')');
    ok(r.notes === 10000, 'all 10,000 notes are on the roll (' + r.notes + ')');
    ok(r.name === 'big-10k', 'project name comes from the file stem (' + r.name + ')');

    // 2. a .midstudio.json project with two candidates
    console.log('\n.midstudio.json project, two takes');
    const proj = path.join(tmp, 'demo.midstudio.json');
    fs.writeFileSync(proj, JSON.stringify({ format: 'midi-studio-project', version: 1, name: 'demo',
      sourceAudio: '', selectedCandidate: 'clean',
      candidates: { clean: path.join(FIXTURES, 'normal.mid'), raw: path.join(FIXTURES, 'big-10k.mid') } }));
    r = await open(proj);
    ok(r.via === 'js', 'read by the renderer parser (via=' + r.via + ')');
    ok(r.notes === 2000, 'the selected take is the one on the roll (' + r.notes + ' notes)');
    ok(r.takes.length === 2, 'both takes are listed (' + r.takes.join(', ') + ')');
    ok(r.name === 'demo', "the project's own name wins over the file stem (" + r.name + ')');

    // 3. a file the renderer parser refuses
    console.log('\na file the renderer parser refuses (type 2)');
    r = await open(type2File(tmp));
    ok(r.via === 'python', 'the python loader took over (via=' + r.via + ')');
    ok(/type 2/i.test(r.say) || /could not open/i.test(r.say),
      'and its error is the one the user sees: ' + JSON.stringify(r.say.slice(0, 90)));

    // 4. a file that is not there
    console.log('\na file that does not exist');
    r = await open(path.join(tmp, 'nope.mid'));
    ok(r.via === 'python', 'the python loader took over (via=' + r.via + ')');
    ok(/was not found/i.test(r.say), 'and its error is the one the user sees: ' + JSON.stringify(r.say.slice(0, 90)));
  } catch (e) {
    fail++;
    process.stderr.write('FATAL ' + ((e && e.stack) || e) + '\n');
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* windows lock */ }
  }
  console.log('\n' + pass + ' ok, ' + fail + ' failed');
  app.exit(fail ? 1 : 0);
})();

// subscribe-cost.js -- what does telling main "I listen to this channel" cost
// the renderer, in the frame that pays it?
//
//   node_modules/electron/dist/electron.exe benchmarks/subscribe-cost.js
//
// preload.js's onChannel now fires one fire-and-forget ipcRenderer.send per
// channel per frame, plus one "I have finished loading" marker. That is renderer
// work added to the boot path, so it has to be counted rather than assumed
// negligible. It is measured through window.studio.bootMark, which is the SAME
// ipcRenderer.send primitive in the same preload, driven from page script.
'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const stubs = require(path.join(ROOT, 'tools', 'ipc-stubs.js'));
const fanout = require(path.join(ROOT, 'electron', 'fanout.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  stubs.registerStubs();
  let subscribeMessages = 0;
  ipcMain.on('app:subscribe', (e, channel) => {
    subscribeMessages += 1;
    if (channel == null) fanout.markReady(e.senderFrame);
    else fanout.noteSubscription(e.senderFrame, channel);
  });

  const win = new BrowserWindow({
    width: 1280, height: 820, show: false, frame: false,
    webPreferences: {
      preload: path.join(ROOT, 'electron', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
      nodeIntegrationInSubFrames: true, backgroundThrottling: false,
    },
  });
  const wc = win.webContents;
  wc.on('will-prevent-unload', (e) => e.preventDefault());
  await win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  for (let i = 0; i < 200; i++) {
    const ready = await wc.executeJavaScript(`document.body.dataset.boot === 'ready'`, true).catch(() => false);
    if (ready) break;
    await sleep(60);
  }
  const bootMessages = subscribeMessages;
  await sleep(500);

  // 2000 sends of the same primitive, from page script, in the shell frame.
  const perSend = await wc.executeJavaScript(`(() => {
    const N = 2000;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) window.studio.bootMark('probe', i);
    return (performance.now() - t0) / N;
  })()`, true);

  console.log(`app:subscribe messages sent while the shell + its first panel booted: ${bootMessages}`);
  console.log(`one ipcRenderer.send from page script: ${perSend.toFixed(4)} ms`);
  console.log(`=> renderer cost of the whole subscription mechanism at boot: ${(bootMessages * perSend).toFixed(3)} ms`);
  win.destroy();
  app.quit();
}).catch((e) => { console.error(e); app.exit(1); });

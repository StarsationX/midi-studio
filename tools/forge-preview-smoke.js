// Exercise Forge's built-in MIDI preview through a running Electron debug port.
'use strict';

const fs = require('fs');

async function main() {
  const port = Number(process.argv[2]);
  const projectPath = process.argv[3];
  const screenshotPath = process.argv[4];
  if (!port || !projectPath || !screenshotPath) throw new Error('Usage: node tools/forge-preview-smoke.js <port> <project> <screenshot>');
  const [page] = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let nextId = 0;
  const pending = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
  };
  const call = (method, params = {}) => new Promise((resolve) => {
    const id = ++nextId; pending.set(id, resolve); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = (expression) => call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  await evaluate(`document.querySelector('.tab[data-tab="forge"]').click()`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const initial = await evaluate(`(() => {
    const doc = document.getElementById('frame-forge').contentDocument;
    return {
      outputHidden: doc.getElementById('output').hidden,
      previewHidden: doc.getElementById('midi-preview').hidden,
      emptyHidden: doc.getElementById('midi-preview-empty').hidden,
      bodyHidden: doc.getElementById('midi-preview-body').hidden,
      openHidden: doc.getElementById('midi-preview-open').hidden
    };
  })()`);
  await evaluate(`(() => {
    const frame = document.getElementById('frame-forge');
    frame.contentWindow.openForgeMidiPreview('', ${JSON.stringify(projectPath)});
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 1400));
  const loaded = await evaluate(`(() => {
    const doc = document.getElementById('frame-forge').contentDocument;
    const panel = doc.getElementById('midi-preview');
    panel.scrollIntoView({ block: 'center' });
    const volume = doc.getElementById('midi-preview-volume');
    volume.value = 37; volume.dispatchEvent(new Event('input', { bubbles: true }));
    const sound = doc.getElementById('midi-preview-sound');
    sound.value = 'electric_piano'; sound.dispatchEvent(new Event('change', { bubbles: true }));
    const sustain = doc.getElementById('midi-preview-sustain');
    sustain.checked = true; sustain.dispatchEvent(new Event('change', { bubbles: true }));
    const candidate = doc.getElementById('midi-preview-candidate');
    candidate.value = 'balanced'; candidate.dispatchEvent(new Event('change', { bubbles: true }));
    return { hidden: panel.hidden, candidates: candidate.options.length,
      status: doc.getElementById('midi-preview-status').textContent,
      canvas: [doc.getElementById('midi-preview-roll').clientWidth, doc.getElementById('midi-preview-roll').clientHeight],
      volume: doc.getElementById('midi-preview-volume-value').textContent,
      audioVolume: doc.getElementById('preview-volume-value').textContent,
      sound: sound.value,
      instruments: sound.options.length,
      sustain: sustain.checked };
  })()`);
  await evaluate(`document.getElementById('frame-forge').contentDocument.getElementById('midi-preview-play').click()`);
  await new Promise((resolve) => setTimeout(resolve, 4000));
  const playback = await evaluate(`(() => {
    const doc = document.getElementById('frame-forge').contentDocument;
    const result = { button: doc.getElementById('midi-preview-play').textContent,
      seek: Number(doc.getElementById('midi-preview-seek').value),
      time: doc.getElementById('midi-preview-time').textContent,
      instrumentReady: doc.getElementById('midi-preview-sound').dataset.ready };
    doc.getElementById('midi-preview-stop').click();
    return result;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const screenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(screenshotPath, Buffer.from(screenshot.result.data, 'base64'));
  socket.close();
  const state = loaded.result.result.value;
  const played = playback.result.result.value;
  const initialState = initial.result.result.value;
  if (initialState.outputHidden || initialState.previewHidden || initialState.emptyHidden
      || !initialState.bodyHidden || initialState.openHidden || state.hidden || state.candidates !== 3
      || !state.canvas[0] || state.volume !== '37%' || state.instruments !== 8 || !state.sustain
      || state.sound !== 'electric_piano' || played.instrumentReady !== 'electric_piano'
      || played.button !== 'Ⅱ' || played.seek <= 0) {
    throw new Error(`Forge preview smoke test failed: ${JSON.stringify({ initialState, state, played })}`);
  }
  console.log(JSON.stringify({ initialState, state, played }));
}

main().catch((error) => { console.error(error); process.exit(1); });

'use strict';

const fs = require('fs');

async function main() {
  const port = Number(process.argv[2]);
  const projectPath = process.argv[3];
  if (!port || !projectPath) throw new Error('Usage: node tools/audition-smoke.js <port> <project>');
  const project = JSON.parse(fs.readFileSync(projectPath, 'utf8'));
  const midiPath = project.candidates.balanced || Object.values(project.candidates)[0];
  const [page] = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let nextId = 0;
  const pending = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
  };
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 15000);
    pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = (expression) => call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  await call('Page.enable');
  await evaluate(`document.querySelector('.tab[data-tab="audition"]').click()`);
  await new Promise((resolve) => setTimeout(resolve, 350));
  const initial = await evaluate(`(() => {
    const audition = document.getElementById('frame-audition').contentDocument;
    const forge = document.getElementById('frame-forge').contentDocument;
    return {
      tabs: document.querySelectorAll('.tab').length,
      active: document.querySelector('.tab.is-active').dataset.tab,
      emptyVisible: !audition.getElementById('empty').hidden,
      openEnabled: !audition.getElementById('open-midi').disabled,
      forgePreviewRemoved: !forge.getElementById('midi-preview'),
      forgeListenExists: !!forge.getElementById('output-listen')
    };
  })()`);
  await evaluate(`(() => {
    const forge = document.getElementById('frame-forge').contentDocument;
    forge.getElementById('output-path').textContent = ${JSON.stringify(midiPath)};
    forge.getElementById('output-listen').click();
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const handoff = await evaluate(`(() => ({
    active: document.querySelector('.tab.is-active').dataset.tab,
    file: document.getElementById('frame-audition').contentDocument.getElementById('file-name').textContent
  }))()`);
  await evaluate(`document.getElementById('frame-audition').contentWindow.loadAudition('', ${JSON.stringify(projectPath)}, { play: false })`);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const loaded = await evaluate(`(() => {
    const doc = document.getElementById('frame-audition').contentDocument;
    const instrument = doc.getElementById('instrument');
    instrument.value = 'electric_piano'; instrument.dispatchEvent(new Event('change', { bubbles: true }));
    const volume = doc.getElementById('volume');
    volume.value = 37; volume.dispatchEvent(new Event('input', { bubbles: true }));
    const sustain = doc.getElementById('sustain');
    sustain.checked = true; sustain.dispatchEvent(new Event('change', { bubbles: true }));
    const autoplay = doc.getElementById('autoplay');
    autoplay.checked = true; autoplay.dispatchEvent(new Event('change', { bubbles: true }));
    const candidate = doc.getElementById('candidate');
    candidate.value = 'balanced'; candidate.dispatchEvent(new Event('change', { bubbles: true }));
    doc.getElementById('roll-section').scrollIntoView({ block: 'center' });
    return {
      file: doc.getElementById('file-name').textContent,
      candidates: candidate.options.length,
      instruments: instrument.options.length,
      recent: doc.getElementById('recent').options.length,
      volume: doc.getElementById('volume-value').textContent,
      sustain: sustain.checked,
      autoplay: autoplay.checked,
      canvas: [doc.getElementById('note-roll').clientWidth, doc.getElementById('note-roll').clientHeight]
    };
  })()`);
  await evaluate(`document.getElementById('frame-audition').contentDocument.getElementById('play').click()`);
  await new Promise((resolve) => setTimeout(resolve, 4000));
  const played = await evaluate(`(() => {
    const doc = document.getElementById('frame-audition').contentDocument;
    const result = {
      button: doc.getElementById('play').textContent,
      seek: Number(doc.getElementById('seek').value),
      time: doc.getElementById('time').textContent,
      ready: doc.getElementById('instrument').dataset.ready,
      loadingHidden: doc.getElementById('loading').hidden
    };
    doc.getElementById('stop').click();
    return result;
  })()`);
  socket.close();
  const initialState = initial.result.result.value;
  const handoffState = handoff.result.result.value;
  const state = loaded.result.result.value;
  const playback = played.result.result.value;
  if (initialState.tabs !== 4 || initialState.active !== 'audition'
      || !initialState.openEnabled || !initialState.forgePreviewRemoved || !initialState.forgeListenExists
      || handoffState.active !== 'audition' || !handoffState.file.includes('smoke_balanced')
      || state.candidates !== 3 || state.instruments !== 8 || state.recent < 2 || state.volume !== '37%'
      || !state.sustain || !state.autoplay || !state.canvas[0] || !state.canvas[1]
      || playback.button !== 'Ⅱ' || playback.seek <= 0 || playback.ready !== 'electric_piano'
      || !playback.loadingHidden) {
    throw new Error(`Audition smoke test failed: ${JSON.stringify({ initialState, handoffState, state, playback })}`);
  }
  console.log(JSON.stringify({ initialState, handoffState, state, playback }));
}

main().catch((error) => { console.error(error); process.exit(1); });

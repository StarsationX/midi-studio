// Load a Review project through a running Electron debug port and capture it.
'use strict';

const fs = require('fs');

async function main() {
  const port = Number(process.argv[2] || 9333);
  const projectPath = process.argv[3];
  const screenshotPath = process.argv[4];
  if (!projectPath || !screenshotPath) throw new Error('Usage: node tools/ui-smoke.js <port> <project> <screenshot>');

  const [page] = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let nextId = 0;
  const pending = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  };
  const call = (method, params = {}) => new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = (expression) => call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });

  await evaluate(`document.querySelector('.tab[data-tab="review"]').click()`);
  await new Promise((resolve) => setTimeout(resolve, 400));
  await evaluate(`document.getElementById('frame-review').contentWindow.openReviewProject(${JSON.stringify(projectPath)})`);
  await new Promise((resolve) => setTimeout(resolve, 2400));
  const info = await evaluate(`(() => {
    const frame = document.getElementById('frame-review');
    const doc = frame.contentDocument;
    const roll = doc.getElementById('piano-roll');
    const waveform = doc.getElementById('waveform');
    return {
      title: document.title,
      active: document.querySelector('.tab.is-active').dataset.tab,
      name: doc.getElementById('project-name').textContent,
      candidates: doc.querySelectorAll('.candidate').length,
      cleanNotes: Number(doc.querySelector('.candidate.is-active small').textContent.match(/\d+/)[0]),
      editorVisible: doc.getElementById('empty').hidden,
      roll: [roll.clientWidth, roll.clientHeight],
      waveform: [waveform.clientWidth, waveform.clientHeight],
      status: doc.getElementById('status').textContent,
    };
  })()`);
  const edit = await evaluate(`(() => {
    const doc = document.getElementById('frame-review').contentDocument;
    const roll = doc.getElementById('piano-roll');
    const rect = roll.getBoundingClientRect();
    roll.dispatchEvent(new MouseEvent('dblclick', {
      bubbles: true, clientX: rect.left + 260, clientY: rect.top + 300,
    }));
    return { status: doc.getElementById('status').textContent,
      cleanNotes: doc.querySelector('.candidate.is-active small').textContent };
  })()`);
  await evaluate(`document.getElementById('frame-review').contentDocument.getElementById('save').click()`);
  await new Promise((resolve) => setTimeout(resolve, 800));
  const interaction = await evaluate(`(() => {
    const doc = document.getElementById('frame-review').contentDocument;
    doc.querySelectorAll('.candidate')[1].click();
    return { status: doc.getElementById('status').textContent,
      activeCandidate: doc.querySelector('.candidate.is-active strong').textContent };
  })()`);
  const screenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(screenshotPath, Buffer.from(screenshot.result.data, 'base64'));
  socket.close();
  const result = info.result.result.value;
  const editResult = edit.result.result.value;
  const interactionResult = interaction.result.result.value;
  if (result.active !== 'review' || result.candidates !== 3 || !result.editorVisible || !result.roll[0]
      || editResult.status !== 'UNSAVED' || Number(editResult.cleanNotes.match(/\d+/)[0]) !== result.cleanNotes + 1
      || interactionResult.status !== 'SAVED' || interactionResult.activeCandidate !== 'Balanced') {
    throw new Error(`Review smoke test failed: ${JSON.stringify({ result, editResult, interactionResult })}`);
  }
  console.log(JSON.stringify({ ...result, edit: editResult, interaction: interactionResult }));
}

main().catch((error) => { console.error(error); process.exit(1); });

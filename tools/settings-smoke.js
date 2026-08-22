'use strict';

async function main() {
  const port = Number(process.argv[2]);
  if (!port) throw new Error('Usage: node tools/settings-smoke.js <port>');
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
  await evaluate(`document.getElementById('settings-btn').click()`);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const inspected = await evaluate(`(async () => {
    const info = await window.studio.forgeInfo();
    const path = document.getElementById('s-forgedir');
    const actions = path.parentElement.querySelector('.storage-actions');
    const modal = document.querySelector('.modal');
    const modalRect = modal.getBoundingClientRect();
    const actionRect = actions.getBoundingClientRect();
    return {
      visible: !document.getElementById('settings-modal').hidden,
      path: path.textContent,
      title: path.title,
      change: !document.getElementById('s-changeforge').hidden,
      open: !document.getElementById('s-openforge').hidden,
      changeApi: typeof window.studio.changeForgeFolder === 'function',
      resetApi: typeof window.studio.resetForgeFolder === 'function',
      defaultMatches: info.forgeEnvDir === path.textContent,
      controlsFit: actionRect.right <= modalRect.right && actionRect.bottom <= modalRect.bottom,
      custom: info.forgeCustom,
      resetHidden: document.getElementById('s-resetforge').hidden
    };
  })()`);
  socket.close();
  const state = inspected.result.result.value;
  if (!state.visible || !state.path || state.path === '—' || !state.change || !state.open
      || !state.changeApi || !state.resetApi
      || !state.defaultMatches || !state.controlsFit || state.resetHidden === state.custom) {
    throw new Error(`Settings smoke test failed: ${JSON.stringify(state)}`);
  }
  console.log(JSON.stringify(state));
}

main().catch((error) => { console.error(error); process.exit(1); });

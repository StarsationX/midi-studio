'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(window, ...file) {
  window.window = window;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'renderer', ...file), 'utf8'), window);
}

function scheduler() {
  let now = 1000;
  let id = 0;
  let onAttributes;
  const frames = new Map(), timers = new Map();
  const dataset = { drawms: '16', windowFocused: '1' };
  const root = { dataset, setAttribute() {}, removeAttribute() {} };
  const browser = {
    performance: { now: () => now },
    document: { documentElement: root, addEventListener() {}, hasFocus: () => false },
    MutationObserver: class { constructor(fn) { onAttributes = fn; } observe() {} },
    addEventListener() {},
    requestAnimationFrame(fn) { frames.set(++id, fn); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    setTimeout(fn, delay) { timers.set(++id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  browser.top = browser;
  load(browser, 'shared', 'draw.js');
  let draws = 0;
  const panel = browser.Draw.register({ key: 'panel', draw: () => draws++ });
  function frame() {
    const [[id, run]] = [...frames];
    frames.delete(id);
    now += 16;
    run(now);
  }
  panel.invalidate();
  frame();
  panel.invalidate();
  assert.equal(timers.size, 1, 'a static panel has a deferred paint');
  panel.setLive(true);
  assert.equal(timers.size, 0, 'live playback supersedes the idle timer');
  assert.equal(frames.size, 1);
  dataset.windowMinimized = '1';
  onAttributes();
  assert.equal(browser.Draw.stats().parked, true);
  assert.equal(frames.size, 0, 'minimize cancels an already queued frame');
  assert.equal(timers.size, 0);
  for (let i = 0; i < 86400; i++) {
    now += 1000;
    panel.invalidate();
  }
  assert.equal(frames.size, 0);
  assert.equal(timers.size, 0, 'repeated hidden invalidation cannot wake the scheduler');
  dataset.windowMinimized = '0';
  onAttributes();
  assert.equal(browser.Draw.stats().budgetMs, 16, 'restored window uses native focus even before iframe focus');
  assert.equal(frames.size, 1);
  frame();
  assert.equal(draws, 2);
}

async function waveforms() {
  const fetched = [];
  const decodes = [];
  const browser = {
    fetch: async (url, { signal }) => {
      assert.equal(signal.aborted, false);
      fetched.push(url);
      return { ok: true, arrayBuffer: async () => url };
    },
    OfflineAudioContext: class {
      decodeAudioData(url) {
        return new Promise(resolve => decodes.push({ url, resolve }));
      }
    },
    performance: { now: () => 0 },
    setTimeout,
  };
  load(browser, 'shared', 'audio-peaks.js');
  const reader = browser.AudioPeaks.createReader();
  const requests = [], results = [];
  function read(url) {
    const request = new AbortController();
    if (requests.length) requests.at(-1).abort();
    requests.push(request);
    const task = reader.read(url, request.signal).catch(error => error.name);
    results.push(task);
    return task;
  }
  const first = read('first');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(decodes.map(d => d.url), ['first']);
  for (let i = 0; i < 150; i++) read('stale-' + i);
  const latest = read('latest');
  assert.deepEqual(fetched, ['first']);
  decodes[0].resolve('obsolete PCM');
  assert.equal(await first, 'AbortError');
  await Promise.all(results.slice(0, -1));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(fetched, ['first', 'latest']);
  assert.deepEqual(decodes.map(d => d.url), ['first', 'latest']);
  decodes[1].resolve('current PCM');
  assert.equal(await latest, 'current PCM');
  const peaks = await browser.AudioPeaks.buckets(Float32Array.of(-1, .5, -.25, .75, .1), 1, 5, 2, requests.at(-1).signal);
  assert.deepEqual(Array.from(peaks), [-.25, .5, Math.fround(.1), .75]);
}

async function audioGraph() {
  const connections = new Set();
  class Node extends EventTarget {
    constructor() {
      super();
      this.playbackRate = {};
      this.gain = {
        setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {},
      };
    }
    connect(destination) { connections.add(this); return destination; }
    disconnect() { connections.delete(this); }
    start() {}
    stop() {}
  }
  const browser = { MIDI: { Soundfont: { acoustic_grand_piano: { C4: 'data:audio/mp3;base64,AAAA' } } } };
  browser.fetch = fetch;
  load(browser, 'shared', 'note-voice.js');
  load(browser, 'soundfonts', 'player.js');
  const context = {
    createBufferSource: () => new Node(),
    createGain: () => new Node(),
    decodeAudioData: async () => ({}),
    destination: {},
  };
  const synth = browser.MidiStudioSoundfonts;
  await synth.prepare(context, 'grand_piano', [60]);
  for (let i = 0; i < 5000; i++) {
    const voice = synth.play(context, 'grand_piano', 60, i / 10, .07, 85);
    assert.ok(voice);
    voice.source.dispatchEvent(new Event('ended'));
  }
  assert.equal(connections.size, 0, 'finished notes retain no live Web Audio connections');
}

async function test() {
  scheduler();
  await waveforms();
  await audioGraph();
}

module.exports = test;
if (require.main === module) test().then(
  () => console.log('Long-session rendering, waveform, and audio checks passed.'),
  error => { console.error(error); process.exitCode = 1; }
);

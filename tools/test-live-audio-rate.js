'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const renderer = path.join(__dirname, '..', 'renderer');
const read = file => fs.readFileSync(path.join(renderer, file), 'utf8');
const noop = () => {};
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} differs from ${b}`);

// Like test-review-timing, exercise the panel's real closures without booting
// the DOM. Supply a controllable audio clock and record actual Web Audio calls.
function procedures(file, names) {
  const lines = read(file).split(/\r?\n/);
  return names.map(name => {
    const start = lines.findIndex(line => line.startsWith(`  function ${name}(`));
    assert.notEqual(start, -1, name);
    let end = start;
    if (!lines[start].endsWith('}')) {
      while (++end < lines.length && lines[end] !== '  }') {}
      assert.ok(end < lines.length, name);
    }
    return lines.slice(start, end + 1).join('\n');
  }).join('\n');
}

function audioClock() {
  const context = { currentTime: 100, destination: {}, decodeAudioData: async () => ({ duration: 20 }) };
  class Param {
    constructor() { this.events = []; }
    setValueAtTime(value, at) { this.events.push(['set', value, at]); }
    linearRampToValueAtTime(value, at) { this.events.push(['attack', value, at]); }
    exponentialRampToValueAtTime(value, at) { this.events.push(['decay', value, at]); }
    cancelAndHoldAtTime(at) { this.events.push(['hold', at]); }
  }
  class Node extends EventTarget {
    constructor() { super(); this.starts = []; this.stops = []; this.frequency = new Param(); this.playbackRate = {}; }
    start(at, offset = 0) { assert.equal(this.starts.length, 0); this.starts.push([at, offset]); }
    stop(at = context.currentTime) { this.stops.push(at); }
    connect(destination) { return destination; }
    disconnect() {}
  }
  context.createGain = () => Object.assign(new Node(), { gain: new Param() });
  context.createOscillator = context.createBufferSource = () => new Node();
  return context;
}

async function session(editor, sampled) {
  const ctx = audioClock(), notes = [[8, 10], [8, 8.0625], [8.125, 8.625], [8.125, 9], [8.25, 9.25]]
    .map(([start, end], i) => ({ start, end, channel: 0, pitch: 60 + i, velocity: 85 }));
  let timer = 0;
  const media = { currentTime: 0, paused: true, playbackRate: 1 };
  const song = { notes };
  const s = vm.createContext({ window: { MIDI: { Soundfont: { acoustic_grand_piano: {
    C4: 'data:audio/mp3;base64,AAAA', C8: 'data:audio/mp3;base64,AAAA',
  } } } },
    fetch, clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)), notes, duration: 20,
    ctx: () => ctx, ctxAudio: ctx, master: ctx.destination, sampledReady: sampled, INSTRUMENT: 'grand_piano',
    doc: () => song, samplePrepare: null, previewRequest: 0, say: noop,
    audible: () => true, midiOn: true, playing: true, clockTimer: 1, playhead: 7, songBase: 8, clockBase: 100,
    rate: 1, cursor: 0, schedTo: 8, chaseAt: null, usingAudio: () => !media.paused, audio: media, audioOffset: 12,
    voices: new Set(), timers: new Set(), sounding: new Set(), offAt: new Map(), setTimeout: () => ++timer, clearTimeout: noop,
    loopOn: false, ensureSorted: noop, paint: noop, reportTransport: noop,
    currentDocument: () => ({ notes }), loop: { on: false }, repeat: 'off', LOOKAHEAD: editor ? 0.14 : 1.5,
    ctl: { speed: 1, instrument: 'grand_piano', sustain: false, volume: 100, transpose: 0 },
    player: { duration: 20, context: ctx, master: ctx.destination, position: 7, playing: true, voices: new Set(),
      instrumentReady: sampled ? 'grand_piano' : '', audioStart: 92, cursor: 0 }, prefs: {}, rollHandle: null,
    syncSpeedUI: noop, setClock: noop, savePrefs: noop, reportState: noop });
  vm.runInContext(read('shared/note-voice.js'), s);
  vm.runInContext(read('soundfonts/player.js'), s);
  s.soundfonts = s.window.MidiStudioSoundfonts;
  if (sampled) await s.soundfonts.prepare(ctx, 'grand_piano', [60, 61, 62, 63, 64]);
  const audioProcs = ['playNote', 'scheduleAhead', 'songTime'];
  const panel = editor ? 'review/review.js' : 'audition/audition.js';
  const names = editor ? ['ensureSamples', 'boundary', 'markSounding', 'later', 'trackVoice', 'clearHighlights', 'setRate'] :
    ['region', 'cursorFor', 'pruneVoices', 'playFallback', 'setSpeed'];
  vm.runInContext(procedures(panel, audioProcs.concat(names)), s);
  return { s, ctx, media, change: editor ? s.setRate : s.setSpeed, voices: editor ? s.voices : s.player.voices };
}

async function exercise(editor, sampled) {
  const { s, ctx, media, change, voices } = await session(editor, sampled);
  s.scheduleAhead();
  const find = index => Array.from(voices).find(v => v.index === index);
  const held = find(0), tail = find(1), future = [find(2), find(3)];
  assert.ok(held && tail && future.every(Boolean), 'initial lookahead includes a chord');
  if (editor) s.playNote({ pitch: 60, velocity: 90, start: 0, end: 1, channel: 0 }, 0, true);
  const preview = find(null);
  ctx.currentTime += .0625;
  close(s.songTime(), 8.0625);
  change(2);
  close(s.songTime(), 8.0625);
  assert.equal(find(0), held, 'held voice is not replaced');
  close(held.releaseAt, 101.03125);
  close(held.source.stops.at(-1), held.endsAt);
  assert.deepEqual(held.gain.events.filter(e => e[0] === 'hold'), [['hold', 100.0625]]);
  assert.equal(held.gain.events.filter(e => e[0] === 'attack').length, 1);
  assert.equal(tail.source.stops.length, 1, 'release already in progress is not disturbed');
  if (editor) assert.equal(preview.source.stops.length, 1, 'manual preview is independent of transport');
  for (const [i, voice] of future.entries()) {
    close(voice.source.stops.at(-1), ctx.currentTime);
    assert.ok(voice.source.stops.at(-1) < voice.at, 'old attack canceled before sounding');
    assert.notEqual(find(i + 2), voice);
    close(find(i + 2).at, 100.09375);
  }
  const chord = [find(2), find(3)];
  ctx.currentTime = 100.09375; // exactly on the newly scheduled chord
  change(.5);
  close(s.songTime(), 8.125);
  for (const [i, voice] of chord.entries()) assert.equal(find(i + 2), voice, 'boundary attack is not replayed');
  close(held.releaseAt, 103.84375);
  close(chord[0].releaseAt, 101.09375);
  close(find(4).at, 100.34375);
  ctx.currentTime += .125;
  close(s.songTime(), 8.1875);
  const stops = held.source.stops.length;
  change(.5);
  assert.equal(held.source.stops.length, stops, 'same rate does not touch an envelope');
  if (editor) {
    media.currentTime = 12 + 8.2; media.paused = false;
    change(1.25);
    close(media.playbackRate, 1.25);
    close(s.songTime(), 8.2);
    assert.equal(media.currentTime, 12 + 8.2, 'original audio was not sought');
  }
  s.playing = s.player.playing = false;
  for (const position of [5, 0]) {
    s.playhead = s.player.position = position;
    change(position ? 1 : 1.5);
    close(s.songTime(), position);
    assert.equal(editor ? s.playing : s.player.playing, false);
  }
}

async function test() {
  for (const sampled of [false, true]) await exercise(false, sampled);
  await exercise(true, true);
  // A cold keyboard click and a newly drawn high note must both use samples,
  // even though the original song only contained notes near middle C.
  const { s, ctx, voices } = await session(true, false);
  ctx.createOscillator = () => assert.fail('Editor used a synthesized tone');
  const audition = pitch => s.playNote({ pitch, channel: 4, velocity: 80, start: 0, end: .5 }, 0, true);
  audition(60);
  assert.equal(voices.size, 0);
  await s.ensureSamples();
  assert.ok([...voices][0]?.source.buffer, 'first audition waited for a decoded piano recording');
  audition(108);
  const high = [...voices].at(-1);
  assert.equal(high.pitch, 108);
  assert.equal(high.source.playbackRate.value, 1, 'new C8 plays its own recording rather than transposed C4');
}

module.exports = test;
if (require.main === module) test().then(() => console.log('Live Listen and Editor audio rate changes passed.'),
  error => { console.error(error); process.exitCode = 1; });

'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const TempoMap = require('../renderer/shared/tempo-map.js');

function test() {
  const change = 69.517224; // Beat 168 of the imported Zero score.
  const events = [{ time: 0, microsecondsPerBeat: 413793 }, { time: change, microsecondsPerBeat: 375000 }];
  const grid = new TempoMap(145, events);
  const close = (a, b) => assert.ok(Math.abs(a - b) <= 1e-9, a + ' differs from ' + b);
  close(grid.beatAt(change), 168);
  close(grid.advance(change, 1), change + 0.375);
  close(grid.advance(change, -1), change - 0.413793);
  close(grid.snap(change + 0.101, 16), change + 0.09375);
  close(grid.snap(change - 0.105, 16), change - 0.413793 / 4);
  close(grid.advance(change - 0.413793 / 2, 1), change + 0.375 / 2);
  const lines = [];
  grid.forEachGrid(change - 0.42, change + 0.76, 1, 0.001, (t, i) => lines.push([t, i]));
  assert.deepEqual(lines.map(entry => entry[1]), [167, 168, 169, 170]);
  close(lines[1][0], change);
  close(lines[2][0], change + 0.375);
  const fractional = new TempoMap(120, [{ time: 0.375, microsecondsPerBeat: 250000 }]);
  close(fractional.beatAt(0.375), 0.75);
  close(fractional.timeAt(1), 0.4375);
  const legacy = new TempoMap(96);
  for (const div of [4,8,12,16,24,32]) {
    const step = 60 / 96 * 4 / div;
    for (const t of [0,.13,.26,1.007,9.308]) close(legacy.snap(t,div), Math.round(t / step) * step);
  }
  const edited = new TempoMap(100, events);
  close(edited.timeAt(1), 0.6);
  close(edited.advance(change, 1), change + 0.375);
  // Invoke the panel's real edit operations using a tiny two-note document.
  const review = fs.readFileSync(path.join(__dirname, '../renderer/review/review.js'), 'utf8');
  const procedure = name => {
    const start = review.indexOf('  function ' + name + '(');
    assert.notEqual(start, -1);
    return review.slice(start, review.indexOf('\n  }', start) + 4);
  };
  const song = { bpm:145, tempoChanges:events.map(e => ({...e})), markers:[], controllers:[],
    notes:[{start:change-0.105,end:change-0.06},{start:change+0.101,end:change+0.18}] };
  const recorded = [];
  const sandbox = { doc:() => song, targets:() => song.notes, tempoGrid:() => new TempoMap(song.bpm, song.tempoChanges),
    qDiv:() => 16, $:key => ({value:key === 'stretch' ? 200 : 100}), edit:(_, fn) => fn(), MIN_LEN:0.01,
    snap() {}, noteMoved() {}, relayout() {}, say() {}, loaded:() => true, selected:new Set(), plural:() => '',
    snapEvents:field => recorded.push(field), clamp:(v,a,b) => Math.max(a,Math.min(b,v)), cachedGrid:grid };
  vm.runInNewContext(procedure('applyQuantize') + '\napplyQuantize();', sandbox);
  close(song.notes[0].start, change-0.413793/4);
  close(song.notes[1].start, change+0.09375);
  close(song.notes[1].end - song.notes[1].start, 0.079);
  vm.runInNewContext(procedure('timeStretch') + '\ntimeStretch();', sandbox);
  assert.ok(recorded.includes('tempoChanges'));
  close(song.tempoChanges[1].time, change*2);
  close(song.notes[1].start, 2*(change+0.09375));
  assert.equal(song.tempoChanges[1].microsecondsPerBeat,375000);
}

module.exports = test;
if (require.main === module) { test(); console.log('Tempo grid, quantize and full-song stretch passed.'); }

// Convert between source seconds and quarter-note beats without resetting the
// beat count when the conductor changes tempo in the middle of a bar.
(function (root) {
  'use strict';

  class TempoMap {
    constructor(bpm, changes = []) {
      const initial = Number(bpm);
      const quarter = 60 / (Number.isFinite(initial) && initial > 0 ? initial : 120);
      const segments = [{ time: 0, beat: 0, quarter }];
      const ordered = [...(changes || [])].filter(e => Number.isFinite(e.time) && e.time >= 0 &&
        Number.isInteger(e.microsecondsPerBeat) && e.microsecondsPerBeat > 0 && e.microsecondsPerBeat <= 0xffffff
      ).sort((a, b) => a.time - b.time);
      for (const event of ordered) {
        const period = event.microsecondsPerBeat / 1000000;
        const last = segments[segments.length - 1];
        if (event.time === 0) {
          // The inspector displays the imported BPM rounded to three decimals.
          // Preserve its exact period until that initial BPM is edited.
          if (Math.abs(60 / period - initial) <= 0.000500001) last.quarter = period;
        } else if (event.time === last.time) {
          last.quarter = period;
        } else if (period !== last.quarter) {
          segments.push({ time: event.time, beat: last.beat + (event.time - last.time) / last.quarter, quarter: period });
        }
      }
      this.segments = segments;
    }

    indexAt(value, field) {
      let low = 0, high = this.segments.length;
      while (low + 1 < high) {
        const mid = Math.floor((low + high) / 2);
        if (this.segments[mid][field] <= value) low = mid;
        else high = mid;
      }
      return low;
    }

    beatAt(time) {
      const s = this.segments[this.indexAt(time, 'time')];
      return s.beat + (time - s.time) / s.quarter;
    }

    timeAt(beat) {
      const s = this.segments[this.indexAt(beat, 'beat')];
      return s.time + (beat - s.beat) * s.quarter;
    }

    snap(time, division) {
      const step = 4 / division;
      return this.timeAt(Math.round(this.beatAt(time) / step) * step);
    }

    advance(time, beats) { return this.timeAt(this.beatAt(time) + beats); }

    forEachGrid(from, to, step, minimumSeconds, draw) {
      from = Math.max(0, from);
      if (!(to >= from && step > 0)) return;
      const segments = this.segments;
      for (let i = this.indexAt(from, 'time'); i < segments.length && segments[i].time <= to; i++) {
        const s = segments[i], next = segments[i + 1];
        if (s.quarter * step < minimumSeconds) continue;
        const firstBeat = s.beat + (Math.max(from, s.time) - s.time) / s.quarter;
        const first = Math.ceil(firstBeat / step - 1e-9);
        const last = next && next.time <= to ? Math.ceil(next.beat / step - 1e-9) - 1 :
          Math.floor((s.beat + (to - s.time) / s.quarter) / step + 1e-9);
        for (let index = first; index <= last; index++) {
          draw(s.time + (index * step - s.beat) * s.quarter, index, s.quarter);
        }
      }
    }
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = TempoMap;
  else root.MidiTempoMap = TempoMap;
})(typeof window !== 'undefined' ? window : globalThis);

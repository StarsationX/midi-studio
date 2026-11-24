// CC64 extends the sounding release, never the key press in the piano roll.
// Documents store controllers in time order. Retain only down/up transitions.
window.MidiStudioSustain = class {
  constructor(controllers) {
    this.channels = new Map();
    for (const e of controllers || []) {
      if (e.controller !== 64 || e.channel === 9) continue;
      let edges = this.channels.get(e.channel);
      if (!edges) this.channels.set(e.channel, edges = []);
      if ((edges.length % 2 === 1) !== (e.value >= 64)) edges.push(e.time);
    }
  }

  static upper(edges, time) {
    let lo = 0, hi = edges.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (edges[mid] <= time) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  // null: no pedal lane on this channel. A dangling pedal ends with the song.
  release(note, songEnd) {
    const edges = this.channels.get(note.channel);
    if (!edges) return null;
    const i = window.MidiStudioSustain.upper(edges, note.end);
    return i % 2 ? (edges[i] ?? songEnd) : note.end;
  }

  // An editor seek can land after key-up but before pedal-up.
  chaseFrom(time) {
    let from = time;
    for (const edges of this.channels.values()) {
      const i = window.MidiStudioSustain.upper(edges, time);
      if (i % 2) from = Math.min(from, edges[i - 1]);
    }
    return from;
  }
};

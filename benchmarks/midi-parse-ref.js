// midi-parse-ref.js: the minimal JS MIDI reader benchmarks/bench.js already
// used inline, lifted out so the load-path harness can reuse the same code and
// the two never drift. It is a MEASUREMENT reference, not the app's loader:
// it produces the note shape the canvases walk, so the renderer-side cost of a
// document is measurable apart from python startup and the pipe.
'use strict';

module.exports = function parseMidi(buf) {
  let p = 0;
  const u32 = () => { const v = buf.readUInt32BE(p); p += 4; return v; };
  const u16 = () => { const v = buf.readUInt16BE(p); p += 2; return v; };
  const vlq = () => { let v = 0, b; do { b = buf[p++]; v = (v << 7) | (b & 0x7f); } while (b & 0x80); return v; };

  if (buf.readUInt32BE(0) !== 0x4d546864) throw new Error('not a MIDI file');
  p = 8;
  u16();                       // format
  const ntrk = u16();
  const division = u16();

  const notes = [];
  let tempo = 500000;          // us per quarter, the MIDI default
  for (let t = 0; t < ntrk; t++) {
    if (u32() !== 0x4d54726b) throw new Error('bad track header');
    const len = u32();
    const end = p + len;
    let tick = 0, status = 0;
    const active = new Map();  // (channel<<8|pitch) -> [tick, velocity]
    while (p < end) {
      tick += vlq();
      const b = buf[p];
      if (b & 0x80) { status = b; p++; } // else running status
      const type = status & 0xf0;
      const ch = status & 0x0f;
      if (status === 0xff) {
        const meta = buf[p++]; const mlen = vlq();
        if (meta === 0x51) tempo = (buf[p] << 16) | (buf[p + 1] << 8) | buf[p + 2];
        p += mlen;
      } else if (status === 0xf0 || status === 0xf7) {
        p += vlq();
      } else if (type === 0x90 || type === 0x80) {
        const pitch = buf[p++], vel = buf[p++];
        const key = (ch << 8) | pitch;
        if (type === 0x90 && vel > 0) {
          active.set(key, [tick, vel]);
        } else {
          const on = active.get(key);
          if (on) {
            active.delete(key);
            const sec = (tk) => (tk / division) * (tempo / 1e6);
            notes.push({ pitch, start: sec(on[0]), end: sec(tick), velocity: on[1], channel: ch });
          }
        }
      } else if (type === 0xc0 || type === 0xd0) {
        p += 1;
      } else {
        p += 2;
      }
    }
    p = end;
  }
  notes.sort((a, b) => a.start - b.start);
  return notes;
};

// A scheduled Web Audio note. Changing tempo moves its release, not its pitch,
// sample offset or attack. A source's start time is immutable; its stop time
// may be replaced until it has actually stopped.
(() => {
  'use strict';

  class NoteVoice {
    constructor(source, envelope, destination, at, length, { attack, initial, peak, floor, release = 0, padding = 0.02, offset = 0, fixed = false }) {
      this.source = source;
      this.gain = envelope.gain;
      this.at = at;
      this.releaseAt = at + length;
      this.attackEnd = at + Math.min(attack, length);
      this.peak = peak;
      this.floor = floor;
      this.release = release;
      this.padding = padding;
      this.fixed = fixed;
      this.index = null; // null = manual preview, -1 = chased held note, otherwise the scheduler's note index
      this.gain.setValueAtTime(initial, at);
      this.gain.linearRampToValueAtTime(peak, this.attackEnd);
      source.connect(envelope).connect(destination);
      source.addEventListener('ended', () => { source.disconnect(); envelope.disconnect(); }, { once: true });
      if (offset) source.start(at, offset); else source.start(at);
      this.scheduleRelease();
    }

    get endsAt() { return this.releaseAt + this.release + this.padding; }

    scheduleRelease() {
      // Samples hold their level until key-up; fallback oscillators decay
      // continuously from the end of the attack to key-up.
      if (this.release) this.gain.setValueAtTime(this.peak, this.releaseAt);
      this.gain.exponentialRampToValueAtTime(this.floor, this.releaseAt + this.release);
      this.source.stop(this.endsAt);
    }

    retime(now, ratio) {
      if (this.fixed || this.releaseAt <= now) return; // leave drum hits and released tails alone
      this.releaseAt = now + (this.releaseAt - now) * ratio;
      this.gain.cancelAndHoldAtTime(now);
      if (now < this.attackEnd) {
        this.attackEnd = Math.min(this.attackEnd, this.releaseAt);
        this.gain.linearRampToValueAtTime(this.peak, this.attackEnd);
      }
      this.scheduleRelease();
    }

    static retimeScheduled(voices, now, ratio, cursor) {
      for (const voice of voices) {
        if (voice.index === null) continue;
        if (voice.at > now) {
          // Requeue only unsounded lookahead, including chords. Rewinding by
          // index keeps an attack exactly on the change boundary from repeating.
          voice.source.stop();
          voices.delete(voice);
          cursor = Math.min(cursor, voice.index);
        } else voice.retime(now, ratio);
      }
      return cursor;
    }
  }

  window.MidiStudioNoteVoice = NoteVoice;
})();

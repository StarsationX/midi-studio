/* midi-parse.js — read a Standard MIDI File into the Editor's document shape,
   in the renderer, without leaving the process.
   ==========================================================================

   WHY THIS EXISTS

   `python-engine/midi_document.py load` is the Editor's original loader and is
   still the writer and still the fallback. Opening a 50,000-note transcription
   through it measured 2102ms: mido parses every track into Message objects,
   iterates the merged track copying every message again to convert ticks to
   seconds, and then main JSON.parses 5MB into live objects that are structured-
   cloned across the process boundary and deep-copied a second time by
   contextBridge (a further 238ms at 50k, 666ms at 120k). None of that work has
   to happen anywhere but in the frame that is going to hold the document.

   Parsing the same file here costs 45ms at 50k and 145ms at 120k, and the
   document never crosses a process boundary at all.

   WHAT IT PROMISES

   Byte-for-byte the same document `midi_document.load_midi` returns:
   merged-track playback order, mid-file tempo changes, FIFO note matching, the
   `unterminated` close-at-end-of-file rule, the (start, pitch) sort, stable
   n1..nN ids, `programs`, `duration`, `bpm` and the onset-derived
   `bpmEstimated` guess. tools/run-tests.js asserts that field for field against
   what the python loader actually prints, over every fixture in
   benchmarks/fixtures.

   HOW IT STAYS HONEST

   It is DELIBERATELY STRICTER than it needs to be. Every construct where this
   reader and mido could plausibly disagree — an SMPTE time division, a track
   whose messages overrun its chunk length, a System Common status byte, running
   status with no status to run from, running status inheriting a SysEx — throws
   instead of guessing. The caller (renderer/review/review.js openPath) catches
   and falls back to the python loader, so the worst case of an unusual file is
   the old speed, never a wrong document and never a file that stops opening.

   THE ROUNDING IS EXACT, NOT APPROXIMATE

   python's round(x, 6) is round-half-to-EVEN and JS's toFixed(6)/Math.round are
   round-half-up, so pyRound() below reproduces python's rule rather than
   approximating it. Ties are NOT rare curiosities here: an exact tie needs
   x*1e7 to be an integer ending in 5, which reduces to a dyadic rational
   whenever the odd part carries 5^6 — and note ends land on values like
   76.1015625 (= 9741/128) all the time, because tick2second sums are dyadic
   whenever the tempo and ticks-per-beat cooperate. Rounding one of those the
   wrong way put a 1e-6 discrepancy into 1-7 notes of nearly every file in a
   92-file corpus. Tick-to-second arithmetic is likewise written in mido's exact
   operation order (`tick * (tempo * 1e-6 / ticks_per_beat)`): a mathematically
   equal but differently ordered expression rounds differently in the last bit.

   Classic script (window.MidiParse). No module system, no dependencies. */
(function (global) {
  'use strict';

  // python's round(x, N) — exactly, for every double, for the non-negative
  // magnitudes this file deals in. Two multiplies and a floor, no string work:
  // it runs twice per note, so 120k notes is 240k calls.
  //
  // Math.round(x*s)/s is python's answer for every value that is not exactly
  // halfway, because x*s is off the true product by at most half an ULP (~1e-7
  // at the 1e9 magnitudes reached by a 1000-second file) and a non-tie is
  // further from the boundary than that. An exact tie is detected the only way
  // that is airtight: x*2s is an ODD INTEGER precisely when x's decimal
  // expansion terminates in a 5 one place past N, and that product is exact
  // because both operands are exact and the result is a sub-2^53 integer.
  // Python then breaks the tie towards the EVEN last digit, which is what the
  // branch does.
  var S1 = [1, 10, 100, 1e3, 1e4, 1e5, 1e6];
  // 5^(n+1): a decimal with n+1 places is exactly representable as a double
  // only when its scaled integer is divisible by this, which is what turns
  // "looks like a tie" into "IS a tie".
  var P5 = [5, 25, 125, 625, 3125, 15625, 78125];
  function pyRound(x, n) {
    var s = S1[n];
    var y = x * s;
    var r = Math.round(y);
    // FAST PATH, taken for essentially every note. Only a value within 1e-4 (in
    // scaled units) of a .5 boundary can be rounded differently by half-up and
    // half-even, and 1e-4 is orders of magnitude wider than the half-ULP error
    // of the product y at the magnitudes this file reaches (y < 1e10). No
    // string work, no branch mispredict worth caring about.
    if (0.5 - (y > r ? y - r : r - y) > 1e-4) return r / s;

    // Close to a boundary, so the answer has to come from the double's EXACT
    // value rather than from a scaled product. toFixed is specified against
    // that exact value; the only thing it gets wrong is python's tie rule.
    var d = x.toFixed(n + 1);
    if (d.charCodeAt(d.length - 1) === 53) {          // ends in '5'
      // j is the exact value scaled by 10^(n+1) IF the expansion really stops
      // there. It does exactly when j is divisible by 5^(n+1) (which makes the
      // decimal dyadic, hence representable) AND that decimal is this very
      // double. Both together are an airtight tie test; the divisibility alone
      // is not, and equality alone is not either — 76.1015635 passes equality
      // but is really 76.10156349999... and python rounds it DOWN.
      var j = Number(d.replace('.', ''));
      if (j % P5[n] === 0 && Number(d) === x) {
        var k = (j - 5) / 10;                          // the n-digit floor
        return (k % 2 !== 0 ? k + 1 : k) / s;          // ...to the EVEN side
      }
    }
    return Number(x.toFixed(n));
  }
  var r6 = function (x) { return pyRound(x, 6); };
  var r4 = function (x) { return pyRound(x, 4); };

  function fail(why) { throw new Error('midi-parse: ' + why); }

  // ---- the file --------------------------------------------------------- //

  // Bytes in, document out. `bytes` is a Uint8Array or ArrayBuffer of the whole
  // file; `filePath` is the OS path it came from, used only for `path`/`name`.
  function parse(bytes, filePath) {
    var b = (bytes instanceof Uint8Array) ? bytes : new Uint8Array(bytes);
    if (b.length < 14) fail('file is too short to be a MIDI file');
    if (b[0] !== 0x4d || b[1] !== 0x54 || b[2] !== 0x68 || b[3] !== 0x64) {
      fail('MThd not found. Probably not a MIDI file');
    }
    var headerLen = u32(b, 4);
    if (headerLen < 6 || 8 + headerLen > b.length) fail('bad header chunk');
    var format = u16(b, 8);
    var ntrk = u16(b, 10);
    var division = u16(b, 12);
    // mido reads these as SIGNED shorts and does no SMPTE handling at all: a
    // division with the top bit set becomes a NEGATIVE ticks_per_beat and every
    // timestamp comes out negative. Rather than reproduce that, hand the file to
    // the python loader and let the two paths stay identical by construction.
    if (division & 0x8000) fail('SMPTE time division is not handled here');
    if (division === 0) fail('zero ticks per beat');
    // Only type 2 is refused, and mido refuses it too (merged_track raises), so
    // the error the user sees is the same either way.
    if (format === 2) fail("can't merge tracks in type 2 (asynchronous) file");

    // ---- pass 1: every track's events, flat, as absolute ticks ----------- //
    // Four parallel typed arrays instead of one object per message: a 120k-note
    // file is ~250k messages, and 250k short-lived objects is a major GC on the
    // open path all by itself.
    //   kind 0 something else  1 note_on(vel>0)  2 note_off  3 set_tempo
    //        4 program_change
    //   a    = channel (1,2,4) or tempo (3)
    //   b    = (pitch << 8) | velocity for 1/2, program for 4
    //
    // EVERY message is recorded, not just the four kinds that carry data, and
    // that is load-bearing rather than lazy. mido converts each merged delta to
    // seconds on its own and midi_document.py sums those, so how a tick interval
    // is PARTITIONED between messages changes the last bit of the running total:
    // tick2second(10) + tick2second(10) is not always tick2second(20). Skipping
    // the messages this reader has no use for was measured to move 1-2% of the
    // notes in a real 92-file corpus by exactly one unit in the 6th decimal.
    // The one message that must NOT be recorded is end_of_track: merge_tracks
    // runs fix_end_of_track, which deletes every end_of_track and folds its
    // delta into the following message, which is precisely what leaving them out
    // of this array reproduces. Their ticks still count towards maxTick below,
    // which is the trailing marker fix_end_of_track emits.
    // Sized from the file itself: the shortest possible message is a 1-byte
    // delta plus a 2-byte running-status body, so length/3 is a realistic
    // ceiling and the doubling below almost never runs on a real file.
    var cap = Math.max(4096, (b.length / 3) | 0), len = 0;
    var mTick = new Float64Array(cap);
    var mKind = new Uint8Array(cap);
    var mA = new Int32Array(cap);
    var mB = new Int32Array(cap);
    function grow() {
      cap *= 2;
      var t = new Float64Array(cap); t.set(mTick); mTick = t;
      var k = new Uint8Array(cap); k.set(mKind); mKind = k;
      var a = new Int32Array(cap); a.set(mA); mA = a;
      var c = new Int32Array(cap); c.set(mB); mB = c;
    }

    var p = 8 + headerLen;
    // The last tick of ANY message in ANY track, meta included. mido's
    // MidiFile.length is the sum of every delta in the merged track, and
    // merge_tracks keeps end_of_track's time (fix_end_of_track folds it into the
    // trailing marker rather than dropping it). A file with trailing silence
    // after its last note therefore has a duration this reader would otherwise
    // miss, because it only records the four event kinds above.
    var maxTick = 0;

    for (var t = 0; t < ntrk; t++) {
      if (p + 8 > b.length) fail('truncated before track ' + t);
      if (b[p] !== 0x4d || b[p + 1] !== 0x54 || b[p + 2] !== 0x72 || b[p + 3] !== 0x6b) {
        fail('no MTrk header at start of track ' + t);
      }
      var tlen = u32(b, p + 4);
      p += 8;
      var end = p + tlen;
      if (end > b.length) fail('track ' + t + ' runs past the end of the file');
      var tick = 0;
      // mido keeps last_status across meta messages ("Meta messages don't set
      // running status") but DOES set it from a SysEx status byte. Tracking the
      // running status separately from the byte just read is the only way to
      // match that; conflating them silently breaks running status after any
      // meta event, which is common in real files.
      var last = -1;

      while (p < end) {
        // delta time (variable-length quantity)
        var v = 0, k = 0, byte;
        do {
          if (p >= end) fail('truncated delta time in track ' + t);
          byte = b[p++];
          v = (v * 128) + (byte & 0x7f);
          if (++k > 4) fail('over-long delta time in track ' + t);
        } while (byte & 0x80);
        tick += v;

        if (p >= end) fail('truncated event in track ' + t);
        var s = b[p];
        if (s & 0x80) {
          p++;
          if (s !== 0xff) last = s;    // meta does not arm running status
        } else {
          // Running status: p is NOT advanced, because b[p] is already the first
          // data byte of a message that reuses the previous status.
          if (last < 0) fail('running status without last_status');
          s = last;
          // Running status inherited from a SysEx is a construct mido handles by
          // crashing; refuse it rather than invent an interpretation.
          if (s === 0xf0 || s === 0xf7) fail('running status after SysEx');
        }

        if (s === 0xff) {
          if (p >= end) fail('truncated meta event in track ' + t);
          var meta = b[p++];
          var ml = 0, mk = 0, mb;
          do {
            if (p >= end) fail('truncated meta length in track ' + t);
            mb = b[p++];
            ml = (ml * 128) + (mb & 0x7f);
            if (++mk > 4) fail('over-long meta length in track ' + t);
          } while (mb & 0x80);
          if (p + ml > end) fail('meta event overruns track ' + t);
          if (meta !== 0x2f) {                       // 0x2f = end_of_track
            if (len === cap) grow();
            mTick[len] = tick;
            if (meta === 0x51 && ml === 3) {
              mKind[len] = 3;
              mA[len] = (b[p] << 16) | (b[p + 1] << 8) | b[p + 2];
            } else { mKind[len] = 0; mA[len] = 0; }
            mB[len] = 0; len++;
          }
          p += ml;
        } else if (s === 0xf0 || s === 0xf7) {
          var sl = 0, sk = 0, sb;
          do {
            if (p >= end) fail('truncated SysEx length in track ' + t);
            sb = b[p++];
            sl = (sl * 128) + (sb & 0x7f);
            if (++sk > 4) fail('over-long SysEx length in track ' + t);
          } while (sb & 0x80);
          if (p + sl > end) fail('SysEx overruns track ' + t);
          if (len === cap) grow();
          mTick[len] = tick; mKind[len] = 0; mA[len] = 0; mB[len] = 0; len++;
          p += sl;
        } else if (s >= 0xf1) {
          // System Common / Real Time inside a file. mido has a spec for some of
          // these and raises for the rest; both are rare enough that falling
          // back is cheaper than being subtly wrong about their length.
          fail('system message 0x' + s.toString(16) + ' inside a track');
        } else {
          var type = s & 0xf0;
          var ch = s & 0x0f;
          // Data bytes start at p either way: a running-status message never
          // consumed a status byte, so its first data byte is still under p.
          var need = (type === 0xc0 || type === 0xd0) ? 1 : 2;
          var d0 = b[p];
          var d1 = need > 1 ? b[p + 1] : 0;
          p += need;
          if (p > end) fail('event overruns track ' + t);
          // mido raises on a data byte >= 0x80 unless clip=True, and
          // midi_document.py does not pass clip.
          if (d0 & 0x80 || (need > 1 && (d1 & 0x80))) fail('data byte must be in range 0..127');
          if (len === cap) grow();
          mTick[len] = tick;
          if (type === 0x90) {
            mKind[len] = d1 > 0 ? 1 : 2; mA[len] = ch; mB[len] = (d0 << 8) | d1;
          } else if (type === 0x80) {
            mKind[len] = 2; mA[len] = ch; mB[len] = (d0 << 8) | d1;
          } else if (type === 0xc0) {
            mKind[len] = 4; mA[len] = ch; mB[len] = d0;
          } else {
            // control_change, pitchwheel, aftertouch: no data this reader wants,
            // but its position in the merged stream still splits a tick interval
            // and therefore still shapes the running total. See the note above.
            mKind[len] = 0; mA[len] = 0; mB[len] = 0;
          }
          len++;
        }
      }
      // mido reads a track by comparing the file position against the chunk
      // size and only stops on an EXACT match, so a track whose last message
      // overruns its length makes mido read into the next chunk and fail. Being
      // more permissive here is precisely how the two paths would drift apart.
      if (p !== end) fail('track ' + t + ' does not end on a message boundary');
      if (tick > maxTick) maxTick = tick;
    }

    // ---- pass 2: merged playback order ----------------------------------- //
    // mido's merge_tracks: every track to absolute time, concatenated in track
    // order, then ONE stable sort by tick. A format 0 file has a single track,
    // which is already in order, so the sort is skipped outright — that is the
    // shape every Forge transcription has.
    var ord = null;
    if (ntrk > 1) {
      ord = new Int32Array(len);
      for (var i = 0; i < len; i++) ord[i] = i;
      // The index tiebreak makes the result stable regardless of what the
      // engine's typed-array sort guarantees, which is what python's stable
      // list.sort() gives merge_tracks.
      Array.prototype.sort.call(ord, function (x, y) {
        return (mTick[x] - mTick[y]) || (x - y);
      });
    }

    var tempo = 500000;             // mido's DEFAULT_TEMPO
    var firstTempo = 500000;
    var foundTempo = false;
    var spq = division;
    var scale = tempo * 1e-6 / spq; // mido tick2second's exact expression
    var timeSec = 0;
    var lastTick = 0;
    var notes = [];
    var programs = {};
    // One FIFO per (channel, pitch), flat [start, velocity, start, velocity...].
    var active = new Map();

    for (var n = 0; n < len; n++) {
      var j = ord ? ord[n] : n;
      var dt = mTick[j] - lastTick;
      lastTick = mTick[j];
      if (dt > 0) timeSec += dt * scale;
      var kind = mKind[j];
      if (kind === 1) {
        var key1 = (mA[j] << 8) | (mB[j] >> 8);
        var q = active.get(key1);
        if (q === undefined) { q = []; active.set(key1, q); }
        q.push(timeSec, mB[j] & 0xff);
      } else if (kind === 2) {
        var key2 = (mA[j] << 8) | (mB[j] >> 8);
        var qq = active.get(key2);
        if (qq !== undefined && qq.length) {
          var st = qq.shift(), vel = qq.shift();
          notes.push({ pitch: mB[j] >> 8, start: r6(st),
            end: r6(st + 0.01 > timeSec ? st + 0.01 : timeSec),
            velocity: vel, channel: mA[j] });
        }
      } else if (kind === 3) {
        if (!foundTempo) { firstTempo = mA[j]; foundTempo = true; }
        tempo = mA[j];
        scale = tempo * 1e-6 / spq;
      } else if (kind === 4) {
        if (programs[mA[j]] === undefined) programs[mA[j]] = mB[j];
      }
    }
    // Everything after the last note/tempo/program event still counts towards the
    // file's length. No tempo change can hide in there — set_tempo is one of the
    // kinds above — so one multiply closes the gap exactly.
    if (maxTick > lastTick) timeSec += (maxTick - lastTick) * scale;

    // A note whose note_off is missing or truncated (common in transcriptions
    // and in files cut short) would otherwise be invisible in the editor and
    // lost on the next save. Close it at the end of the file instead of
    // dropping it — in the same first-seen key order python's dict iteration
    // uses, which a Map preserves.
    active.forEach(function (q, key) {
      var pitch = key & 0xff, ch = key >> 8;
      for (var i2 = 0; i2 < q.length; i2 += 2) {
        var st2 = q[i2];
        notes.push({ pitch: pitch, start: r6(st2),
          end: r6(st2 + 0.01 > timeSec ? st2 + 0.01 : timeSec),
          velocity: q[i2 + 1], channel: ch, unterminated: true });
      }
    });

    notes.sort(function (x, y) { return (x.start - y.start) || (x.pitch - y.pitch); });
    for (var i3 = 0; i3 < notes.length; i3++) notes[i3].id = 'n' + (i3 + 1);

    var maxEnd = timeSec;
    for (var i4 = 0; i4 < notes.length; i4++) if (notes[i4].end > maxEnd) maxEnd = notes[i4].end;

    // Transcriptions carry no tempo track, so mido hands back its 500000 default
    // and every one of them claimed to be 120 BPM. Guess from the onsets
    // instead, and say the guess is a guess.
    var estimated = !foundTempo;
    // mido tempo2bpm is 60 * 1e6 / tempo * 4 / 4., and *4/4 on a double is exact.
    var bpm = pyRound(60000000 / firstTempo, 3);
    if (estimated) bpm = bpmFromOnsets(notes, bpm);

    return {
      path: resolvePath(filePath),
      name: stem(filePath),
      bpm: bpm,
      bpmEstimated: estimated,
      duration: r6(maxEnd),
      programs: programs,
      notes: notes,
    };
  }

  // midi_document._bpm_from_onsets, rule for rule.
  function bpmFromOnsets(notes, fallback) {
    var seen = new Set();
    for (var i = 0; i < notes.length; i++) seen.add(r4(notes[i].start));
    var uniq = Array.from(seen);
    uniq.sort(function (a, b) { return a - b; });
    var gaps = [];
    for (var k = 1; k < uniq.length; k++) {
      var d = uniq[k] - uniq[k - 1];
      if (d >= 0.02 && d <= 2.0) gaps.push(d);
    }
    if (gaps.length < 6) return fallback;
    gaps.sort(function (a, b) { return a - b; });
    var bpm = 60.0 / (gaps[Math.floor(gaps.length / 2)] * 4.0);
    while (bpm < 90.0) bpm *= 2.0;
    while (bpm > 250.0) bpm /= 2.0;
    return pyRound(bpm, 2);
  }

  // ---- paths ------------------------------------------------------------ //
  // pathlib's Path(p).stem and str(Path(p).resolve()) for the absolute paths
  // this app deals in. `name` matches exactly: stem is taken from the string it
  // was given, not from the filesystem. `path` matches for any path already in
  // the filesystem's own casing, which is every path the app produces (a native
  // open dialog, a directory listing, or Forge's own output). It differs only in
  // the letter case of a hand-typed path, and only in the "Opened <path>" line.

  function stem(p) {
    var s = String(p || '').replace(/[\\/]+$/, '');
    var i = s.search(/[^\\/]*$/);
    var base = s.slice(i);
    var dot = base.lastIndexOf('.');
    return dot > 0 ? base.slice(0, dot) : base;
  }

  function resolvePath(p) {
    var s = String(p || '');
    if (!/^[a-zA-Z]:[\\/]/.test(s) && s.indexOf('\\\\') !== 0) return s;
    if (s.indexOf('\\\\') === 0) return s;               // UNC: leave alone
    s = s.replace(/\//g, '\\');
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function u16(b, i) { return (b[i] << 8) | b[i + 1]; }
  function u32(b, i) { return ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0; }

  var API = { parse: parse, bpmFromOnsets: bpmFromOnsets, stem: stem, resolvePath: resolvePath,
    pyRound: pyRound };
  if (typeof module === 'object' && module.exports) module.exports = API;
  global.MidiParse = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);

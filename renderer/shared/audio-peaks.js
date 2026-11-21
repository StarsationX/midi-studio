// Waveform decodes are deliberately separate from live playback. Serialize
// decodes in each panel because decodeAudioData itself cannot be aborted.
(function (global) {
  'use strict';

  async function decode(bytes, sampleRate) {
    const Offline = global.OfflineAudioContext || global.webkitOfflineAudioContext;
    if (Offline) return new Offline(1, 1, sampleRate).decodeAudioData(bytes);
    const Audio = global.AudioContext || global.webkitAudioContext;
    if (!Audio) throw new Error('No audio decoder is available.');
    const context = new Audio();
    try { return await context.decodeAudioData(bytes); }
    finally { await context.close().catch(() => {}); }
  }

  function createReader(sampleRate = 11025) {
    let tail = Promise.resolve();
    return {
      read(url, signal, onBytes) {
        const result = tail.then(async () => {
          signal.throwIfAborted();
          const response = await global.fetch(url, { signal });
          if (!response.ok) throw new Error('Could not read the audio file.');
          const bytes = await response.arrayBuffer();
          signal.throwIfAborted();
          if (onBytes) onBytes(bytes);
          const buffer = await decode(bytes, sampleRate);
          signal.throwIfAborted();
          return buffer;
        });
        // A finished request must not leave the decoded PCM in this queue.
        tail = result.then(() => {}, () => {});
        return result;
      },
    };
  }

  async function buckets(samples, start, end, count, signal) {
    if (end <= start) return new Float32Array(0);
    count = Math.min(count, end - start);
    const peaks = new Float32Array(count * 2);
    let slice = global.performance.now();
    for (let b = 0; b < count; b++) {
      const lo = start + Math.floor(b * (end - start) / count);
      const hi = start + Math.floor((b + 1) * (end - start) / count);
      let min = 1, max = -1;
      for (let i = lo; i < hi; i++) {
        const value = samples[i];
        if (value < min) min = value;
        if (value > max) max = value;
      }
      peaks[b * 2] = min;
      peaks[b * 2 + 1] = max;
      if ((b & 15) === 15 && global.performance.now() - slice >= 4) {
        await new Promise(resolve => global.setTimeout(resolve, 0));
        signal.throwIfAborted();
        slice = global.performance.now();
      }
    }
    signal.throwIfAborted();
    return peaks;
  }

  global.AudioPeaks = { createReader, buckets };
})(window);

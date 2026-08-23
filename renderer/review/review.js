(() => {
  'use strict';
  const R = window.review;
  const $ = (id) => document.getElementById(id);
  const canvas = $('piano-roll');
  const wave = $('waveform');
  const scroll = $('roll-scroll');
  const wrap = $('roll-wrap');
  const audio = $('audio');
  const ctx = canvas.getContext('2d');
  const waveCtx = wave.getContext('2d');
  const KEY_W = 58;
  const TOP_H = 25;
  const ROW_H = 14;

  let projectPath = '';
  let project = null;
  let documents = {};
  let candidate = 'clean';
  let selected = new Set();
  let dirty = false;
  let zoom = 85;
  let duration = 0;
  let projectDuration = 0;
  let pitchLow = 48;
  let pitchHigh = 96;
  let histories = {};
  let futures = {};
  let drag = null;
  let waveDrag = null;
  let wavePeaks = [];
  let loopStart = 0;
  let loopEnd = 0;
  let playhead = 0;
  let playing = false;
  let startedAt = 0;
  let previousMidiTime = -0.01;
  let animation = 0;
  let audioOffset = 0;
  let synthContext = null;
  let marquee = null;
  let noteSeq = 0;
  const soundfonts = window.MidiStudioSoundfonts;
  const INSTRUMENT = 'grand_piano';
  let sampledReady = false;
  let samplePrepare = null;

  const doc = () => documents[candidate] || null;
  const cloneNotes = (notes) => notes.map((note) => ({ ...note }));
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const fmt = (seconds) => {
    seconds = Math.max(0, Number(seconds) || 0);
    const minutes = Math.floor(seconds / 60);
    const rest = seconds - minutes * 60;
    return `${String(minutes).padStart(2, '0')}:${rest.toFixed(3).padStart(6, '0')}`;
  };

  function setStatus(text, kind) {
    $('status').textContent = text;
    $('status').style.color = kind === 'error' ? 'var(--err)' : kind === 'ok' ? 'var(--ok)' : '';
  }

  function setDirty(value = true) {
    dirty = value;
    setStatus(dirty ? 'UNSAVED' : 'SAVED', dirty ? '' : 'ok');
  }

  function updateControls() {
    const loaded = !!doc();
    ['save', 'export', 'to-player', 'to-audition', 'play', 'stop', 'quantize', 'apply-quantize', 'zoom',
      'midi-on', 'loop-on'].forEach((id) => { $(id).disabled = !loaded; });
    $('audio-on').disabled = !loaded || !(project && (project.sourceAudio || project.previewAudio));
    const hasSelection = selected.size > 0;
    ['delete', 'oct-down', 'oct-up', 'velocity'].forEach((id) => { $(id).disabled = !hasSelection; });
    $('undo').disabled = !loaded || !(histories[candidate] || []).length;
    $('redo').disabled = !loaded || !(futures[candidate] || []).length;
    $('selection-readout').textContent = `${selected.size} note${selected.size === 1 ? '' : 's'} selected`;
    if (hasSelection) {
      const first = doc().notes.find((note) => selected.has(note.id));
      if (first) $('velocity').value = first.velocity;
    }
  }

  function checkpoint() {
    const current = doc();
    if (!current) return;
    histories[candidate] = histories[candidate] || [];
    histories[candidate].push(cloneNotes(current.notes));
    if (histories[candidate].length > 80) histories[candidate].shift();
    futures[candidate] = [];
  }

  function undo() {
    const current = doc();
    const stack = histories[candidate] || [];
    if (!current || !stack.length) return;
    futures[candidate] = futures[candidate] || [];
    futures[candidate].push(cloneNotes(current.notes));
    current.notes = stack.pop();
    selected.clear(); setDirty(); renderCandidates(); refresh();
  }

  function redo() {
    const current = doc();
    const stack = futures[candidate] || [];
    if (!current || !stack.length) return;
    histories[candidate] = histories[candidate] || [];
    histories[candidate].push(cloneNotes(current.notes));
    current.notes = stack.pop();
    selected.clear(); setDirty(); renderCandidates(); refresh();
  }

  function calculateBounds() {
    const current = doc();
    if (!current || !current.notes.length) { pitchLow = 48; pitchHigh = 96; return; }
    const pitches = current.notes.map((note) => note.pitch);
    pitchLow = clamp(Math.min(...pitches) - 3, 24, 72);
    pitchHigh = clamp(Math.max(...pitches) + 3, pitchLow + 35, 108);
  }

  // A five-minute song at the default zoom is ~24,000px wide. A canvas that
  // size is 60+ MB of pixels AND past Chromium's 16,384px limit, so the tail of
  // a long song simply never drew. The canvas is now the size of the viewport
  // and the wrapper provides the scroll extent; drawing offsets by scrollLeft.
  function contentWidth() {
    return Math.max(scroll.clientWidth, KEY_W + duration * zoom + 50);
  }

  function resizeRoll() {
    if (!doc() || scroll.hidden) return;
    calculateBounds();
    const cssHeight = TOP_H + (pitchHigh - pitchLow + 1) * ROW_H;
    const viewWidth = Math.max(1, scroll.clientWidth);
    wrap.style.width = `${contentWidth()}px`;
    wrap.style.height = `${cssHeight}px`;
    const dpr = window.devicePixelRatio || 1;
    canvas.style.width = `${viewWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    canvas.width = Math.round(viewWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawRoll();
  }

  function resizeWave() {
    const rect = wave.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = window.devicePixelRatio || 1;
    wave.width = Math.round(rect.width * dpr);
    wave.height = Math.round(rect.height * dpr);
    waveCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawWave();
  }

  function xForTime(time) { return KEY_W + time * zoom; }
  function timeForX(x) { return clamp((x - KEY_W) / zoom, 0, duration); }
  function yForPitch(pitch) { return TOP_H + (pitchHigh - pitch) * ROW_H; }
  function pitchForY(y) { return clamp(pitchHigh - Math.floor((y - TOP_H) / ROW_H), pitchLow, pitchHigh); }
  function snapSeconds(time) {
    const division = Number($('quantize').value);
    if (!division || !doc()) return time;
    const step = (60 / (Number(doc().bpm) || 120)) * (4 / division);
    return Math.round(time / step) * step;
  }

  function drawRoll() {
    const current = doc();
    if (!current) return;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const ox = scroll.scrollLeft;                 // content -> viewport offset
    const vx = (time) => xForTime(time) - ox;
    const fromTime = timeForX(ox + KEY_W), toTime = timeForX(ox + width);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#101115'; ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#202228'; ctx.fillRect(KEY_W, 0, width - KEY_W, TOP_H);

    for (let pitch = pitchLow; pitch <= pitchHigh; pitch += 1) {
      const y = yForPitch(pitch);
      const black = [1, 3, 6, 8, 10].includes(pitch % 12);
      ctx.fillStyle = black ? '#121318' : '#181a1e';
      ctx.fillRect(KEY_W, y, width - KEY_W, ROW_H);
      ctx.strokeStyle = '#272a31'; ctx.beginPath(); ctx.moveTo(0, y + ROW_H); ctx.lineTo(width, y + ROW_H); ctx.stroke();
    }

    ctx.save();
    ctx.beginPath(); ctx.rect(KEY_W, 0, width - KEY_W, height); ctx.clip();

    const beat = 60 / (Number(current.bpm) || 120);
    const sub = beat / 4;
    const firstIndex = Math.max(0, Math.floor(fromTime / sub) - 1);
    for (let index = firstIndex; index * sub <= Math.min(duration + sub, toTime + sub); index += 1) {
      const x = vx(index * sub);
      const strong = index % 16 === 0;
      const beatLine = index % 4 === 0;
      ctx.strokeStyle = strong ? '#4a4e58' : beatLine ? '#343740' : '#24272d';
      ctx.beginPath(); ctx.moveTo(x, strong ? 0 : TOP_H); ctx.lineTo(x, height); ctx.stroke();
      if (strong) { ctx.fillStyle = '#858891'; ctx.font = '9px JetBrains Mono'; ctx.fillText(String(index / 16 + 1), x + 4, 16); }
    }

    for (const note of current.notes) {
      if (note.end < fromTime || note.start > toTime) continue;
      const x = vx(note.start);
      const y = yForPitch(note.pitch) + 1;
      const widthNote = Math.max(4, (note.end - note.start) * zoom);
      const on = selected.has(note.id);
      ctx.fillStyle = on ? getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() : '#4f9fb5';
      ctx.fillRect(x + 1, y, widthNote - 2, ROW_H - 2);
      ctx.strokeStyle = on ? '#e9ff9d' : '#72c1d4'; ctx.strokeRect(x + 1.5, y + .5, Math.max(1, widthNote - 3), ROW_H - 3);
      if (widthNote > 10) { ctx.fillStyle = on ? '#202500' : '#10242a'; ctx.fillRect(x + widthNote - 4, y + 2, 2, ROW_H - 6); }
    }
    if (marquee && marquee.moved) {
      const mx = Math.min(marquee.x0, marquee.x1) - ox, my = Math.min(marquee.y0, marquee.y1);
      const mw = Math.abs(marquee.x1 - marquee.x0), mh = Math.abs(marquee.y1 - marquee.y0);
      ctx.fillStyle = 'rgba(184,230,46,.12)'; ctx.fillRect(mx, my, mw, mh);
      ctx.strokeStyle = 'rgba(184,230,46,.65)'; ctx.strokeRect(mx + .5, my + .5, mw, mh);
    }
    const playX = vx(playhead);
    ctx.strokeStyle = '#f0d34e'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(playX, 0); ctx.lineTo(playX, height); ctx.stroke(); ctx.lineWidth = 1;
    ctx.restore();

    // The keyboard stays pinned at the left edge while the roll scrolls under it.
    ctx.fillStyle = '#181a1f'; ctx.fillRect(0, 0, KEY_W, height);
    for (let pitch = pitchLow; pitch <= pitchHigh; pitch += 1) {
      const y = yForPitch(pitch);
      const black = [1, 3, 6, 8, 10].includes(pitch % 12);
      ctx.fillStyle = black ? '#202228' : '#d9dadc'; ctx.fillRect(0, y, KEY_W - 1, ROW_H - 1);
      if (pitch % 12 === 0) {
        ctx.fillStyle = black ? '#afb1b6' : '#25272d'; ctx.font = '9px JetBrains Mono';
        ctx.fillText(`C${Math.floor(pitch / 12) - 1}`, 6, y + 10);
      }
    }
  }

  const waveZoom = window.TimelineZoom
    ? window.TimelineZoom(wave, () => duration, () => drawWave())
    : null;
  const waveStart = () => (waveZoom ? waveZoom.start() : 0);
  const waveSpan = () => (waveZoom ? waveZoom.span() : (duration || 1));
  const waveX = (t, w) => (waveZoom ? waveZoom.xFor(t, w) : (t / (duration || 1)) * w);
  const waveT = (x, w) => (waveZoom ? waveZoom.timeAt(x, w) : (x / w) * (duration || 0));

  function drawWave() {
    const width = wave.clientWidth;
    const height = wave.clientHeight;
    waveCtx.clearRect(0, 0, width, height);
    waveCtx.fillStyle = '#0f1013'; waveCtx.fillRect(0, 0, width, height);
    if (duration > 0 && loopEnd > loopStart && ($('loop-on').checked || loopStart > 0 || loopEnd < duration)) {
      waveCtx.fillStyle = 'rgba(184,230,46,.10)';
      waveCtx.fillRect(waveX(loopStart, width), 0, waveX(loopEnd, width) - waveX(loopStart, width), height);
    }
    waveCtx.strokeStyle = '#3a3d45'; waveCtx.beginPath(); waveCtx.moveTo(0, height / 2); waveCtx.lineTo(width, height / 2); waveCtx.stroke();
    if (wavePeaks.length) {
      waveCtx.strokeStyle = '#82a9b3'; waveCtx.beginPath();
      const from = duration ? waveStart() / duration : 0;
      const visible = duration ? waveSpan() / duration : 1;
      for (let x = 0; x < width; x += 1) {
        const peak = wavePeaks[Math.floor((from + (x / width) * visible) * wavePeaks.length)] || 0;
        waveCtx.moveTo(x + .5, height / 2 - peak * (height * .43));
        waveCtx.lineTo(x + .5, height / 2 + peak * (height * .43));
      }
      waveCtx.stroke();
    }
    if (doc()) {
      waveCtx.fillStyle = 'rgba(184,230,46,.42)';
      for (const note of doc().notes) waveCtx.fillRect(waveX(note.start, width), height - 8, 1, 6);
    }
    const x = duration ? waveX(playhead, width) : 0;
    waveCtx.strokeStyle = '#f0d34e'; waveCtx.lineWidth = 1.5; waveCtx.beginPath(); waveCtx.moveTo(x, 0); waveCtx.lineTo(x, height); waveCtx.stroke(); waveCtx.lineWidth = 1;
  }

  function refresh() {
    const current = doc();
    if (current) {
      current.duration = Math.max(Number(current.duration) || 0, ...current.notes.map((note) => note.end), 0.1);
      duration = Math.max(duration, current.duration);
    }
    updateControls(); resizeRoll(); resizeWave(); updateTime();
  }

  function renderCandidates() {
    const host = $('candidate-tabs'); host.textContent = '';
    for (const name of Object.keys(documents)) {
      const button = document.createElement('button');
      button.className = `candidate${name === candidate ? ' is-active' : ''}`;
      button.innerHTML = `<strong>${name[0].toUpperCase() + name.slice(1)}</strong><small>${documents[name].notes.length} NOTES</small>`;
      button.addEventListener('click', () => switchCandidate(name));
      host.appendChild(button);
    }
  }

  function switchCandidate(name) {
    if (!documents[name] || name === candidate) return;
    pause(); candidate = name; selected.clear(); playhead = 0;
    project.selectedCandidate = name;
    duration = Math.max(projectDuration, Number(doc().duration) || 0);
    loopStart = 0; loopEnd = duration;
    renderCandidates(); refresh();
  }

  async function loadAudioWave() {
    wavePeaks = [];
    const source = project && (project.sourceAudio || project.previewAudio);
    $('audio-on').checked = !!source;
    $('audio-on').disabled = !source;
    if (!source) { audio.removeAttribute('src'); resizeWave(); return; }
    audio.src = R.fileUrl(source);
    try {
      synthContext = synthContext || new AudioContext();
      const response = await fetch(audio.src);
      const buffer = await synthContext.decodeAudioData(await response.arrayBuffer());
      const timingEnd = Number(project.timing && project.timing.end);
      const available = Math.max(0, buffer.duration - audioOffset);
      if (!Number.isFinite(timingEnd)) projectDuration = Math.max(duration, available);
      else projectDuration = Math.max(duration, timingEnd - audioOffset);
      duration = projectDuration;
      loopEnd = duration;
      const channel = buffer.getChannelData(0);
      const startSample = Math.floor(audioOffset * buffer.sampleRate);
      const endSample = Math.min(channel.length, Math.ceil((audioOffset + duration) * buffer.sampleRate));
      const count = 1800;
      const stride = Math.max(1, Math.floor((endSample - startSample) / count));
      for (let index = startSample; index < endSample; index += stride) {
        let peak = 0;
        for (let at = index; at < Math.min(endSample, index + stride); at += 1) peak = Math.max(peak, Math.abs(channel[at]));
        wavePeaks.push(peak);
      }
      refresh();
    } catch (_) {
      $('transport-note').textContent = 'Original audio is unavailable; MIDI preview still works.';
      resizeWave();
    }
  }

  async function openPath(filePath) {
    if (!filePath) return;
    if (dirty && !window.confirm('Discard unsaved note edits and open another file?')) return;
    setStatus('LOADING');
    const result = await R.load(filePath);
    if (!result || !result.ok) { setStatus('LOAD FAILED', 'error'); $('transport-note').textContent = result && result.error || 'Could not open file.'; return; }
    pause();
    projectPath = result.data.projectPath || '';
    project = result.data.project;
    documents = result.data.documents;
    for (const document of Object.values(documents)) {
      document.notes.forEach((note, index) => { note.id = note.id || `n${index + 1}`; });
    }
    candidate = documents[project.selectedCandidate] ? project.selectedCandidate : Object.keys(documents)[0];
    histories = {}; futures = {}; selected.clear(); playhead = 0;
    duration = Number(doc().duration) || 0;
    projectDuration = duration;
    audioOffset = Math.max(0, Number(project.timing && project.timing.start) || 0);
    loopStart = 0; loopEnd = duration;
    $('project-name').value = project.name || doc().name || 'Untitled';
    $('project-name').disabled = false;
    $('empty').hidden = true; scroll.hidden = false;
    $('zoom').value = zoom;
    sampledReady = false; ensureSamples();
    renderCandidates(); setDirty(false); refresh(); await loadAudioWave();
  }

  async function chooseFile() { const picked = await R.pick(); if (picked) openPath(picked); }

  async function saveAll() {
    if (!project || !doc()) return null;
    setStatus('SAVING');
    const result = await R.saveProject({ projectPath, project, documents, selectedCandidate: candidate });
    if (!result || !result.ok) {
      if (!(result && result.canceled)) { setStatus('SAVE FAILED', 'error'); $('transport-note').textContent = result && result.error || 'Save failed.'; }
      else setStatus(dirty ? 'UNSAVED' : 'READY');
      return null;
    }
    projectPath = result.projectPath; project = result.project; setDirty(false);
    $('transport-note').textContent = `Saved ${projectPath}`;
    return result;
  }

  async function exportMidi() {
    if (!doc()) return;
    const result = await R.exportMidi({ name: `${project.name || 'melody'}_${candidate}`, document: doc() });
    if (result && result.ok) { $('transport-note').textContent = `Exported ${result.path}`; setStatus('EXPORTED', 'ok'); }
    else if (result && !result.canceled) { setStatus('EXPORT FAILED', 'error'); $('transport-note').textContent = result.error || 'Export failed.'; }
  }

  function hitNote(x, y) {
    const current = doc();
    if (!current) return null;
    for (let index = current.notes.length - 1; index >= 0; index -= 1) {
      const note = current.notes[index];
      const left = xForTime(note.start), right = xForTime(note.end), top = yForPitch(note.pitch);
      if (x >= left && x <= Math.max(left + 5, right) && y >= top && y <= top + ROW_H) {
        // A 1/16 note at the default zoom is ~10px wide; a fixed 8px edge zone
        // made almost every short note resize instead of move.
        const width = right - left;
        return { note, edge: width > 14 && right - x < Math.min(8, width * 0.3) };
      }
    }
    return null;
  }

  // The canvas only covers the viewport, so pointer x has to be put back into
  // song coordinates before anything uses it.
  const contentX = (clientX) => clientX - canvas.getBoundingClientRect().left + scroll.scrollLeft;

  canvas.addEventListener('pointerdown', (event) => {
    if (!doc()) return;
    const rect = canvas.getBoundingClientRect();
    const x = contentX(event.clientX), y = event.clientY - rect.top;
    const hit = hitNote(x, y);
    if (!hit) {
      // Drag on empty space = box select; a plain click = seek.
      if (!event.shiftKey) selected.clear();
      marquee = { x0: x, y0: y, x1: x, y1: y, moved: false, base: new Set(selected) };
      canvas.setPointerCapture(event.pointerId);
      refresh(); return;
    }
    if (event.shiftKey) {
      if (selected.has(hit.note.id)) selected.delete(hit.note.id);
      else { selected.add(hit.note.id); playSynthNote(hit.note, true); }
      refresh(); return;
    }
    if (!selected.has(hit.note.id)) { selected.clear(); selected.add(hit.note.id); }
    if (!hit.edge) playSynthNote(hit.note, true);
    // The undo snapshot is taken on the first move that actually changes
    // something — a plain click is how you select and audition a note, and it
    // used to mark the project unsaved and push a no-op onto the undo stack.
    const originals = doc().notes.filter((note) => selected.has(note.id)).map((note) => ({ note, start: note.start, end: note.end, pitch: note.pitch }));
    drag = { x, y, edge: hit.edge, originals, dirtied: false };
    canvas.setPointerCapture(event.pointerId); updateControls(); drawRoll();
  });

  canvas.addEventListener('pointermove', (event) => {
    if (marquee) {
      const rect = canvas.getBoundingClientRect();
      marquee.x1 = contentX(event.clientX); marquee.y1 = event.clientY - rect.top;
      if (Math.abs(marquee.x1 - marquee.x0) > 4 || Math.abs(marquee.y1 - marquee.y0) > 4) marquee.moved = true;
      if (marquee.moved) {
        const t0 = timeForX(Math.min(marquee.x0, marquee.x1)), t1 = timeForX(Math.max(marquee.x0, marquee.x1));
        const p0 = pitchForY(Math.max(marquee.y0, marquee.y1)), p1 = pitchForY(Math.min(marquee.y0, marquee.y1));
        selected = new Set(marquee.base);
        for (const note of doc().notes) {
          if (note.end >= t0 && note.start <= t1 && note.pitch >= p0 && note.pitch <= p1) selected.add(note.id);
        }
        updateControls();
      }
      drawRoll(); return;
    }
    if (!drag) return;
    const rect = canvas.getBoundingClientRect();
    const x = contentX(event.clientX), y = event.clientY - rect.top;
    if (!drag.dirtied) {
      if (Math.abs(x - drag.x) < 2 && Math.abs(y - drag.y) < 2) return;
      checkpoint();
      drag.dirtied = true;
    }
    const deltaTime = (x - drag.x) / zoom;
    const deltaPitch = pitchForY(y) - pitchForY(drag.y);
    for (const original of drag.originals) {
      if (drag.edge) original.note.end = Math.max(original.note.start + 0.02, snapSeconds(original.end + deltaTime));
      else {
        const length = original.end - original.start;
        original.note.start = clamp(snapSeconds(original.start + deltaTime), 0, Math.max(0, duration - .02));
        original.note.end = original.note.start + length;
        original.note.pitch = clamp(original.pitch + deltaPitch, 0, 127);
      }
    }
    drawRoll();
  });

  function endPointer() {
    if (marquee) {
      if (!marquee.moved) seek(timeForX(marquee.x1));
      marquee = null; refresh(); return;
    }
    if (drag) {
      const first = drag.originals[0];
      const changed = drag.dirtied && drag.originals.some((o) =>
        o.note.pitch !== o.pitch || o.note.start !== o.start || o.note.end !== o.end);
      if (changed && first && !drag.edge && first.note.pitch !== first.pitch) playSynthNote(first.note, true);
      drag = null;
      if (changed) { setDirty(); refresh(); } else { updateControls(); drawRoll(); }
    }
  }
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('dblclick', (event) => {
    if (!doc()) return;
    const rect = canvas.getBoundingClientRect();
    const start = snapSeconds(timeForX(contentX(event.clientX)));
    const pitch = pitchForY(event.clientY - rect.top);
    const division = Number($('quantize').value) || 16;
    const length = (60 / (Number(doc().bpm) || 120)) * (4 / division);
    checkpoint();
    const note = { id: `add${++noteSeq}`, pitch, start, end: Math.min(duration, start + length), velocity: 96, channel: 0 };
    doc().notes.push(note); selected = new Set([note.id]); playSynthNote(note, true);
    setDirty(); renderCandidates(); refresh();
  });

  let clipboard = [];

  function copySelected(cut) {
    const current = doc();
    if (!current || !selected.size) return;
    const picked = current.notes.filter((note) => selected.has(note.id));
    const origin = Math.min(...picked.map((note) => note.start));
    clipboard = picked.map((note) => ({ pitch: note.pitch, velocity: note.velocity,
      channel: note.channel || 0, start: note.start - origin, length: note.end - note.start }));
    $('transport-note').textContent = `${clipboard.length} note${clipboard.length === 1 ? '' : 's'} copied`;
    if (cut) deleteSelected();
  }

  function pasteClipboard(at) {
    const current = doc();
    if (!current || !clipboard.length) return;
    checkpoint();
    const start = snapSeconds(at == null ? playhead : at);
    const added = clipboard.map((item) => ({
      id: `add${++noteSeq}`, pitch: item.pitch, velocity: item.velocity, channel: item.channel,
      start: start + item.start, end: start + item.start + item.length,
    }));
    current.notes.push(...added);
    selected = new Set(added.map((note) => note.id));
    duration = Math.max(duration, ...added.map((note) => note.end));
    setDirty(); renderCandidates(); refresh();
  }

  function duplicateSelection() {
    const current = doc();
    if (!current || !selected.size) return;
    const picked = current.notes.filter((note) => selected.has(note.id));
    const span = Math.max(...picked.map((n) => n.end)) - Math.min(...picked.map((n) => n.start));
    copySelected(false);
    pasteClipboard(Math.min(...picked.map((n) => n.start)) + Math.max(span, 0.05));
  }

  // Move the selection in time. Step is one grid unit, or a millisecond with
  // Shift for the last bit of alignment.
  function nudgeTime(direction, fine) {
    const current = doc();
    if (!current || !selected.size) return;
    const division = Number($('quantize').value);
    const grid = division ? (60 / (Number(current.bpm) || 120)) * (4 / division) : 0.01;
    const step = (fine ? 0.001 : grid) * direction;
    checkpoint();
    for (const note of current.notes) {
      if (!selected.has(note.id)) continue;
      const length = note.end - note.start;
      note.start = clamp(note.start + step, 0, Math.max(0, duration - 0.02));
      note.end = note.start + length;
    }
    setDirty(); refresh();
  }

  function deleteSelected() {
    if (!doc() || !selected.size) return;
    checkpoint(); doc().notes = doc().notes.filter((note) => !selected.has(note.id)); selected.clear(); setDirty(); refresh(); renderCandidates();
  }

  function transpose(amount) {
    if (!doc() || !selected.size) return;
    checkpoint();
    doc().notes.forEach((note) => { if (selected.has(note.id)) note.pitch = clamp(note.pitch + amount, 0, 127); });
    const first = doc().notes.find((note) => selected.has(note.id));
    if (first) playSynthNote(first, true);
    setDirty(); refresh();
  }

  function quantize() {
    if (!doc() || !Number($('quantize').value)) return;
    checkpoint();
    const targets = selected.size ? doc().notes.filter((note) => selected.has(note.id)) : doc().notes;
    for (const note of targets) {
      const length = Math.max(.02, note.end - note.start);
      note.start = snapSeconds(note.start); note.end = note.start + length;
    }
    setDirty(); refresh();
  }

  function updateTime() {
    $('time').textContent = `${fmt(playhead)} / ${fmt(duration)}`;
    $('range-readout').textContent = `${fmt(loopStart)} — ${fmt(loopEnd)}`;
  }

  // Keep the playhead on screen; the roll is duration*zoom pixels wide, so
  // without this it walks off the viewport a second into playback.
  function followPlayhead(force) {
    if (scroll.hidden || (!force && !$('follow-on').checked)) return;
    const x = xForTime(playhead);
    const view = scroll.clientWidth;
    if (x < scroll.scrollLeft + KEY_W + 24 || x > scroll.scrollLeft + view - 60) {
      scroll.scrollLeft = clamp(x - view * .35, 0, Math.max(0, contentWidth() - view));
    }
  }

  function seek(time) {
    playhead = clamp(time, 0, duration);
    startedAt = performance.now() - playhead * 1000;
    previousMidiTime = playhead - .01;
    if ($('audio-on').checked && audio.src) audio.currentTime = audioOffset + playhead;
    followPlayhead(); updateTime(); drawWave(); drawRoll();
  }

  // Load the bundled piano samples once, in the background. Until they land,
  // previews fall back to the oscillator below so the editor is never silent.
  function ensureSamples() {
    if (!soundfonts || sampledReady) return samplePrepare || Promise.resolve(sampledReady);
    if (samplePrepare) return samplePrepare;
    const current = doc();
    if (!current) return Promise.resolve(false);
    synthContext = synthContext || new AudioContext();
    const pitches = current.notes.length ? current.notes.map((note) => note.pitch) : [60];
    samplePrepare = soundfonts.prepare(synthContext, INSTRUMENT, pitches)
      .then(() => { sampledReady = true; return true; })
      .catch(() => false)
      .finally(() => { samplePrepare = null; });
    return samplePrepare;
  }

  function playSynthNote(note, force) {
    if (!force && !$('midi-on').checked) return;
    synthContext = synthContext || new AudioContext();
    if (sampledReady) {
      const source = soundfonts.play(synthContext, INSTRUMENT, note.pitch, synthContext.currentTime,
        clamp(note.end - note.start, .05, 4), note.velocity);
      if (source) return;
    } else ensureSamples();
    const oscillator = synthContext.createOscillator();
    const gain = synthContext.createGain();
    const now = synthContext.currentTime;
    const length = clamp(note.end - note.start, .04, 2.5);
    oscillator.type = 'triangle';
    oscillator.frequency.value = 440 * Math.pow(2, (note.pitch - 69) / 12);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime((note.velocity / 127) * .12, now + .008);
    gain.gain.exponentialRampToValueAtTime(.001, now + length);
    oscillator.connect(gain).connect(synthContext.destination);
    oscillator.start(now); oscillator.stop(now + length + .02);
  }

  function triggerNotes(from, to) {
    const current = doc(); if (!current || to < from) return;
    current.notes.forEach((note) => { if (note.start > from && note.start <= to + .006) playSynthNote(note); });
  }

  // The roll canvas is duration*zoom pixels wide - tens of thousands for a
  // normal song - so repainting it every frame pins the GPU. Repaint only when
  // the playhead actually moved a pixel, and back off hard when the window is
  // not the one being looked at.
  let lastDraw = 0, lastPlayX = -1;
  function shouldDraw() {
    if (document.hidden) return false;
    const now = performance.now();
    const level = document.documentElement.dataset.perf || 'full';
    const focused = document.hasFocus();
    const budget = level === 'easy' ? (focused ? 100 : 1000)
      : level === 'balanced' ? (focused ? 66 : 500)
      : (focused ? 33 : 250);
    if (now - lastDraw < budget) return false;
    const x = Math.round(xForTime(playhead));
    if (x === lastPlayX) return false;
    lastDraw = now; lastPlayX = x;
    return true;
  }

  function tick() {
    if (!playing) return;
    let next = (performance.now() - startedAt) / 1000;
    if ($('audio-on').checked && audio.src && !audio.paused) next = audio.currentTime - audioOffset;
    const boundary = $('loop-on').checked ? loopEnd : duration;
    if (next >= boundary) {
      if ($('loop-on').checked && loopEnd > loopStart) {
        triggerNotes(previousMidiTime, boundary); seek(loopStart); previousMidiTime = loopStart - .01;
        if ($('audio-on').checked && audio.src) audio.play().catch(() => {});
      } else { stop(); return; }
    } else {
      triggerNotes(previousMidiTime, next);
      previousMidiTime = next; playhead = next;
    }
    if (shouldDraw()) { followPlayhead(); updateTime(); drawWave(); drawRoll(); }
    animation = requestAnimationFrame(tick);
  }

  async function playPause() {
    if (!doc()) return;
    if (playing) { pause(); return; }
    if (playhead >= duration - .01) seek($('loop-on').checked ? loopStart : 0);
    playing = true; $('play').textContent = 'Ⅱ'; $('play').setAttribute('aria-label', 'Pause');
    startedAt = performance.now() - playhead * 1000; previousMidiTime = playhead - .01;
    ensureSamples();
    if (synthContext) await synthContext.resume();
    if ($('audio-on').checked && audio.src) { audio.currentTime = audioOffset + playhead; audio.play().catch(() => {}); }
    tick();
  }

  function pause() {
    if (!playing) return;
    playing = false; cancelAnimationFrame(animation); audio.pause();
    $('play').textContent = '▶'; $('play').setAttribute('aria-label', 'Play');
  }

  function stop() { pause(); seek(0); }

  wave.addEventListener('pointerdown', (event) => {
    if (!doc() || !duration) return;
    const rect = wave.getBoundingClientRect();
    const time = clamp(waveT(event.clientX - rect.left, rect.width), 0, duration);
    waveDrag = { startX: event.clientX, start: time };
    wave.setPointerCapture(event.pointerId);
  });
  wave.addEventListener('pointermove', (event) => {
    if (!waveDrag) return;
    const rect = wave.getBoundingClientRect();
    const time = clamp(waveT(event.clientX - rect.left, rect.width), 0, duration);
    if (Math.abs(event.clientX - waveDrag.startX) > 4) {
      loopStart = Math.min(waveDrag.start, time); loopEnd = Math.max(waveDrag.start, time);
      $('loop-on').checked = true; updateTime(); drawWave();
    }
  });
  wave.addEventListener('pointerup', (event) => {
    if (!waveDrag) return;
    if (Math.abs(event.clientX - waveDrag.startX) <= 4) seek(waveDrag.start);
    waveDrag = null;
  });
  // dblclick resets the zoom (TimelineZoom) — clear the loop with the toggle.

  // Renaming decides the filenames the next Save/Export writes.
  $('project-name').addEventListener('change', (event) => {
    if (!project) return;
    const name = event.target.value.trim().replace(/[<>:"/\|?* -]/g, '').slice(0, 120);
    event.target.value = name || project.name || 'Untitled';
    if (!name || name === project.name) return;
    project.name = name;
    // Write the renamed take to new files rather than silently overwriting the
    // ones the old name pointed at.
    project.candidates = {};
    setDirty();
    $('transport-note').textContent = 'Renamed — Save project or Export MIDI writes it under the new name.';
  });
  $('open').addEventListener('click', chooseFile); $('empty-open').addEventListener('click', chooseFile);
  $('save').addEventListener('click', saveAll); $('export').addEventListener('click', exportMidi);
  $('undo').addEventListener('click', undo); $('redo').addEventListener('click', redo);
  $('delete').addEventListener('click', deleteSelected);
  $('oct-down').addEventListener('click', () => transpose(-12)); $('oct-up').addEventListener('click', () => transpose(12));
  $('apply-quantize').addEventListener('click', quantize);
  $('zoom').addEventListener('input', (event) => { zoom = Number(event.target.value); resizeRoll(); });
  $('velocity').addEventListener('change', (event) => {
    if (!doc() || !selected.size) return;
    checkpoint(); doc().notes.forEach((note) => { if (selected.has(note.id)) note.velocity = Number(event.target.value); }); setDirty(); refresh();
  });
  $('play').addEventListener('click', playPause); $('stop').addEventListener('click', stop);
  $('audio-on').addEventListener('change', () => { if (playing) { audio.pause(); if ($('audio-on').checked && audio.src) { audio.currentTime = audioOffset + playhead; audio.play().catch(() => {}); } } });
  $('to-audition').addEventListener('click', async () => {
    const saved = dirty ? await saveAll() : { ok: true };
    if (!saved) return;
    const midiPath = (project && project.candidates && project.candidates[candidate]) || '';
    if (midiPath) parent.postMessage({ type: 'studio:open-audition', midiPath, projectPath, play: true }, '*');
  });
  $('to-player').addEventListener('click', async () => {
    const saved = dirty || !projectPath ? await saveAll() : { ok: true, project };
    if (!saved) return;
    const midiPath = project.candidates && project.candidates[candidate];
    if (!midiPath) return;
    parent.postMessage({ type: 'studio:open-player', midiPath }, '*');
  });

  window.addEventListener('keydown', (event) => {
    const typing = /INPUT|SELECT|TEXTAREA/.test((event.target && event.target.tagName) || '');
    if (typing) return;
    if (event.code === 'Space') { playPause(); event.preventDefault(); }
    else if (event.key === 'Delete' || event.key === 'Backspace') { deleteSelected(); event.preventDefault(); }
    else if (event.ctrlKey && event.key.toLowerCase() === 'z') { event.shiftKey ? redo() : undo(); event.preventDefault(); }
    else if (event.ctrlKey && event.key.toLowerCase() === 'y') { redo(); event.preventDefault(); }
    else if (event.ctrlKey && event.key.toLowerCase() === 'a' && doc()) { selected = new Set(doc().notes.map((note) => note.id)); refresh(); event.preventDefault(); }
    else if (event.ctrlKey && event.key.toLowerCase() === 's') { saveAll(); event.preventDefault(); }
    else if (event.ctrlKey && event.key.toLowerCase() === 'c') { copySelected(false); event.preventDefault(); }
    else if (event.ctrlKey && event.key.toLowerCase() === 'x') { copySelected(true); event.preventDefault(); }
    else if (event.ctrlKey && event.key.toLowerCase() === 'v') { pasteClipboard(); event.preventDefault(); }
    else if (event.ctrlKey && event.key.toLowerCase() === 'd') { duplicateSelection(); event.preventDefault(); }
    else if (event.key === 'ArrowUp') { transpose(event.shiftKey ? 12 : 1); event.preventDefault(); }
    else if (event.key === 'ArrowDown') { transpose(event.shiftKey ? -12 : -1); event.preventDefault(); }
    else if (event.key === 'ArrowLeft') { nudgeTime(-1, event.shiftKey); event.preventDefault(); }
    else if (event.key === 'ArrowRight') { nudgeTime(1, event.shiftKey); event.preventDefault(); }
  });

  const dropZone = $('drop-zone');
  dropZone.addEventListener('dragover', (event) => { event.preventDefault(); dropZone.classList.add('dragging'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragging'));
  dropZone.addEventListener('drop', (event) => {
    event.preventDefault(); dropZone.classList.remove('dragging');
    const file = event.dataTransfer.files && event.dataTransfer.files[0];
    if (file) openPath(R.getDroppedFilePath(file));
  });
  // Wheel over the roll zooms around the pointer (DAW-style); shift-wheel and a
  // plain wheel keep scrolling, so the surface still behaves like a document.
  scroll.addEventListener('wheel', (event) => {
    if (!doc()) return;
    if (!event.ctrlKey && !event.altKey && !(event.deltaY && event.shiftKey)) {
      if (event.shiftKey) { scroll.scrollLeft += event.deltaY; event.preventDefault(); }
      return;
    }
    event.preventDefault();
    const anchorTime = timeForX(contentX(event.clientX));
    const factor = Math.exp(-event.deltaY * 0.0016);
    const next = clamp(zoom * factor, Number($('zoom').min), Number($('zoom').max));
    if (next === zoom) return;
    zoom = next;
    $('zoom').value = String(zoom);
    resizeRoll();
    // Keep the pointer over the same musical position.
    scroll.scrollLeft = clamp(xForTime(anchorTime) - (event.clientX - scroll.getBoundingClientRect().left),
      0, Math.max(0, contentWidth() - scroll.clientWidth));
  }, { passive: false });

  scroll.addEventListener('scroll', () => drawRoll(), { passive: true });
  window.addEventListener('resize', () => { resizeWave(); resizeRoll(); });
  window.addEventListener('beforeunload', (event) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
  window.openReviewProject = openPath;
  resizeWave(); updateControls(); updateTime();
})();

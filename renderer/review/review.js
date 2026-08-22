(() => {
  'use strict';
  const R = window.review;
  const $ = (id) => document.getElementById(id);
  const canvas = $('piano-roll');
  const wave = $('waveform');
  const scroll = $('roll-scroll');
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
    ['save', 'export', 'to-player', 'play', 'stop', 'quantize', 'apply-quantize', 'zoom',
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
    selected.clear(); setDirty(); refresh();
  }

  function redo() {
    const current = doc();
    const stack = futures[candidate] || [];
    if (!current || !stack.length) return;
    histories[candidate] = histories[candidate] || [];
    histories[candidate].push(cloneNotes(current.notes));
    current.notes = stack.pop();
    selected.clear(); setDirty(); refresh();
  }

  function calculateBounds() {
    const current = doc();
    if (!current || !current.notes.length) { pitchLow = 48; pitchHigh = 96; return; }
    const pitches = current.notes.map((note) => note.pitch);
    pitchLow = clamp(Math.min(...pitches) - 3, 24, 72);
    pitchHigh = clamp(Math.max(...pitches) + 3, pitchLow + 35, 108);
  }

  function resizeRoll() {
    if (!doc() || scroll.hidden) return;
    calculateBounds();
    const cssWidth = Math.max(scroll.clientWidth, KEY_W + duration * zoom + 50);
    const cssHeight = TOP_H + (pitchHigh - pitchLow + 1) * ROW_H;
    const dpr = window.devicePixelRatio || 1;
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    canvas.width = Math.round(cssWidth * dpr);
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
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#101115'; ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#181a1f'; ctx.fillRect(0, 0, KEY_W, height);
    ctx.fillStyle = '#202228'; ctx.fillRect(KEY_W, 0, width - KEY_W, TOP_H);

    for (let pitch = pitchLow; pitch <= pitchHigh; pitch += 1) {
      const y = yForPitch(pitch);
      const black = [1, 3, 6, 8, 10].includes(pitch % 12);
      ctx.fillStyle = black ? '#121318' : '#181a1e';
      ctx.fillRect(KEY_W, y, width - KEY_W, ROW_H);
      ctx.strokeStyle = '#272a31'; ctx.beginPath(); ctx.moveTo(0, y + ROW_H); ctx.lineTo(width, y + ROW_H); ctx.stroke();
      ctx.fillStyle = black ? '#202228' : '#d9dadc'; ctx.fillRect(0, y, KEY_W - 1, ROW_H - 1);
      if (pitch % 12 === 0) {
        ctx.fillStyle = black ? '#afb1b6' : '#25272d'; ctx.font = '9px JetBrains Mono';
        ctx.fillText(`C${Math.floor(pitch / 12) - 1}`, 6, y + 10);
      }
    }

    const beat = 60 / (Number(current.bpm) || 120);
    const sub = beat / 4;
    for (let time = 0, index = 0; time <= duration + sub; time += sub, index += 1) {
      const x = xForTime(time);
      const strong = index % 16 === 0;
      const beatLine = index % 4 === 0;
      ctx.strokeStyle = strong ? '#4a4e58' : beatLine ? '#343740' : '#24272d';
      ctx.beginPath(); ctx.moveTo(x, strong ? 0 : TOP_H); ctx.lineTo(x, height); ctx.stroke();
      if (strong) { ctx.fillStyle = '#858891'; ctx.font = '9px JetBrains Mono'; ctx.fillText(String(index / 16 + 1), x + 4, 16); }
    }

    for (const note of current.notes) {
      const x = xForTime(note.start);
      const y = yForPitch(note.pitch) + 1;
      const widthNote = Math.max(4, (note.end - note.start) * zoom);
      const on = selected.has(note.id);
      ctx.fillStyle = on ? getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() : '#4f9fb5';
      ctx.fillRect(x + 1, y, widthNote - 2, ROW_H - 2);
      ctx.strokeStyle = on ? '#e9ff9d' : '#72c1d4'; ctx.strokeRect(x + 1.5, y + .5, Math.max(1, widthNote - 3), ROW_H - 3);
      if (widthNote > 10) { ctx.fillStyle = on ? '#202500' : '#10242a'; ctx.fillRect(x + widthNote - 4, y + 2, 2, ROW_H - 6); }
    }
    const playX = xForTime(playhead);
    ctx.strokeStyle = '#f0d34e'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(playX, 0); ctx.lineTo(playX, height); ctx.stroke(); ctx.lineWidth = 1;
  }

  function drawWave() {
    const width = wave.clientWidth;
    const height = wave.clientHeight;
    waveCtx.clearRect(0, 0, width, height);
    waveCtx.fillStyle = '#0f1013'; waveCtx.fillRect(0, 0, width, height);
    if (duration > 0 && loopEnd > loopStart && ($('loop-on').checked || loopStart > 0 || loopEnd < duration)) {
      waveCtx.fillStyle = 'rgba(184,230,46,.10)';
      waveCtx.fillRect(loopStart / duration * width, 0, (loopEnd - loopStart) / duration * width, height);
    }
    waveCtx.strokeStyle = '#3a3d45'; waveCtx.beginPath(); waveCtx.moveTo(0, height / 2); waveCtx.lineTo(width, height / 2); waveCtx.stroke();
    if (wavePeaks.length) {
      waveCtx.strokeStyle = '#82a9b3'; waveCtx.beginPath();
      for (let x = 0; x < width; x += 1) {
        const peak = wavePeaks[Math.floor(x / width * wavePeaks.length)] || 0;
        waveCtx.moveTo(x + .5, height / 2 - peak * (height * .43));
        waveCtx.lineTo(x + .5, height / 2 + peak * (height * .43));
      }
      waveCtx.stroke();
    }
    if (doc()) {
      waveCtx.fillStyle = 'rgba(184,230,46,.42)';
      for (const note of doc().notes) waveCtx.fillRect(note.start / duration * width, height - 8, 1, 6);
    }
    const x = duration ? playhead / duration * width : 0;
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
    $('project-name').textContent = project.name || doc().name || 'Untitled';
    $('empty').hidden = true; scroll.hidden = false;
    $('zoom').value = zoom;
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
      if (x >= left && x <= Math.max(left + 5, right) && y >= top && y <= top + ROW_H) return { note, edge: right - x < 8 };
    }
    return null;
  }

  canvas.addEventListener('pointerdown', (event) => {
    if (!doc()) return;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left, y = event.clientY - rect.top;
    const hit = hitNote(x, y);
    if (!hit) { if (!event.shiftKey) selected.clear(); playhead = timeForX(x); refresh(); return; }
    if (event.shiftKey) {
      if (selected.has(hit.note.id)) selected.delete(hit.note.id); else selected.add(hit.note.id);
      refresh(); return;
    }
    if (!selected.has(hit.note.id)) { selected.clear(); selected.add(hit.note.id); }
    checkpoint();
    const originals = doc().notes.filter((note) => selected.has(note.id)).map((note) => ({ note, start: note.start, end: note.end, pitch: note.pitch }));
    drag = { x, y, edge: hit.edge, originals };
    canvas.setPointerCapture(event.pointerId); updateControls(); drawRoll();
  });

  canvas.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left, y = event.clientY - rect.top;
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

  canvas.addEventListener('pointerup', () => { if (drag) { drag = null; setDirty(); refresh(); } });
  canvas.addEventListener('pointercancel', () => { if (drag) { drag = null; setDirty(); refresh(); } });
  canvas.addEventListener('dblclick', (event) => {
    if (!doc()) return;
    const rect = canvas.getBoundingClientRect();
    const start = snapSeconds(timeForX(event.clientX - rect.left));
    const pitch = pitchForY(event.clientY - rect.top);
    const division = Number($('quantize').value) || 16;
    const length = (60 / (Number(doc().bpm) || 120)) * (4 / division);
    checkpoint();
    const note = { id: `n${Date.now()}`, pitch, start, end: Math.min(duration, start + length), velocity: 96, channel: 0 };
    doc().notes.push(note); selected = new Set([note.id]); setDirty(); renderCandidates(); refresh();
  });

  function deleteSelected() {
    if (!doc() || !selected.size) return;
    checkpoint(); doc().notes = doc().notes.filter((note) => !selected.has(note.id)); selected.clear(); setDirty(); refresh(); renderCandidates();
  }

  function transpose(amount) {
    if (!doc() || !selected.size) return;
    checkpoint();
    doc().notes.forEach((note) => { if (selected.has(note.id)) note.pitch = clamp(note.pitch + amount, 0, 127); });
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

  function seek(time) {
    playhead = clamp(time, 0, duration);
    startedAt = performance.now() - playhead * 1000;
    previousMidiTime = playhead - .01;
    if ($('audio-on').checked && audio.src) audio.currentTime = audioOffset + playhead;
    updateTime(); drawWave(); drawRoll();
  }

  function playSynthNote(note) {
    if (!$('midi-on').checked) return;
    synthContext = synthContext || new AudioContext();
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
    updateTime(); drawWave(); drawRoll();
    animation = requestAnimationFrame(tick);
  }

  async function playPause() {
    if (!doc()) return;
    if (playing) { pause(); return; }
    if (playhead >= duration - .01) seek($('loop-on').checked ? loopStart : 0);
    playing = true; $('play').textContent = 'Ⅱ'; $('play').setAttribute('aria-label', 'Pause');
    startedAt = performance.now() - playhead * 1000; previousMidiTime = playhead - .01;
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
    const time = clamp((event.clientX - rect.left) / rect.width * duration, 0, duration);
    waveDrag = { startX: event.clientX, start: time };
    wave.setPointerCapture(event.pointerId);
  });
  wave.addEventListener('pointermove', (event) => {
    if (!waveDrag) return;
    const rect = wave.getBoundingClientRect();
    const time = clamp((event.clientX - rect.left) / rect.width * duration, 0, duration);
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
  wave.addEventListener('dblclick', () => { loopStart = 0; loopEnd = duration; $('loop-on').checked = false; refresh(); });

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
  $('to-player').addEventListener('click', async () => {
    const saved = dirty || !projectPath ? await saveAll() : { ok: true, project };
    if (!saved) return;
    const midiPath = project.candidates && project.candidates[candidate];
    if (!midiPath) return;
    try {
      parent.document.querySelector('.tab[data-tab="player"]').click();
      const player = parent.document.getElementById('frame-player').contentWindow;
      if (player && typeof player.setMidiFile === 'function') player.setMidiFile(midiPath);
    } catch (_) { $('transport-note').textContent = 'Could not hand off to Player.'; }
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
  });

  const dropZone = $('drop-zone');
  dropZone.addEventListener('dragover', (event) => { event.preventDefault(); dropZone.classList.add('dragging'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragging'));
  dropZone.addEventListener('drop', (event) => {
    event.preventDefault(); dropZone.classList.remove('dragging');
    const file = event.dataTransfer.files && event.dataTransfer.files[0];
    if (file) openPath(R.getDroppedFilePath(file));
  });
  window.addEventListener('resize', () => { resizeWave(); resizeRoll(); });
  window.addEventListener('beforeunload', (event) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
  window.openReviewProject = openPath;
  resizeWave(); updateControls(); updateTime();
})();

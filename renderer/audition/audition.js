(() => {
  'use strict';

  const api = window.api;
  const review = window.review;
  const soundfonts = window.MidiStudioSoundfonts;
  const $ = (id) => document.getElementById(id);
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const PREFS_KEY = 'midi-studio.audition.v1';
  const OLD_PREFS_KEY = 'midi-forge.preview-prefs.v1';
  const SOUND_MIGRATION = { soft: 'grand_piano', bright: 'synth_lead', pure: 'electric_piano', chip: 'music_box' };
  const defaults = { volume: 65, instrument: 'grand_piano', speed: 1, pitch: 0, sustain: true,
    loop: false, autoplay: false, recent: [], lastMidiPath: '', lastProjectPath: '' };
  let prefs = { ...defaults };
  try {
    const old = JSON.parse(localStorage.getItem(OLD_PREFS_KEY) || '{}');
    prefs = { ...prefs, volume: Number(old.midiVolume) || prefs.volume,
      instrument: SOUND_MIGRATION[old.sound] || old.sound || prefs.instrument,
      speed: Number(old.speed) || prefs.speed, pitch: Number(old.pitch) || 0,
      sustain: old.sustain !== false, loop: !!old.loop,
      lastMidiPath: old.lastMidiPath || '', lastProjectPath: old.lastProjectPath || '' };
    prefs = { ...prefs, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') };
  } catch (_) {}
  if (!soundfonts || !soundfonts.presets[prefs.instrument]) prefs.instrument = 'grand_piano';
  if (!Array.isArray(prefs.recent)) prefs.recent = [];

  const player = {
    token: 0, documents: {}, candidate: '', project: null, midiPath: '', projectPath: '',
    duration: 0, position: 0, previousTime: -0.01, startedAt: 0, playing: false, frame: 0,
    context: null, master: null, voices: new Set(), instrumentToken: 0,
    instrumentReady: '', instrumentFailed: false,
  };

  function savePrefs() {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (_) {}
  }

  function formatTime(seconds) {
    const total = Math.max(0, Number(seconds) || 0);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = Math.floor(total % 60);
    return `${hours ? `${String(hours).padStart(2, '0')}:` : ''}${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  function currentDocument() { return player.documents[player.candidate] || null; }
  function currentPath() { const doc = currentDocument(); return (doc && doc.path) || player.midiPath || ''; }
  function speed() { return Number($('speed').value) || 1; }
  function instrument() { return $('instrument').value || 'grand_piano'; }
  function instrumentLabel(key = instrument()) { return soundfonts && soundfonts.presets[key] ? soundfonts.presets[key].label : 'Grand Piano'; }
  function isFormControl(target) { return target && /^(INPUT|SELECT|BUTTON|TEXTAREA)$/.test(target.tagName); }

  function setLoading(message, show = true) {
    $('loading').hidden = !show;
    $('loading-text').textContent = message;
  }

  function enableTransport(enabled) {
    for (const id of ['play', 'stop', 'back', 'forward', 'seek']) $(id).disabled = !enabled;
    $('show-file').disabled = !enabled;
    $('to-player').disabled = !enabled;
  }

  function updateInstrumentStatus(message = '') {
    $('instrument-status').textContent = message || `${instrumentLabel()} · Ready`;
  }

  function updateSongUI() {
    const doc = currentDocument();
    const path = currentPath();
    $('file-name').textContent = (doc && doc.name) || (player.project && player.project.name) || 'MIDI Audition';
    $('file-path').textContent = path || 'No MIDI loaded';
    $('stat-notes').textContent = doc ? String(doc.notes.length) : '0';
    $('stat-bpm').textContent = doc ? String(Math.round(Number(doc.bpm) || 120)) : '0';
    $('stat-length').textContent = formatTime(player.duration);
    $('seek').value = player.duration ? String(Math.round(player.position / player.duration * 1000)) : '0';
    $('time').textContent = `${formatTime(player.position)} / ${formatTime(player.duration)}`;
    document.title = doc ? `${doc.name} · MIDI Audition` : 'MIDI Audition';
    drawRoll();
  }

  function renderRecent() {
    const select = $('recent');
    select.textContent = '';
    const placeholder = document.createElement('option');
    placeholder.value = ''; placeholder.textContent = prefs.recent.length ? 'Choose recent MIDI' : 'No recent MIDI';
    select.appendChild(placeholder);
    prefs.recent.slice(0, 10).forEach((item, index) => {
      const option = document.createElement('option');
      option.value = String(index); option.textContent = item.label || item.midiPath || item.projectPath;
      option.title = item.projectPath || item.midiPath || '';
      select.appendChild(option);
    });
    $('clear-recent').disabled = !prefs.recent.length;
  }

  function addRecent(midiPath, projectPath, label) {
    const key = projectPath || midiPath;
    if (!key) return;
    prefs.recent = [{ midiPath: midiPath || '', projectPath: projectPath || '', label: label || key.split(/[\\/]/).pop() },
      ...prefs.recent.filter((item) => (item.projectPath || item.midiPath) !== key)].slice(0, 10);
    renderRecent();
  }

  function clearVoices() {
    for (const voice of player.voices) { try { voice.stop(); } catch (_) {} }
    player.voices.clear();
  }

  function registerVoice(voice) {
    player.voices.add(voice);
    voice.addEventListener('ended', () => player.voices.delete(voice), { once: true });
  }

  function pause() {
    if (!player.playing) return;
    player.playing = false;
    cancelAnimationFrame(player.frame);
    clearVoices();
    $('play').textContent = '▶';
    $('play').setAttribute('aria-label', 'Play');
  }

  function seek(seconds) {
    player.position = clamp(Number(seconds) || 0, 0, player.duration || 0);
    player.previousTime = player.position - 0.01;
    player.startedAt = performance.now() - player.position / speed() * 1000;
    clearVoices();
    updateSongUI();
  }

  function stop() { pause(); seek(0); }

  function invalidateInstrument() {
    player.instrumentToken += 1;
    player.instrumentReady = '';
    player.instrumentFailed = false;
    $('instrument').dataset.ready = '';
    if (currentDocument()) $('play').disabled = false;
    updateInstrumentStatus(`${instrumentLabel()} · Loads on play`);
  }

  function ensureAudio() {
    player.context = player.context || new (window.AudioContext || window.webkitAudioContext)();
    if (!player.master) {
      player.master = player.context.createGain();
      player.master.connect(player.context.destination);
    }
    player.master.gain.value = Number($('volume').value) / 100;
    return player.context;
  }

  async function prepareInstrument() {
    const doc = currentDocument();
    const key = instrument();
    if (!doc || !soundfonts || !soundfonts.presets[key]) return false;
    if (player.instrumentReady === key) return true;
    const token = ++player.instrumentToken;
    const transpose = Number($('pitch').value) || 0;
    const pitches = doc.notes.map((note) => Number(note.pitch) + transpose);
    $('play').disabled = true;
    updateInstrumentStatus(`Loading ${instrumentLabel(key)}...`);
    try {
      await soundfonts.prepare(ensureAudio(), key, pitches, (ready, total) => {
        if (token === player.instrumentToken) updateInstrumentStatus(`Loading ${instrumentLabel(key)}... ${ready}/${total}`);
      });
      if (token !== player.instrumentToken || key !== instrument()) return false;
      player.instrumentReady = key;
      player.instrumentFailed = false;
      $('instrument').dataset.ready = key;
      updateInstrumentStatus();
      return true;
    } catch (error) {
      if (token !== player.instrumentToken) return false;
      player.instrumentFailed = true;
      updateInstrumentStatus(`${instrumentLabel(key)} unavailable · Basic fallback`);
      return false;
    } finally {
      if (token === player.instrumentToken && currentDocument()) $('play').disabled = false;
    }
  }

  function playFallback(note, pitch, duration) {
    const context = player.context;
    const now = context.currentTime;
    const oscillator = context.createOscillator();
    const envelope = context.createGain();
    const velocity = clamp(Number(note.velocity) || 80, 1, 127) / 127;
    const drum = Number(note.channel) === 9 || instrument() === 'synth_drum';
    let length = duration;
    let peak = 0.11 * velocity;
    if (drum) {
      const notePitch = Number(note.pitch);
      length = [42, 44, 46, 49, 51].includes(notePitch) ? 0.08 : notePitch <= 36 ? 0.18 : 0.12;
      oscillator.type = notePitch <= 36 ? 'sine' : notePitch === 38 || notePitch === 40 ? 'sawtooth' : 'square';
      oscillator.frequency.setValueAtTime(notePitch <= 36 ? 120 : notePitch <= 40 ? 190 : 3200, now);
      oscillator.frequency.exponentialRampToValueAtTime(notePitch <= 36 ? 45 : notePitch <= 40 ? 90 : 900, now + length);
      peak = 0.09 * velocity;
    } else {
      oscillator.type = 'triangle';
      oscillator.frequency.value = 440 * Math.pow(2, (pitch - 69) / 12);
    }
    envelope.gain.setValueAtTime(0.0001, now);
    envelope.gain.linearRampToValueAtTime(Math.max(0.0002, peak), now + 0.008);
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + length);
    oscillator.connect(envelope).connect(player.master || context.destination);
    registerVoice(oscillator);
    oscillator.start(now); oscillator.stop(now + length + 0.02);
  }

  function playNote(note) {
    if (!player.context || Number($('volume').value) <= 0) return;
    const playbackSpeed = speed();
    let duration = clamp((Number(note.end) - Number(note.start)) / playbackSpeed, 0.04, 2.5);
    const pitch = Number(note.pitch) + Number($('pitch').value);
    const drum = Number(note.channel) === 9 || instrument() === 'synth_drum';
    if ($('sustain').checked && !drum) duration = clamp(duration + 1.25 / playbackSpeed, 0.2, 5);
    if (player.instrumentReady === instrument()) {
      const source = soundfonts.play(player.context, instrument(), pitch, player.context.currentTime,
        duration, note.velocity, player.master);
      if (source) { registerVoice(source); return; }
    }
    playFallback(note, pitch, duration);
  }

  function triggerNotes(from, to) {
    const doc = currentDocument();
    if (!doc || to < from) return;
    for (const note of doc.notes) if (note.start > from && note.start <= to + 0.006) playNote(note);
  }

  function tick() {
    if (!player.playing) return;
    const next = (performance.now() - player.startedAt) / 1000 * speed();
    if (next >= player.duration) {
      triggerNotes(player.previousTime, player.duration);
      if ($('loop').checked && player.duration > 0) {
        seek(0); player.previousTime = -0.01;
      } else { stop(); return; }
    } else {
      triggerNotes(player.previousTime, next);
      player.previousTime = next;
      player.position = next;
      updateSongUI();
    }
    player.frame = requestAnimationFrame(tick);
  }

  async function togglePlay() {
    if (!currentDocument() || !player.duration) return;
    if (player.playing) { pause(); return; }
    if (player.position >= player.duration - 0.01) seek(0);
    ensureAudio();
    await player.context.resume();
    const before = player.instrumentToken;
    await prepareInstrument();
    if (before !== player.instrumentToken && player.instrumentReady !== instrument() && !player.instrumentFailed) return;
    player.playing = true;
    player.startedAt = performance.now() - player.position / speed() * 1000;
    player.previousTime = player.position - 0.01;
    $('play').textContent = 'Ⅱ';
    $('play').setAttribute('aria-label', 'Pause');
    tick();
  }

  function setCandidate(name) {
    if (!player.documents[name]) return;
    pause();
    player.candidate = name;
    const doc = currentDocument();
    player.duration = Number(doc.duration) || Math.max(0, ...doc.notes.map((note) => note.end));
    player.position = 0;
    player.previousTime = -0.01;
    invalidateInstrument();
    updateSongUI();
  }

  async function loadAudition(midiPath, projectPath, options = {}) {
    const token = ++player.token;
    stop();
    player.documents = {};
    setLoading('Loading MIDI...');
    $('empty').hidden = true;
    enableTransport(false);
    const source = projectPath || midiPath;
    if (!source || !review || !review.load) { setLoading('MIDI preview is unavailable.'); return false; }
    let result;
    try { result = await review.load(source); }
    catch (error) { result = { ok: false, error: error.message }; }
    if (token !== player.token) return false;
    if (!result || !result.ok || !result.data || !Object.keys(result.data.documents || {}).length) {
      setLoading((result && result.error) || 'Could not load this MIDI.');
      $('empty').hidden = false;
      return false;
    }

    player.documents = result.data.documents;
    player.project = result.data.project || null;
    player.midiPath = midiPath || '';
    player.projectPath = projectPath || '';
    const names = Object.keys(player.documents);
    $('candidate').textContent = '';
    for (const name of names) {
      const option = document.createElement('option');
      option.value = name; option.textContent = name[0].toUpperCase() + name.slice(1);
      $('candidate').appendChild(option);
    }
    $('candidate-field').hidden = names.length < 2;
    const preferred = result.data.project && result.data.project.selectedCandidate;
    $('candidate').value = names.includes(preferred) ? preferred : names[0];
    setCandidate($('candidate').value);
    setLoading('', false);
    $('empty').hidden = true;
    enableTransport(true);

    const drumNotes = currentDocument().notes.filter((note) => Number(note.channel) === 9).length;
    if (drumNotes > currentDocument().notes.length * 0.6 && prefs.instrument === 'grand_piano') {
      prefs.instrument = 'synth_drum'; $('instrument').value = 'synth_drum'; invalidateInstrument();
    }
    prefs.lastMidiPath = midiPath || '';
    prefs.lastProjectPath = projectPath || '';
    addRecent(midiPath, projectPath, (player.project && player.project.name) || currentDocument().name);
    savePrefs();
    updateSongUI();
    if (options.play === true || (options.play !== false && prefs.autoplay)) await togglePlay();
    return true;
  }

  function drawRoll() {
    const canvas = $('note-roll');
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * dpr); canvas.height = Math.round(rect.height * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0f1013'; ctx.fillRect(0, 0, rect.width, rect.height);
    const doc = currentDocument();
    if (!doc || !doc.notes.length || !player.duration) return;
    const pitches = doc.notes.map((note) => Number(note.pitch));
    const low = Math.min(...pitches), high = Math.max(...pitches);
    const range = Math.max(12, high - low + 3);
    const bottom = low - 1;
    ctx.lineWidth = 1;
    for (let pitch = bottom; pitch <= bottom + range; pitch += 1) {
      const y = rect.height - (pitch - bottom) / range * rect.height;
      ctx.strokeStyle = pitch % 12 === 0 ? '#3a3d45' : '#22242a';
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(rect.width, y); ctx.stroke();
    }
    const gridSeconds = player.duration > 240 ? 30 : player.duration > 90 ? 10 : player.duration > 30 ? 5 : 1;
    ctx.font = '9px "JetBrains Mono", monospace'; ctx.fillStyle = '#62656d';
    for (let at = 0; at <= player.duration; at += gridSeconds) {
      const x = at / player.duration * rect.width;
      ctx.strokeStyle = '#2b2e36'; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, rect.height); ctx.stroke();
      if (x + 30 < rect.width) ctx.fillText(formatTime(at), x + 4, 12);
    }
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#b8e62e';
    ctx.fillStyle = accent; ctx.globalAlpha = 0.82;
    for (const note of doc.notes) {
      const x = Number(note.start) / player.duration * rect.width;
      const width = Math.max(2, (Number(note.end) - Number(note.start)) / player.duration * rect.width);
      const y = rect.height - (Number(note.pitch) - bottom + 1) / range * rect.height;
      ctx.fillRect(x, y, width, Math.max(3, rect.height / range - 2));
    }
    ctx.globalAlpha = 1;
    const playX = player.position / player.duration * rect.width;
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(playX, 0); ctx.lineTo(playX, rect.height); ctx.stroke();
  }

  function sendToPlayer() {
    const path = currentPath();
    if (!path) return;
    try {
      parent.document.querySelector('.tab[data-tab="player"]').click();
      const frame = parent.document.getElementById('frame-player');
      const target = frame && frame.contentWindow;
      if (target && typeof target.setMidiFile === 'function') target.setMidiFile(path);
      else if (target && target.api) target.api.send({ cmd: 'load_midi', path, mapping: 'roblox88', tempo: 1.0 });
    } catch (_) {}
  }

  $('volume').value = String(clamp(Number(prefs.volume) || 0, 0, 100));
  $('volume-value').textContent = `${$('volume').value}%`;
  $('instrument').value = prefs.instrument;
  $('speed').value = String(prefs.speed || 1);
  $('pitch').value = String(Number(prefs.pitch) || 0);
  $('sustain').checked = prefs.sustain !== false;
  $('loop').checked = !!prefs.loop;
  $('autoplay').checked = !!prefs.autoplay;
  updateInstrumentStatus(`${instrumentLabel()} · Loads on play`);
  renderRecent();

  const openPicker = async () => {
    const files = api && api.pickMidi ? await api.pickMidi() : [];
    if (files && files[0]) loadAudition(files[0], '', { play: prefs.autoplay });
  };
  $('open-midi').addEventListener('click', openPicker);
  $('empty-open').addEventListener('click', openPicker);
  $('play').addEventListener('click', togglePlay);
  $('stop').addEventListener('click', stop);
  $('back').addEventListener('click', () => seek(player.position - 5));
  $('forward').addEventListener('click', () => seek(player.position + 5));
  $('seek').addEventListener('input', (event) => seek(Number(event.target.value) / 1000 * player.duration));
  $('candidate').addEventListener('change', (event) => setCandidate(event.target.value));
  $('volume').addEventListener('input', (event) => {
    prefs.volume = Number(event.target.value); $('volume-value').textContent = `${event.target.value}%`;
    if (player.master) player.master.gain.value = prefs.volume / 100;
    savePrefs();
  });
  $('instrument').addEventListener('change', async (event) => {
    pause(); prefs.instrument = event.target.value; invalidateInstrument(); savePrefs();
    if (player.context && currentDocument()) await prepareInstrument();
  });
  $('pitch').addEventListener('change', async (event) => {
    pause(); prefs.pitch = Number(event.target.value); invalidateInstrument(); savePrefs();
    if (player.context && currentDocument()) await prepareInstrument();
  });
  $('speed').addEventListener('change', (event) => { prefs.speed = Number(event.target.value); seek(player.position); savePrefs(); });
  $('sustain').addEventListener('change', (event) => { prefs.sustain = event.target.checked; clearVoices(); savePrefs(); });
  $('loop').addEventListener('change', (event) => { prefs.loop = event.target.checked; savePrefs(); });
  $('autoplay').addEventListener('change', (event) => { prefs.autoplay = event.target.checked; savePrefs(); });
  $('show-file').addEventListener('click', () => { if (currentPath() && review && review.showItem) review.showItem(currentPath()); });
  $('to-player').addEventListener('click', sendToPlayer);
  $('recent').addEventListener('change', (event) => {
    const item = prefs.recent[Number(event.target.value)];
    event.target.value = '';
    if (item) loadAudition(item.midiPath, item.projectPath, { play: prefs.autoplay });
  });
  $('clear-recent').addEventListener('click', () => { prefs.recent = []; savePrefs(); renderRecent(); });
  $('note-roll').addEventListener('pointerdown', (event) => {
    if (!player.duration) return;
    const rect = event.currentTarget.getBoundingClientRect();
    seek((event.clientX - rect.left) / rect.width * player.duration);
  });
  window.addEventListener('resize', drawRoll);
  window.addEventListener('keydown', (event) => {
    if (isFormControl(event.target) || event.ctrlKey || event.altKey || event.metaKey) return;
    if (event.code === 'Space') { togglePlay(); event.preventDefault(); }
    else if (event.key === 'ArrowLeft') { seek(player.position - 5); event.preventDefault(); }
    else if (event.key === 'ArrowRight') { seek(player.position + 5); event.preventDefault(); }
    else if (event.key === 'Home') { stop(); event.preventDefault(); }
  });

  let dragDepth = 0;
  document.addEventListener('dragenter', (event) => { event.preventDefault(); dragDepth += 1; $('drop-overlay').classList.add('is-active'); });
  document.addEventListener('dragover', (event) => event.preventDefault());
  document.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('drop-overlay').classList.remove('is-active'); });
  document.addEventListener('drop', (event) => {
    event.preventDefault(); dragDepth = 0; $('drop-overlay').classList.remove('is-active');
    const file = event.dataTransfer.files && event.dataTransfer.files[0];
    const path = file && review && review.getDroppedFilePath ? review.getDroppedFilePath(file) : '';
    if (/\.midi?$/i.test(path)) loadAudition(path, '', { play: prefs.autoplay });
    else if (/\.midstudio\.json$/i.test(path)) loadAudition('', path, { play: prefs.autoplay });
  });

  window.loadAudition = loadAudition;
  if (prefs.lastProjectPath || prefs.lastMidiPath) loadAudition(prefs.lastMidiPath, prefs.lastProjectPath, { play: false });
})();

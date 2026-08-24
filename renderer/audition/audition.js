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

  // Notes are queued onto the Web Audio clock ahead of time, so playback keeps
  // going even when the window is in the background and frames/timers throttle.
  const LOOKAHEAD = 1.5;
  const SCHED_MS = 120;

  const player = {
    token: 0, documents: {}, candidate: '', project: null, midiPath: '', projectPath: '',
    duration: 0, position: 0, playing: false, frame: 0,
    audioStart: 0, cursor: 0, timer: 0,
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
    $('to-editor').disabled = !enabled;
  }

  function updateInstrumentStatus(message = '') {
    $('instrument-status').textContent = message || `${instrumentLabel()} · Ready`;
  }

  function updateSongUI() {
    const doc = currentDocument();
    const path = currentPath();
    $('file-name').textContent = (doc && doc.name) || (player.project && player.project.name) || 'Self Midi';
    $('file-path').textContent = path || 'No MIDI loaded';
    $('stat-notes').textContent = doc ? String(doc.notes.length) : '0';
    $('stat-bpm').textContent = doc ? String(Math.round(Number(doc.bpm) || 120)) : '0';
    $('stat-length').textContent = formatTime(player.duration);
    $('seek').value = player.duration ? String(Math.round(player.position / player.duration * 1000)) : '0';
    $('time').textContent = `${formatTime(player.position)} / ${formatTime(player.duration)}`;
    document.title = doc ? `${doc.name} · Self Midi` : 'Self Midi';
    drawRoll();
  }

  // ---- library ---------------------------------------------------------------
  let libraryFiles = [];
  let libraryTruncated = false;

  const relativeDir = (dir) => String(dir || '').split(/[\\/]/).slice(-2).join('\\');

  function libraryView() {
    const query = $('library-search').value.trim().toLowerCase();
    const sort = $('library-sort').value;
    let files = libraryFiles;
    if (query) {
      const terms = query.split(/\s+/);
      files = files.filter((file) => {
        const hay = `${file.name} ${file.dir}`.toLowerCase();
        return terms.every((term) => hay.includes(term));
      });
    }
    files = files.slice();
    if (sort === 'name') files.sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === 'folder') files.sort((a, b) => a.dir.localeCompare(b.dir) || a.name.localeCompare(b.name));
    else files.sort((a, b) => b.modified - a.modified);
    return files;
  }

  function renderLibrary() {
    const host = $('library-list');
    const files = libraryView();
    const active = currentPath().toLowerCase();
    host.textContent = '';
    $('library-count').textContent = libraryFiles.length
      ? `${files.length}${files.length === libraryFiles.length ? '' : `/${libraryFiles.length}`}${libraryTruncated ? '+' : ''}`
      : '0';
    if (!files.length) {
      const empty = document.createElement('div');
      empty.className = 'library-empty';
      empty.textContent = libraryFiles.length
        ? 'Nothing matches that search.'
        : 'No MIDI files found yet. Forge results land here automatically, or add a folder you keep MIDI in.';
      host.appendChild(empty);
      return;
    }
    // Rows are cheap; a few thousand of them are not. Render what fits and grow
    // on scroll instead of building the whole list up front.
    let shown = 0;
    const chunk = () => {
      const slice = files.slice(shown, shown + 300);
      for (const file of slice) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = `library-item${file.path.toLowerCase() === active ? ' is-active' : ''}`;
        item.title = file.path;
        item.innerHTML = '<b></b><small></small>';
        item.querySelector('b').textContent = file.name;
        item.querySelector('small').textContent = relativeDir(file.dir);
        item.addEventListener('click', () => loadAudition(file.path, '', { play: true }));
        item.addEventListener('contextmenu', (event) => {
          event.preventDefault();
          if (window.library && library.reveal) library.reveal(file.path);
        });
        host.appendChild(item);
      }
      shown += slice.length;
    };
    chunk();
    host.onscroll = () => {
      if (shown < files.length && host.scrollTop + host.clientHeight > host.scrollHeight - 200) chunk();
    };
  }

  async function refreshLibrary() {
    if (!window.library || !library.list) return;
    let result;
    try { result = await library.list(); } catch { return; }
    libraryFiles = (result && result.files) || [];
    libraryTruncated = !!(result && result.truncated);
    renderLibrary();
  }

  function renderRecent() {}

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
    player.position = songTime();
    player.playing = false;
    cancelAnimationFrame(player.frame);
    clearInterval(player.timer); player.timer = 0;
    clearVoices();
    $('play').textContent = '▶';
    $('play').setAttribute('aria-label', 'Play');
    updateSongUI();
  }

  function songTime() {
    if (!player.playing || !player.context) return player.position;
    return clamp((player.context.currentTime - player.audioStart) * speed(), 0, player.duration);
  }

  // First note at or after `from`, the scheduler walks forward from here.
  function cursorFor(from) {
    const doc = currentDocument();
    if (!doc) return 0;
    let index = 0;
    while (index < doc.notes.length && Number(doc.notes[index].start) < from) index += 1;
    return index;
  }

  function seek(seconds) {
    player.position = clamp(Number(seconds) || 0, 0, player.duration || 0);
    player.cursor = cursorFor(player.position);
    if (player.context) player.audioStart = player.context.currentTime - player.position / speed();
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

  function playFallback(note, pitch, duration, when) {
    const context = player.context;
    const now = Math.max(when || 0, context.currentTime);
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

  function playNote(note, when) {
    if (!player.context || Number($('volume').value) <= 0) return;
    const playbackSpeed = speed();
    let duration = clamp((Number(note.end) - Number(note.start)) / playbackSpeed, 0.04, 2.5);
    const pitch = Number(note.pitch) + Number($('pitch').value);
    const drum = Number(note.channel) === 9 || instrument() === 'synth_drum';
    if ($('sustain').checked && !drum) duration = clamp(duration + 1.25 / playbackSpeed, 0.2, 5);
    const at = Math.max(when, player.context.currentTime);
    if (player.instrumentReady === instrument()) {
      const source = soundfonts.play(player.context, instrument(), pitch, at,
        duration, note.velocity, player.master);
      if (source) { registerVoice(source); return; }
    }
    playFallback(note, pitch, duration, at);
  }

  // Queue every note that starts inside the lookahead window. Called on a timer,
  // but the notes themselves are pinned to absolute audio-clock times, so a late
  // or throttled wake-up costs nothing as long as it lands inside LOOKAHEAD.
  function scheduleAhead() {
    const doc = currentDocument();
    if (!player.playing || !doc || !player.context) return;
    const notes = doc.notes;
    const horizon = (player.context.currentTime + LOOKAHEAD - player.audioStart) * speed();
    while (player.cursor < notes.length && Number(notes[player.cursor].start) <= horizon) {
      const note = notes[player.cursor++];
      playNote(note, player.audioStart + Number(note.start) / speed());
    }
    const end = player.audioStart + player.duration / speed();
    if (player.context.currentTime >= end) {
      if ($('loop').checked && player.duration > 0) {
        // Roll the timeline forward instead of seeking, so the loop is seamless.
        player.audioStart = end;
        player.cursor = 0;
        scheduleAhead();
      } else { stop(); }
    }
  }

  // Audio runs off the scheduler, so drawing is free to be lazy. Background
  // throttling is disabled app-wide to keep playback alive behind the game
  // window, without a cap here that would mean a full-rate repaint forever.
  let lastDraw = 0;
  // The shell publishes the frame budget in milliseconds, derived from the
  // "use at most N%" setting. Unfocused windows get an eighth of the rate.
  function drawBudgetMs() {
    if (document.hidden) return Infinity;          // minimized: don't draw at all
    // Another tab is showing. Playback continues, it just has no viewer.
    if (document.documentElement.dataset.onscreen === '0') return Infinity;
    const base = Number(document.documentElement.dataset.drawms) || 33;
    return document.hasFocus() ? base : Math.max(250, base * 8);
  }
  function tick() {
    if (!player.playing) return;
    player.position = songTime();
    const now = performance.now();
    if (now - lastDraw >= drawBudgetMs()) { lastDraw = now; updateSongUI(); }
    player.frame = requestAnimationFrame(tick);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { lastDraw = 0; updateSongUI(); } });
  // Coming back on screen: catch the canvas up immediately. The loop itself
  // kept running while hidden, it just skipped the drawing.
  window.addEventListener('midi-studio:onscreen', () => { lastDraw = 0; updateSongUI(); });

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
    player.audioStart = player.context.currentTime - player.position / speed();
    player.cursor = cursorFor(player.position);
    $('play').textContent = 'Ⅱ';
    $('play').setAttribute('aria-label', 'Pause');
    scheduleAhead();
    clearInterval(player.timer);
    player.timer = setInterval(scheduleAhead, SCHED_MS);
    tick();
  }

  function setCandidate(name) {
    if (!player.documents[name]) return;
    pause();
    player.candidate = name;
    const doc = currentDocument();
    player.duration = Number(doc.duration) || Math.max(0, ...doc.notes.map((note) => note.end));
    player.position = 0;
    player.cursor = 0;
    view.span = 0; view.start = 0;
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
    renderLibrary();
    if (options.play === true || (options.play !== false && prefs.autoplay)) await togglePlay();
    return true;
  }

  // Visible slice of the song, in seconds. Full song until the user zooms.
  const view = { start: 0, span: 0 };
  function viewSpan() {
    const span = view.span > 0 ? Math.min(view.span, player.duration) : player.duration;
    return Math.max(0.5, span || 0.5);
  }
  function viewStart() {
    return clamp(view.start, 0, Math.max(0, (player.duration || 0) - viewSpan()));
  }

  function drawRoll() {
    const canvas = $('note-roll');
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = window.devicePixelRatio || 1;
    // Only resize when it actually changed - reassigning width/height every
    // animation frame reallocates the backing store and stalls playback.
    const wantW = Math.round(rect.width * dpr), wantH = Math.round(rect.height * dpr);
    if (canvas.width !== wantW || canvas.height !== wantH) { canvas.width = wantW; canvas.height = wantH; }
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
    const span = viewSpan(), from = viewStart();
    const xFor = (t) => (t - from) / span * rect.width;
    const gridSeconds = span > 240 ? 30 : span > 90 ? 10 : span > 30 ? 5 : span > 10 ? 1 : 0.5;
    ctx.font = '11px "JetBrains Mono", monospace';
    ctx.fillStyle = getComputedStyle(document.documentElement)
      .getPropertyValue('--text-3').trim() || '#868a92';
    for (let at = Math.floor(from / gridSeconds) * gridSeconds; at <= from + span; at += gridSeconds) {
      const x = xFor(at);
      ctx.strokeStyle = '#2b2e36'; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, rect.height); ctx.stroke();
      if (x + 34 < rect.width) ctx.fillText(formatTime(at), x + 4, 13);
    }
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#b8e62e';
    ctx.fillStyle = accent; ctx.globalAlpha = 0.82;
    for (const note of doc.notes) {
      if (Number(note.end) < from || Number(note.start) > from + span) continue;
      const x = xFor(Number(note.start));
      const width = Math.max(2, (Number(note.end) - Number(note.start)) / span * rect.width);
      const y = rect.height - (Number(note.pitch) - bottom + 1) / range * rect.height;
      ctx.fillRect(x, y, width, Math.max(3, rect.height / range - 2));
    }
    ctx.globalAlpha = 1;
    const playX = xFor(player.position);
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(playX, 0); ctx.lineTo(playX, rect.height); ctx.stroke();
  }

  function sendToPlayer() {
    const path = currentPath();
    if (!path) return;
    parent.postMessage({ type: 'studio:open-player', midiPath: path }, '*');
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
  refreshLibrary();

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
  $('to-editor').addEventListener('click', () => {
    const target = player.projectPath || currentPath();
    if (target) parent.postMessage({ type: 'studio:open-review', projectPath: target }, '*');
  });
  $('library-search').addEventListener('input', renderLibrary);
  $('library-sort').addEventListener('change', renderLibrary);
  $('library-refresh').addEventListener('click', refreshLibrary);
  $('library-add').addEventListener('click', async () => {
    if (!window.library || !library.addFolder) return;
    const r = await library.addFolder();
    if (r && r.ok) refreshLibrary();
  });
  if (window.library && library.onChanged) library.onChanged(() => refreshLibrary());
  $('note-roll').addEventListener('pointerdown', (event) => {
    if (!player.duration) return;
    const rect = event.currentTarget.getBoundingClientRect();
    seek(viewStart() + (event.clientX - rect.left) / rect.width * viewSpan());
  });
  // Wheel zooms the timeline around the pointer; shift-wheel pans.
  $('note-roll').addEventListener('wheel', (event) => {
    if (!player.duration) return;
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientX - rect.left) / rect.width;
    const span = viewSpan(), from = viewStart();
    if (event.shiftKey) { view.start = clamp(from + event.deltaY / rect.width * span, 0, player.duration); drawRoll(); return; }
    const anchor = from + ratio * span;
    const next = clamp(span * Math.exp(event.deltaY * 0.0016), 1, player.duration);
    view.span = next >= player.duration ? 0 : next;
    view.start = anchor - ratio * viewSpan();
    drawRoll();
  }, { passive: false });
  $('note-roll').addEventListener('dblclick', () => { view.span = 0; view.start = 0; drawRoll(); });
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
